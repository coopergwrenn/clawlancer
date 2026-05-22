/**
 * EdgeOS OTP login helper — first half of the per-user eos_live_* mint chain.
 *
 * The flow (confirmed by Tule 2026-05-14):
 *
 *   1. POST /api/v1/auth/user/login        body { email }
 *      → emails a 6-digit code to the user, returns { message, email, expires_in_minutes }
 *   2. POST /api/v1/auth/user/authenticate body { email, code(6 digits) }
 *      → returns { access_token, token_type: "bearer" }
 *   3. POST /api/v1/api-keys (in lib/edgeos-api-keys.ts) with the bearer
 *      → returns the eos_live_* token (shown once)
 *
 * State model: the chain is stateless from our side — there's no session_id
 * to carry between login and authenticate. The email + code are the
 * coupling. The OTP code expires per the `expires_in_minutes` on the login
 * response.
 *
 * Security:
 *   - Never logs the OTP code or the resulting access_token (they're
 *     bearer-equivalent credentials).
 *   - Returns structured Result-style discriminated unions so callers can
 *     branch on specific failure modes (no_account, invalid_code, etc.)
 *     without parsing error strings.
 *   - Does NOT retry on 401/422 — those are caller bugs or expired state,
 *     retrying just hides them. Returns the failure to the caller.
 *
 * Caveats (per Tule 2026-05-14):
 *   - The OTP service is "not tested on the latest version" — migration is
 *     glitchy until Tuesday May 19. Expect occasional 5xx; up to the caller
 *     whether to retry.
 *   - Calendar API (api-keys + events) is reportedly stable in the latest
 *     version; the auth/OTP path is the wobbly piece.
 */

// 2026-05-22 P0 fix: default was `api.dev.edgeos.world` (the sandbox tier).
// Tule's production attendee directory lives at `api.edgeos.world`. The dev
// tier returns 401 "Invalid third-party credentials" for prod-tier tenant
// keys + prod-tier attendees. Switched default to prod; dev/sandbox testing
// must explicitly set EDGEOS_API_BASE=https://api.dev.edgeos.world.
const DEFAULT_API_BASE =
  process.env.EDGEOS_API_BASE || "https://api.edgeos.world";

const NETWORK_TIMEOUT_MS = 15_000;

/**
 * Known EdgeOS tenant UUIDs. Resolved 2026-05-14 via OpenAPI archaeology
 * + frontend JS chunk mining + live probe. See
 * `instaclaw/docs/edgeos-sandbox-test-setup.md` for derivation.
 *
 * Map by InstaClaw `partner` field to pick the right one:
 *   partner=edge_city → EDGEOS_TENANT_EDGECITY_PROD
 *   partner=(anything else, or unset, in sandbox tests) → EDGEOS_TENANT_DEMO_SANDBOX
 */
export const EDGEOS_TENANT_EDGECITY_PROD =
  "6018917b-3bce-4333-9870-c29aae915038";
export const EDGEOS_TENANT_DEMO_SANDBOX =
  "ea1aaa1d-d06f-4c43-b690-79c22c441093";

/**
 * Known popup IDs.
 *
 * Edge Esmeralda 2026: hard-coded so the agent doesn't have to discover
 * it at call time. If EdgeOS ever invalidates this UUID we'll surface
 * via the events-list 404 → no_events failure mode.
 */
export const POPUP_EDGE_ESMERALDA_2026 =
  "43746fd0-bce2-472b-93e4-a438177b2dff";

export type EdgeOSEnv = {
  apiBase?: string;
  /**
   * EdgeOS X-Tenant-Id header value. The frontend interceptor sets this
   * from `localStorage[portal_tenant_id]` on every request; we substitute
   * by explicit pass-through.
   *
   * - REQUIRED for /api/v1/popups/public/list, /api/v1/events/portal/*,
   *   and (defensively) /api/v1/api-keys/*. The api-keys requirement is
   *   based on the frontend's universal interceptor — empirical
   *   confirmation is open as of 2026-05-14.
   * - NOT REQUIRED for /api/v1/auth/user/login or
   *   /api/v1/auth/user/authenticate (empirically confirmed).
   *
   * Both auth functions accept the field and pass it through harmlessly
   * if set, mirroring the frontend's universal interceptor. Setting it
   * here is the safe default.
   */
  tenantId?: string;
  /**
   * Per-call network timeout. Default 15_000 ms. Useful to bump up to
   * 30_000 for the EdgeOS sandbox during glitchy migration windows
   * (Tule 2026-05-14: "not tested on the latest version, migration is
   * glitchy until Tuesday May 19"), or down to e.g. 5_000 inside a
   * configureOpenClaw flow where total time is bounded.
   */
  timeoutMs?: number;
  /**
   * EdgeOS X-Third-Party-Api-Key header value, used by
   * `requestThirdPartyLogin` to verify attendee/pass-holder status against
   * the popup attendee directory. Defaults to
   * `process.env.EDGEOS_THIRD_PARTY_API_KEY`. Tests inject explicitly.
   *
   * Cooper's tenant key (Edge Esmeralda 2026 admin) from Tule 2026-05-22:
   *   nFrMSSPjeWLFOlBxZ2HJbqVSjuURq2JGRKpCYVDaDzs
   *
   * DIFFERENT from `tenantId` (the X-Tenant-Id header used by directory
   * + events endpoints). Don't confuse them. EdgeOS has two parallel auth
   * surfaces and we use both for different read/write patterns.
   */
  thirdPartyApiKey?: string;
};

