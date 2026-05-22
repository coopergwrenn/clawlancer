/**
 * EdgeOS attendee verification — thin wrapper used by the /edge/claim
 * ticket gate.
 *
 * ── Two endpoints, two purposes (2026-05-22 three-auth-paths refactor) ──
 *
 * SILENT VERIFY (default, used by /api/edge/verify-ticket):
 *   GET https://api-citizen-portal.simplefi.tech/citizens/email/{email}
 *   Auth: Authorization: Bearer $EDGEOS_BEARER_TOKEN
 *   Returns: 200 with full citizen profile (firstName, telegram, role, etc.)
 *            OR 404 "Citizen not found"
 *   Side effects: NONE (no OTP email sent)
 *   Use case: page-load-time check on /edge/claim. User enters email, we
 *             silently confirm they're an Edge person, then show the auth-
 *             choice screen with their first name personalized.
 *
 * OTP-LOGIN (only fired when user picks the Email-code auth path):
 *   POST https://api.edgeos.world/api/v1/auth/human/third-party/login
 *   Auth: X-Third-Party-Api-Key: $EDGEOS_THIRD_PARTY_API_KEY
 *   Returns: 200 with OTP email sent OR 401 if not attendee
 *   Side effects: OTP email sent to the user's inbox
 *   Use case: ONLY for the Email-OTP path. User entered the silent verify,
 *             picked Email code, and now needs an actual code to enter.
 *   Implementation: `requestThirdPartyLogin` in lib/edgeos-auth.ts.
 *
 * ── Why two endpoints (the Timour problem) ──
 *
 * Pre-refactor, /api/edge/verify-ticket fired the OTP-login endpoint as the
 * silent-check primitive. That meant EVERY email entry sent an OTP email
 * even though the user might pick Google or ChatGPT auth and never need it.
 * Timour caught this on the 2026-05-22 call: "people are just gonna get
 * confused because they got a code, there's nowhere to put it." The
 * /citizens endpoint solves this — it's read-only, returns the citizen
 * profile without firing any email, and we already have the auth token.
 *
 * Bonus: /citizens returns NAME + TELEGRAM HANDLE for the user, which
 * lets us personalize the verified state ("Welcome back, Cooper") AND
 * prefill the Telegram handle on /connect.
 *
 * Operator escape hatch: EDGE_VERIFIED_OVERRIDE_EMAILS env var. Comma-
 * separated, case-insensitive, trimmed. Any email in the list short-
 * circuits to `verified: true` BEFORE any network call. Used for hand-
 * validated cases (sponsors, Cooper's test accounts, etc.). Override
 * emails get `firstName` defaulted to the email's local-part for the
 * personalization slot.
 */
import { requestThirdPartyLogin } from "./edgeos-auth";
import { logger } from "./logger";

/**
 * Citizen profile returned by SimpleFi's /citizens/email/{email} endpoint.
 * We expose the fields the frontend needs for personalization +
 * downstream account linking. Other fields (created_at, picture_url, etc.)
 * are intentionally NOT plumbed through — keep the surface minimal.
 */
export interface EdgeCitizen {
  /** Canonical email — may differ from the lookup email if the lookup
   * matched a secondary_email or with case normalization. Always lowercased. */
  email: string;
  /** First name for "Welcome back, {firstName}" personalization. */
  firstName: string | null;
  /** Last name; rarely shown directly but useful for downstream user
   * profile init. */
  lastName: string | null;
  /** Telegram @handle without the @. Prefilled on /connect to save the
   * user a typing step. May be null (user didn't register a Telegram). */
  telegram: string | null;
  /** Whether SimpleFi has validated the email. We don't gate on this —
   * we trust EdgeOS to have done its own validation — but pass it
   * through for logging. */
  emailValidated: boolean;
}

export interface VerifyAttendeeResult {
  /**
   * Authoritative pass/fail decision the gate routes on. `true` means
   * SimpleFi confirmed the email is a known Edge citizen — OR the
   * verifier degraded gracefully (5xx/network) and chose to let the
   * user through. `degraded` distinguishes the two cases for logging.
   */
  verified: boolean;

  /** Non-blocking explanation when `verified === false`. */
  reason?:
    | "not_found"
    | "invalid_email"
    | "rate_limited"
    | "api_error"
    | "config_missing";

