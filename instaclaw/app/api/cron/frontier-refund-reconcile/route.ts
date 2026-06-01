/**
 * GET /api/cron/frontier-refund-reconcile
 *
 * The safety net the refund route's docblock promises but never built. The
 * refund flow (app/api/agent-economy/refund) flips a transaction
 * settled→refunded atomically, THEN queues the on-chain refund retry. If the
 * queue insert fails after the flip, the refund is OWED BUT NEVER QUEUED — it
 * would be silently lost. This sweep finds refunded transactions with no
 * action='refund' retry row and enqueues the missing one.
 *
 * Orphan = status='refunded' with NO refund retry row in ANY status. A
 * queued/done/failed refund-retry means the refund is accounted for (re-running
 * a 'failed' one is the executor's job, not this sweep's); only complete absence
 * is an orphan. Idempotent: once enqueued the txn is no longer an orphan.
 *
 * This does NOT execute the refund (no funds move) — it only guarantees the
 * refund reaches the queue, where the (gated) settlement-retry executor handles
 * it like any other. Same record-vs-value split as the rest of Frontier.
 *
 * Bounded: scans the most-recent SCAN_CAP refunded txns (orphans are freshest —
 * created the instant a queue insert fails). If truncated, it logs a warning;
 * the durable fix is a refunded_at column / reconciled flag so old orphans can't
 * fall off the window (follow-up).
 *
 * Auth: Bearer CRON_SECRET.
 *
 * PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §6.7
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { chunk, computeOrphanRefunds } from "@/lib/frontier-reconcile";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_NAME = "frontier-refund-reconcile";
const LOCK_TTL_SECONDS = 280;
const SCAN_CAP = 2000; // most-recent refunded txns examined per run
const IN_CHUNK = 200; // ids per PostgREST IN(...) query

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const locked = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!locked) return NextResponse.json({ ok: true, skipped: "locked" });

  try {
    const supabase = getSupabase();

    // Most-recent refunded txns (orphans are freshest).
    const { data: refunded, error: rErr } = await supabase
      .from("frontier_transactions")
      .select("id")
      .eq("status", "refunded")
      .order("created_at", { ascending: false })
      .limit(SCAN_CAP);
    if (rErr) {
      logger.error("[frontier-refund-reconcile] refunded scan failed", { error: rErr.message });
      return NextResponse.json({ error: "refunded scan failed" }, { status: 500 });
    }
    const refundedIds = (refunded ?? []).map((r: { id: string }) => r.id);
    const truncated = refundedIds.length >= SCAN_CAP;
    if (refundedIds.length === 0) {
      return NextResponse.json({ ok: true, refunded: 0, orphans: 0, enqueued: 0 });
    }

    // Which of those already have a refund retry row (any status)?
    const withRetry = new Set<string>();
    for (const ids of chunk(refundedIds, IN_CHUNK)) {
      const { data, error } = await supabase
        .from("frontier_settlement_retry_queue")
        .select("transaction_id")
        .eq("action", "refund")
        .in("transaction_id", ids);
      if (error) {
        logger.error("[frontier-refund-reconcile] retry-row lookup failed", { error: error.message });
        return NextResponse.json({ error: "retry lookup failed" }, { status: 500 });
      }
      for (const row of (data ?? []) as { transaction_id: string }[]) withRetry.add(row.transaction_id);
    }

    const orphans = computeOrphanRefunds(refundedIds, withRetry);
    if (orphans.length === 0) {
      if (truncated) {
        logger.warn("[frontier-refund-reconcile] scan truncated at cap (no orphans in window)", { cap: SCAN_CAP });
      }
      return NextResponse.json({ ok: true, refunded: refundedIds.length, orphans: 0, enqueued: 0, truncated });
    }

    // Enqueue the missing refund retry for each orphan. cron-lock makes this
    // single-flight; once inserted the txn drops out of the orphan set, so
    // duplicates are not reachable in practice (a partial unique index on
    // (transaction_id) WHERE action='refund' is the belt-and-suspenders).
    let enqueued = 0;
    const failures: string[] = [];
    for (const transactionId of orphans) {
      const { error } = await supabase.from("frontier_settlement_retry_queue").insert({
        transaction_id: transactionId,
        action: "refund",
        status: "queued",
        last_error: "reconciliation: refunded txn had no queued refund retry (flip-then-queue gap)",
      });
      if (error) {
        // FK gone (txn hard-deleted between scan and insert) or transient — log, continue.
        failures.push(`${transactionId}: ${error.code ?? ""} ${error.message}`);
      } else {
        enqueued++;
      }
    }

    logger.error("[frontier-refund-reconcile] recovered orphaned refunds — refund route's flip-then-queue gap fired", {
      orphans: orphans.length,
      enqueued,
      failures: failures.length,
      truncated,
    });
    if (failures.length > 0) {
      logger.error("[frontier-refund-reconcile] some enqueue failures", { sample: failures.slice(0, 5) });
    }

    return NextResponse.json({
      ok: true,
      refunded: refundedIds.length,
      orphans: orphans.length,
      enqueued,
      failures: failures.length,
      truncated,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
