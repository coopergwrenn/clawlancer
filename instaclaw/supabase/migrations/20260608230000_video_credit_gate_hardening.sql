-- Higgsfield video-credit gate — HARDENING (closes 2 flagged holes + 1 structural safety).
--
-- Follow-up to 20260608220000_video_credit_gate.sql (already applied to prod).
-- CREATE OR REPLACE only — no schema change, no destructive op, fully reversible
-- by re-applying the prior file's function bodies. Idempotent.
--
-- THREE changes, all in service of "real-money gate, zero corners cut":
--
--   (A) FREE-RETRY LEAK [reserve] — the free-allowance count previously counted
--       only status IN ('pending','settled'), so a FAILED/nsfw free job freed
--       the slot back → a user could retry free generation unboundedly, each
--       retry a real Higgsfield submission. FIX: count ATTEMPTS — every free row
--       created in today's window counts, regardless of terminal status. A
--       failed free job still consumed a real submission, so it spends a slot.
--       TRADE-OFF (documented): a genuine transient failure costs the user one
--       free slot for the day. Acceptable — bounds free submissions to the
--       allowance no matter the outcome; the alternative is unbounded free cost.
--       Future refinement (not now): exclude a distinct OUR-FAULT release reason.
--
--   (B) p_cap_daily FAILS OPEN [reserve] — the paid path enforced the ceiling
--       only `IF p_cap_daily IS NOT NULL`, so a NULL cap meant NO daily ceiling
--       (unbounded paid spend). FIX: fail CLOSED — a paid reserve with a NULL
--       cap is refused outright. The route ALWAYS passes a real cap (Rule 45
--       drift guard); a NULL here means a route bug, and we deny rather than
--       allow uncapped spend. Defense-in-depth behind the route's own guarantee.
--
--   (C) SETTLE CLAMP [settle] — the charge is now LEAST(passed_actual, est_credits),
--       i.e. the HELD amount is a HARD CEILING on the charge BY CONSTRUCTION. A
--       settle can never charge more than was reserved/authorized. This makes the
--       "hold >= charge" profitability invariant structural rather than trusted.
--       Behavior-preserving for correct inputs (cost is flat per model, so the
--       route passes actual == est == the held amount); strictly safer on any
--       future bug or variable-cost model. Same advisory-lock CAS as before.
--
-- RELEASE (3c) is UNCHANGED — re-stated below verbatim only for a single,
-- self-contained file; re-applying it is a no-op.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3a. RESERVE — (A) free counts attempts; (B) fail-closed on NULL paid cap.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION instaclaw_video_reserve_spend(
  p_vm_id                 uuid,
  p_request_id            text,
  p_endpoint              text,
  p_est_credits           numeric,
  p_hf_cost_credits       numeric,
  p_is_free               boolean,
  p_free_cap_daily        integer,
  p_cap_daily             numeric,
  p_window_start          timestamptz,
  p_fresh_pending_cutoff  timestamptz,
  p_metadata              jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance    numeric;
  v_holds      numeric;
  v_settled    numeric;
  v_free_used  integer;
  v_available  numeric;
  v_id         uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_vm_id::text));

  -- ── Free path: count ATTEMPTS (any free row today), then a zero-cost hold. ──
  IF p_is_free THEN
    SELECT COUNT(*) INTO v_free_used
    FROM instaclaw_video_transactions
    WHERE vm_id = p_vm_id
      AND is_free = true
      AND created_at >= p_window_start;   -- (A) all statuses: failed attempts still consume a slot
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

  -- ── Paid path. (B) Fail CLOSED if no daily ceiling was supplied. ──
  IF p_cap_daily IS NULL THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'no_cap_provided');
  END IF;

  -- Re-sum committed (settled + fresh pending) under the lock.
  SELECT COALESCE(SUM(est_credits), 0) INTO v_holds
  FROM instaclaw_video_transactions
  WHERE vm_id = p_vm_id AND is_free = false AND status = 'pending'
    AND created_at >= p_fresh_pending_cutoff;

  SELECT COALESCE(SUM(settled_credits), 0) INTO v_settled
  FROM instaclaw_video_transactions
  WHERE vm_id = p_vm_id AND is_free = false AND status = 'settled'
    AND created_at >= p_window_start;

  -- Per-VM daily paid ceiling (always bound now — NULL was rejected above).
  IF (v_settled + v_holds + p_est_credits) > p_cap_daily THEN
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
    RETURN jsonb_build_object('reserved', false, 'conflict', true, 'reason', 'duplicate_request_id');
  WHEN foreign_key_violation THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'invalid_vm');
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3b. SETTLE — (C) charge = LEAST(passed_actual, est_credits): the hold is a
--     HARD CEILING on the charge. Same advisory-lock single-winner CAS + debit.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION instaclaw_video_settle(
  p_vm_id           uuid,
  p_request_id      text,
  p_actual_credits  numeric,
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
  -- (C) charge is clamped to the row's held est_credits — never more than reserved.
  UPDATE instaclaw_video_transactions
     SET status          = 'settled',
         settled_credits = CASE WHEN is_free THEN 0
                                ELSE LEAST(GREATEST(p_actual_credits, 0), est_credits) END,
         settled_at      = now(),
         metadata        = metadata || COALESCE(p_metadata, '{}'::jsonb)
   WHERE vm_id = p_vm_id AND request_id = p_request_id AND status = 'pending'
   RETURNING id, is_free,
             CASE WHEN is_free THEN 0
                  ELSE LEAST(GREATEST(p_actual_credits, 0), est_credits) END
       INTO v_id, v_is_free, v_charge;

  IF v_id IS NULL THEN
    -- Lost the race or already terminal → idempotent: report current state.
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
-- 3c. RELEASE — UNCHANGED (re-stated for a self-contained file; no-op re-apply).
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
-- §ROLLBACK: re-apply 20260608220000_video_credit_gate.sql's function bodies
--   (the pre-hardening reserve/settle). No schema rollback needed.
-- ─────────────────────────────────────────────────────────────────────────────
