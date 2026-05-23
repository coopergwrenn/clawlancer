/**
 * POST /api/edge/intents/skip
 *
 * Service-degradation escape hatch for /edge/intents. When Index Network's
 * /signup returns 403 (Yanek-side outage), /api/edge/express-intent's JIT
 * provision fails, the user sees "not_eligible" or "service_unavailable"
 * and is otherwise blocked from completing onboarding.
 *
 * This endpoint:
 *   1. Validates the user's session + edge_city partner gate
 *   2. Persists the queued intent description via structured logger.info
 *      (greppable in Vercel logs for back-fill when Index is restored)
 *   3. Sets `index_last_intent_at = NOW()` so the dashboard layout's
 *      mandatory-intent gate lets the user through
 *   4. Returns 200 — caller redirects to /dashboard
 *
 * Why structured-log persistence vs a new DB table:
 *   Adding a queue table requires a migration. Per CLAUDE.md Rule 56,
 *   migrations must be applied to prod BEFORE the file lands in
 *   /supabase/migrations/. This is a hotfix shipped 2026-05-22 late at
 *   night during an event-prep crunch — minimizing the deploy surface.
 *   Structured logs are durable (Vercel retains for 30 days, longer with
 *   Logflare export) and queryable by userId. When Index Network is
 *   restored, a one-shot script greps for "[edge-intent-skipped]" lines,
 *   parses the JSON, replays via createIndexIntent.
 *
 * Trade-off accepted: if the user later edits/replaces the intent before
 * the back-fill runs, we'll persist the LATEST version (this endpoint
 * fires each skip click). Fine for V1.
 *
 * Auth: NextAuth session. Partner gate enforced inline (same as
 * /api/edge/express-intent — defense in depth).
 *
 * Rate-limit: NONE intentionally. This is the escape from a broken
 * state — we don't want a rate limit to compound the user's bad
 * experience. Per-user spam is bounded by the gate semantics anyway
 * (one skip click marks index_last_intent_at; subsequent visits to
 * /edge/intents wouldn't show the form).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DESCRIPTION_MAX_CHARS = 500;

interface SkipRequest {
  /** The intent text the user typed before hitting the skip button.
   *  Optional — if the user skips before typing, we still let them
   *  through. */
  description?: unknown;
  /** Why the user is skipping. Operator-grade signal for log triage.
   *  Defaults to "user_initiated" when omitted. */
  reason?: unknown;
}

interface SkipResponseSuccess {
  ok: true;
  /** Tells the client whether their intent was queued for back-fill.
   *  False when no description was provided. */
  queued: boolean;
}

interface SkipResponseFailure {
  ok: false;
  reason:
    | "unauthenticated"
    | "not_edge_city"
    | "user_lookup_failed"
    | "db_write_failed"
    | "server_error";
}

type SkipResponse = SkipResponseSuccess | SkipResponseFailure;

export async function POST(req: NextRequest) {
  // 1. Auth
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json<SkipResponse>(
      { ok: false, reason: "unauthenticated" },
      { status: 401 },
    );
  }
  const userId = session.user.id;

  // 2. Parse body (lenient — skip endpoint should never refuse on shape).
  let body: SkipRequest = {};
  try {
    body = (await req.json()) as SkipRequest;
  } catch {
    // No body OR malformed JSON — treat as a no-description skip. The user
    // shouldn't be blocked because of a body-parse failure.
    body = {};
  }

  const description =
    typeof body.description === "string"
      ? body.description.trim().slice(0, DESCRIPTION_MAX_CHARS)
      : null;
  const reason =
    typeof body.reason === "string"
      ? body.reason.trim().slice(0, 80)
      : "user_initiated";

  // 3. Partner gate (defense in depth — the page-level gate at
  //    app/edge/intents/page.tsx is the primary).
  const supabase = getSupabase();
  const { data: user, error: userErr } = await supabase
    .from("instaclaw_users")
    .select("id, partner")
    .eq("id", userId)
    .single();

  if (userErr || !user) {
    logger.error("[edge-intent-skip] user lookup failed", {
      userIdPrefix: userId.slice(0, 8),
      err: userErr?.message,
    });
    return NextResponse.json<SkipResponse>(
      { ok: false, reason: "user_lookup_failed" },
      { status: 500 },
    );
  }
  if (user.partner !== "edge_city") {
    return NextResponse.json<SkipResponse>(
      { ok: false, reason: "not_edge_city" },
      { status: 403 },
    );
  }

  // 4. Persistent queue via structured log. Field names chosen for grep
  //    + back-fill script convenience. NEVER include PII beyond what the
  //    user explicitly typed (no email, no IP). The description IS the
  //    user's content — they explicitly want it queued.
  //
  //    Back-fill grep template:
  //      vercel logs --since 24h | grep '\[edge-intent-skipped\]'
  //      → parse the JSON-ish structured fields, replay via
  //        createIndexIntent with the recorded description.
  if (description && description.length >= 10) {
    logger.info("[edge-intent-skipped] queued for back-fill", {
      userId,
      userEmailHashPrefix: user.id.slice(0, 8), // for cross-reference
      description,
      descriptionLength: description.length,
      reason,
      timestamp: new Date().toISOString(),
    });
  } else {
    logger.info("[edge-intent-skipped] no description to queue", {
      userId,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  // 5. Mark the gate as satisfied. Same write the success path does, so
  //    the dashboard layout treats the user as having completed intent.
  const { error: updateErr } = await supabase
    .from("instaclaw_users")
    .update({ index_last_intent_at: new Date().toISOString() })
    .eq("id", userId);

  if (updateErr) {
    logger.error("[edge-intent-skip] index_last_intent_at write failed", {
      userIdPrefix: userId.slice(0, 8),
      err: updateErr.message,
    });
    return NextResponse.json<SkipResponse>(
      { ok: false, reason: "db_write_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json<SkipResponse>(
    { ok: true, queued: Boolean(description && description.length >= 10) },
    { status: 200 },
  );
}
