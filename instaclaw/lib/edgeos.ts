/**
 * EdgeOS attendee verification — thin wrapper used by the /edge/claim
 * ticket gate. Maps the categorized failure modes from
 * `lib/edgeos-auth.ts:requestOTP` into a uniform shape the gate route
 * can act on.
 *
 * Underlying primitive: POST `/api/v1/auth/user/login` on EdgeOS
 * (`api.edgeos.world` prod). EdgeOS returns:
 *   - 200 OK if the email is registered for any Edge popup → verified
 *   - 404 "User not found" if not registered → not_found
 *   - 422 if email is malformed → invalid_email
 *   - 429 if we hammer them → rate_limited
 *   - 5xx / network → degraded (caller decides whether to let through)
 *
 * Side-effect on 200: EdgeOS sends an OTP email to the user. They don't
 * have to use the code — our gate exchanges the 200 response for a signed
 * cookie + the user proceeds via Google/OpenAI OAuth on /connect — but
 * they'll see "Verify your EdgeOS sign-in" in their inbox. Treat that as
 * a soft confirmation: it's literally EdgeOS confirming the email is
 * registered. Acceptable UX for V1.
 *
 * Why we can't return the attendee's name in V1: the `/auth/user/login`
 * response only has `{message, email, expires_in_minutes}`. The
 * attendees-directory endpoint at api-citizen-portal.simplefi.tech has
 * names but redacts emails to `"*"` — so no email→name mapping is
 * possible with the keys we currently hold. The verified-state UX is
 * designed to be exclusive WITHOUT a name (it leans on the "Reserved
 * for the village." copy + the slow reveal). If Tule ships an
 * authenticated by-email lookup later we can light up personalization.
 *
 * Operator escape hatch: EDGE_VERIFIED_OVERRIDE_EMAILS env var. Comma-
 * separated, case-insensitive, trimmed. Any email in the list short-
 * circuits to `verified: true, degraded: false` BEFORE any network
 * call. Used for hand-validated cases (Tule, sponsors, Cooper's test
 * accounts, etc.).
 */
import { requestOTP } from "./edgeos-auth";
import { logger } from "./logger";

export interface VerifyAttendeeResult {
  /**
   * Authoritative pass/fail decision the gate routes on. `true` means
   * EdgeOS confirmed the email is a registered attendee — OR the
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
   * Set to `true` when `verified === true` was returned because EdgeOS
   * was unreachable (5xx, timeout) rather than because we confirmed the
   * email. The route logs this for monitoring — we don't want to ship
   * a regression where EdgeOS being down silently bypasses every gate.
   */
  degraded?: boolean;
}

const OVERRIDE_ENV_VAR = "EDGE_VERIFIED_OVERRIDE_EMAILS";

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
      .filter((s) => s.length > 0)
  );
}

/**
 * Verify that an email is registered for Edge Esmeralda 2026.
 *
 * Returns `{ verified: true }` if EdgeOS confirms registration, OR if
 * the email is in the operator override list, OR if EdgeOS was
 * unreachable but the caller should let the user through (degraded).
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

  // Operator escape hatch — bypass EdgeOS entirely.
  const overrides = getOverrideSet();
  if (overrides.has(trimmed)) {
    logger.info("edgeos.verifyAttendeeByEmail: override match", {
      route: "lib/edgeos",
      email: trimmed,
    });
    return { verified: true };
  }

  // Hit EdgeOS via the audited OTP-login primitive. requestOTP handles:
  //   - HTTPS to api.edgeos.world
  //   - 15s default timeout
  //   - Network error categorization
  //   - 422/404/429 categorization
  const result = await requestOTP(trimmed);

  if (result.ok) {
    return { verified: true };
  }

  // Map requestOTP's failure statuses into our verification shape.
  switch (result.status) {
    case "no_account":
      return { verified: false, reason: "not_found" };
    case "validation_error":
      return { verified: false, reason: "invalid_email" };
    case "rate_limited":
      return { verified: false, reason: "rate_limited" };
    case "network":
    case "unknown":
      // EdgeOS is down or returning unexpected shapes. Let the user
      // through so a real attendee isn't blocked by a partner outage,
      // but flag degraded so the route can log + alert.
      logger.warn("edgeos.verifyAttendeeByEmail: degraded (api unavailable)", {
        route: "lib/edgeos",
        emailDomain: trimmed.split("@")[1] ?? "?",
        edgeosStatus: result.status,
        edgeosHttpStatus: result.httpStatus,
      });
      return { verified: true, degraded: true };
    default:
      return { verified: false, reason: "api_error" };
  }
}

/**
 * Test-only helper to override the EdgeOS call. Tests inject a fake
 * `requestOTP` so they can exercise every branch without hitting the
 * real EdgeOS sandbox. Production code never calls this — the public
 * surface is just `verifyAttendeeByEmail`.
 */
export const __testHooks = {
  /** Inspect the parsed override set without hitting the real env. */
  getOverrideSet,
};
