-- Higgsfield video-credit spend gate — schema + atomic reserve/settle/release.
--
-- Faithful mirror of the Frontier spend pattern (20260602210000_frontier_reserve_spend.sql
-- + frontier_transactions in 20260601000000_frontier_economy.sql):
--   * per-VM serialization via pg_advisory_xact_lock(hashtext(vm_id)) — same lock model.
--   * UNIQUE (vm_id, request_id) idempotency; reserve catches unique_violation.
--   * committed = settled + FRESH pending (TTL cutoff PASSED IN by the route, Rule 45 drift guard).
--   * caps PASSED IN by the route (no magic numbers in SQL).
-- DIFFERENCE FROM FRONTIER (justified): Frontier has no stored balance (budget is computed),
-- so it settles in the route. We hold against a stored prepaid balance (video_credit_balance),
-- so balance MUST move atomically with the status flip → settle/release are RPCs that do the
-- compare-and-set AND the balance debit under the same advisory lock. Balance is debited ONLY
-- at settle (reserve just records a pending hold; available = balance − outstanding fresh holds).
--
-- KEYING: per-VM (matches frontier_transactions.vm_id + instaclaw_vms.credit_balance).
-- RULE 56: staged in pending_migrations/. Apply to prod, THEN git-mv to migrations/.
-- RULE 60: new table ENABLEs RLS (service-role only; deny-all baseline for anon/auth).
-- REVERSIBLE: only ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE
--   FUNCTION / CREATE INDEX IF NOT EXISTS. No destructive ops. Rollback = §ROLLBACK at bottom.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Per-VM video-credit balance (mirror credit_balance's NUMERIC type exactly).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS video_credit_balance NUMERIC NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Hold ledger (mirror frontier_transactions; the table IS the audit trail).
--    est_credits  = held amount in OUR video-credits (charged at settle for paid).
--    settled_credits = actually charged at settle (0 for free or failed).
--    hf_cost_credits = the Higgsfield credit cost (for margin reconciliation only).
--    is_free      = drawn from the per-tier daily free allowance (charges 0).
--    status: pending → settled (charged) | failed (released, no charge).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS instaclaw_video_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id       text NOT NULL,                              -- Higgsfield request_id = idempotency key
  vm_id            uuid NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  endpoint         text NOT NULL,                              -- Cloud model slug (validated allowlist)
  est_credits      numeric NOT NULL DEFAULT 0 CHECK (est_credits >= 0),     -- held (our video-credits)
  settled_credits  numeric CHECK (settled_credits IS NULL OR settled_credits >= 0),
  hf_cost_credits  numeric CHECK (hf_cost_credits IS NULL OR hf_cost_credits >= 0),
  is_free          boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','settled','failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  settled_at       timestamptz,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (vm_id, request_id)
);