// ─── requestOTP ───────────────────────────────────────────────────────────

export type RequestOTPSuccess = {
  ok: true;
  email: string;
  expiresInMinutes: number | null;
  message: string | null;
};

export type RequestOTPFailureStatus =
  | "no_account" // email isn't in EdgeOS
  | "validation_error" // 422 — bad email format
  | "rate_limited" // 429
  | "network" // fetch threw / timed out
  | "unknown"; // anything else, surfaced with httpStatus + raw

export type RequestOTPFailure = {
  ok: false;
  status: RequestOTPFailureStatus;
  httpStatus?: number;
  raw?: string;
};

export type RequestOTPResult = RequestOTPSuccess | RequestOTPFailure;

export async function requestOTP(
  email: string,
  env: EdgeOSEnv = {}
): Promise<RequestOTPResult> {
  const apiBase = env.apiBase ?? DEFAULT_API_BASE;

  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) {
    return { ok: false, status: "validation_error", raw: "email is empty or missing @" };
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${apiBase}/api/v1/auth/user/login`,
      {
        method: "POST",
        headers: buildHeaders({ contentType: "application/json", tenantId: env.tenantId }),
        body: JSON.stringify({ email: trimmed }),
        timeoutMs: env.timeoutMs,
      }
    );
  } catch (err) {
    return {
      ok: false,
      status: "network",
      raw: err instanceof Error ? err.message : String(err),
    };
  }

  const bodyText = await res.text().catch(() => "");

  if (res.ok) {
    let parsed: { message?: string; email?: string; expires_in_minutes?: number } = {};
    try {
      parsed = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      // Body is supposed to be JSON; if not, fall through with the raw text.
      return { ok: false, status: "unknown", httpStatus: res.status, raw: bodyText.slice(0, 500) };
    }
    return {
      ok: true,
      email: parsed.email ?? trimmed,
      expiresInMinutes: parsed.expires_in_minutes ?? null,
      message: parsed.message ?? null,
    };
  }

  // Categorize failures
  // Tule's API hasn't been documented for these specific failure modes — we
  // infer from HTTP status. The endpoint declares no auth requirement, so
  // 401 means something else (maybe "account exists but blocked"?). Treat
  // 401/404 as no_account because we can't proceed either way.
  if (res.status === 404 || res.status === 401) {
    return { ok: false, status: "no_account", httpStatus: res.status, raw: bodyText.slice(0, 500) };
  }
  if (res.status === 422) {
    return { ok: false, status: "validation_error", httpStatus: res.status, raw: bodyText.slice(0, 500) };
  }
  if (res.status === 429) {
    return { ok: false, status: "rate_limited", httpStatus: res.status, raw: bodyText.slice(0, 500) };
  }
  return { ok: false, status: "unknown", httpStatus: res.status, raw: bodyText.slice(0, 500) };
}

// ─── requestThirdPartyLogin ───────────────────────────────────────────────
//
// 2026-05-22 P0 fix: the CORRECT primitive for "is this email a ticket /
// pass holder?" verification. requestOTP (above) calls
// /api/v1/auth/user/login which checks for an existing EdgeOS USER ACCOUNT
// — a separate system from the popup ATTENDEE/PASS-HOLDER directory.
// Production attendees who never manually logged into EdgeOS standalone
// (~80% of Edge Esmeralda's 1000 tickets) returned 404 even though their
// pass was valid. Timour worked because he, as an Edge team member, had
// already created an EdgeOS user account at some prior point.
//
// The third-party-login endpoint authenticates against the popup
// attendee directory using a tenant-level API key in the
// X-Third-Party-Api-Key header. Empirically verified 2026-05-22 vs
// api.edgeos.world:
//
//   coopergrantwrenn@gmail.com  (real ticket, no user account)  → 200 ✓
//   timour.kosters@gmail.com    (real ticket, has user account) → 200 ✓
//   throwaway-non-attendee@...  (no ticket)                     → 401 ✗
//
// Side effect on 200: EdgeOS sends an OTP email to the attendee. We don't
// need them to use the code (we treat 200 as "verified" and proceed). The
// /edge/claim verified state shows soft copy telling the user the email
// is harmless. Tule confirmed this is the intended verification primitive
// for third-party integrations (2026-05-22).
//
// 401 mapping: EdgeOS returns 401 "Authentication failed" for BOTH "bad
// api key" AND "email not in directory". Since we know our key works for
// known-good emails, we can safely interpret 401 → "not_attendee" in this
// codepath. If the api key is ever invalidated, EVERY verification will
// return 401 → operators will see a flood of "not_attendee" reasons and
// know to rotate. There's no per-request distinction; this is fine.
//
// Failure-mode semantics in lib/edgeos.ts:verifyAttendeeByEmail:
//   - 200                                → { verified: true }
//   - 401                                → { verified: false, reason: not_found }
//   - 422                                → { verified: false, reason: invalid_email }
//   - 429                                → { verified: false, reason: rate_limited }
//   - 5xx / network / config_error       → { verified: true, degraded: true }
//     (fail-open per Cooper directive 2026-05-22: blocking 1000 attendees
//     on a Tule API hiccup is worse than letting through a few non-attendees)

export type RequestThirdPartyLoginSuccess = {
  ok: true;
  email: string;
  expiresInMinutes: number | null;
  message: string | null;
};

export type RequestThirdPartyLoginFailureStatus =
  | "not_attendee" // 401 — email isn't in the popup attendee directory
  | "validation_error" // 422 — bad email format
  | "rate_limited" // 429
  | "config_error" // EDGEOS_THIRD_PARTY_API_KEY not set
  | "network" // fetch threw / timed out
  | "unknown"; // anything else, surfaced with httpStatus + raw

export type RequestThirdPartyLoginFailure = {
  ok: false;
  status: RequestThirdPartyLoginFailureStatus;
  httpStatus?: number;
  raw?: string;
};

export type RequestThirdPartyLoginResult =
  | RequestThirdPartyLoginSuccess
  | RequestThirdPartyLoginFailure;

export async function requestThirdPartyLogin(
  email: string,
  env: EdgeOSEnv = {},
): Promise<RequestThirdPartyLoginResult> {
  const apiBase = env.apiBase ?? DEFAULT_API_BASE;
  const tenantKey =
    env.thirdPartyApiKey ?? process.env.EDGEOS_THIRD_PARTY_API_KEY;

  if (!tenantKey) {
    return {
      ok: false,
      status: "config_error",
      raw: "EDGEOS_THIRD_PARTY_API_KEY not set in environment",
    };
  }

  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) {
    return {
      ok: false,
      status: "validation_error",
      raw: "email is empty or missing @",
    };
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${apiBase}/api/v1/auth/human/third-party/login`,
      {
        method: "POST",
        headers: {
          "X-Third-Party-Api-Key": tenantKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: trimmed }),
        timeoutMs: env.timeoutMs,
      },
    );
  } catch (err) {
    return {
      ok: false,
      status: "network",
      raw: err instanceof Error ? err.message : String(err),
    };
  }

  const bodyText = await res.text().catch(() => "");

  if (res.ok) {
    let parsed: {
      message?: string;
      email?: string;
      expires_in_minutes?: number;
    } = {};
    try {
      parsed = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      return {
        ok: false,
        status: "unknown",
        httpStatus: res.status,
        raw: bodyText.slice(0, 500),
      };
    }
    return {
      ok: true,
      email: parsed.email ?? trimmed,
      expiresInMinutes: parsed.expires_in_minutes ?? null,
      message: parsed.message ?? null,
    };
  }

  if (res.status === 401) {
    return {
      ok: false,
      status: "not_attendee",
      httpStatus: res.status,
      raw: bodyText.slice(0, 500),
    };
  }
  if (res.status === 422) {
    return {
      ok: false,
      status: "validation_error",
      httpStatus: res.status,
      raw: bodyText.slice(0, 500),
    };
  }
  if (res.status === 429) {
    return {
      ok: false,
      status: "rate_limited",
      httpStatus: res.status,
      raw: bodyText.slice(0, 500),
    };
  }
  return {
    ok: false,
    status: "unknown",
    httpStatus: res.status,
    raw: bodyText.slice(0, 500),
  };
}

