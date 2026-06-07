/**
 * GET /api/agent-economy/state
 *
 * Dashboard summary of the logged-in user's Frontier economy: a rolling-24h
 * earn/spend/net, lifetime totals, reputation, active-offering count, and the
 * most recent transactions. Read-only; session-authed.
 *
 * Aggregation notes (deliberate v1 choices, see PRD §9 / §6):
 *  - Window is ROLLING 24h, not calendar-"today". A calendar day needs the
 *    user's timezone and a midnight boundary — a class of off-by-a-day bug that
 *    bites exactly at 3am UTC for US users. Rolling 24h is tz-independent and
 *    has no DST/midnight edge. Calendar-today-in-tz is a later polish via a
 *    Postgres RPC (date_trunc('day', now() AT TIME ZONE tz)).
 *  - Totals are computed LIVE from a single bounded fetch (most-recent 500),
 *    not from the frontier_lifetime_* rollup columns. Those columns are
 *    maintained by a nightly cron that doesn't exist yet — reading them now
 *    would show $0 lifetime next to live 24h numbers (looks broken). Live-sum
 *    is exact at Phase-1A volume; `lifetime.truncated` flags the (currently
 *    unreachable) cap so the dashboard can fall back to the rollup columns once
 *    the cron lands and volume grows past the cap.
 *  - Money totals count status='settled' only. 'refunded'/'failed'/'pending'/
 *    'disputed' rows appear in `recent` (activity feed) but not in earn/spend.
 *
 * Auth: NextAuth session. Maps session.user.id → the user's assigned VM.
 *
 * PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §9.1, §10.1
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { loadVmStanding } from "@/lib/frontier-standing-db";
import type { FrontierTier } from "@/lib/frontier-policy";
import { aggregateWindows, mapRecentTxn, type StateTxnRow } from "@/lib/frontier-economy-readpath";

export const dynamic = "force-dynamic";

// Most-recent rows scanned for live aggregation. Far above Phase-1A per-VM
// volume; when a VM exceeds this, `lifetime.truncated` is true and the dashboard
// should prefer the (cron-maintained) rollup columns.
const SCAN_LIMIT = 500;
const RECENT_COUNT = 10;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // user → VM. A user without an assigned VM has no economy yet.
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, tier")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
  }
  const vmId = vm.id as string;

  // Single bounded fetch drives every number below.
  const { data: txns, error: txnErr } = await supabase
    .from("frontier_transactions")
    .select(
      "id, rail, direction, amount_usdc, protocol_fee_usdc, status, counterparty_address, counterparty_vm_id, response_summary, tx_hash, created_at, settled_at, metadata",
    )
    .eq("vm_id", vmId)
    .order("created_at", { ascending: false })
    .limit(SCAN_LIMIT);

  if (txnErr) {
    console.error("[/api/agent-economy/state] transaction fetch failed:", txnErr);
    return NextResponse.json({ error: "failed to load economy state" }, { status: 500 });
  }

  const rows = (txns ?? []) as StateTxnRow[];

  // Rolling-24h + lifetime earn/spend/net (settled-only). hasTrackRecord gates
  // whether reputation is surfaced (a brand-new agent stays null).
  const { window_24h, lifetime, hasTrackRecord } = aggregateWindows(rows, Date.now(), SCAN_LIMIT);

  // Live credit standing — the SAME 300-850 score the authorize gate stamps into
  // each decision's score_at_authorize (lib/frontier-standing-db.loadVmStanding,
  // shared one-source-of-truth with the gate), so the Standing surfaces match the
  // feed instead of the never-written frontier_reputation_score rollup column.
  // Surfaced only once the agent has a settled track record; a brand-new agent
  // stays null so the crafted empty / first-run Standing copy is preserved.
  // Tolerant of a ledger-read failure (degrade to null; never break the page).
  const TIERS: readonly FrontierTier[] = ["starter", "pro", "power"];
  const tier = (TIERS as readonly string[]).includes(String(vm.tier ?? "").toLowerCase())
    ? (String(vm.tier).toLowerCase() as FrontierTier)
    : "starter";
  let reputationScore: number | null = null;
  if (hasTrackRecord) {
    try {
      const { standing } = await loadVmStanding(supabase, {
        vmId,
        ownerId: session.user.id,
        tier,
        nowMs: Date.now(),
      });
      reputationScore = standing.score;
    } catch (e) {
      console.error("[/api/agent-economy/state] standing read failed:", e);
      reputationScore = null;
    }
  }

  // Active offerings — cheap count.
  const { count: offeringCount } = await supabase
    .from("frontier_offerings")
    .select("id", { count: "exact", head: true })
    .eq("vm_id", vmId)
    .eq("active", true);

  // Each row → an activity-feed decision (decision-context lifted from metadata).
  const recent = rows.slice(0, RECENT_COUNT).map(mapRecentTxn);

  return NextResponse.json({
    window_24h,
    lifetime,
    reputation_score: reputationScore,
    active_offerings: offeringCount ?? 0,
    recent,
    // True when the agent has more decisions than the recent[] slice surfaces —
    // the dashboard feed uses this to offer "See full history" only when the
    // archive genuinely holds more than what's shown (see /economy/history).
    recent_has_more: rows.length > RECENT_COUNT,
  });
}
