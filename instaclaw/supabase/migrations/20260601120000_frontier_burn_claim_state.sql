-- Frontier — crash-safe claim state for the treasury buy-and-burn executor.
--
-- Adds the 'burning' (claimed / in-flight) status to frontier_treasury_burn_queue
-- plus the columns the executor needs to spend treasury USDC EXACTLY ONCE:
--
--   status 'burning'  — a batch atomically claimed (queued→burning) BEFORE any
--                       on-chain spend, so a crash mid-burn can't let a second
--                       run re-spend the same fees.
--   burn_batch_id     — correlates the claimed DB rows to the on-chain burn tx,
--                       so reconciliation can ask "did batch X already burn?"
--                       instead of guessing (the answer is what makes recovery
--                       double-spend-safe).
--   claimed_at        — when the batch was claimed; reconciliation scans for
--                       rows stuck 'burning' past a TTL.
--
-- Rule 56: this lives in pending_migrations/ until applied to prod, THEN moves
-- to migrations/ in the same commit. The burn executor only references these
-- columns / the 'burning' value on its BURN_EXECUTOR_CONFIGURED path (off in
-- prod), so the worker is safe to deploy before this migration is applied.
--
-- CONSTRAINT NAME: inline column CHECKs created by CREATE TABLE are auto-named
-- '<table>_<column>_check'. If Supabase reports the DROP didn't find it (name
-- differs), find the real name in the table editor and adjust — applying the
-- ADD without dropping the old 3-value CHECK leaves BOTH active, whose
-- intersection still rejects 'burning'.
--
-- Idempotent: IF EXISTS / IF NOT EXISTS throughout. RLS already enabled on the
-- table (service-role-only) — no new table, no new policy needed.

ALTER TABLE frontier_treasury_burn_queue
  DROP CONSTRAINT IF EXISTS frontier_treasury_burn_queue_status_check;

ALTER TABLE frontier_treasury_burn_queue
  ADD CONSTRAINT frontier_treasury_burn_queue_status_check
  CHECK (status IN ('queued', 'burning', 'burned', 'failed'));

ALTER TABLE frontier_treasury_burn_queue
  ADD COLUMN IF NOT EXISTS burn_batch_id uuid,
  ADD COLUMN IF NOT EXISTS claimed_at    timestamptz;

-- Reconciliation scan: rows stuck 'burning' past the claim TTL.
CREATE INDEX IF NOT EXISTS frontier_burn_burning_idx
  ON frontier_treasury_burn_queue (claimed_at)
  WHERE status = 'burning';

-- Finalize/reconcile a whole claimed batch by its id.
CREATE INDEX IF NOT EXISTS frontier_burn_batch_idx
  ON frontier_treasury_burn_queue (burn_batch_id)
  WHERE burn_batch_id IS NOT NULL;

COMMENT ON COLUMN frontier_treasury_burn_queue.burn_batch_id IS
  'Claim/batch id correlating these rows to one on-chain burn tx. Set at claim (queued→burning); the idempotency anchor for double-spend-safe reconciliation.';
COMMENT ON COLUMN frontier_treasury_burn_queue.claimed_at IS
  'When the row was claimed into status=burning. Reconciliation releases/escalates rows stuck past CLAIM_TTL.';
