/**
 * Index Network /signup body enrichment via SimpleFi /citizens.
 *
 * BACKGROUND
 * ──────────
 *
 * Yanek's Index Network intent-extraction NLP runs the user's submitted
 * intent against the user's PROFILE (built server-side from the signup
 * payload + any social URLs Yanek's system can scrape). Pre-fix, our
 * /signup call sent only `{email, name}` — frequently `{email}` alone
 * when the local user row had no name — leaving Yanek's profile builder
 * with almost no signal to work against. The NLP responded with:
 *
 *   {"success":false,"error":"No actionable intent was extracted (no
 *    intents extracted). Please retry with a more specific goal (what
 *    kind, what for, and/or timeframe), or ask the user to clarify."}
 *
 * for BOTH substantive intents AND pure gibberish. Yanek confirmed
 * (2026-05-23 Telegram): "not a vocab list, purely llm driven against
 * your profile" + "we are handling the profile part" + "it is
 * automatically generated via social urls etc."
 *
 * FIX SHAPE
 * ─────────
 *
 * Re-fetch the user's /citizens profile from SimpleFi (the Edge
 * attendee directory) at signup time and enrich the body with:
 *
 *   - name:    first_name + " " + last_name from /citizens (vs the
 *              instaclaw_users.name which is often the OAuth-derived
 *              short form like "Shelp")
 *   - bio:     role + " at " + organization (composed defensively for
 *              partial data)
 *   - socials: telegram + x_user (Yanek's profile builder follows the
 *              social URLs to scrape additional context)
 *   - email:   PREFER user.edge_verified_email when set (the Edge
 *              identity, the one attendees recognize each other by)
 *              vs the OAuth email (often a personal account different
 *              from the Edge ticket email — see 2026-05-22
 *              Cooper-shelpinc incident: real Edge ticket on
 *              coopergrantwrenn@gmail.com, ChatGPT account on
 *              shelpinc@gmail.com)
 *
 * /citizens is the SimpleFi citizen-portal endpoint we already use for
 * /api/edge/verify-ticket (silent attendee verification). Same auth
 * (EDGEOS_BEARER_TOKEN). Same trust model. No new env var needed.
 *
 * FAILURE BEHAVIOR
 * ────────────────
 *
 * Best-effort. Every error path falls through to the minimal-body
 * signup (just email + name from the DB row). We never block signup
 * on /citizens being slow or down — the user's intent flow MUST still
 * complete. The trade-off: a /citizens outage at signup time means
 * that user's Index profile is impoverished forever (Yanek's profile
 * builder runs once at signup; we never re-call /signup for an existing
 * user). Acceptable for tonight's launch window; a P1 follow-up would
 * be either (a) cache the /citizens response to the user row + replay
 * via a "re-enrich profile" reconciler step, or (b) refetch + send
 * `update_profile` to Index when their data changes.
 *
 * IDEMPOTENCY GUARANTEE
 * ─────────────────────
 *
 * This helper does NO writes. It returns a typed payload the caller
 * passes to `callIndexSignup`. Safe to call repeatedly with the same
 * input (returns the same output). No state, no DB writes, no logging
 * side effects in the success path. Warn-logs only on failure for
 * operator triage.
 */
import { logger } from "./logger";
import type { IndexSignupRequest } from "./index-network-client";

/**
 * Input shape the helper needs. Caller (JIT or reconciler) gathers
 * these from instaclaw_users + computes the user_id slice for logging.
 */
export interface BuildEnrichedSignupBodyArgs {
  /** The OAuth-account email — used as `email` fallback if no Edge
   *  identity is on file. */
  email: string;
  /** The Edge ticket / SimpleFi identity. If set, preferred as the
   *  primary signup email. Null for non-Edge users (other partners). */
  edgeVerifiedEmail: string | null;
  /** Cached name on instaclaw_users — fallback when /citizens lookup
   *  fails or returns empty name fields. */
  name: string | null;
  /** Cached telegram handle on instaclaw_users — fallback when
   *  /citizens lookup fails or returns null telegram. */
  telegramHandle: string | null;
  /** For log correlation only — 8-char prefix of instaclaw_users.id.
   *  Never logged in full per Rule 53 / GDPR. */
  userIdPrefix: string;
}

