/**
 * OpenAI Codex (ChatGPT) device-code OAuth client.
 *
 * Pure functions that wrap the OpenAI Codex OAuth endpoints. No DB, no
 * logger, no Vercel-specific behavior — these primitives are testable
 * from any environment (the test harness in
 * scripts/_test-openai-oauth-primitives.ts uses an injected fetch).
 *
 * Verified end-to-end in Phase 0 spike (2026-05-18): the OAuth and
 * inference endpoints work from a Linode us-east cloud IP using the
 * official Codex CLI. Verified again in Phase 0.5 — OpenClaw's bundled
 * @mariozechner/pi-ai uses the same endpoints and same client_id for
 * the device-code flow. This implementation mirrors pi-ai's exactly
 * (utils/oauth/openai-codex.js) modulo TypeScript types and richer
 * error classification (mapped from Codex source's 5 failure modes).
 *
 * The flow is three steps from the user's perspective:
 *
 *   1. Backend calls startDeviceFlow() to get a user-visible code +
 *      verification URL. Persist {device_auth_id, user_code} in
 *      instaclaw_oauth_device_flows.
 *
 *   2. User visits the URL, signs in, enters the code, clicks Authorize.
 *
 *   3. Backend polls pollDeviceFlow(deviceAuthId, userCode) every
 *      {intervalMs} (~5s). On {status: "completed", tokens}, store the
 *      tokens encrypted in instaclaw_users and bump openai_token_version.
 *
 * Refresh: when the access token nears expiry, the refresh cron calls
 * refreshAccessToken(refreshToken). Refresh tokens are SINGLE-USE per
 * OpenAI spec — concurrent attempts cause permanent lockout
 * (refresh_token_reused). Callers MUST serialize via Postgres row lock
 * (SELECT ... FOR UPDATE NOWAIT).
 *
 * Errors as values: all expected failure modes return typed result
 * objects with a `status` discriminator. We throw only on:
 *   - Malformed input (TypeError)
 *   - Network-level failures (fetch throws)
 *   - 5xx from OpenAI (transient — caller retries)
 *
 * Endpoints used (all verified working from Linode cloud IPs in Phase 0):
 *   POST https://auth.openai.com/api/accounts/deviceauth/usercode
 *   POST https://auth.openai.com/api/accounts/deviceauth/token
 *   POST https://auth.openai.com/oauth/token
 */

// ─── Constants ───────────────────────────────────────────────────────────

/**
 * The default OAuth issuer. Configurable via env for testing/staging
 * (set OPENAI_OAUTH_ISSUER to override).
 */
const DEFAULT_ISSUER = "https://auth.openai.com";

/**
 * The public OAuth client_id for OpenAI Codex. Same one the official
 * Codex CLI uses (verified in Phase 0; confirmed in Phase 0.5 source
 * at @mariozechner/pi-ai/dist/utils/oauth/openai-codex.js).
 *
 * This is a public identifier — there's no client_secret (PKCE replaces
 * that). Embedded in our code is fine.
 */
export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/**
 * Where OpenAI tells us to redirect after auth-code exchange in the
 * device-code flow. Hardcoded by Codex; we just pass it back.
 */
const DEVICE_REDIRECT_URI = `${DEFAULT_ISSUER}/deviceauth/callback`;

/**
 * Device-code flows are valid for 15 minutes per OpenAI's docs. If a
 * user hasn't authorized in this window, OpenAI returns expired_token.
 */
const DEFAULT_DEVICE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Default poll interval when OpenAI doesn't return one explicitly.
 * OpenAI usually returns interval=5 (seconds).
 */
const DEFAULT_INTERVAL_MS = 5_000;

/**
 * User-Agent header on every OAuth request. Identifies us to OpenAI's
 * server-side observability. If we ever hit bot-detection issues this is
 * the first thing to investigate (Phase 0 verified codex_cli_rs works
 * from Linode us-east; instaclaw should work the same — different UA
 * strings have not been observed to differ in success rate, but if they
 * do, set OPENAI_OAUTH_USER_AGENT env var to "codex_cli_rs/0.131.0").
 */
