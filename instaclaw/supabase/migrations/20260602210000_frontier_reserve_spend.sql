-- frontier_reserve_spend — atomic budget-reserve for /api/agent-economy/authorize (P1-4 TOCTOU fix).
--
-- WHY: authorize computed spent-today, checked it against the earned budget + the
-- daily ceiling, then INSERTed a pending hold — three steps, no lock. Two concurrent
-- authorize calls (different request_ids) both read the same spent-today, both passed,
-- both reserved → the earned budget AND the neverPerDay hard ceiling were bypassable
-- under concurrency (bounded only by the wallet balance). This RPC closes that window:
-- it serializes per-VM with a transaction-scoped advisory lock, re-sums committed spend
-- INSIDE the lock, enforces both caps, and inserts — all atomically.
--
-- The committed-spend window + fresh-pending TTL cutoffs are PASSED IN by the caller
-- (computed in TS from the same constants as lib/frontier-ledger-db.reserveAwareSpentTodayUsd)
-- so there is no duplicated window/TTL magic number in SQL (Rule 45 drift guard). The
-- status logic (settled OR fresh-pending) mirrors reserveAwareSpentTodayUsd exactly.
--
-- The route prefers this RPC and FALLS BACK to a plain insert if it's absent (error
-- 42883 / PGRST202) — so deploying the route before this migration is applied is
-- non-breaking (fallback = the prior, TOCTOU-vulnerable-but-wallet-bounded behavior).
-- Applying this migration ACTIVATES the lock. No CREATE TABLE / ALTER ADD COLUMN, so
-- verify-migrations.ts does not gate the build (Rule 56); still staged in
-- pending_migrations/ until applied, then git-mv to migrations/.
--
-- Function-only migration → idempotent via CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION frontier_reserve_spend(
  p_vm_id uuid,
  p_request_id text,
  p_rail text,
  p_counterparty_address text,
  p_counterparty_vm_id uuid,
  p_amount numeric,
  p_protocol_fee numeric,
  p_metadata jsonb,
  p_cap_daily numeric,
  p_cap_earned numeric,
  p_human_approved boolean,
  p_window_start timestamptz,
  p_fresh_pending_cutoff timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_committed numeric;
  v_id uuid;
BEGIN
  -- Serialize concurrent reserves for THIS vm (txn-scoped; auto-released at commit).
  PERFORM pg_advisory_xact_lock(hashtext(p_vm_id::text));

  -- Re-sum committed spend (settled + FRESH pending) under the lock — the same
  -- definition as reserveAwareSpentTodayUsd, with cutoffs supplied by the caller.
  SELECT COALESCE(SUM(amount_usdc), 0) INTO v_committed
  FROM frontier_transactions
  WHERE vm_id = p_vm_id
    AND direction = 'spend'
    AND created_at >= p_window_start
    AND (status = 'settled' OR (status = 'pending' AND created_at >= p_fresh_pending_cutoff));

  -- Hard daily ceiling — always binds (even human-approved).
  IF (v_committed + p_amount) > p_cap_daily THEN
    RETURN jsonb_build_object('reserved', false, 'committed', v_committed, 'reason', 'exceeds_daily_ceiling');
  END IF;
  -- Earned-budget ceiling — binds unless the human approved this spend.
  IF (NOT p_human_approved) AND (v_committed + p_amount) > p_cap_earned THEN
    RETURN jsonb_build_object('reserved', false, 'committed', v_committed, 'reason', 'exceeds_earned_budget');
  END IF;

  INSERT INTO frontier_transactions
    (request_id, rail, direction, vm_id, counterparty_address, counterparty_vm_id,
     amount_usdc, protocol_fee_usdc, status, facilitator, metadata)
  VALUES
    (p_request_id, p_rail, 'spend', p_vm_id, p_counterparty_address, p_counterparty_vm_id,
     p_amount, p_protocol_fee, 'pending', 'coinbase', p_metadata)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('reserved', true, 'id', v_id, 'committed', v_committed);
EXCEPTION
  WHEN unique_violation THEN
    -- (vm_id, request_id) already exists — idempotent retry; caller re-reads the row.
    RETURN jsonb_build_object('reserved', false, 'conflict', true, 'reason', 'duplicate_request_id');
  WHEN foreign_key_violation THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'invalid_counterparty');
END;
$$;
