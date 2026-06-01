-- ToolRouter v1 — sponsored-tier allocation + in-chat upsell + call log.
-- PRD: instaclaw/docs/prd/toolrouter-integration.md §7.11 Task K.1 + K.3.
--
-- Per Rule 56: lives in pending_migrations/ until applied to prod via
-- Supabase Studio, then `git mv` to migrations/. Per Rule 60: every
-- new table has ENABLE ROW LEVEL SECURITY in the same file.

-- ── instaclaw_users — five new columns for per-user allocation state ──
ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS toolrouter_balance INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS toolrouter_grant_override INTEGER,
  ADD COLUMN IF NOT EXISTS toolrouter_grant_period_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS toolrouter_80pct_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS toolrouter_topup_balance INTEGER NOT NULL DEFAULT 0;
-- toolrouter_balance         monthly-included grant remaining (resets on month boundary)
-- toolrouter_grant_override  NULL → tier default; INTEGER → operator-set override
-- toolrouter_grant_period_start  NOW() on first grant; rolled monthly per user.timezone
-- toolrouter_80pct_notified_at   NULL → not yet hinted this period (M2 idempotency)
-- toolrouter_topup_balance   purchased Stripe top-up packs (NEVER resets; stacks)

-- instaclaw_users already has RLS (Rule 60 covered).

-- ── instaclaw_toolrouter_call_log — per-call audit trail ──
CREATE TABLE IF NOT EXISTS public.instaclaw_toolrouter_call_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.instaclaw_users(id) ON DELETE CASCADE,
  vm_id UUID REFERENCES public.instaclaw_vms(id) ON DELETE SET NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  endpoint_id TEXT NOT NULL,
  -- path: agentkit | agentkit_to_x402 | x402 | dev_stub | timeout
  path TEXT NOT NULL,
  charged BOOLEAN NOT NULL,
  amount_usd NUMERIC(8, 4),
  weight INTEGER NOT NULL DEFAULT 0,
  -- allocation_source: sponsored_agentkit | sponsored_paid | topup_paid |
  --                    post_hoc_exceeded | toolrouter_unavailable | blocked_daily_cap
  allocation_source TEXT NOT NULL,
  http_code INTEGER,
  latency_ms INTEGER,
  error_class TEXT,
  trace_id TEXT
);

ALTER TABLE public.instaclaw_toolrouter_call_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS instaclaw_toolrouter_call_log_user_ts_idx
  ON public.instaclaw_toolrouter_call_log (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS instaclaw_toolrouter_call_log_vm_ts_idx
  ON public.instaclaw_toolrouter_call_log (vm_id, ts DESC);
CREATE INDEX IF NOT EXISTS instaclaw_toolrouter_call_log_alloc_ts_idx
  ON public.instaclaw_toolrouter_call_log (allocation_source, ts DESC);

-- ── RPC: consume premium-search weight (atomic check-and-decrement) ──
-- Source-of-truth for allocation deductions. See PRD §7.11 Task K.3 for
-- the rationale (tier-aware lookup, monthly reset, tier-change edge
-- cases, optimistic-concurrency `allowed=false` for post-hoc check).
CREATE OR REPLACE FUNCTION public.instaclaw_consume_toolrouter_searches(
  p_user_id UUID,
  p_weight INTEGER,
  p_endpoint_id TEXT,
  p_charged BOOLEAN,
  p_trace_id TEXT
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
BEGIN
  -- charged=false → sponsored by AgentKit, no decrement
  IF NOT p_charged THEN
    RETURN json_build_object('allowed', true, 'balance_after', NULL,
      'allocation_source', 'sponsored_agentkit', 'hit_80pct', false);
  END IF;

  SELECT * INTO v_user FROM public.instaclaw_users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('allowed', false, 'error', 'no_user');
  END IF;

  -- Commercial tier from instaclaw_subscriptions (canonical per access-control-credits-upgrade.md §2.3).
  SELECT COALESCE(s.tier, 'starter') INTO v_tier
  FROM public.instaclaw_subscriptions s
  WHERE s.user_id = p_user_id
  LIMIT 1;
  v_tier := COALESCE(v_tier, 'starter');

  -- Tier-default grant. Mirrors TOOLROUTER_TIER_GRANTS in lib/toolrouter-credits.ts.
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

  -- Tier-change edge-case handling (Issue 6 from PM-6 review).
  IF v_balance > v_grant THEN
    -- Downgrade: cap balance to new lower grant.
    UPDATE public.instaclaw_users
      SET toolrouter_balance = v_grant
      WHERE id = p_user_id;
    v_balance := v_grant;
  ELSIF v_balance < v_grant
        AND v_period_start IS NOT NULL
        AND v_user.toolrouter_80pct_notified_at IS NOT NULL THEN
    -- Upgrade: bump balance to new higher grant immediately.
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
    -- Post-hoc check fired (call already made, wrapper paid the platform
    -- credit balance). Wrapper logs as 'post_hoc_exceeded' and delivers
    -- the result anyway. See PRD §5.3.5 wrapper-ordering for rationale.
    RETURN json_build_object('allowed', false, 'balance_after', v_balance,
      'topup_after', v_topup, 'allocation_source', 'blocked',
      'weight_required', p_weight,
      'note', 'post_hoc_check_only_call_already_made');
  END IF;

  RETURN json_build_object('allowed', true, 'balance_after', v_balance,
    'topup_after', v_topup, 'allocation_source', v_alloc_source,
    'hit_80pct', v_hit_80, 'tier', v_tier, 'tier_grant', v_tier_grant);
END $$;

-- ── RPC: add purchased premium-searches (Stripe webhook hook) ──
CREATE OR REPLACE FUNCTION public.instaclaw_add_toolrouter_searches(
  p_user_id UUID,
  p_credits INTEGER
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.instaclaw_users
    SET toolrouter_topup_balance = toolrouter_topup_balance + p_credits
    WHERE id = p_user_id;
END $$;