// ─── authenticateOTP ──────────────────────────────────────────────────────

export type AuthenticateOTPSuccess = {
  ok: true;
  accessToken: string;
  tokenType: string;
};

export type AuthenticateOTPFailureStatus =
  | "invalid_code" // 401 — wrong or expired code
  | "no_account" // 404 — email isn't in EdgeOS (e.g., they never signed up at demo.dev.edgeos.world)
  | "validation_error" // 422 — bad format (not 6 digits, bad email, etc.)
  | "rate_limited" // 429 — too many attempts
  | "network"
  | "unknown";

export type AuthenticateOTPFailure = {
  ok: false;
  status: AuthenticateOTPFailureStatus;
  httpStatus?: number;
  raw?: string;
};

export type AuthenticateOTPResult = AuthenticateOTPSuccess | AuthenticateOTPFailure;

const SIX_DIGITS = /^\d{6}$/;

export async function authenticateOTP(
  email: string,
  code: string,
  env: EdgeOSEnv = {}
): Promise<AuthenticateOTPResult> {
  const apiBase = env.apiBase ?? DEFAULT_API_BASE;

  const trimmedEmail = email.trim().toLowerCase();
  const trimmedCode = code.trim();

  if (!trimmedEmail || !trimmedEmail.includes("@")) {
    return { ok: false, status: "validation_error", raw: "email is empty or missing @" };
  }
  if (!SIX_DIGITS.test(trimmedCode)) {
    return {
      ok: false,
      status: "validation_error",
      raw: "code must be exactly 6 digits (server-side regex enforced)",
    };
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${apiBase}/api/v1/auth/user/authenticate`,
      {
        method: "POST",
        headers: buildHeaders({ contentType: "application/json", tenantId: env.tenantId }),
        body: JSON.stringify({ email: trimmedEmail, code: trimmedCode }),
        timeoutMs: env.timeoutMs,
      }
    );
  } catch (err) {
    return {
      ok: false,
      status: "network",
      raw: err instanceof Error ? err.message : String(err),
    };
  }

  const bodyText = await res.text().catch(() => "");

  if (res.ok) {
    let parsed: { access_token?: string; token_type?: string } = {};
    try {
      parsed = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      return { ok: false, status: "unknown", httpStatus: res.status, raw: bodyText.slice(0, 500) };
    }
    if (!parsed.access_token) {
      return { ok: false, status: "unknown", httpStatus: res.status, raw: "200 response missing access_token" };
    }
    return {
      ok: true,
      accessToken: parsed.access_token,
      tokenType: parsed.token_type ?? "bearer",
    };
  }

  if (res.status === 401) {
    return { ok: false, status: "invalid_code", httpStatus: res.status, raw: bodyText.slice(0, 500) };
  }
  // 404 = email isn't a registered EdgeOS user. Empirically confirmed
  // 2026-05-19 against api.dev.edgeos.world: bogus email returns
  // 404 {"detail":"User not found"}. Map to no_account so the caller can
  // surface the actionable "go sign up at demo.dev.edgeos.world" message
  // instead of a generic "unknown error".
  if (res.status === 404) {
    return { ok: false, status: "no_account", httpStatus: res.status, raw: bodyText.slice(0, 500) };
  }
  if (res.status === 422) {
    return { ok: false, status: "validation_error", httpStatus: res.status, raw: bodyText.slice(0, 500) };
  }
  if (res.status === 429) {
    return { ok: false, status: "rate_limited", httpStatus: res.status, raw: bodyText.slice(0, 500) };
  }
  return { ok: false, status: "unknown", httpStatus: res.status, raw: bodyText.slice(0, 500) };
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Build standard headers for an EdgeOS request.
 *
 * - `Content-Type` if `contentType` provided.
 * - `X-Tenant-Id` if `tenantId` provided (frontend pattern: send on every
 *   request, auth endpoints ignore harmlessly).
 * - `Authorization: Bearer ${bearer}` if `bearer` provided.
 */
export function buildHeaders(opts: {
  contentType?: string;
  tenantId?: string;
  bearer?: string;
}): Record<string, string> {
  const h: Record<string, string> = {};
  if (opts.contentType) h["Content-Type"] = opts.contentType;
  if (opts.tenantId) h["X-Tenant-Id"] = opts.tenantId;
  if (opts.bearer) h["Authorization"] = `Bearer ${opts.bearer}`;
  return h;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = NETWORK_TIMEOUT_MS, ...rest } = init;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs ?? NETWORK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Mask a bearer/access_token for log output. Returns "abc12345…(96 chars)"
 * so logs are scannable but the credential isn't leaked.
 */
export function maskToken(token: string): string {
  if (!token) return "(empty)";
  if (token.length <= 12) return "(short_token)";
  return `${token.slice(0, 8)}…(${token.length} chars)`;
}
