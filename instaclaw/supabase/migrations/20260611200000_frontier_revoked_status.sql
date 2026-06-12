-- frontier_transactions: add 'revoked' to the status enum (Tier-0 G — revoke
-- interdiction, mechanism C). A 'revoked' hold is a PENDING hold that the human
-- terminated via /api/agent-economy/revoke-spend before it settled. It is a
-- terminal state distinct from 'failed' (the pay leg never completed) — 'revoked'
-- means "the human deliberately cancelled this in-flight spend".
--
-- Why the settle CAS needs no change: settle's flip guards on `.eq("status",
-- "pending")`, so a hold flipped to 'revoked' LOSES the flip for free (0 rows) —
-- the interdiction is enforced by arithmetic already in place, not by new code.
--
-- Reader-safety (verified at build, not assumed):
--   reserveAwareSpentTodayUsd: only 'settled' + fresh 'pending' count → 'revoked'
--     EXCLUDED → revoking a hold FREES its reserved budget. (frontier-ledger-db.ts)
--   classifyExistingHold: 'revoked' → "consumed" → an idempotent authorize retry
--     after revoke returns request_id_consumed, never a live hold. (authorize route)
--   lifetime-rollup / verify-settlements / refund / spend-anomaly: all gate on
--     'settled' (or 'refunded'/'pending') → 'revoked' never counts as a completed
--     spend, never reputation, never refundable.
--
-- This is an ALTER CONSTRAINT (DROP + re-ADD), NOT a CREATE TABLE / ADD COLUMN,
-- so verify-migrations does not gate the build on it. Rule 56 nonetheless: HELD in
-- pending_migrations/ until Cooper applies it in Studio (batched with the
-- composite-unique + spend-events pastes), then git-mv'd to migrations/.
--
-- DEPLOY-WINDOW (same standard as A): the revoke route's interdiction UPDATE is
-- BEST-EFFORT. If the route deploys before this is applied, `SET status='revoked'`
-- violates the OLD CHECK → the UPDATE is rejected → 0 holds flipped → caught +
-- logged → revoke still disables future spend (no regression vs today) → the user
-- copy honestly reflects 0 pending cancelled. Once this lands, interdiction
-- activates with NO further deploy. No forced sequencing; safe in any paste order.

ALTER TABLE public.frontier_transactions
  DROP CONSTRAINT IF EXISTS frontier_transactions_status_check;

ALTER TABLE public.frontier_transactions
  ADD CONSTRAINT frontier_transactions_status_check
  CHECK (status IN ('pending','settled','failed','disputed','refunded','revoked'));
