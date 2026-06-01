/**
 * GET /api/cron/frontier-burn-executor
 *
 * Drains frontier_treasury_burn_queue: protocol fees (USDC) accrued by the
 * chain-verify worker, converted to a $INSTACLAW buy-and-burn. The deflationary
 * half of the fee loop.
 *
 * EXECUTION IS GATED. The on-chain swap+burn (lib/frontier-burn.ts:executeBuyBurn)
 * is not wired as of 2026-06-01 (no treasury signer / swap route / burn call),
 * so it throws BurnNotStartedError and BURN_EXECUTOR_CONFIGURED stays unset.
 * While unset this worker is READ-ONLY: it reports queue depth and alerts if a
 * meaningful backlog accrues un-burned. It touches NO new columns in that mode,
 * so it is safe to deploy before the claim-state migration
 * (pending_migrations/20260601120000_frontier_burn_claim_state.sql) is applied.
 *
 * When wired (BURN_EXECUTOR_CONFIGURED=true + migration applied + executeBuyBurn
 * implemented), spend-exactly-once is enforced by:
 *   1. Atomic claim BEFORE spend — queued→'burning' with a burn_batch_id, single
 *      winner per row (compare-and-set on status='queued').
 *   2. Spend the CLAIMED total, re-aggregated from the rows the claim actually
 *      returned — never the pre-claim read, so we can't burn more than we hold.
 *   3. A per-run circuit breaker (MAX_BURN_PER_RUN_USDC): if the queued total
 *      exceeds it, refuse + alert. A buggy upstream (verifier bug, fee
 *      double-queue) cannot drain the treasury in one swing.
 *   4. Double-spend-safe recovery: a failed attempt that DEFINITELY didn't spend
 *      (BurnNotStartedError) releases the claim back to 'queued'. Anything that
 *      MAY have spent leaves the batch 'burning' and ALERTS — it is never
 *      blind-released, because re-burning a batch that already burned is
 *      irreversible. Stuck 'burning' rows are escalated, not auto-released, until
 *      executeBuyBurn's chain-tagged reconciliation lands (see its contract).
 *
 * Auth: Bearer CRON_SECRET. Schedule: daily (burns batch; daily buy-and-burn).
 *
 * PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §8 (tokenomics loop)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import {
  aggregateBurnBatch,
  executeBuyBurn,
  BurnNotStartedError,
  type BurnQueueRow,
} from "@/lib/frontier-burn";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // on-chain swap + batch (Rule 11)

const CRON_NAME = "frontier-burn-executor";
const LOCK_TTL_SECONDS = 280;
const CONFIGURED = process.env.BURN_EXECUTOR_CONFIGURED === "true";

const READ_BATCH = 500; // queued rows scanned per run
const MAX_BURN_PER_RUN_USDC = 1000; // treasury circuit breaker — refuse + alert above this
const BACKLOG_ALERT_USD = 50; // un-burned backlog that warrants an (unconfigured-mode) heads-up
const CLAIM_TTL_MS = 30 * 60 * 1000; // a row 'burning' longer than this is stuck

/** Deduped admin alert via instaclaw_admin_alert_log (mirrors enospc-guard). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function alertDeduped(supabase: any, key: string, intervalMs: number, subject: string, body: string): Promise<void> {
  const cutoff = new Date(Date.now() - intervalMs).toISOString();
  try {
    const { data } = await supabase
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", key)
      .gte("sent_at", cutoff)
      .limit(1);
    if ((data?.length ?? 0) > 0) return; // recently alerted
  } catch {
    // dedup table unavailable → fall through and alert (over-alert > miss)
  }
  try {
    await supabase.from("instaclaw_admin_alert_log").insert({ alert_key: key, vm_count: 0, details: subject });
  } catch {
    // record-before-send failed → still send
  }
  try {
    await sendAdminAlertEmail(subject, body);
  } catch (err) {
    logger.error("[frontier-burn] admin alert send failed", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const locked = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!locked) return NextResponse.json({ ok: true, skipped: "locked" });

  try {
    const supabase = getSupabase();

    // ─ Pass 1: reconcile stuck claims (only meaningful — and only references
    //   the new columns — when configured; gated so it can't 42703 pre-migration).
    if (CONFIGURED) {
      const staleCutoff = new Date(Date.now() - CLAIM_TTL_MS).toISOString();
      const { data: stuck, error: stuckErr } = await supabase
        .from("frontier_treasury_burn_queue")
        .select("id, burn_batch_id, amount_usdc, claimed_at")
        .eq("status", "burning")
        .lt("claimed_at", staleCutoff)
        .limit(READ_BATCH);
      if (stuckErr) {
        logger.error("[frontier-burn] stuck-claim scan failed", { error: stuckErr.message });
      } else if (stuck && stuck.length > 0) {
        // NEVER auto-release: a 'burning' row may represent an already-broadcast
        // burn. Re-queue → re-burn = irreversible double-spend. Escalate; the
        // chain-tagged reconciliation lands with executeBuyBurn (see contract).
        const batches = [...new Set(stuck.map((r: { burn_batch_id: string | null }) => r.burn_batch_id ?? "null"))];
        logger.error("[frontier-burn] CRITICAL: rows stuck in 'burning' past TTL — manual chain reconciliation required", {
          rows: stuck.length,
          batches,
        });
        await alertDeduped(
          supabase,
          `frontier-burn-stuck:${batches.sort().join(",")}`,
          6 * 60 * 60 * 1000,
          `[P0] Frontier burn: ${stuck.length} row(s) stuck 'burning'`,
          `${stuck.length} burn-queue row(s) across batch(es) [${batches.join(", ")}] have been in status='burning' ` +
            `longer than ${CLAIM_TTL_MS / 60000}min.\n\n` +
            `These were claimed for a buy-and-burn that did not finalize. They are NOT auto-released — a claimed ` +
            `batch may already have burned on-chain, and re-queueing would double-spend treasury USDC.\n\n` +
            `Reconcile each batch against the chain (did a $INSTACLAW burn tagged the batch id land?): if yes, ` +
            `finalize to 'burned' with that tx hash; if provably not broadcast, release to 'queued'.`,
      );
      }
    }

    // ─ Pass 2a: unconfigured → read-only depth report (no new-column refs). ─
    if (!CONFIGURED) {
      const { data: queued, error } = await supabase
        .from("frontier_treasury_burn_queue")
        .select("id, amount_usdc, source_tag")
        .eq("status", "queued")
        .limit(READ_BATCH);
      if (error) {
        logger.error("[frontier-burn] queued read failed", { error: error.message });
        return NextResponse.json({ error: "queued read failed" }, { status: 500 });
      }
      const batch = aggregateBurnBatch((queued ?? []) as BurnQueueRow[]);
      logger.info("[frontier-burn] executor disabled — queue accruing", {
        queued: batch.ids.length,
        total_usd: batch.totalUsd,
        truncated: (queued?.length ?? 0) >= READ_BATCH,
      });
      // Only nudge once the un-burned backlog is materially large. Steady "still
      // disabled" emails would be pure noise — the queue table + this log are the
      // durable signal; the alert is for "real money is piling up unburned".
      if (batch.totalUsd >= BACKLOG_ALERT_USD) {
        await alertDeduped(
          supabase,
          "frontier-burn-backlog",
          7 * 24 * 60 * 60 * 1000,
          `Frontier burn backlog: $${batch.totalUsd} queued, executor off`,
          `$${batch.totalUsd} of protocol fees across ${batch.ids.length} row(s) are queued for $INSTACLAW burn, ` +
            `but BURN_EXECUTOR_CONFIGURED is not set (the swap+burn path isn't wired yet).\n\n` +
            `Nothing is lost — the queue is durable — but the deflationary loop isn't running. Wire ` +
            `lib/frontier-burn.ts:executeBuyBurn per its contract, apply the claim-state migration, and set the flag.`,
        );
      }
      return NextResponse.json({
        ok: true,
        configured: false,
        queued: batch.ids.length,
        total_usd: batch.totalUsd,
        executed: false,
      });
    }

    // ─ Pass 2b: configured → claim + execute. ─
    const { data: queued, error: readErr } = await supabase
      .from("frontier_treasury_burn_queue")
      .select("id, amount_usdc, source_tag")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(READ_BATCH);
    if (readErr) {
      logger.error("[frontier-burn] queued read failed", { error: readErr.message });
      return NextResponse.json({ error: "queued read failed" }, { status: 500 });
    }
    const pre = aggregateBurnBatch((queued ?? []) as BurnQueueRow[]);
    if (pre.ids.length === 0) {
      return NextResponse.json({ ok: true, configured: true, queued: 0, executed: false });
    }

    // Circuit breaker — refuse to spend an implausibly large amount in one run.
    if (pre.totalUsd > MAX_BURN_PER_RUN_USDC) {
      logger.error("[frontier-burn] queued total exceeds per-run ceiling — refusing to burn", {
        total_usd: pre.totalUsd,
        ceiling: MAX_BURN_PER_RUN_USDC,
        rows: pre.ids.length,
      });
      await alertDeduped(
        supabase,
        "frontier-burn-ceiling",
        6 * 60 * 60 * 1000,
        `[P0] Frontier burn: $${pre.totalUsd} exceeds per-run ceiling $${MAX_BURN_PER_RUN_USDC}`,
        `The burn queue holds $${pre.totalUsd} across ${pre.ids.length} row(s), over the ${MAX_BURN_PER_RUN_USDC} ` +
          `per-run ceiling. The executor refused to burn — this usually means an upstream bug flooded the queue ` +
          `(verifier fault, fee double-queue). Investigate before raising the ceiling or manually burning.`,
      );
      return NextResponse.json({ ok: true, configured: true, queued: pre.ids.length, executed: false, reason: "ceiling_exceeded" });
    }

    // Atomic claim: queued→burning, single winner per row.
    const burnBatchId = crypto.randomUUID();
    const { data: claimed, error: claimErr } = await supabase
      .from("frontier_treasury_burn_queue")
      .update({ status: "burning", burn_batch_id: burnBatchId, claimed_at: new Date().toISOString() })
      .in("id", pre.ids)
      .eq("status", "queued")
      .select("id, amount_usdc, source_tag");
    if (claimErr) {
      logger.error("[frontier-burn] claim failed", { error: claimErr.message });
      return NextResponse.json({ error: "claim failed" }, { status: 500 });
    }
    const claimedRows = (claimed ?? []) as BurnQueueRow[];
    if (claimedRows.length === 0) {
      // Another run (or the cron-lock race we shouldn't hit) already took them.
      return NextResponse.json({ ok: true, configured: true, queued: 0, executed: false, reason: "nothing_claimed" });
    }

    // Spend EXACTLY what we claimed — re-aggregate from the claim's return set.
    const batch = aggregateBurnBatch(claimedRows);
    if (batch.totalUsd <= 0) {
      // Degenerate (all claimed rows invalid). Release and bail — don't burn $0.
      await supabase
        .from("frontier_treasury_burn_queue")
        .update({ status: "queued", burn_batch_id: null, claimed_at: null })
        .eq("burn_batch_id", burnBatchId)
        .eq("status", "burning");
      logger.error("[frontier-burn] claimed batch aggregated to <= 0 — released", { burnBatchId, rows: claimedRows.length });
      return NextResponse.json({ ok: true, configured: true, executed: false, reason: "zero_total_released" });
    }

    try {
      const { burnTxHash } = await executeBuyBurn({
        totalUsdc: batch.totalUsd,
        bySource: batch.bySource,
        burnBatchId,
      });

      // Finalize the whole claimed batch.
      const { error: finErr } = await supabase
        .from("frontier_treasury_burn_queue")
        .update({ status: "burned", burn_tx_hash: burnTxHash, burned_at: new Date().toISOString() })
        .eq("burn_batch_id", burnBatchId)
        .eq("status", "burning");
      if (finErr) {
        // Funds burned on-chain but the DB flip failed. Rows stay 'burning';
        // Pass 1 will escalate them. Log the hash so it's recoverable by hand.
        logger.error("[frontier-burn] CRITICAL: burned on-chain but finalize failed — manual reconcile", {
          burnBatchId,
          burnTxHash,
          total_usd: batch.totalUsd,
          error: finErr.message,
        });
        return NextResponse.json({ ok: true, configured: true, executed: true, finalized: false, tx: burnTxHash });
      }

      logger.info("[frontier-burn] burned", { burnBatchId, total_usd: batch.totalUsd, rows: batch.ids.length, tx: burnTxHash });
      return NextResponse.json({ ok: true, configured: true, executed: true, burned_usd: batch.totalUsd, rows: batch.ids.length, tx: burnTxHash });
    } catch (err) {
      if (err instanceof BurnNotStartedError) {
        // Funds DEFINITELY did not move — safe to release the claim and retry next run.
        const { error: relErr } = await supabase
          .from("frontier_treasury_burn_queue")
          .update({ status: "queued", burn_batch_id: null, claimed_at: null })
          .eq("burn_batch_id", burnBatchId)
          .eq("status", "burning");
        if (relErr) {
          logger.error("[frontier-burn] release after not-started failed (rows left burning; Pass 1 will escalate)", {
            burnBatchId,
            error: relErr.message,
          });
        }
        logger.info("[frontier-burn] burn not started — claim released", { burnBatchId, reason: err.message });
        return NextResponse.json({ ok: true, configured: true, executed: false, reason: "not_started" });
      }

      // ANY other error → funds MAY have moved. Do NOT release. Leave 'burning';
      // Pass 1 escalates. This is the double-spend firewall.
      const maybeTx = (err as { maybeTxHash?: string })?.maybeTxHash;
      logger.error("[frontier-burn] CRITICAL: burn may have spent — batch left 'burning' for chain reconciliation", {
        burnBatchId,
        maybeTxHash: maybeTx,
        total_usd: batch.totalUsd,
        error: err instanceof Error ? err.message : String(err),
      });
      await alertDeduped(
        supabase,
        `frontier-burn-maybe-spent:${burnBatchId}`,
        60 * 60 * 1000,
        `[P0] Frontier burn MAY have spent — batch ${burnBatchId}`,
        `Batch ${burnBatchId} ($${batch.totalUsd}) threw a non-BurnNotStarted error during execution.\n\n` +
          `Funds may have moved (tx: ${maybeTx ?? "unknown"}). The batch is left status='burning' and was NOT ` +
          `released — re-queueing could double-spend. Reconcile against the chain before any action.`,
      );
      return NextResponse.json({ ok: true, configured: true, executed: false, reason: "may_have_spent" }, { status: 200 });
    }
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
