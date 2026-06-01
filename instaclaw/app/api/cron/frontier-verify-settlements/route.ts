/**
 * GET /api/cron/frontier-verify-settlements
 *
 * The value-moving half of the record-vs-value split. /api/agent-economy/transaction
 * records settlement CLAIMS (verified_on_chain_at NULL). This worker proves each
 * claim against the Base chain, then stamps verified_on_chain_at — the trust
 * signal every downstream value effect keys on.
 *
 * Per verified settlement it also queues the protocol fee to the burn queue. It
 * deliberately does NOT mint compute credits: converting earnings → InstaClaw
 * credits (the self-funding loop) is a product decision with a rate attached and
 * is Cooper's call. This worker's job is to establish on-chain TRUTH and route
 * fees — never to give away value off an unverified claim. (Crediting becomes a
 * clean follow-up keyed on verified_on_chain_at once the rate is decided.)
 *
 * Safety (same paranoia as /refund — this is where money is real):
 *  - double-credit: the verified-stamp is an atomic compare-and-set
 *    (verified_on_chain_at NULL→now); only the single winner queues the fee.
 *    Idempotent across overlapping runs; a cron-lock additionally avoids wasted
 *    duplicate RPC work.
 *  - tx_hash replay: a single on-chain tx can verify ONE row. Oldest-first
 *    processing lets the legitimate first claimant win; a later row claiming the
 *    same tx_hash is marked disputed. (Partial unique index on tx_hash WHERE
 *    verified IS NOT NULL is the hardening path.)
 *  - forgery: verifyUsdcSettlement rejects wrong recipient/amount/reverted/
 *    malformed. rejected → disputed (never credited) + admin alert.
 *  - reorg/flaky RPC: pending and rpc_error are retried, NEVER marked fraud. A
 *    claim stuck unconfirmable past VERIFY_TIMEOUT is marked disputed.
 *
 * Scope: on-chain rails only (x402 / compute / base_mcp) with a tx_hash. Fiat
 * rails (stripe_mcp / card / ap2) need their own verifier.
 *
 * Auth: Bearer CRON_SECRET (Vercel cron).
 *
 * PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §6.5, §8, §10
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import {
  getBaseChainReader,
  verifyUsdcSettlement,
} from "@/lib/frontier-chain-verify";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // external RPC + batch (Rule 11)

const CRON_NAME = "frontier-verify-settlements";
const LOCK_TTL_SECONDS = 280; // under maxDuration; auto-expires if a run dies
const BATCH = 25;
const MIN_CONFIRMATIONS = 30; // ~1 min at 2s Base blocks; L2-block reorg is ~0%
const VERIFY_TIMEOUT_MS = 2 * 60 * 60 * 1000; // unconfirmable past 2h ⇒ dead hash
const VERIFIABLE_RAILS = ["x402", "compute", "base_mcp"];

interface Candidate {
  id: string;
  vm_id: string;
  rail: string;
  direction: "earn" | "spend";
  amount_usdc: string | number;
  protocol_fee_usdc: string | number;
  tx_hash: string;
  created_at: string;
}

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const locked = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!locked) {
    return NextResponse.json({ ok: true, skipped: "locked" });
  }

  const summary = { checked: 0, verified: 0, rejected: 0, timed_out: 0, pending: 0, rpc_errors: 0 };
  const rejections: string[] = [];

  try {
    const supabase = getSupabase();

    const { data: candidates, error: candErr } = await supabase
      .from("frontier_transactions")
      .select("id, vm_id, rail, direction, amount_usdc, protocol_fee_usdc, tx_hash, created_at")
      .is("verified_on_chain_at", null)
      .eq("status", "settled")
      .not("tx_hash", "is", null)
      .in("rail", VERIFIABLE_RAILS)
      .order("created_at", { ascending: true })
      .limit(BATCH);

    if (candErr) {
      logger.error("[frontier-verify] candidate query failed", { error: candErr.message });
      return NextResponse.json({ error: "candidate query failed" }, { status: 500 });
    }

    const rows = (candidates ?? []) as Candidate[];
    if (rows.length === 0) {
      return NextResponse.json({ ok: true, ...summary });
    }

    // Batch-load VM wallets (the expected payee/payer for each settlement).
    const vmIds = [...new Set(rows.map((r) => r.vm_id))];
    const { data: vms } = await supabase
      .from("instaclaw_vms")
      .select("id, bankr_evm_address, cdp_wallet_address")
      .in("id", vmIds);
    const walletsByVm = new Map<string, string[]>();
    for (const v of vms ?? []) {
      walletsByVm.set(
        v.id,
        [v.bankr_evm_address, v.cdp_wallet_address].filter((w): w is string => !!w),
      );
    }

    const reader = getBaseChainReader();

    for (const row of rows) {
      summary.checked++;
      try {
        const wallets = walletsByVm.get(row.vm_id) ?? [];
        const outcome = await verifyUsdcSettlement({
          reader,
          txHash: row.tx_hash,
          direction: row.direction,
          vmWallets: wallets,
          expectedAmountUsdc: Number(row.amount_usdc),
          minConfirmations: MIN_CONFIRMATIONS,
        });

        if (outcome.status === "verified") {
          // Replay defense, scoped by DIRECTION. A single on-chain USDC Transfer
          // has exactly one (from,to,value), so a given tx_hash backs at most ONE
          // legit earn (the recipient) and ONE legit spend (the sender). A second
          // VERIFIED row of the SAME direction on the same tx_hash is a genuine
          // replay (double-counting one transfer) → dispute. We must NOT key on
          // tx_hash alone: an agent-to-agent sale legitimately produces TWO rows
          // sharing one tx_hash (seller earn + buyer spend), and both must verify.
          // Oldest-first ⇒ the legitimate first claimant of each direction wins.
          // (Boundary: a batched multi-recipient tx could yield two legit earns on
          // one hash; x402 `exact` settles one transfer per tx, so that's out of
          // scope for Phase 1A. If batched settlement lands, key on log_index too.)
          const { data: dup } = await supabase
            .from("frontier_transactions")
            .select("id")
            .eq("tx_hash", row.tx_hash)
            .eq("direction", row.direction)
            .not("verified_on_chain_at", "is", null)
            .neq("id", row.id)
            .limit(1)
            .maybeSingle();
          if (dup) {
            await markDisputed(supabase, row.id);
            summary.rejected++;
            rejections.push(`${row.id} tx ${row.tx_hash.slice(0, 12)}… REPLAY of already-verified ${row.direction} on this tx`);
            logger.warn("[frontier-verify] tx_hash replay", { txId: row.id, txHash: row.tx_hash, dupId: dup.id });
            continue;
          }

          // Atomic single-winner stamp.
          const { data: stamped } = await supabase
            .from("frontier_transactions")
            .update({ verified_on_chain_at: new Date().toISOString() })
            .eq("id", row.id)
            .is("verified_on_chain_at", null)
            .select("id");

          if (stamped && stamped.length === 1) {
            const fee = Number(row.protocol_fee_usdc) || 0;
            if (fee > 0) {
              const { error: feeErr } = await supabase.from("frontier_treasury_burn_queue").insert({
                transaction_id: row.id,
                amount_usdc: fee,
                source_tag: `${row.rail}_protocol_fee`,
                status: "queued",
              });
              if (feeErr) {
                // Verified but fee not queued — recoverable (a sweep can re-queue
                // fees for verified rows lacking a burn row). Never blocks verify.
                logger.error("[frontier-verify] fee queue insert failed (reconcile)", {
                  txId: row.id, error: feeErr.message,
                });
              }
            }
            summary.verified++;
          }
          // stamped.length === 0 → another run already verified it; no-op.
          continue;
        }

        if (outcome.status === "rejected") {
          await markDisputed(supabase, row.id);
          summary.rejected++;
          rejections.push(`${row.id} tx ${row.tx_hash.slice(0, 12)}… ${outcome.reason}`);
          logger.warn("[frontier-verify] rejected", { txId: row.id, txHash: row.tx_hash, reason: outcome.reason });
          continue;
        }

        if (outcome.status === "pending") {
          if (Date.now() - Date.parse(row.created_at) > VERIFY_TIMEOUT_MS) {
            await markDisputed(supabase, row.id);
            summary.timed_out++;
            rejections.push(`${row.id} tx ${row.tx_hash.slice(0, 12)}… unconfirmable past timeout (${outcome.reason})`);
            logger.warn("[frontier-verify] timed out unverified", { txId: row.id, reason: outcome.reason });
          } else {
            summary.pending++;
          }
          continue;
        }

        // rpc_error — leave for retry, do not penalize.
        summary.rpc_errors++;
        logger.warn("[frontier-verify] rpc_error (will retry)", { txId: row.id, reason: outcome.reason });
      } catch (err) {
        // One bad row must not kill the batch.
        summary.rpc_errors++;
        logger.error("[frontier-verify] unexpected error on row", {
          txId: row.id, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // One summary alert per run (never per-row) when claims fail verification.
    if (rejections.length > 0) {
      try {
        await sendAdminAlertEmail(
          `[P1] Frontier: ${rejections.length} settlement claim(s) failed verification`,
          `Run ${CRON_NAME}\nverified=${summary.verified} rejected=${summary.rejected} timed_out=${summary.timed_out}\n\n` +
            rejections.join("\n"),
        );
      } catch (alertErr) {
        logger.error("[frontier-verify] admin alert failed", {
          error: alertErr instanceof Error ? alertErr.message : String(alertErr),
        });
      }
    }

    return NextResponse.json({ ok: true, ...summary });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function markDisputed(supabase: any, txId: string): Promise<void> {
  // Atomic: only flip a still-settled claim, never clobber a later state.
  await supabase
    .from("frontier_transactions")
    .update({ status: "disputed" })
    .eq("id", txId)
    .eq("status", "settled");
}