const DEFAULT_USER_AGENT = "instaclaw/0.1.0 (openai-oauth-client)";

function issuer(): string {
  return (process.env.OPENAI_OAUTH_ISSUER || DEFAULT_ISSUER).replace(/\/+$/, "");
}

function userAgent(): string {
  return process.env.OPENAI_OAUTH_USER_AGENT || DEFAULT_USER_AGENT;
}

// ─── Types ───────────────────────────────────────────────────────────────

export interface DeviceCodeStart {
  /** Human-readable code (e.g., "92PM-PLU8N") that the user enters in the browser. */
  userCode: string;
  /** Opaque ID used together with userCode on every poll. */
  deviceAuthId: string;
  /** URL we show the user (e.g., https://auth.openai.com/codex/device). */
  verificationUri: string;
  /** Minimum time between polls, per OpenAI's response. */
  intervalMs: number;
  /** Absolute deadline beyond which OpenAI will return expired_token. */
  expiresInMs: number;
}

export interface TokenSet {
  /** Bearer JWT used as Authorization header for inference. ~28-day TTL typical. */
  accessToken: string;
  /** Single-use refresh token. Concurrent use causes permanent lockout. */
  refreshToken: string;
  /** ID token JWT carrying chatgpt_plan_type, chatgpt_account_id, email, exp. */
  idToken: string;
  /** Absolute expiry timestamp in unix milliseconds (Date.now() + expires_in*1000). */
  expiresAtMs: number;
}

export interface IdTokenClaims {
  email?: string;
  chatgptPlanType?: string;
  chatgptAccountId?: string;
  chatgptUserId?: string;
  chatgptAccountIsFedramp?: boolean;
  exp?: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
}

export type DeviceCodePoll =
  | { status: "pending" }
  | { status: "completed"; tokens: TokenSet; claims: IdTokenClaims | null }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "error"; message: string };

/**
 * The five distinct refresh-failure modes, mirroring Codex's
 * RefreshTokenFailedReason enum (codex-rs/login/src/auth/manager.rs).
 * Each gets a different user-facing message — generic "auth failed" is
 * useless during incident response.
 *
 * - expired: refresh_token_expired (user needs to re-auth)
 * - reused: refresh_token_reused (PERMANENT lockout from concurrent
 *           refresh; user must re-auth and we should investigate
 *           whether two processes raced)
 * - revoked: refresh_token_invalidated (user revoked our access OR
 *            changed their OpenAI password)
 * - account_mismatch: refresh succeeded but the new token's account
 *                     differs from what was cached (user signed out
 *                     and into a different account)
 * - other: unknown 401, unknown error code, malformed response
 */
export type RefreshFailureReason =
  | "expired"
  | "reused"
  | "revoked"
  | "account_mismatch"
  | "other";

export type RefreshResult =
  | { status: "success"; tokens: TokenSet; claims: IdTokenClaims | null }
  | { status: "failed"; reason: RefreshFailureReason; message: string };

type FetchImpl = typeof fetch;

