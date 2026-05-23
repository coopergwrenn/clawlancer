/**
 * POST /api/edge/personalize-agent
 *
 * Backs the Edge personalization progress screen that runs the first
 * time an Edge attendee lands on /dashboard after onboarding. Replaces
 * the generic Gmail-connect popup for `partner === "edge_city"` users.
 *
 * The endpoint fetches the user's SimpleFi /citizens profile (the Edge
 * attendee directory) + reads whether they've submitted an intent yet,
 * classifies the available data into a "tier", and returns the payload
 * the client needs to animate through 2-4 personalization steps with
 * the user's real data ("Founder at Wild West Bots", "@cooperwrenn", etc).
 *
 * THE GRACEFUL-DEGRADATION LADDER
 * ───────────────────────────────
 *
 * tier="full"     /citizens has name + (role OR organization) + (telegram OR x)
 *                 → 4 steps, ~4s experience, full data reveal
 * tier="partial"  /citizens has name and either role/org OR socials (not both)
 *                 → 3 steps, ~3s experience, what we have is shown
 * tier="minimal"  /citizens null/404/5xx OR only name with no other fields
 *                 → 2 steps, ~2s experience, generic village copy
 *
 * The user ALWAYS sees at least 2 steps and ALWAYS reaches "your agent
 * is ready." We never instant-skip or block on EdgeOS outages — the
 * "agent ready" moment is the magic, the data reveal is the bonus.
 *
 * hasIntent flag separately signals whether the user already submitted
 * an intent on /edge/intents. When true, copy adapts to acknowledge it
 * ("we know what you're looking for"). The intent TEXT itself is not
 * yet plumbed through — that's the follow-up commit (requires the
 * `last_intent_description` migration that's pending).
 *
 * FAILURE BEHAVIOR
 * ────────────────
 *
 * Every error collapses to tier="minimal" + a successful response. The
 * personalization moment ALWAYS happens. We never tell the user "no
 * we couldn't personalize you" — the worst case is a generic
 * "your village agent is ready" with no real data revealed. That's
 * still a magic moment for someone who just walked through 7 screens
 * of onboarding.
 *
 * SECURITY
 * ────────
 *
 * Session-protected via NextAuth (middleware enforces). Partner-gated
 * inline to `edge_city` — non-Edge users get 403 (defense in depth;
 * the dashboard's render gate is the primary).
 *
 * Rate limit: NONE intentionally. Idempotent + side-effect-free
 * (read-only against SimpleFi + DB; no writes from this endpoint
 * tonight). Cheap to call repeatedly.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  fetchCitizenProfile,
  type CitizenProfile,
} from "@/lib/index-signup-enrich";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export type PersonalizationTier = "full" | "partial" | "minimal";

export interface PersonalizeAgentResponse {
  /** Data tier — drives how many animation steps the client renders. */
  tier: PersonalizationTier;
  /** Display-ready first name (preferred from /citizens; fallback to
   *  email local-part). Always non-empty. */
  firstName: string;
  /** Display-ready full name. Always non-empty (defaults to firstName). */
  fullName: string;
  /** Optional role + organization for the "we learned about your work"
   *  step. Either may be null. */
  role: string | null;
  organization: string | null;
  /** Bare handles (no `@`) for the social-context step. */
  telegram: string | null;
  xUser: string | null;
  /** The user's Edge identity email — the one attendees recognize each
   *  other by (vs the OAuth email). Falls back to OAuth if not set. */
  edgeIdentity: string;
  /** True if the user submitted an intent on /edge/intents. Drives copy
   *  in the final reveal step ("we know what you're looking for"). */
  hasIntent: boolean;
}

interface FailureResponse {
  error: string;
}

/**
 * Pure classifier — given a CitizenProfile (or null), return the tier.
 * Exported for the test-hooks file if we ever add one.
 */