/**
 * SimpleFi /citizens/email/{email} response shape we care about.
 *
 * Exported so other callers (e.g. configureOpenClaw's planned agent-
 * personalization injection into SOUL.md) can share the type without
 * redefining it. Yanek's profile builder will pull these fields too;
 * keeping the type centralized prevents drift between the signup-
 * enrichment path and the agent-bootstrap path.
 */
export interface CitizenProfile {
  primary_email?: string | null;
  secondary_email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  telegram?: string | null;
  x_user?: string | null;
  role?: string | null;
  organization?: string | null;
  picture_url?: string | null;
  gender?: string | null;
}

const CITIZEN_TIMEOUT_MS = 5_000;
const SIMPLEFI_BASE = "https://api-citizen-portal.simplefi.tech";

/**
 * Strip a leading "@" or "https://*.tld/" prefix from a handle.
 *
 * /citizens returns plain handles ("cooperwrenn") so this is defense in
 * depth for fallback values from instaclaw_users.telegram_handle which
 * MAY have been set by older code paths that didn't normalize.
 */
function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Strip leading @
  let h = trimmed.replace(/^@/, "");
  // Strip telegram/X URL prefixes if a user accidentally pasted a URL
  h = h
    .replace(/^https?:\/\/(?:www\.)?t\.me\//, "")
    .replace(/^https?:\/\/(?:www\.)?x\.com\//, "")
    .replace(/^https?:\/\/(?:www\.)?twitter\.com\//, "");
  // Trim trailing slash if present after URL strip
  h = h.replace(/\/+$/, "").trim();
  return h.length > 0 ? h : null;
}

/**
 * Compose a bio string from role + organization. Both optional.
 * Returns undefined when neither yields a usable value.
 */
function composeBio(
  role: string | null | undefined,
  organization: string | null | undefined,
): string | undefined {
  const r = (role ?? "").trim();
  const o = (organization ?? "").trim();
  if (r && o) return `${r} at ${o}`;
  if (r) return r;
  if (o) return o;
  return undefined;
}

/**
 * Compose a full-name string. Trims and handles partial data; returns
 * undefined when neither name field has content (caller falls back to
 * DB-side name then to email-local-part).
 */
function composeName(
  first: string | null | undefined,
  last: string | null | undefined,
): string | undefined {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  const combined = [f, l].filter((s) => s.length > 0).join(" ");
  return combined.length > 0 ? combined : undefined;
}

/**
 * Best-effort SimpleFi /citizens lookup. Returns null on any failure
 * (404, 5xx, network timeout, malformed JSON, missing bearer env).
 * Caller treats null as "no enrichment available; use minimal body."
 *
 * Exported so configureOpenClaw (planned agent-bootstrap personalization
 * follow-up per Cooper 2026-05-23 directive) can reuse the same fetch
 * + parse path without duplicating retry/timeout/error semantics.
 */
export async function fetchCitizenProfile(
  email: string,
  userIdPrefix: string,
): Promise<CitizenProfile | null> {
  const bearer = process.env.EDGEOS_BEARER_TOKEN;
  if (!bearer) {
    logger.warn("[signup-enrich] EDGEOS_BEARER_TOKEN unset; skipping enrichment", {
      userIdPrefix,
    });
    return null;
  }

  const url = `${SIMPLEFI_BASE}/citizens/email/${encodeURIComponent(email)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearer}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(CITIZEN_TIMEOUT_MS),
    });
    if (res.status !== 200) {
      // 404 (not in directory) is benign for non-Edge attendees, debug-
      // log only. 4xx other than 404 / 5xx warrant a warn.
      if (res.status === 404) {
        return null;
      }
      logger.warn("[signup-enrich] /citizens non-200 response", {
        userIdPrefix,
        httpStatus: res.status,
        emailDomain: email.split("@")[1] ?? "?",
      });
      return null;
    }
    return (await res.json()) as CitizenProfile;
  } catch (err) {
    // Network timeout, fetch abort, malformed JSON — all collapse to
    // null. Log for diagnostic visibility.
    logger.warn("[signup-enrich] /citizens fetch failed (best-effort)", {
      userIdPrefix,
      err: err instanceof Error ? err.message.slice(0, 150) : String(err).slice(0, 150),
    });
    return null;
  }
}

/**
 * Build the enriched /signup body. Always returns a valid
 * IndexSignupRequest — never throws. The `email` field is guaranteed
 * to be set (preferring edge_verified_email, falling back to OAuth
 * email). Other fields are populated when /citizens enrichment
 * succeeds, otherwise omitted.
 *
 * Caller passes the returned body to `callIndexSignup`.
 *
 * Enrichment precedence (per-field):
 *
 *   email:    edge_verified_email ?? user.email
 *   name:     /citizens first+last ?? user.name (no further fallback;
 *             Index accepts no `name` field, just won't include in
 *             profile)
 *   bio:      /citizens role+organization ?? undefined
 *   socials:  union of /citizens.telegram + user.telegram_handle
 *             (de-duped) + /citizens.x_user
 *
 * Lookup email for /citizens: prefer edge_verified_email (the Edge
 * directory identity) over OAuth email — SimpleFi's directory is
 * keyed by Edge identity, not OAuth identity. A user whose OAuth
 * email isn't in SimpleFi would 404 there even though they ARE in
 * the directory under their Edge email.
 */
export async function buildEnrichedSignupBody(
  args: BuildEnrichedSignupBodyArgs & {
    /**
     * Optional pre-fetched citizen profile. When set, skip the /citizens
     * fetch and use the supplied data — saves the caller a round-trip
     * when they've already fetched it for another purpose (e.g.,
     * configureOpenClaw's planned agent-bootstrap personalization).
     * Pass `undefined` (or omit) to trigger an internal fetch.
     */
    prefetchedCitizen?: CitizenProfile | null;
  },
): Promise<IndexSignupRequest> {
  const {
    email,
    edgeVerifiedEmail,
    name,
    telegramHandle,
    userIdPrefix,
    prefetchedCitizen,
  } = args;

  // The Edge identity (when present) is the lookup key for /citizens
  // AND the preferred Index identity (so attendees see each other by
  // the email they registered with for the event, not by a personal
  // OAuth address).
  const lookupEmail = edgeVerifiedEmail ?? email;

  // 1. Best-effort /citizens enrichment. Falls through to null on any
  //    failure — caller proceeds with minimal body. Skip the fetch
  //    entirely when caller pre-fetched (avoids the double-fetch case
  //    in shared-context flows).
  const citizen =
    prefetchedCitizen !== undefined
      ? prefetchedCitizen
      : await fetchCitizenProfile(lookupEmail, userIdPrefix);

  // 2. Compose enriched fields.
  const enrichedName = composeName(citizen?.first_name, citizen?.last_name);
  const enrichedBio = composeBio(citizen?.role, citizen?.organization);

  // 3. Build socials union. Prefer /citizens telegram (fresher) over
  //    DB cache. Dedupe — if both sources have the same telegram, only
  //    include once. Strip leading @ / URL prefixes defensively.
  const socials: Array<{ label: string; value: string }> = [];
  const seenLabels = new Set<string>();

  const tg = normalizeHandle(citizen?.telegram ?? telegramHandle);
  if (tg && !seenLabels.has("telegram")) {
    socials.push({ label: "telegram", value: tg });
    seenLabels.add("telegram");
  }

  const x = normalizeHandle(citizen?.x_user);
  if (x && !seenLabels.has("x")) {
    socials.push({ label: "x", value: x });
    seenLabels.add("x");
  }

  // 4. Final body. Email is REQUIRED (always present). Other fields
  //    omitted (not undefined-stringified) so Yanek's API doesn't
  //    receive `null` keys.
  const body: IndexSignupRequest = {
    email: lookupEmail,
  };
  if (enrichedName || name) {
    body.name = enrichedName ?? name ?? undefined;
  }
  if (enrichedBio) {
    body.bio = enrichedBio;
  }
  if (socials.length > 0) {
    body.socials = socials;
  }

  // 5. Log the enrichment outcome for ops visibility. We DON'T log the
  //    full body (per Rule 53 — user PII shouldn't land in structured
  //    logs unless necessary). We log just the SHAPE: how many fields
  //    landed + whether /citizens enriched anything.
  logger.info("[signup-enrich] built signup body", {
    userIdPrefix,
    emailIsEdgeIdentity: lookupEmail === edgeVerifiedEmail,
    citizenEnriched: citizen !== null,
    hasName: Boolean(body.name),
    hasBio: Boolean(body.bio),
    socialsCount: socials.length,
    socialLabels: socials.map((s) => s.label).join(",") || "(none)",
  });

  return body;
}

/**
 * Test-only export for the helper's pure functions. Used by the
 * verifier test (if added later) to exercise the composition logic
 * without hitting /citizens or /signup.
 */
export const __testHooks = {
  normalizeHandle,
  composeBio,
  composeName,
};