CREATE INDEX IF NOT EXISTS instaclaw_video_tx_vm_created_idx
  ON instaclaw_video_transactions (vm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS instaclaw_video_tx_status_idx
  ON instaclaw_video_transactions (status, created_at DESC);

ALTER TABLE instaclaw_video_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instaclaw_video_transactions_service ON instaclaw_video_transactions;
CREATE POLICY instaclaw_video_transactions_service ON instaclaw_video_transactions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3a. RESERVE — atomic hold. Mirrors frontier_reserve_spend exactly:
--     advisory xact lock → re-sum committed (settled + fresh pending) under lock →
--     enforce caps + balance → insert pending. Idempotent on (vm_id, request_id).
--     Free path: atomic per-tier daily free-count check (so concurrent free jobs
--     cannot exceed the allowance); free holds charge 0 and don't touch balance.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION instaclaw_video_reserve_spend(
  p_vm_id                 uuid,
  p_request_id            text,
  p_endpoint              text,
  p_est_credits           numeric,      -- our video-credits to hold (paid path)
  p_hf_cost_credits       numeric,      -- Higgsfield credit cost (recon only)
  p_is_free               boolean,      -- route's free-vs-paid intent
  p_free_cap_daily        integer,      -- per-tier daily free-job allowance (count)
  p_cap_daily             numeric,      -- per-VM daily paid credit ceiling (nullable → no cap)
  p_window_start          timestamptz,  -- start of "today" window (route-computed)
  p_fresh_pending_cutoff  timestamptz,  -- stale-hold TTL cutoff (route-computed)
  p_metadata              jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance    numeric;
  v_holds      numeric;   -- outstanding fresh PAID pending holds (count against balance/cap)
  v_settled    numeric;   -- PAID settled today (count against cap)
  v_free_used  integer;   -- FRESH free jobs today (count against free allowance)
  v_available  numeric;
  v_id         uuid;
BEGIN
  -- Serialize concurrent reserves for THIS vm (txn-scoped; auto-released at commit).
  PERFORM pg_advisory_xact_lock(hashtext(p_vm_id::text));

  -- ── Free path: atomic free-allowance count, then a zero-cost hold. ──
  IF p_is_free THEN
    SELECT COUNT(*) INTO v_free_used
    FROM instaclaw_video_transactions
    WHERE vm_id = p_vm_id
      AND is_free = true
      AND created_at >= p_window_start
      AND status IN ('pending','settled');   -- failed (released) frees the slot back
    IF v_free_used >= COALESCE(p_free_cap_daily, 0) THEN
      RETURN jsonb_build_object('reserved', false, 'reason', 'free_exhausted', 'free_used', v_free_used);
    END IF;

    INSERT INTO instaclaw_video_transactions
      (request_id, vm_id, endpoint, est_credits, hf_cost_credits, is_free, status, metadata)
    VALUES
      (p_request_id, p_vm_id, p_endpoint, 0, p_hf_cost_credits, true, 'pending', p_metadata)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('reserved', true, 'id', v_id, 'free', true, 'free_used', v_free_used + 1);
  END IF;

  -- ── Paid path: re-sum committed (settled + fresh pending) under the lock. ──
  SELECT COALESCE(SUM(est_credits), 0) INTO v_holds
  FROM instaclaw_video_transactions
  WHERE vm_id = p_vm_id AND is_free = false AND status = 'pending'
    AND created_at >= p_fresh_pending_cutoff;

  SELECT COALESCE(SUM(settled_credits), 0) INTO v_settled
  FROM instaclaw_video_transactions
  WHERE vm_id = p_vm_id AND is_free = false AND status = 'settled'
    AND created_at >= p_window_start;

  -- Per-VM daily paid ceiling — binds when supplied (mirrors frontier hard cap).
  IF p_cap_daily IS NOT NULL AND (v_settled + v_holds + p_est_credits) > p_cap_daily THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'exceeds_daily_ceiling',
                              'committed', v_settled + v_holds);
  END IF;

  -- Balance gate — available = balance − outstanding fresh paid holds.
  SELECT video_credit_balance INTO v_balance FROM instaclaw_vms WHERE id = p_vm_id;
  v_available := COALESCE(v_balance, 0) - v_holds;
  IF p_est_credits > v_available THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'insufficient_balance',
                              'available', v_available, 'required', p_est_credits);
  END IF;

  INSERT INTO instaclaw_video_transactions
    (request_id, vm_id, endpoint, est_credits, hf_cost_credits, is_free, status, metadata)
  VALUES
    (p_request_id, p_vm_id, p_endpoint, p_est_credits, p_hf_cost_credits, false, 'pending', p_metadata)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('reserved', true, 'id', v_id, 'held', p_est_credits,
                            'available_before', v_available);