function classifyTier(citizen: CitizenProfile | null): PersonalizationTier {
  if (!citizen) return "minimal";
  const hasName = Boolean(
    (citizen.first_name && citizen.first_name.trim()) ||
      (citizen.last_name && citizen.last_name.trim()),
  );
  const hasWork = Boolean(
    (citizen.role && citizen.role.trim()) ||
      (citizen.organization && citizen.organization.trim()),
  );
  const hasSocial = Boolean(
    (citizen.telegram && citizen.telegram.trim()) ||
      (citizen.x_user && citizen.x_user.trim()),
  );

  // tier=full: name + work + social (the demo case)
  if (hasName && hasWork && hasSocial) return "full";
  // tier=partial: name + (work XOR social)
  if (hasName && (hasWork || hasSocial)) return "partial";
  // tier=minimal: just name, or nothing
  return "minimal";
}

function deriveFirstName(citizen: CitizenProfile | null, email: string): string {
  const fromCitizen = citizen?.first_name?.trim();
  if (fromCitizen) return fromCitizen;
  const local = email.split("@")[0] ?? email;
  // Title-case the local-part for "cooper@…" → "Cooper"
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function deriveFullName(citizen: CitizenProfile | null, firstName: string): string {
  const first = citizen?.first_name?.trim() ?? "";
  const last = citizen?.last_name?.trim() ?? "";
  const combined = [first, last].filter((s) => s.length > 0).join(" ");
  return combined.length > 0 ? combined : firstName;
}

function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^@/, "");
  return trimmed.length > 0 ? trimmed : null;
}

export async function POST() {
  // 1. Auth
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json<FailureResponse>(
      { error: "unauthenticated" },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  // 2. Load user + partner-gate + intent-status check.
  //    Single read covers what we need: email, edge_verified_email,
  //    partner (for the gate), name (fallback), and index_last_intent_at
  //    (for the hasIntent flag).
  const supabase = getSupabase();
  const { data: user, error: userErr } = await supabase
    .from("instaclaw_users")
    .select(
      "email, name, edge_verified_email, partner, index_last_intent_at",
    )
    .eq("id", userId)
    .single();

  if (userErr || !user) {
    logger.error("[edge-personalize] user lookup failed", {
      userIdPrefix: userId.slice(0, 8),
      err: userErr?.message,
    });
    return NextResponse.json<FailureResponse>(
      { error: "user_lookup_failed" },
      { status: 500 },
    );
  }

  if (user.partner !== "edge_city") {
    return NextResponse.json<FailureResponse>(
      { error: "not_edge_city" },
      { status: 403 },
    );
  }

  // 3. Best-effort /citizens fetch. Uses the existing helper from the
  //    Index-signup-enrichment commit (a4c523b4). Same 5s timeout, same
  //    null-on-failure semantics.
  //
  //    Lookup email: edge_verified_email (Edge directory identity) when
  //    present, fall back to the OAuth email. For a properly-tagged
  //    edge_city user the former should always be set; defensive
  //    fallback covers oddball state.
  const lookupEmail = user.edge_verified_email ?? user.email;
  const citizen = lookupEmail
    ? await fetchCitizenProfile(lookupEmail, userId.slice(0, 8))
    : null;

  // 4. Classify the tier + build the response payload.
  const tier = classifyTier(citizen);
  const firstName = deriveFirstName(citizen, user.email);
  const fullName = deriveFullName(citizen, firstName);
  const role = citizen?.role?.trim() || null;
  const organization = citizen?.organization?.trim() || null;
  const telegram = normalizeHandle(citizen?.telegram);
  const xUser = normalizeHandle(citizen?.x_user);
  const edgeIdentity = user.edge_verified_email ?? user.email;
  const hasIntent = user.index_last_intent_at !== null;

  // 5. Log the outcome — operator visibility into how often each tier
  //    fires in production. Useful for noticing if a /citizens regression
  //    drops everyone to tier=minimal.
  logger.info("[edge-personalize] composed response", {
    userIdPrefix: userId.slice(0, 8),
    tier,
    citizenFetched: citizen !== null,
    hasName: Boolean(fullName !== firstName), // first+last vs first only
    hasWork: Boolean(role || organization),
    hasSocial: Boolean(telegram || xUser),
    hasIntent,
  });

  const payload: PersonalizeAgentResponse = {
    tier,
    firstName,
    fullName,
    role,
    organization,
    telegram,
    xUser,
    edgeIdentity,
    hasIntent,
  };

  return NextResponse.json<PersonalizeAgentResponse>(payload, { status: 200 });
}
