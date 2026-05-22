/**
 * One-shot OTP-token sign/verify for the Edge email-magic-code auth path.
 *
 * Mirrors lib/openai-signup-token.ts (same HMAC shape, same TTL, same
 * audience-claim defense). The two coexist because the Edge OTP flow
 * and the OpenAI device-code flow are independent code paths that
 * happen to use the same NextAuth-credentials bridge pattern.
 *
 * THE BRIDGE PROBLEM (Edge variant)
 * ─────────────────────────────────
 * The Edge OTP flow runs through:
 *   1. /api/edge/verify-ticket — silent /citizens check, sets signed
 *      edge_verified_email cookie
 *   2. /api/edge/start-email-login — fires OTP via EdgeOS third-party-
 *      login endpoint
 *   3. /api/edge/verify-otp — validates the 6-digit code via EdgeOS
 *      authenticate endpoint, creates/links the instaclaw_users row,
 *      mints a one-shot OTP token, returns to client
 *   4. Client calls `signIn(EDGE_EMAIL_OTP_PROVIDER_ID, { otpToken })`
 *      from next-auth/react
 *   5. NextAuth invokes the Credentials provider's authorize() callback
 *      which verifies THIS token (HMAC + exp) + does a defense-in-depth
 *      DB lookup → returns the user → session minted
 *
 * SHAPE
 * ─────
 * `<payloadB64>.<exp>.<hmacHex>` — identical to openai-signup-token shape
 * (familiar audit surface). Payload: `{ sub: <user.id>, jti, aud: "edge-otp" }`.
 *
 * The `aud: "edge-otp"` claim is the cross-purpose-reuse defense — even
 * if NEXTAUTH_SECRET leaks, an attacker can't replay an openai-signup
 * token through the edge-otp authorize() callback because the audience
 * claim wouldn't match.
 *
 * TTL
 * ───
 * 60s. Same as openai-signup. Window between /api/edge/verify-otp
 * mint and signIn() consume is typically <2s; 60s tolerates slow networks.
 *
 * SENSITIVE
 * ─────────
 * The token grants session creation. Per Rule 53 (session-equivalent
 * secrets): never log the full value; first 12 chars max for forensic
 * correlation.
 */
import crypto from "crypto";

export const EDGE_OTP_TOKEN_TTL_S = 60;
export const EDGE_OTP_TOKEN_AUD = "edge-otp";

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
  aud: string; // "edge-otp" (cross-purpose-reuse defense)
}

function getSecret(): string | null {
  // Reuse NEXTAUTH_SECRET (already required for NextAuth JWT signing).
  // Same rationale as openai-signup-token.ts.
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
 * Mint a one-shot Edge OTP token for the given user. The caller MUST
 * have just successfully validated the user's 6-digit code against
 * EdgeOS's authenticate endpoint. Returns ok:false if NEXTAUTH_SECRET is
 * misconfigured — the route MUST surface this as a 500 (never let the
 * client through without a verifiable token).
 */
export function signEdgeOtpToken(userId: string): SignResult {
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
    aud: EDGE_OTP_TOKEN_AUD,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const exp = Math.floor(Date.now() / 1000) + EDGE_OTP_TOKEN_TTL_S;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(`${payloadB64}.${exp}`)
    .digest("hex");

  return { ok: true, token: `${payloadB64}.${exp}.${hmac}` };
}

/**
 * Verify an Edge OTP token. Same constant-time HMAC discipline as
 * openai-signup-token. Returns userId on success; caller does the DB
 * lookup (defense in depth — same as openai-signup pattern).
 */
export function verifyEdgeOtpToken(value: string | undefined | null): VerifyResult {
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
    payload.aud !== EDGE_OTP_TOKEN_AUD
  ) {
    return { ok: false, reason: "bad_payload" };
  }

  return { ok: true, userId: payload.sub, jti: payload.jti };
}