EXCEPTION
  WHEN unique_violation THEN
    -- (vm_id, request_id) already exists — idempotent retry; caller re-reads the row.
    RETURN jsonb_build_object('reserved', false, 'conflict', true, 'reason', 'duplicate_request_id');
  WHEN foreign_key_violation THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'invalid_vm');
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3b. SETTLE — compare-and-set pending→settled + atomic balance debit.
--     Single-winner on status='pending' (mirrors the frontier settle CAS). Paid
--     holds debit video_credit_balance by p_actual_credits; free holds charge 0.
--     Idempotent: a second settle of an already-terminal row is a no-op success.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION instaclaw_video_settle(
  p_vm_id           uuid,
  p_request_id      text,
  p_actual_credits  numeric,   -- our video-credits to charge (paid); ignored if is_free
  p_metadata        jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_free  boolean;
  v_charge   numeric;
  v_new_bal  numeric;
  v_id       uuid;
  v_status   text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_vm_id::text));

  -- Atomic compare-and-set: only the call that flips pending→settled wins.
  UPDATE instaclaw_video_transactions
     SET status          = 'settled',
         settled_credits = CASE WHEN is_free THEN 0 ELSE GREATEST(p_actual_credits, 0) END,
         settled_at      = now(),
         metadata        = metadata || COALESCE(p_metadata, '{}'::jsonb)
   WHERE vm_id = p_vm_id AND request_id = p_request_id AND status = 'pending'
   RETURNING id, is_free,
             CASE WHEN is_free THEN 0 ELSE GREATEST(p_actual_credits, 0) END
       INTO v_id, v_is_free, v_charge;

  IF v_id IS NULL THEN
    -- Lost the race or already terminal → idempotent: report the current state.
    SELECT status INTO v_status FROM instaclaw_video_transactions
      WHERE vm_id = p_vm_id AND request_id = p_request_id;
    RETURN jsonb_build_object('settled', v_status = 'settled', 'idempotent', true,
                              'reason', COALESCE(v_status, 'not_found'));
  END IF;

  -- Debit balance only for paid holds; free holds cost the user nothing.
  IF NOT v_is_free AND v_charge > 0 THEN
    UPDATE instaclaw_vms
       SET video_credit_balance = video_credit_balance - v_charge
     WHERE id = p_vm_id
     RETURNING video_credit_balance INTO v_new_bal;
  ELSE
    SELECT video_credit_balance INTO v_new_bal FROM instaclaw_vms WHERE id = p_vm_id;
  END IF;

  RETURN jsonb_build_object('settled', true, 'charged', v_charge,
                            'was_free', v_is_free, 'new_balance', v_new_bal);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3c. RELEASE — pending→failed, no charge (failed / nsfw / cancelled). Frees the
--     hold; balance was never debited (debit happens only at settle). Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION instaclaw_video_release(
  p_vm_id       uuid,
  p_request_id  text,
  p_reason      text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_vm_id::text));

  UPDATE instaclaw_video_transactions
     SET status          = 'failed',
         settled_credits = 0,
         settled_at      = now(),
         metadata        = metadata || jsonb_build_object('release_reason', p_reason)
   WHERE vm_id = p_vm_id AND request_id = p_request_id AND status = 'pending'
   RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('released', false, 'idempotent', true, 'reason', 'not_pending');
  END IF;
  RETURN jsonb_build_object('released', true);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- §ROLLBACK (manual, if ever needed — none of the above is destructive):
--   DROP FUNCTION IF EXISTS instaclaw_video_release(uuid,text);
--   DROP FUNCTION IF EXISTS instaclaw_video_settle(uuid,text,numeric,jsonb);
--   DROP FUNCTION IF EXISTS instaclaw_video_reserve_spend(uuid,text,text,numeric,numeric,boolean,integer,numeric,timestamptz,timestamptz,jsonb);
--   DROP TABLE IF EXISTS instaclaw_video_transactions;
--   ALTER TABLE instaclaw_vms DROP COLUMN IF EXISTS video_credit_balance;
-- ─────────────────────────────────────────────────────────────────────────────
