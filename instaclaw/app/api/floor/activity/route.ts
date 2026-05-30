/**
 * GET /api/floor/activity — The Floor's owner-feed (MVP transport).
 *
 * Returns sanitized activity events for the LOGGED-IN user's agent. The client
 * polls this ~2s (PRD §10.1 fallback; Supabase Realtime is the v1 upgrade —
 * same event shape, different source).
 *
 * ── Keyset pagination (H1 fix, see docs/the-floor-build-notes.md) ───────────
 * Two modes:
 *   - FIRST LOAD (no `since`): return the NEWEST page, descending, then reverse
 *     to chronological. The client seeds "now" from the newest row without
 *     replaying history (the store's first-load guard).
 *   - INCREMENTAL (`since` + optional `sinceId`): return rows STRICTLY AFTER the
 *     composite (created_at, id) cursor, ascending, limited. Drains in order so
 *     NO event is ever skipped — even if more than a page arrives between polls.
 *     A missed event here would be a missed perk-up, which defeats the feature;
 *     keyset draining makes that impossible (worst case: a flood is delayed a
 *     few poll cycles, never lost).
 *
 * The SQL below MUST mirror `lib/floor/activity-window.ts:selectNewActivity`
 * (the pure model the overflow test exercises). Keep them in sync.
 *
 * Scope (PRD §13 default-private): OWNER view only — resolves the caller's own
 * VM via `auth()` + `getUserVm`; never takes a handle, never exposes another
 * user's activity. The public anonymized variant is separate (v1).
 *
 * Auth (Rule 13): session-protected via `auth()`. NOT in middleware
 * `selfAuthAPIs` — the middleware session check is the first line, `auth()` is
 * defense-in-depth.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { getUserVm } from "@/lib/get-user-vm";
import { logger } from "@/lib/logger";
import { sanitizeSince, sanitizeSinceId } from "@/lib/floor/activity-window";

// Page size. Keyset draining guarantees no skips regardless; this only bounds
// how many events a single poll folds. A turn's message_in is the oldest of its
// burst, so it's always in the first drained page → perk-up never lags.
const ACTIVITY_LIMIT = 100;

// Explicit safe projection — abstract activity only, no content columns.
const SAFE_COLUMNS =
  "id, created_at, kind, station, intensity, channel, tool_name";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  const vm = await getUserVm<{ id: string }>(supabase, session.user.id, {
    columns: "id",
  });
  if (!vm) {
    // No live office yet (pre-provision, or between assignments). Not an error
    // — the Floor renders an "office being set up" idle state for this case.
    return NextResponse.json({ vmId: null, activity: [] });
  }

  const since = sanitizeSince(req.nextUrl.searchParams.get("since"));
  const sinceId = sanitizeSinceId(req.nextUrl.searchParams.get("sinceId"));

  let activity:
    | Array<Record<string, unknown>>
    | null = null;
  let queryError: { message: string } | null = null;

  if (since) {
    // ── INCREMENTAL: strictly after the (created_at, id) keyset cursor ──
    let q = supabase
      .from("instaclaw_agent_activity")
      .select(SAFE_COLUMNS)
      .eq("vm_id", vm.id);

    if (sinceId) {
      // Composite keyset: created_at > since OR (created_at = since AND id > sinceId).
      // Bulletproof against same-instant collisions (the v1 proxy flood case).
      q = q.or(
        `created_at.gt.${since},and(created_at.eq.${since},id.gt.${sinceId})`,
      );
    } else {
      // No valid id tiebreak — plain time filter. Correct for MVP's low,
      // well-spaced event rate (collisions effectively impossible).
      q = q.gt("created_at", since);
    }

    const { data, error } = await q
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(ACTIVITY_LIMIT);
    // Already chronological (asc) — hand to the client as-is.
    activity = data ?? null;
    queryError = error;
  } else {
    // ── FIRST LOAD: newest page, descending, then reverse to chronological ──
    const { data, error } = await supabase
      .from("instaclaw_agent_activity")
      .select(SAFE_COLUMNS)
      .eq("vm_id", vm.id)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(ACTIVITY_LIMIT);
    activity = data ? data.slice().reverse() : null;
    queryError = error;
  }

  if (queryError) {
    logger.error("[/api/floor/activity] query failed", {
      route: "api/floor/activity",
      userId: session.user.id,
      vmId: vm.id,
      incremental: !!since,
      error: queryError.message,
    });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  return NextResponse.json({
    vmId: vm.id,
    serverTime: new Date().toISOString(),
    activity: activity ?? [],
  });
}
