/**
 * Frontier — treasury buy-and-burn (the value-moving side of the fee loop).
 *
 * The chain-verify worker enqueues protocol fees (USDC) into
 * frontier_treasury_burn_queue. This module aggregates queued fees and — once
 * the on-chain mechanism is wired — executes a USDC→$INSTACLAW buy-and-burn and
 * records the burn tx. Until then `executeBuyBurn` is a deliberately-throwing
 * stub guarded by BURN_EXECUTOR_CONFIGURED, so no path can move treasury funds.
 * Same record-vs-value discipline as /transaction + the chain-verify worker.
 *
 * As of 2026-06-01 the execution infra does NOT exist in the repo (no treasury
 * signer, no swap route, no BurnRouter / burn-address call). $INSTACLAW itself
 * is live on Base (token address below). See the executeBuyBurn contract.
 *
 * THE LOAD-BEARING SAFETY DISTINCTION (this moves real money):
 *   A failed burn attempt has two fundamentally different shapes, and conflating
 *   them is a double-spend at 3am on a Sunday:
 *     - BurnNotStartedError  → funds DEFINITELY did not move (threw before any
 *                              wallet/broadcast). The claimed batch is safe to
 *                              RELEASE back to 'queued' and retry.
 *     - any other throw       → funds MAY have moved (swap broadcast, then a
 *                              failure). The batch MUST stay 'burning' and be
 *                              reconciled against the chain before any retry —
 *                              NEVER blind-released, or we re-burn what we
 *                              already burned.
 *   The worker keys its recovery entirely on this distinction.
 *
 * Pure aggregation is split out for unit testing (scripts/_test-frontier-burn.ts).
 */

/** $INSTACLAW on Base (Virtuals Protocol token). The burn target. */
export const INSTACLAW_TOKEN_BASE = "0xa9e23871156718c1d55e90dad1c4ea8a33480dfd";

export interface BurnQueueRow {
  id: string;
  amount_usdc: number | string; // PostgREST returns numeric as string
  source_tag: string | null;
}

export interface BurnBatch {
  ids: string[];
  totalUsd: number; // rounded to 6dp (USDC precision)
  bySource: Record<string, number>;
  /** Rows skipped for an invalid/non-positive amount (defensive; DB CHECK is >0). */
  skipped: number;
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return Number.isFinite(n as number) ? (n as number) : NaN;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * Pure: fold queued burn rows into one batch (total + per-source breakdown +
 * the exact id set). Defensively skips rows with a non-finite / non-positive
 * amount even though the DB CHECK enforces > 0 — the queue is a cache and we
 * never spend off an unvalidated number. Callers MUST aggregate the
 * atomically-CLAIMED rows (not the pre-claim read) so the spend amount can
 * never exceed what was actually claimed.
 */
export function aggregateBurnBatch(rows: ReadonlyArray<BurnQueueRow>): BurnBatch {
  const ids: string[] = [];
  const bySource: Record<string, number> = {};
  let total = 0;
  let skipped = 0;
  for (const r of rows) {
    const amt = num(r.amount_usdc);
    if (!Number.isFinite(amt) || amt <= 0) {
      skipped++;
      continue;
    }
    ids.push(r.id);
    total += amt;
    const tag = r.source_tag && r.source_tag.trim() ? r.source_tag : "unknown";
    bySource[tag] = round6((bySource[tag] ?? 0) + amt);
  }
  return { ids, totalUsd: round6(total), bySource, skipped };
}

/**
 * Funds DEFINITELY did not move. Throwing this is the executor's signal that a
 * claimed batch is safe to release back to 'queued'. The stub throws this.
 */
export class BurnNotStartedError extends Error {
  constructor(msg = "burn not started (no funds moved)") {
    super(msg);
    this.name = "BurnNotStartedError";
  }
}

/**
 * Funds MAY have moved (broadcast happened, then a failure). The claimed batch
 * MUST stay 'burning' and be chain-reconciled before any retry. Throwing this
 * tells the worker: do NOT release.
 */
export class BurnMayHaveSpentError extends Error {
  constructor(
    msg: string,
    /** Best-known tx hash if a broadcast occurred, for chain reconciliation. */
    public readonly maybeTxHash?: string,
  ) {
    super(msg);
    this.name = "BurnMayHaveSpentError";
  }
}

export interface BuyBurnParams {
  /** Total USDC to convert + burn. Derived from the CLAIMED batch, never the read. */
  totalUsdc: number;
  /** Per-source breakdown (telemetry / on-chain memo). */
  bySource: Record<string, number>;
  /** The claim id correlating on-chain action to the DB batch (idempotency anchor). */
  burnBatchId: string;
}

export interface BuyBurnResult {
  /** The on-chain burn tx hash (Base). Recorded on the burned rows. */
  burnTxHash: string;
}

/**
 * Execute a USDC→$INSTACLAW buy-and-burn for `totalUsdc`. **NOT WIRED.**
 *
 * Throws BurnNotStartedError today (no funds can move). Implementation contract
 * (ALL required before flipping BURN_EXECUTOR_CONFIGURED on):
 *
 *  1. Treasury signer — a funded Base wallet (USDC) whose key lives in backend
 *     env only (e.g. FRONTIER_TREASURY_PRIVATE_KEY); never on a VM.
 *  2. Swap route — USDC → $INSTACLAW (INSTACLAW_TOKEN_BASE). It's a Virtuals
 *     token with Base liquidity; route via the canonical DEX/aggregator with a
 *     hard slippage bound. Reject if quoted slippage exceeds the bound (a thin
 *     pool must not let one burn move the price arbitrarily).
 *  3. Burn — send the acquired $INSTACLAW to the canonical burn address (or call
 *     the BurnRouter); capture the tx hash.
 *  4. Crash-safety, error-typing (load-bearing):
 *     - Before broadcasting ANY tx, only throw BurnNotStartedError on failure.
 *     - Once a tx is broadcast, NEVER throw BurnNotStartedError. If anything
 *       after broadcast fails, throw BurnMayHaveSpentError(msg, txHash) so the
 *       worker keeps the batch 'burning' for chain reconciliation.
 *     - Tag the on-chain action with `burnBatchId` (memo / event / off-chain
 *       index) so reconciliation can answer "did batch X already burn?" without
 *       guessing — that answer is what makes stuck-row recovery double-spend-safe.
 *  5. Reconciliation (worker side, gated on this being real): a row stuck
 *     'burning' past CLAIM_TTL is resolved by checking the chain for a burn
 *     tagged burnBatchId. Found → finalize to 'burned' with that hash. Not found
 *     AND provably un-broadcast → release to 'queued'. Ambiguous → alert, leave
 *     'burning'. The worker will NOT auto-release while configured.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function executeBuyBurn(params: BuyBurnParams): Promise<BuyBurnResult> {
  throw new BurnNotStartedError(
    "executeBuyBurn is not wired: no treasury signer / swap route / burn call. " +
      "See the implementation contract in lib/frontier-burn.ts before enabling BURN_EXECUTOR_CONFIGURED.",
  );
}
