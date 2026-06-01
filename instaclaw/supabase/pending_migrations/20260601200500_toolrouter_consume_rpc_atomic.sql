-- ToolRouter v1.5 — K.4 wrapper atomicity guarantee.
--
-- The K.4 wrapper's POST to /api/agent/toolrouter/record-usage needs both
-- the call_log insert AND the balance decrement to be atomic. The v1 RPC
-- only did the decrement; the endpoint would have needed to do the insert
-- separately, opening these failure modes:
--   - Insert OK, RPC fails → row exists, user not decremented (lost meter)
--   - RPC OK, insert fails → user decremented, no audit row (lost trace)
--   - Concurrent same-trace_id → both decrement, one insert fails → double-charge
--
-- This migration extends instaclaw_consume_toolrouter_searches to take six
-- additional OPTIONAL params (DEFAULT NULL for backward compat with the
-- 5-arg verifier probe in scripts/_verify-toolrouter-canary.ts) and folds
-- the call_log INSERT into the same transaction as the decrement. A
-- function call is one transaction; the INSERT and UPDATE roll back
-- together on any error.
--
-- Idempotency: the function checks call_log for the trace_id at the top.
-- If a row already exists, it returns {idempotent_replay: true} without
-- decrementing or inserting. This handles wrapper retries and the cron
-- backstop touching the same row twice.
--
-- Belt-and-suspenders: the partial UNIQUE index from migration
-- 20260601200000 (call_log.trace_id WHERE NOT NULL) catches concurrent
-- inserts that race past the SELECT-LIMIT-1 check. The losing call gets
-- a 23505 from the INSERT inside the function and the whole transaction
-- (including the balance decrement) rolls back atomically.
--
-- Per Rule 56: lives in pending_migrations/ until Cooper applies via
-- Supabase Studio.

-- Drop the v1 signature (5 args). Required because PostgreSQL treats
-- different argument counts as different functions; CREATE OR REPLACE
-- only replaces an identical signature. The new 11-arg version with
-- defaults remains callable with 5 named args (PostgreSQL fills defaults
-- in by name), so the verifier probe continues to work.
DROP FUNCTION IF EXISTS public.instaclaw_consume_toolrouter_searches(
  UUID, INTEGER, TEXT, BOOLEAN, TEXT
);

CREATE OR REPLACE FUNCTION public.instaclaw_consume_toolrouter_searches(
  p_user_id UUID,
  p_weight INTEGER,
  p_endpoint_id TEXT,
  p_charged BOOLEAN,
  p_trace_id TEXT,
  -- New optional params (K.4 wrapper). NULL defaults preserve the
  -- _verify-toolrouter-canary.ts probe shape (calls with 5 named args).
  p_vm_id UUID DEFAULT NULL,
  p_path TEXT DEFAULT NULL,
  p_status_code INTEGER DEFAULT NULL,
  p_latency_ms INTEGER DEFAULT NULL,
  p_error_class TEXT DEFAULT NULL,
  p_amount_usd NUMERIC DEFAULT NULL
) RETURNS JSON LANGUAGE plpgsql AS $$
DECLARE
  v_user RECORD;
  v_tier TEXT;
  v_tier_grant INTEGER;
  v_grant INTEGER;
  v_now TIMESTAMPTZ := NOW();
  v_balance INTEGER;
  v_topup INTEGER;
  v_period_start TIMESTAMPTZ;
  v_alloc_source TEXT;
  v_hit_80 BOOLEAN := FALSE;
  v_existing_alloc TEXT;
