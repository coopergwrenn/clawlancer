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

export const dynamic = "force-dynamic";

// Most-recent rows scanned for live aggregation. Far above Phase-1A per-VM
// volume; when a VM exceeds this, `lifetime.truncated` is true and the dashboard
// should prefer the (cron-maintained) rollup columns.
const SCAN_LIMIT = 500;
const RECENT_COUNT = 10;
const WINDOW_MS = 24 * 60 * 60 * 1000;

interface TxnRow {
  id: string;
  rail: string;
  direction: "earn" | "spend";
  amount_usdc: number | string; // PostgREST returns numeric as string
  protocol_fee_usdc: number | string;
  status: string;
  counterparty_address: string | null;
  counterparty_vm_id: string | null;
  response_summary: string | null;
  tx_hash: string | null;
  created_at: string;
  settled_at: string | null;
  metadata: Record<string, unknown> | null;
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? parseFloat(v) : v ?? 0;
  return Number.isFinite(n as number) ? (n as number) : 0;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // user → VM. A user without an assigned VM has no economy yet.
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, frontier_reputation_score")
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

  const rows = (txns ?? []) as TxnRow[];
  const since = Date.now() - WINDOW_MS;

  let earned24h = 0, spent24h = 0, count24h = 0;
  let earnedLife = 0, spentLife = 0;
  for (const r of rows) {
    if (r.status !== "settled") continue;
    const amt = num(r.amount_usdc);
    const inWindow = Date.parse(r.created_at) >= since;
    if (r.direction === "earn") {
      earnedLife += amt;
      if (inWindow) { earned24h += amt; count24h++; }
    } else {
      spentLife += amt;
      if (inWindow) { spent24h += amt; count24h++; }
    }
  }

  // Active offerings — cheap count.
  const { count: offeringCount } = await supabase
    .from("frontier_offerings")
    .select("id", { count: "exact", head: true })
    .eq("vm_id", vmId)
    .eq("active", true);

  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

  // Decision-context extractors from the authorize-time metadata jsonb. Every
  // authorize stamps the agent's economic state (standing + earned budget) and
  // the eventual outcome (result_used, latency); the activity feed surfaces it
  // so a row reads like a decision, not a line item. Guarded — metadata shape
  // is owned by the spend skill and may be partial on older rows.
  const mStr = (m: Record<string, unknown>, k: string): string | null =>
    typeof m[k] === "string" && (m[k] as string).trim() !== "" ? (m[k] as string) : null;
  const mNum = (m: Record<string, unknown>, k: string): number | null => {
    const v = m[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  const mBool = (m: Record<string, unknown>, k: string): boolean | null =>
    typeof m[k] === "boolean" ? (m[k] as boolean) : null;

  const recent = rows.slice(0, RECENT_COUNT).map((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      rail: r.rail,
      direction: r.direction,
      amount_usdc: round6(num(r.amount_usdc)),
      protocol_fee_usdc: round6(num(r.protocol_fee_usdc)),
      status: r.status,
      counterparty_address: r.counterparty_address,
      counterparty_vm_id: r.counterparty_vm_id,
      response_summary: r.response_summary,
      tx_hash: r.tx_hash,
      created_at: r.created_at,
      settled_at: r.settled_at,
      // decision context — the agent's economic state at the moment it decided
      category: mStr(m, "category"),
      mode: mStr(m, "mode"),
      result_used: mBool(m, "result_used"),
      standing_at_decision: mNum(m, "score_at_authorize"),
      earned_budget_at_decision: mNum(m, "earned_budget_at_authorize"),
      latency_ms: mNum(m, "latency_ms"),
      endpoint: mStr(m, "endpoint"),
      pay_error: mStr(m, "pay_error"),
    };
  });

  return NextResponse.json({
    window_24h: {
      earned_usdc: round6(earned24h),
      spent_usdc: round6(spent24h),
      net_usdc: round6(earned24h - spent24h),
      transactions: count24h,
    },
    lifetime: {
      earned_usdc: round6(earnedLife),
      spent_usdc: round6(spentLife),
      net_usdc: round6(earnedLife - spentLife),
      // True only if the VM has more than SCAN_LIMIT transactions — then these
      // totals are a floor and the dashboard should prefer rollup columns.
      truncated: rows.length >= SCAN_LIMIT,
    },
    reputation_score: vm.frontier_reputation_score ?? null,
    active_offerings: offeringCount ?? 0,
    recent,
  });
}
