/**
 * GET /api/cron/frontier-lifetime-rollup
 *
 * Maintains the denormalized lifetime money columns on instaclaw_vms:
 *   frontier_lifetime_earned_usdc, frontier_lifetime_spent_usdc
 * from settled frontier_transactions. /api/agent-economy/state live-sums a
 * bounded window today and flags `lifetime.truncated` past 500 rows — these
 * rollup columns are the exact, unbounded source the dashboard falls back to.
 *
 * Filter matches /state exactly (status='settled') so the cache and the live
 * view never disagree. (A verified-only variant — verified_on_chain_at IS NOT
 * NULL — would be a stricter "proven earnings" number; deferred so the two
 * surfaces stay consistent. Flip both together if/when we want it.)
 *
 * RECOMPUTE, never increment — the rollup must be able to DECREASE. If a VM's
 * earnings are later refunded, its settled sum drops; an incrementing rollup
 * would be permanently wrong. And the 3am-Sunday case nobody specs: a VM whose
 * earnings were ALL refunded has zero settled rows, so a "sum the settled rows"
 * pass never visits it and leaves a stale non-zero total forever. So after
 * recomputing positives, we also zero any VM carrying a non-zero rollup that no
 * longer has settled activity.
 *
 * reputation_score is intentionally NOT rolled up here: reputation feedback
 * can't be verified on-chain yet (ERC-8004 registry not deployed), and showing
 * a score from unverified, potentially-gamed feedback is worse than the
 * documented NULL cold-start. It lands with the on-chain reputation path.
 *
 * Auth: Bearer CRON_SECRET. Schedule: nightly.
 *
 * PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §9.1
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_NAME = "frontier-lifetime-rollup";
const LOCK_TTL_SECONDS = 280;
const PAGE = 1000; // settled-txn scan page size

interface Totals {
  earned: number;
  spent: number;
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return Number.isFinite(n as number) ? (n as number) : 0;
}
const round2 = (n: number): number => Math.round(n * 100) / 100;

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const locked = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!locked) return NextResponse.json({ ok: true, skipped: "locked" });

  try {
    const supabase = getSupabase();

    // ─ Recompute per-VM lifetime totals from settled txns (paged). ─
    const totals = new Map<string, Totals>();
    let offset = 0;
    let scanned = 0;
    for (;;) {
      const { data: page, error } = await supabase
        .from("frontier_transactions")
        .select("vm_id, direction, amount_usdc")
        .eq("status", "settled")
        .order("id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) {
        logger.error("[frontier-rollup] settled scan failed", { offset, error: error.message });
        return NextResponse.json({ error: "settled scan failed" }, { status: 500 });
      }
      const rows = page ?? [];
      for (const r of rows as { vm_id: string; direction: string; amount_usdc: number | string }[]) {
        const t = totals.get(r.vm_id) ?? { earned: 0, spent: 0 };
        const amt = num(r.amount_usdc);
        if (r.direction === "earn") t.earned += amt;
        else if (r.direction === "spend") t.spent += amt;
        totals.set(r.vm_id, t);
      }
      scanned += rows.length;
      if (rows.length < PAGE) break;
      offset += PAGE;
    }

    // ─ Write recomputed positives. ─
    let updated = 0;
    const failures: string[] = [];
    for (const [vmId, t] of totals) {
      const { error } = await supabase
        .from("instaclaw_vms")
        .update({
          frontier_lifetime_earned_usdc: round2(t.earned),
          frontier_lifetime_spent_usdc: round2(t.spent),
        })
        .eq("id", vmId);
      if (error) failures.push(`${vmId}: ${error.message}`);
      else updated++;
    }

    // ─ Zero stale rollups: VMs carrying a non-zero lifetime total that no longer
    //   appear in settled activity (e.g. everything got refunded). Without this
    //   their old totals would persist forever. ─
    let zeroed = 0;
    const { data: nonZero, error: nzErr } = await supabase
      .from("instaclaw_vms")
      .select("id")
      .or("frontier_lifetime_earned_usdc.gt.0,frontier_lifetime_spent_usdc.gt.0");
    if (nzErr) {
      logger.error("[frontier-rollup] non-zero scan failed", { error: nzErr.message });
    } else {
      for (const v of (nonZero ?? []) as { id: string }[]) {
        if (totals.has(v.id)) continue; // still has settled activity — already updated
        const { error } = await supabase
          .from("instaclaw_vms")
          .update({ frontier_lifetime_earned_usdc: 0, frontier_lifetime_spent_usdc: 0 })
          .eq("id", v.id);
        if (error) failures.push(`zero ${v.id}: ${error.message}`);
        else zeroed++;
      }
    }

    if (failures.length > 0) {
      logger.error("[frontier-rollup] some VM updates failed", { count: failures.length, sample: failures.slice(0, 5) });
    }
    logger.info("[frontier-rollup] done", { scanned, vms_with_activity: totals.size, updated, zeroed, failures: failures.length });

    return NextResponse.json({
      ok: true,
      scanned_settled: scanned,
      vms_with_activity: totals.size,
      updated,
      zeroed,
      failures: failures.length,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