interface OpsCallOpts {
  fetchImpl?: FetchImpl;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Decode a JWT's middle (payload) segment WITHOUT verifying the signature.
 * We trust the JWT because OpenAI's token endpoint just gave it to us
 * over TLS. Returns null on any parsing failure — caller decides whether
 * that's fatal.
 */
export function parseJwtClaims(jwt: string): IdTokenClaims | null {
  if (typeof jwt !== "string" || jwt.length === 0) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    // URL-safe base64 → standard base64, pad
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf-8");
    const raw = JSON.parse(decoded) as Record<string, unknown>;

    // OpenAI's claim format nests the interesting stuff under a URL-shaped key.
    const authClaims = (raw["https://api.openai.com/auth"] as Record<string, unknown>) || {};
    const profileClaims = (raw["https://api.openai.com/profile"] as Record<string, unknown>) || {};

    return {
      email:
        (raw.email as string | undefined) ??
        (profileClaims.email as string | undefined),
      chatgptPlanType: authClaims.chatgpt_plan_type as string | undefined,
      chatgptAccountId: authClaims.chatgpt_account_id as string | undefined,
      chatgptUserId: authClaims.chatgpt_user_id as string | undefined,
      chatgptAccountIsFedramp:
        (authClaims.chatgpt_account_is_fedramp as boolean | undefined) ?? undefined,
      exp: raw.exp as number | undefined,
      iat: raw.iat as number | undefined,
      iss: raw.iss as string | undefined,
      aud: raw.aud as string | string[] | undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Compute the absolute expiry timestamp (unix ms) from an expires_in
 * value (seconds) returned by OpenAI's /oauth/token endpoint.
 */
export function computeExpiresAt(expiresInSec: number): number {
  if (typeof expiresInSec !== "number" || !Number.isFinite(expiresInSec)) {
    throw new TypeError(`computeExpiresAt: expected number, got ${typeof expiresInSec}`);
  }
  return Date.now() + Math.max(0, Math.trunc(expiresInSec * 1000));
}

/**
 * Parse a JSON body, defensively. Returns null if not parseable as object.
 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function trimNonEmpty(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build a TokenSet from an /oauth/token response body.
 * Returns null if any required field is missing.
 */
function tokenSetFromResponse(body: Record<string, unknown>): TokenSet | null {
  const accessToken = trimNonEmpty(body.access_token);
  const refreshToken = trimNonEmpty(body.refresh_token);
  const idToken = trimNonEmpty(body.id_token);
  const expiresIn = body.expires_in;
  if (!accessToken || !refreshToken || !idToken) return null;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) return null;
  return {
    accessToken,
    refreshToken,
    idToken,
    expiresAtMs: computeExpiresAt(expiresIn),
  };
}

// ─── Operations ──────────────────────────────────────────────────────────

/**
 * Start a device-code OAuth flow. Returns the user-visible code + URL
 * + polling parameters. Persist {deviceAuthId, userCode} in your DB so
 * the poll endpoint can use them.
 *
 * The OAuth /deviceauth/usercode endpoint uses Content-Type: application/json
 * (despite /oauth/token using form-encoded — they're inconsistent).
 */
export async function startDeviceFlow(opts: OpsCallOpts = {}): Promise<DeviceCodeStart> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const response = await fetchFn(`${issuer()}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": userAgent(),
    },
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        "OpenAI Codex device-code login is not available for this client. " +
          "Verify the client_id and that the user's account has Codex access enabled " +
          "(ChatGPT Security Settings → 'Enable device code authorization for Codex').",
      );
    }
    throw new Error(
      `OpenAI deviceauth/usercode failed: HTTP ${response.status} ${bodyText.slice(0, 200)}`,
    );
  }
  const body = parseJsonObject(bodyText);
  const deviceAuthId = trimNonEmpty(body?.device_auth_id);
  const userCode = trimNonEmpty(body?.user_code) ?? trimNonEmpty(body?.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error(
      `OpenAI deviceauth/usercode response missing required fields. Body: ${bodyText.slice(0, 200)}`,
    );
  }
  const intervalSec = body && typeof body.interval === "number" ? body.interval : 5;
  const expiresInSec =
    body && typeof body.expires_in === "number" ? body.expires_in : 15 * 60;
  return {
    userCode,
    deviceAuthId,
    verificationUri: `${issuer()}/codex/device`,
    intervalMs: Math.max(1_000, Math.trunc(intervalSec * 1_000)) || DEFAULT_INTERVAL_MS,
    expiresInMs: Math.max(60_000, Math.trunc(expiresInSec * 1_000)) || DEFAULT_DEVICE_TIMEOUT_MS,
  };
}

/**
 * Poll once for completion. Caller decides when to stop based on the
 * returned status (typically: poll every intervalMs until status !==
 * "pending", with an overall deadline of expiresInMs from start).
 *
 * On {status: "completed"}, the auth code has already been exchanged
 * internally and you get the full TokenSet. No second call needed.
 *
 * The /deviceauth/token endpoint returns 403 OR 404 while pending — both
 * mean "user hasn't authorized yet". Returns the auth code on success.
 * We then immediately POST to /oauth/token to exchange for real tokens.
 */
export async function pollDeviceFlow(
  deviceAuthId: string,
  userCode: string,
  opts: OpsCallOpts = {},
): Promise<DeviceCodePoll> {
  if (typeof deviceAuthId !== "string" || deviceAuthId.length === 0) {
    throw new TypeError("pollDeviceFlow: deviceAuthId required");
  }
  if (typeof userCode !== "string" || userCode.length === 0) {
    throw new TypeError("pollDeviceFlow: userCode required");
  }
  const fetchFn = opts.fetchImpl ?? fetch;

  // Step 1: poll for the auth code.
  const pollRes = await fetchFn(`${issuer()}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": userAgent(),
    },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  });
  const pollText = await pollRes.text();

  // Still waiting. 403 and 404 are both "user hasn't authorized yet."
  if (pollRes.status === 403 || pollRes.status === 404) {
    return { status: "pending" };
  }

  // Explicit failure modes that OpenAI signals via error.code in the body.
  if (!pollRes.ok) {
    const body = parseJsonObject(pollText);
    const errorCode = trimNonEmpty(((body?.error as Record<string, unknown>)?.code as string));
    if (errorCode === "expired_token") return { status: "expired" };
    if (errorCode === "access_denied") return { status: "denied" };
    return {
      status: "error",
      message: `HTTP ${pollRes.status} ${errorCode ?? "no error code"}: ${pollText.slice(0, 200)}`,
    };
  }

  // Step 2: got the auth code. Exchange for real tokens.
  const pollBody = parseJsonObject(pollText);
  const authorizationCode = trimNonEmpty(pollBody?.authorization_code);
  const codeVerifier = trimNonEmpty(pollBody?.code_verifier);
  if (!authorizationCode || !codeVerifier) {
    return {
      status: "error",
      message: `Poll succeeded (HTTP 200) but response missing auth code or code verifier: ${pollText.slice(0, 200)}`,
    };
  }

  const tokens = await exchangeAuthCodeInternal(authorizationCode, codeVerifier, opts);
  if (tokens.status === "failed") {
    return { status: "error", message: tokens.message };
  }
  return {
    status: "completed",
    tokens: tokens.tokens,
    claims: parseJwtClaims(tokens.tokens.idToken),
  };
}

