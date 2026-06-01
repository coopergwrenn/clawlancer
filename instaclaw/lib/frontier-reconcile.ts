/**
 * Frontier — reconciliation helpers (pure, testable).
 *
 * The refund route (app/api/agent-economy/refund) flips a transaction
 * settled→refunded and THEN queues the on-chain refund. That ordering is
 * deliberate (the only failure mode is recoverable), but it leaves a gap the
 * route's own docblock promises a sweep will close: if the queue insert fails
 * after the flip, the refund is owed but never queued — silently lost. These
 * helpers find those orphans for the refund-reconcile cron.
 */

/** Split an array into chunks of `size` (the last chunk may be short, never empty
 *  for a non-empty input). Used to keep PostgREST `IN (...)` URLs bounded. */
export function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Orphaned refunds = refunded transaction ids that have NO refund retry row
 * (in any status). A 'queued'/'done'/'failed' refund-retry row means the refund
 * is accounted for — only the complete ABSENCE of one is an orphan (the flip
 * landed but the queue insert never did). Pure set difference, order-preserving.
 */
export function computeOrphanRefunds(
  refundedTxnIds: ReadonlyArray<string>,
  txnIdsWithRefundRetry: Iterable<string>,
): string[] {
  const have = new Set(txnIdsWithRefundRetry);
  return refundedTxnIds.filter((id) => !have.has(id));
}