  /**
   * Set to `true` when `verified === true` was returned because SimpleFi
   * was unreachable (5xx, timeout) rather than because we confirmed the
   * email. The route logs this for monitoring — we don't want to ship
   * a regression where SimpleFi being down silently bypasses every gate.
   */
  degraded?: boolean;

  /**
   * Full citizen profile from SimpleFi. Present when `verified === true`
   * AND the lookup hit a real citizen (NOT present on degraded fail-open
   * or override matches without a real lookup). Used by the frontend
   * for personalization ("Welcome back, Cooper") and by /connect for
   * Telegram-handle prefill.
   */
  citizen?: EdgeCitizen;
}

const OVERRIDE_ENV_VAR = "EDGE_VERIFIED_OVERRIDE_EMAILS";
const SIMPLEFI_BASE = "https://api-citizen-portal.simplefi.tech";

/**
 * Parse the comma-separated override list. Trimmed + lower-cased so the
 * Set's `.has()` is case-insensitive.
 */
function getOverrideSet(): Set<string> {
  const raw = process.env[OVERRIDE_ENV_VAR];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/**
 * Verify that an email is a known Edge citizen (silent, no OTP fired).
 *
 * Returns `{ verified: true, citizen? }` if SimpleFi confirms the email,
 * OR if the email is in the operator override list, OR if SimpleFi was
 * unreachable but the caller should let the user through (degraded).
 *
 * The `citizen` field is populated when we got a real lookup hit and
 * carries the user's first name + telegram handle for personalization.
 *
 * Returns `{ verified: false, reason }` for the negative cases the
 * caller should surface as a retryable error UI.
 */
export async function verifyAttendeeByEmail(
  email: string,
): Promise<VerifyAttendeeResult> {
  const trimmed = email.trim().toLowerCase();

  if (!trimmed || !trimmed.includes("@")) {
    return { verified: false, reason: "invalid_email" };
  }

  // Operator escape hatch — bypass SimpleFi entirely. Override matches
  // skip the network call; we synthesize a minimal citizen object using
  // the email's local-part as the "first name" so personalization still
  // renders something reasonable ("Welcome back, cooper").
  const overrides = getOverrideSet();
  if (overrides.has(trimmed)) {
    logger.info("edgeos.verifyAttendeeByEmail: override match", {
      route: "lib/edgeos",
      email: trimmed,
    });
    const localPart = trimmed.split("@")[0] ?? trimmed;
    return {
      verified: true,
      citizen: {
        email: trimmed,
        firstName: localPart.charAt(0).toUpperCase() + localPart.slice(1),
        lastName: null,
        telegram: null,
        emailValidated: true,
      },
    };
  }

  // Bearer-token presence check. If unset, we can't call SimpleFi at all
  // — fail-open with degraded so the launch isn't blocked on operator
  // misconfiguration. Loud-log so the gap is caught in Vercel logs.
  const bearer = process.env.EDGEOS_BEARER_TOKEN;
  if (!bearer) {
    logger.error(
      "edgeos.verifyAttendeeByEmail: EDGEOS_BEARER_TOKEN not set — failing open",
      {
        route: "lib/edgeos",
        emailDomain: trimmed.split("@")[1] ?? "?",
      },
    );
    return { verified: true, degraded: true };
  }

  // Silent check via SimpleFi /citizens/email/{email}.
  //
  // Encode the email path segment (handles `+aliases`, special chars).
  // We don't worry about path traversal — encodeURIComponent escapes `/`
  // and `..` reliably.
  const url = `${SIMPLEFI_BASE}/citizens/email/${encodeURIComponent(trimmed)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
      },
      // 10s ceiling — /citizens typically responds in <500ms; this protects
      // against SimpleFi hanging during launch hour. Above 10s we surface
      // as degraded.
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Network error OR AbortSignal timeout. Degraded fail-open per Cooper
    // directive 2026-05-22: better to let through a few non-attendees
    // during a SimpleFi outage than to block every real attendee.
    logger.warn(
      "edgeos.verifyAttendeeByEmail: network error — failing open",
      {
        route: "lib/edgeos",
        emailDomain: trimmed.split("@")[1] ?? "?",
        err: err instanceof Error ? err.message : String(err),
      },
    );
    return { verified: true, degraded: true };
  }

  if (res.status === 200) {
    let body: {
      primary_email?: string;
      first_name?: string;
      last_name?: string;
      telegram?: string;
      email_validated?: boolean;
    };
    try {
      body = await res.json();
    } catch {
      logger.warn(
        "edgeos.verifyAttendeeByEmail: 200 with malformed JSON — failing open",
        { route: "lib/edgeos", emailDomain: trimmed.split("@")[1] ?? "?" },
      );
      return { verified: true, degraded: true };
    }

    const citizen: EdgeCitizen = {
      email: (body.primary_email ?? trimmed).toLowerCase(),
      firstName: body.first_name ?? null,
      lastName: body.last_name ?? null,
      telegram: body.telegram ?? null,
      emailValidated: Boolean(body.email_validated),
    };

    return { verified: true, citizen };
  }

  if (res.status === 404) {
    return { verified: false, reason: "not_found" };
  }

  if (res.status === 401 || res.status === 403) {
    // Our bearer is invalid/expired. This is an operator-config bug —
    // log loud, fail-open so we don't block real attendees on it.
    logger.error(
      "edgeos.verifyAttendeeByEmail: SimpleFi rejected our bearer — failing open",
      {
        route: "lib/edgeos",
        emailDomain: trimmed.split("@")[1] ?? "?",
        httpStatus: res.status,
      },
    );
    return { verified: true, degraded: true };
  }

  if (res.status === 422) {
    // SimpleFi rejected the email shape — surface as invalid_email so
    // the user retries with a corrected value. Doesn't fire degraded
    // (the request itself was malformed; SimpleFi is fine).
    return { verified: false, reason: "invalid_email" };
  }

  if (res.status === 429) {
    return { verified: false, reason: "rate_limited" };
  }

  // 5xx / unknown — SimpleFi is degraded. Fail-open.
  logger.warn(
    "edgeos.verifyAttendeeByEmail: SimpleFi unexpected status — failing open",
    {
      route: "lib/edgeos",
      emailDomain: trimmed.split("@")[1] ?? "?",
      httpStatus: res.status,
    },
  );
  return { verified: true, degraded: true };
}

/**
 * Fire an OTP login email to a verified attendee — ONLY used by the
 * Email-code auth path on /edge/claim.
 *
 * Preconditions: caller MUST have already passed `verifyAttendeeByEmail`
 * (silent /citizens check). This function trusts that the email is a
 * real attendee; it doesn't re-verify against /citizens. The third-party-
 * login endpoint will return 401 for non-attendees but we shouldn't
 * waste an EdgeOS call on emails we already know aren't registered.
 *
 * Returns:
 *   { ok: true } when EdgeOS confirmed the OTP was queued
 *   { ok: false, reason }  for retryable failures the caller can surface
 *
 * Implementation note: this is a thin wrapper around
 * `requestThirdPartyLogin` in lib/edgeos-auth.ts. Kept as a separate
 * helper so the call sites are semantically clear ("we're firing an
 * OTP for the email auth path" vs "we're doing a silent check").
 */
export type RequestEmailLoginOtpResult =
  | { ok: true; expiresInMinutes: number | null }
  | {
      ok: false;
      reason: "not_attendee" | "validation_error" | "rate_limited" | "api_error";
    };

export async function requestEmailLoginOtp(
  email: string,
): Promise<RequestEmailLoginOtpResult> {
  const result = await requestThirdPartyLogin(email);

  if (result.ok) {
    return { ok: true, expiresInMinutes: result.expiresInMinutes };
  }

  switch (result.status) {
    case "not_attendee":
      return { ok: false, reason: "not_attendee" };
    case "validation_error":
      return { ok: false, reason: "validation_error" };
    case "rate_limited":
      return { ok: false, reason: "rate_limited" };
    case "config_error":
      logger.error(
        "edgeos.requestEmailLoginOtp: EDGEOS_THIRD_PARTY_API_KEY not set",
        { route: "lib/edgeos" },
      );
      return { ok: false, reason: "api_error" };
    case "network":
    case "unknown":
      logger.warn("edgeos.requestEmailLoginOtp: EdgeOS unreachable", {
        route: "lib/edgeos",
        edgeosStatus: result.status,
        edgeosHttpStatus: result.httpStatus,
      });
      return { ok: false, reason: "api_error" };
    default:
      return { ok: false, reason: "api_error" };
  }
}

/**
 * Test-only helper exposing internals for the synthetic verifier test.
 * Production code never calls this — the public surface is
 * `verifyAttendeeByEmail` + `requestEmailLoginOtp`.
 */
export const __testHooks = {
  /** Inspect the parsed override set without hitting the real env. */
  getOverrideSet,
};
