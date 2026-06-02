/**
 * Frontier — the DB adapter for the pure ledger (frontier-ledger.ts). Pure.
 *
 * frontier-ledger.ts knows nothing about Postgres; it operates on LedgerRow.
 * This file is the ONE place that translates a `frontier_transactions` row into
 * a LedgerRow, and the ONE place that computes the budget-reserve-aware
 * spent-today total. Keeping the DB shape here means the pure ledger never has
 * to learn column names, and every endpoint reads rows the same way.
 *
 * Two exports:
 *   - toLedgerRow(dbRow)              → LedgerRow (status/metadata normalization)
 *   - reserveAwareSpentTodayUsd(rows) → the budget the agent has committed today
 *
 * The reserve math is the load-bearing invention here. A `pending` hold created
 * by /authorize reserves budget. But a hold that's authorized and never settled
 * (a buggy agent, a crashed session, an authorize-bomb) would otherwise reserve
 * budget FOREVER and lock the VM out of its own autonomy. The fix is not a
 * cleanup cron — it's arithmetic: a pending hold counts against the budget only
 * while it is FRESH (younger than HOLD_TTL_MS). A stale hold self-expires from
 * the reserve. Correctness lives in the read, so it holds even if no cron ever
 * runs. (A cron may still sweep truly-abandoned holds to `failed` for a clean
 * activity feed — but the budget is correct without it.)
 *
 * PURE: no I/O. Date parsing only. Tests: scripts/_test-frontier-authz.ts.
 */

import type { LedgerRow } from "./frontier-ledger";

/** How long a `pending` hold reserves budget before it self-expires from the reserve. */
export const HOLD_TTL_MS = 15 * 60 * 1000; // 15 min — an x402 sign+settle round-trip is seconds; this is generous headroom.

/** The rolling window for "today" — matches /state and the ledger reader. */
export const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The subset of a frontier_transactions row this adapter reads. PostgREST returns numerics as strings. */
export interface FrontierTxnDbRow {
  direction: string;
  status: string;
  amount_usdc: number | string;
  created_at: string;
  counterparty_vm_id: string | null;
  counterparty_address: string | null;
  verified_on_chain_at: string | null;
  metadata: Record<string, unknown> | null;
}

const KNOWN_STATUSES = ["pending", "settled", "failed", "disputed", "refunded"] as const;

function num(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

/** Translate a frontier_transactions row into the pure ledger's LedgerRow. */
export function toLedgerRow(r: FrontierTxnDbRow): LedgerRow {
  const md = r.metadata ?? {};
  const endpoint = typeof md.endpoint === "string" ? md.endpoint : null;
  const tags = Array.isArray(md.tags)
    ? (md.tags.filter((t) => typeof t === "string") as string[])
    : [];
  return {
    direction: r.direction === "earn" ? "earn" : "spend",
    status: (KNOWN_STATUSES as readonly string[]).includes(r.status)
      ? (r.status as LedgerRow["status"])
      : "failed",
    amountUsd: num(r.amount_usdc),
    createdAtMs: Date.parse(r.created_at),
    counterpartyVmId: r.counterparty_vm_id,
    counterpartyAddress: r.counterparty_address,
    endpoint,
    // §7.3.2 good-decision quality signal — self-reported by the agent at settle,
    // neutralized for abuse by the wash-trade defenses (a self-dealer's "used"
    // rows are excluded by same-human filtering before this ever counts).
    tags,
    resultUsed: md.result_used === true,
    verifiedOnChain: !!r.verified_on_chain_at,
  };
}

/**
 * The USD an agent has COMMITTED today: settled spends in the window plus FRESH
 * pending holds (younger than holdTtlMs). Stale holds are excluded so an
 * abandoned authorize self-frees from the budget with no cron. Earns never count.
 *
 * This is the figure both the policy gate (SpendContext.spentTodayUsd) and the
 * earned-budget gate read — one definition, no drift between the two checks.
 */
export function reserveAwareSpentTodayUsd(
  rows: FrontierTxnDbRow[],
  opts: { nowMs: number; windowMs?: number; holdTtlMs?: number },
): number {
  const windowMs = opts.windowMs ?? SPEND_WINDOW_MS;
  const holdTtlMs = opts.holdTtlMs ?? HOLD_TTL_MS;
  const cutoff = opts.nowMs - windowMs;

  let total = 0;
  for (const r of rows) {
    if (r.direction !== "spend") continue;
    const ts = Date.parse(r.created_at);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    if (r.status === "settled") {
      total += num(r.amount_usdc);
    } else if (r.status === "pending" && opts.nowMs - ts < holdTtlMs) {
      total += num(r.amount_usdc); // fresh reserve
    }
    // failed / refunded / disputed / stale-pending → not committed → excluded
  }
  return Math.round(total * 1e6) / 1e6; // USDC is 6-decimal; kill float noise
}
