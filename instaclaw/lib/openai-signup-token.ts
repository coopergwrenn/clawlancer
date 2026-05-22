/**
 * One-shot signup-token sign/verify for the ChatGPT-as-signin bridge.
 *
 * THE BRIDGE PROBLEM
 * ──────────────────
 * The OpenAI device-code flow runs through our /api/auth/openai/signup/*
 * routes (session-less, polling). When the flow completes, we have:
 *   - OAuth tokens stored on a real instaclaw_users row (the route
 *     creates/links the user before returning)
 *   - NO NextAuth session yet — the session cookie is what authorizes
 *     the rest of the app
 *
 * NextAuth (v5 beta.30) won't create a session from a raw "we already
 * authed this user out-of-band, please trust us" claim. The idiomatic
 * way to bridge the gap is the Credentials provider: client calls
 * `signIn("openai-device-code", {signupToken})`, NextAuth invokes the
 * provider's `authorize` callback, and `authorize` returns a user object
 * → NextAuth creates the session JWT + cookie + redirects.
 *
 * The signupToken in that handoff is what THIS module mints and verifies.
 *
 * SHAPE
 * ─────
 * `<payloadB64>.<exp>.<hmacHex>`  — same shape as lib/edge-verified-cookie
 * for consistency. Decoded payload is JSON: { sub: <user.id>, jti: <hex> }.
 *
 * Why HMAC and not a full JWT library:
 *   - We already use this pattern (edge-verified-cookie) and it's audited.
 *   - No external dep needed (Node crypto only).
 *   - We don't need OIDC claims, just "this user.id was authorized by
 *     our /signup/poll route within the last 60s."
 *
 * TTL
 * ───
 * 60s. The client receives the token from /signup/poll's response and
 * immediately calls `signIn("openai-device-code", {signupToken})`. The
 * end-to-end window between mint and verify is typically <2s. 60s gives
 * generous headroom for slow networks without leaving a meaningful
 * replay window.
 *
 * REPLAY PROTECTION
 * ─────────────────
 * The `jti` claim is a 16-byte random hex string per mint. We do NOT
 * enforce single-use via a DB-side blacklist (would require an extra
 * round-trip in the hot path). The 60s exp window is the primary defense.
 * If single-use becomes load-bearing, swap to a per-jti TTL'd row in
 * `instaclaw_consumed_jtis` and the verify path checks-and-inserts.
 *
 * SENSITIVE
 * ─────────
 * The token grants session creation. Treat as a session-equivalent
 * secret per Rule 53: never log the full value; first 12 chars max are
 * safe for forensic correlation.
 */
import crypto from "crypto";

export const SIGNUP_TOKEN_TTL_S = 60;
export const SIGNUP_TOKEN_AUD = "openai-signup";

interface SignResult {
  ok: boolean;
  token?: string;
  error?: string;
}

interface VerifyResult {
  ok: boolean;
  userId?: string;
  jti?: string;
  reason?:
    | "missing_secret"
    | "malformed"
    | "bad_sig"
    | "expired"
    | "bad_payload";
}

interface TokenPayload {
  sub: string; // instaclaw_users.id
  jti: string; // 16-byte hex random
  aud: string; // "openai-signup" (defense against cross-purpose token reuse)
}

function getSecret(): string | null {
  // Reuse NEXTAUTH_SECRET — already required for NextAuth JWT signing,
  // already 32+ bytes, already required to be set in production. No
  // separate env var to manage.
  const s = process.env.NEXTAUTH_SECRET;
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
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function constantTimeEqHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Mint a one-shot signup token for the given user. The caller should
 * pass the user.id of a row that has just been created (or linked) by
 * a successful device-code completion. Returns ok:false if NEXTAUTH_SECRET
 * is misconfigured — the caller MUST surface this as a 500 (never let
 * the client through without a verifiable token).
 */
export function signSignupToken(userId: string): SignResult {
  const secret = getSecret();
  if (!secret) {
    return { ok: false, error: "NEXTAUTH_SECRET unset or too short" };
  }
  if (!userId || typeof userId !== "string") {
    return { ok: false, error: "userId required" };
  }

  const payload: TokenPayload = {
    sub: userId,
    jti: crypto.randomBytes(16).toString("hex"),
    aud: SIGNUP_TOKEN_AUD,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const exp = Math.floor(Date.now() / 1000) + SIGNUP_TOKEN_TTL_S;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(`${payloadB64}.${exp}`)
    .digest("hex");

  return { ok: true, token: `${payloadB64}.${exp}.${hmac}` };
}

/**
 * Verify a signup token. Constant-time HMAC compare per the parent
 * doc's reasoning. Returns the userId on success — caller does the DB
 * lookup to confirm the user actually exists (defense in depth: a
 * forged-secret attacker would still need to know a real user.id, but
 * if NEXTAUTH_SECRET ever leaks, we want the DB lookup to be the final
 * gate before issuing a session).
 */
export function verifySignupToken(value: string | undefined | null): VerifyResult {
  if (!value) return { ok: false, reason: "malformed" };

  const secret = getSecret();
  if (!secret) return { ok: false, reason: "missing_secret" };

  const parts = value.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [payloadB64, expStr, hmacHex] = parts;
  if (!payloadB64 || !expStr || !hmacHex) return { ok: false, reason: "malformed" };

  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return { ok: false, reason: "malformed" };
  if (Math.floor(Date.now() / 1000) > exp) return { ok: false, reason: "expired" };

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${payloadB64}.${expStr}`)
    .digest("hex");
  if (!constantTimeEqHex(hmacHex, expected)) return { ok: false, reason: "bad_sig" };

  let payload: TokenPayload;
  try {
    const json = b64urlDecode(payloadB64);
    payload = JSON.parse(json) as TokenPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.jti !== "string" ||
    !payload.jti ||
    payload.aud !== SIGNUP_TOKEN_AUD
  ) {
    return { ok: false, reason: "bad_payload" };
  }

  return { ok: true, userId: payload.sub, jti: payload.jti };
}