BEGIN
  -- ── Idempotency gate (top-level) ──
  -- If trace_id is given and we've already logged a call with that
  -- trace_id, treat this as a replay. Returns the prior allocation_source
  -- so the wrapper can echo it back to the agent if needed.
  IF p_trace_id IS NOT NULL THEN
    SELECT allocation_source INTO v_existing_alloc
    FROM public.instaclaw_toolrouter_call_log
    WHERE trace_id = p_trace_id
    LIMIT 1;

    IF FOUND THEN
      RETURN json_build_object(
        'allowed', true,
        'idempotent_replay', true,
        'allocation_source', v_existing_alloc
      );
    END IF;
  END IF;

  -- ── Sponsored AgentKit path: no decrement, log only ──
  -- charged=false means the call went through AgentKit's free quota
  -- on toolrouter.world. We still log it for the audit trail.
  IF NOT p_charged THEN
    v_alloc_source := 'sponsored_agentkit';

    INSERT INTO public.instaclaw_toolrouter_call_log (
      user_id, vm_id, ts, endpoint_id, path, charged, amount_usd, weight,
      allocation_source, http_code, latency_ms, error_class, trace_id
    ) VALUES (
      p_user_id, p_vm_id, v_now, p_endpoint_id, COALESCE(p_path, 'agentkit'),
      false, p_amount_usd, p_weight, v_alloc_source, p_status_code,
      p_latency_ms, p_error_class, p_trace_id
    );

    RETURN json_build_object(
      'allowed', true,
      'balance_after', NULL,
      'allocation_source', v_alloc_source,
      'hit_80pct', false
    );
  END IF;

  -- ── Charged path: lock user row, resolve tier, decrement ──
  SELECT * INTO v_user FROM public.instaclaw_users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('allowed', false, 'error', 'no_user');
  END IF;

  -- Commercial tier from instaclaw_subscriptions.
  SELECT COALESCE(s.tier, 'starter') INTO v_tier
  FROM public.instaclaw_subscriptions s
  WHERE s.user_id = p_user_id
  LIMIT 1;
  v_tier := COALESCE(v_tier, 'starter');

  -- Tier-default grant. Mirrors TOOLROUTER_TIER_GRANTS in
  -- lib/toolrouter-credits.ts. Section 7 of _verify-toolrouter-canary.ts
  -- enforces the TS/SQL drift catcher across these two sources.
  v_tier_grant := CASE v_tier
    WHEN 'power'      THEN 1500
    WHEN 'pro'        THEN 400
    WHEN 'starter'    THEN 60
    WHEN 'free_trial' THEN 20
    WHEN 'byok'       THEN 60
    ELSE 60
  END;
  v_grant := COALESCE(v_user.toolrouter_grant_override, v_tier_grant);
  v_period_start := v_user.toolrouter_grant_period_start;

  -- Monthly reset (timezone-aware).
  IF v_period_start IS NULL OR
     (v_now AT TIME ZONE COALESCE(v_user.timezone, 'UTC')) -
     (v_period_start AT TIME ZONE COALESCE(v_user.timezone, 'UTC'))
     >= INTERVAL '1 month' THEN
    UPDATE public.instaclaw_users
      SET toolrouter_balance = v_grant,
          toolrouter_grant_period_start = v_now,
          toolrouter_80pct_notified_at = NULL
      WHERE id = p_user_id;
    v_user.toolrouter_balance := v_grant;
  END IF;

  v_balance := v_user.toolrouter_balance;

  -- Tier-change edge-case handling (downgrade caps, upgrade bumps).
  IF v_balance > v_grant THEN
    UPDATE public.instaclaw_users
      SET toolrouter_balance = v_grant
      WHERE id = p_user_id;
    v_balance := v_grant;
  ELSIF v_balance < v_grant
        AND v_period_start IS NOT NULL
        AND v_user.toolrouter_80pct_notified_at IS NOT NULL THEN
    UPDATE public.instaclaw_users
      SET toolrouter_balance = v_grant,
          toolrouter_80pct_notified_at = NULL
      WHERE id = p_user_id;
    v_balance := v_grant;
  END IF;

  v_topup := v_user.toolrouter_topup_balance;

  IF v_balance >= p_weight THEN
    UPDATE public.instaclaw_users
      SET toolrouter_balance = toolrouter_balance - p_weight
      WHERE id = p_user_id;
    v_alloc_source := 'sponsored_paid';
    v_balance := v_balance - p_weight;
    IF (v_grant - v_balance)::FLOAT / GREATEST(v_grant, 1) >= 0.80
       AND v_user.toolrouter_80pct_notified_at IS NULL THEN
      UPDATE public.instaclaw_users
        SET toolrouter_80pct_notified_at = v_now
        WHERE id = p_user_id;
      v_hit_80 := TRUE;
    END IF;
  ELSIF v_topup >= p_weight THEN
    UPDATE public.instaclaw_users
      SET toolrouter_topup_balance = toolrouter_topup_balance - p_weight
      WHERE id = p_user_id;
    v_alloc_source := 'topup_paid';
    v_topup := v_topup - p_weight;
  ELSE
    -- Post-hoc check: call already happened (the wrapper observed a
    -- successful response from toolrouter), wrapper paid the platform
    -- credit balance, but the user doesn't have allocation for it.
    -- Log it as 'post_hoc_exceeded' (still a real call that landed) and
    -- return blocked so the wrapper can flag for human review.
    v_alloc_source := 'post_hoc_exceeded';

    INSERT INTO public.instaclaw_toolrouter_call_log (
      user_id, vm_id, ts, endpoint_id, path, charged, amount_usd, weight,
      allocation_source, http_code, latency_ms, error_class, trace_id
    ) VALUES (
      p_user_id, p_vm_id, v_now, p_endpoint_id, COALESCE(p_path, 'unknown'),
      true, p_amount_usd, p_weight, v_alloc_source, p_status_code,
      p_latency_ms, p_error_class, p_trace_id
    );

    RETURN json_build_object(
      'allowed', false,
      'balance_after', v_balance,
      'topup_after', v_topup,
      'allocation_source', v_alloc_source,
      'weight_required', p_weight,
      'note', 'post_hoc_exceeded_call_already_made'
    );
  END IF;

  -- Successful charged path: log + return.
  INSERT INTO public.instaclaw_toolrouter_call_log (
    user_id, vm_id, ts, endpoint_id, path, charged, amount_usd, weight,
    allocation_source, http_code, latency_ms, error_class, trace_id
  ) VALUES (
    p_user_id, p_vm_id, v_now, p_endpoint_id, COALESCE(p_path, 'unknown'),
    true, p_amount_usd, p_weight, v_alloc_source, p_status_code,
    p_latency_ms, p_error_class, p_trace_id
  );

  RETURN json_build_object(
    'allowed', true,
    'balance_after', v_balance,
    'topup_after', v_topup,
    'allocation_source', v_alloc_source,
    'hit_80pct', v_hit_80,
    'tier', v_tier,
    'tier_grant', v_tier_grant
  );
END $$;

COMMENT ON FUNCTION public.instaclaw_consume_toolrouter_searches(
  UUID, INTEGER, TEXT, BOOLEAN, TEXT, UUID, TEXT, INTEGER, INTEGER, TEXT, NUMERIC
) IS
  'K.4 wrapper consume + atomic call_log insert. Idempotent on trace_id.
   Backward-compatible with 5-arg verifier probe via named-default args.
   The wrapper POSTs to /api/agent/toolrouter/record-usage which calls
   this single RPC — no separate INSERT needed at the endpoint layer.';
