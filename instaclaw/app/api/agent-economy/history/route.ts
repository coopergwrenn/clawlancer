/**
 * GET /api/agent-economy/history
 *
 * The COMPLETE Frontier decision record for the logged-in user's agent — the
 * archive behind the dashboard's "Recent activity" feed (which surfaces only
 * the 10 most recent via /api/agent-economy/state). Read-only; session-authed.
 *
 * Renders on /economy/history using the SAME timeline component as the
 * dashboard feed, so the full archive is consistent, not a second design. The
 * per-row shape (ActivityRow) and decision-context extraction below are kept
 * deliberately IDENTICAL to the `recent[]` mapping in
 * `app/api/agent-economy/state/route.ts` — keep the two in sync.
 *
 * PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §9.1
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Most-recent decisions returned for the full-history surface. Far above
// Phase-1A per-VM volume; `truncated` flags the (currently unreachable) cap so
// the page can add pagination once volume grows past it.
const HISTORY_LIMIT = 200;

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

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id")
    .eq("assigned_to", session.user.id)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
  }
  const vmId = vm.id as string;

  const { data: txns, error: txnErr } = await supabase
    .from("frontier_transactions")
    .select(
      "id, rail, direction, amount_usdc, protocol_fee_usdc, status, counterparty_address, counterparty_vm_id, response_summary, tx_hash, created_at, settled_at, metadata",
    )
    .eq("vm_id", vmId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (txnErr) {
    console.error("[/api/agent-economy/history] transaction fetch failed:", txnErr);
    return NextResponse.json({ error: "failed to load history" }, { status: 500 });
  }

  const rowsRaw = (txns ?? []) as TxnRow[];
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

  // ── decision-context extractors — KEEP IN SYNC with state/route.ts recent[] ──
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

  const rows = rowsRaw.map((r) => {
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

  return NextResponse.json({ rows, truncated: rows.length >= HISTORY_LIMIT });
}