/**
 * Internal — exchange an authorization code for tokens via /oauth/token.
 *
 * Called by pollDeviceFlow on successful poll. NOT exported because
 * callers should always go through pollDeviceFlow.
 *
 * /oauth/token uses Content-Type: application/x-www-form-urlencoded
 * (NOT JSON — confirmed via Phase 0.5 source reading of
 * @mariozechner/pi-ai/dist/utils/oauth/openai-codex.js).
 */
async function exchangeAuthCodeInternal(
  authorizationCode: string,
  codeVerifier: string,
  opts: OpsCallOpts = {},
): Promise<{ status: "success"; tokens: TokenSet } | { status: "failed"; message: string }> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const response = await fetchFn(`${issuer()}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent(),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CODEX_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: DEVICE_REDIRECT_URI,
    }).toString(),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    return {
      status: "failed",
      message: `code→token exchange failed: HTTP ${response.status} ${bodyText.slice(0, 200)}`,
    };
  }
  const body = parseJsonObject(bodyText);
  if (!body) {
    return { status: "failed", message: `code→token exchange returned non-JSON body: ${bodyText.slice(0, 200)}` };
  }
  const tokens = tokenSetFromResponse(body);
  if (!tokens) {
    return {
      status: "failed",
      message: `code→token exchange missing required fields (access_token/refresh_token/id_token/expires_in): ${bodyText.slice(0, 200)}`,
    };
  }
  return { status: "success", tokens };
}

/**
 * Refresh an access token. Returns rich error classification so the
 * caller can show the user an appropriate message.
 *
 * THE LOCKING DISCIPLINE IS LOAD-BEARING. Refresh tokens are single-use
 * per OpenAI's spec. Two concurrent refresh attempts → one succeeds, the
 * other gets `refresh_token_reused` → PERMANENT LOCKOUT for that user
 * until they re-auth. Callers MUST hold a Postgres row-level lock on
 * the user's row (SELECT ... FOR UPDATE NOWAIT) across this call.
 *
 * /oauth/token uses Content-Type: application/x-www-form-urlencoded for
 * refresh (NOT JSON, despite some docs claiming otherwise — Phase 0.5
 * source reading confirmed form-encoded).
 *
 * Failure classification mirrors Codex source's RefreshTokenFailedReason
 * enum. The user-facing messages should be tailored per reason:
 *   - expired: "Your ChatGPT login expired — please reconnect."
 *   - reused:  "Your ChatGPT login was used by another process — please reconnect."
 *   - revoked: "You revoked InstaClaw's access to ChatGPT — please reconnect."
 *   - account_mismatch: "You're now signed into a different OpenAI account — please reconnect."
 *   - other:   "Couldn't refresh your ChatGPT login — please reconnect."
 */
export async function refreshAccessToken(
  refreshToken: string,
  opts: OpsCallOpts = {},
): Promise<RefreshResult> {
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new TypeError("refreshAccessToken: refreshToken required");
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${issuer()}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent(),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: OPENAI_CODEX_CLIENT_ID,
        refresh_token: refreshToken,
      }).toString(),
    });
  } catch (err) {
    // Network errors are transient — the cron will retry on the next tick.
    return {
      status: "failed",
      reason: "other",
      message: `Network error during refresh: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const bodyText = await response.text();
  if (response.ok) {
    const body = parseJsonObject(bodyText);
    if (!body) {
      return {
        status: "failed",
        reason: "other",
        message: `Refresh returned non-JSON body: ${bodyText.slice(0, 200)}`,
      };
    }
    const tokens = tokenSetFromResponse(body);
    if (!tokens) {
      return {
        status: "failed",
        reason: "other",
        message: `Refresh response missing required fields: ${bodyText.slice(0, 200)}`,
      };
    }
    return {
      status: "success",
      tokens,
      claims: parseJwtClaims(tokens.idToken),
    };
  }

  // Classify the failure. Codex source uses error.code from the JSON body.
  const body = parseJsonObject(bodyText);
  const errorCode = trimNonEmpty(((body?.error as Record<string, unknown>)?.code as string));
  switch (errorCode) {
    case "refresh_token_expired":
      return {
        status: "failed",
        reason: "expired",
        message: "Refresh token has expired. User must re-authorize.",
      };
    case "refresh_token_reused":
      return {
        status: "failed",
        reason: "reused",
        message:
          "Refresh token was already used by another request. This is a permanent lockout — " +
          "the user must re-authorize. Investigate concurrent-refresh root cause (missing row lock?).",
      };
    case "refresh_token_invalidated":
      return {
        status: "failed",
        reason: "revoked",
        message:
          "Refresh token was revoked (user clicked Disconnect on OpenAI's side, or changed " +
          "their password). User must re-authorize.",
      };
    default:
      return {
        status: "failed",
        reason: "other",
        message: `HTTP ${response.status} error=${errorCode ?? "unknown"}: ${bodyText.slice(0, 200)}`,
      };
  }
}

/**
 * Detect account mismatch after a successful refresh. Compare the new
 * id_token's chatgpt_account_id (or chatgpt_user_id) against the cached
 * value from before the refresh. If different, the user has signed out
 * and into a different OpenAI account — we should reject the new tokens
 * and prompt them to re-authorize.
 *
 * Returns the mismatch reason if detected, or null if accounts match
 * (or if there's nothing cached to compare against — first refresh).
 */
export function detectAccountMismatch(
  newClaims: IdTokenClaims | null,
  cachedAccountId: string | null | undefined,
  cachedUserId?: string | null,
): RefreshFailureReason | null {
  if (!newClaims) return null;
  if (!cachedAccountId && !cachedUserId) return null;

  const newAccount = newClaims.chatgptAccountId ?? null;
  const newUser = newClaims.chatgptUserId ?? null;

  if (cachedAccountId && newAccount && cachedAccountId !== newAccount) {
    return "account_mismatch";
  }
  if (cachedUserId && newUser && cachedUserId !== newUser) {
    return "account_mismatch";
  }
  return null;
}
