-- ─────────────────────────────────────────────────────────────────────────────
-- Video free-allowance counter fix — exclude released/failed holds.
--
-- THE BUG (2026-06-10, found during the higgsfield-cloud e2e canary on vm-050):
--   The free-allowance counter in instaclaw_video_reserve_spend counted free
--   rows of ANY status, including 'failed'. The G11 stale-hold sweeper
--   (cron/higgsfield-sweep) released two orphaned holds from earlier testing to
--   status='failed' (release_reason='swept_orphan_ttl'). Those two refunded,
--   nothing-delivered rows then counted against vm-050's starter free cap (2),
--   so the next free image submit hit free_exhausted -> paid path -> balance 0
--   -> insufficient_credits. The agent then silently fell back to the legacy
--   muapi skill. Two systems, one resource (Rule 25): the sweeper writes
--   status='failed'; this counter read status to count slots; they collided.
--
-- THE FIX (Option A, Cooper's ruling): count ONLY status IN ('pending','settled').
--   A released/failed hold delivered nothing and was refunded, so it must NEVER
--   consume the free allowance — regardless of WHY it was released.
--
--   Rejected the alternative (exclude specific release_reason values like
--   'swept_orphan_ttl'): release-reason string-matching is the same fragile
--   coupling that caused this bug — the next new release_reason value would
--   silently reintroduce it. If free-tier abuse (e.g. spamming nsfw to farm
--   retries) ever appears, it gets its own NAMED per-VM rate limit as a
--   distinct mechanism, NOT a side effect of failure-counting.
--
-- Function-only change (CREATE OR REPLACE). No schema change. The only
-- difference from 20260608230000's reserve fn is the free-count WHERE clause
-- (marked (A) below). Everything else is byte-identical.
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

  -- ── Free path: count CONSUMED slots, then a zero-cost hold. ──
  IF p_is_free THEN
    SELECT COUNT(*) INTO v_free_used
    FROM instaclaw_video_transactions
    WHERE vm_id = p_vm_id
      AND is_free = true
      AND status IN ('pending','settled')  -- (A) FIX 2026-06-10: only CONSUMED slots count.
      AND created_at >= p_window_start;     --     A released/failed hold (sweeper, submit_failed,
                                            --     nsfw, provider failure) delivered nothing + was
                                            --     refunded, so it must NOT burn the allowance.
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
