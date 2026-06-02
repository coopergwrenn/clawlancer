/**
 * Signed cookie helpers for the EdgeOS ticket verification gate.
 *
 * Chain of custody:
 *   1. User submits email at /edge/claim → POST /api/edge/verify-ticket.
 *   2. Route verifies against EdgeOS attendees directory.
 *   3. On verified, route sets `edge_verified_email` httpOnly cookie
 *      with this module's `signEdgeVerifiedCookie(email)`.
 *   4. User clicks "Continue" → /connect → picks auth method.
 *   5. NextAuth signIn callback reads cookie via `verifyEdgeVerifiedCookie`.
 *   6. If cookie is valid + unexpired + email signature checks out, the
 *      callback writes `instaclaw_users.edge_verified_email` to the new
 *      or existing user row.
 *   7. Partial UNIQUE index on the column catches dual-claim attempts.
 *
 * Why signed (not plain) cookie: without HMAC, a malicious user could
 * just set `edge_verified_email=victim@example.com` themselves and
 * bypass the verifier. Signing it server-side with a shared secret
 * means only the verify-ticket route can mint valid values.
 *
 * Format: `<emailB64>.<exp>.<hmacHex>`
 *   - emailB64: base64url-encoded lower-cased email (no padding)
 *   - exp:      unix-seconds expiry
 *   - hmacHex:  HMAC-SHA256(`<emailB64>.<exp>`, secret) as lowercase hex
 *
 * TTL is 60 minutes (bumped from 15 on 2026-05-31). The 15-min window
 * was too tight for the slowest realistic Edge path: a conference
 * attendee on spotty wifi picking the ChatGPT device-code auth (the
 * PRIMARY path on /edge/claim) must leave the tab, log into ChatGPT,
 * paste a device code, and return — OpenAI's own device code is valid
 * ~15 min, but OUR 15-min clock started 1-2 min EARLIER at email
 * unlock, so a distracted attendee could exhaust it mid-auth.
 *
 * Why bumping is the SAFE direction (not the risky one): if this
 * cookie expires mid-auth, the user experience does NOT break — the
 * separate 7-day `instaclaw_partner` cookie still tags them edge_city
 * (so billing, the Edge /plan variant, and Edge skills all work). The
 * ONLY thing lost on expiry is the write of `edge_verified_email`,
 * which backs the 1-agent-per-EdgeOS-email dual-claim UNIQUE lock. So
 * a LONGER TTL means that abuse guard is MORE likely to be applied for
 * slow-auth users — tighter enforcement, not looser. The cost is a
 * larger leak window, but a leaked signed cookie's exploit value is
 * near-zero: an attacker would need a victim's real registered EdgeOS
 * email AND their httpOnly cookie to claim a sponsor slot they don't
 * own. 60 min gives comfortable runway for the worst realistic
 * conference scenario while keeping the cookie operationally
 * short-lived.
 *
 * Server secret: `EDGE_VERIFIED_COOKIE_SECRET` env var. Cooper sets in
 * Vercel. If absent, the module returns failure and refuses to mint —
 * fail-closed (per Rule 50's "fail-CLOSED for destructive decisions"
 * spirit; minting a verified cookie without a secret is a destructive
 * mistake we'd rather avoid).
 */
import crypto from "crypto";

export const EDGE_VERIFIED_COOKIE_NAME = "edge_verified_email";
export const EDGE_VERIFIED_COOKIE_MAX_AGE_S = 60 * 60; // 60 minutes (see header)

interface SignResult {
  ok: boolean;
  cookie?: string;
  error?: string;
}

interface VerifyResult {
  ok: boolean;
  email?: string;
  reason?: "missing_secret" | "malformed" | "bad_sig" | "expired";
}

function getSecret(): string | null {
  const s = process.env.EDGE_VERIFIED_COOKIE_SECRET;
  if (!s || s.length < 16) return null;
  return s;
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf, "utf-8") : buf;
  return b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(s: string): string {
  // Restore padding for Buffer.from('base64')
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function constantTimeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    // hex parse failure = not equal
    return false;
  }
}

/**
 * Mint a signed cookie for the given email. Email is lower-cased before
 * signing so case-insensitive comparison at verify time is built-in.
 *
 * Returns `{ ok: false, error }` if the server secret is unset — caller
 * MUST surface this as a 500 to the user (we won't quietly let an
 * unverified user past the gate by skipping cookie issuance).
 */
export function signEdgeVerifiedCookie(email: string): SignResult {
  const secret = getSecret();
  if (!secret) {
    return { ok: false, error: "EDGE_VERIFIED_COOKIE_SECRET unset" };
  }
  const normalized = email.trim().toLowerCase();
  if (!normalized) return { ok: false, error: "empty email" };

  const emailB64 = b64url(normalized);
  const exp = Math.floor(Date.now() / 1000) + EDGE_VERIFIED_COOKIE_MAX_AGE_S;
  const payload = `${emailB64}.${exp}`;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  return { ok: true, cookie: `${payload}.${hmac}` };
}

/**
 * Verify a cookie value. Returns `{ ok: true, email }` on success, or
 * `{ ok: false, reason }` on any failure. Constant-time HMAC compare to
 * prevent timing-based forgery (well, the impact would be minor — the
 * value just lets a user claim a partner tag — but cost is one
 * timingSafeEqual call so we do it).
 */
export function verifyEdgeVerifiedCookie(value: string | undefined | null): VerifyResult {
  if (!value) return { ok: false, reason: "malformed" };

  const secret = getSecret();
  if (!secret) return { ok: false, reason: "missing_secret" };

  const parts = value.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [emailB64, expStr, hmacHex] = parts;
  if (!emailB64 || !expStr || !hmacHex) return { ok: false, reason: "malformed" };

  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return { ok: false, reason: "malformed" };
  if (Math.floor(Date.now() / 1000) > exp) return { ok: false, reason: "expired" };

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${emailB64}.${expStr}`)
    .digest("hex");
  if (!constantTimeEqHex(hmacHex, expected)) return { ok: false, reason: "bad_sig" };

  let email: string;
  try {
    email = b64urlDecode(emailB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!email) return { ok: false, reason: "malformed" };

  return { ok: true, email };
}
