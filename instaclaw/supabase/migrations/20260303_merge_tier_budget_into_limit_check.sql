-- Merge tier budget check into instaclaw_check_limit_only.
--
-- Previously the proxy made TWO RPC calls per non-heartbeat request:
--   1. instaclaw_check_limit_only  (daily usage limit)
--   2. instaclaw_check_tier_budget (Sonnet/Opus budget)
--
-- This migration adds tier budget fields to instaclaw_check_limit_only
-- so one call returns both. Saves ~50-100ms latency per request.

DROP FUNCTION IF EXISTS instaclaw_check_limit_only(UUID, TEXT, TEXT, BOOLEAN, TEXT);

CREATE OR REPLACE FUNCTION instaclaw_check_limit_only(
  p_vm_id UUID,
  p_tier TEXT,
  p_model TEXT DEFAULT 'minimax-m2.5',
  p_is_heartbeat BOOLEAN DEFAULT false,
  p_timezone TEXT DEFAULT 'America/New_York'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  display_limit INTEGER;
  internal_limit INTEGER;
  heartbeat_budget INTEGER := 100;
  cost_weight NUMERIC;
  current_count NUMERIC;
  hb_count NUMERIC;
  vm_credits NUMERIC;
  today DATE := (NOW() AT TIME ZONE COALESCE(p_timezone, 'America/New_York'))::date;
  -- Tier budget vars
  sonnet_limit INTEGER;
  opus_limit INTEGER;
  used_tier_2 INTEGER := 0;
  used_tier_3 INTEGER := 0;
  tier_budget JSONB := '{}'::JSONB;
BEGIN
  -- Display limits (what the user sees)
  CASE p_tier
    WHEN 'starter' THEN display_limit := 600;
    WHEN 'pro'     THEN display_limit := 1000;
    WHEN 'power'   THEN display_limit := 2500;
    ELSE display_limit := 600;
  END CASE;

  internal_limit := display_limit + 200;

  -- Model cost weights: MiniMax=0.2, Haiku=1, Sonnet=4, Opus=19
  CASE
    WHEN p_model ILIKE '%minimax%' THEN cost_weight := 0.2;
    WHEN p_model ILIKE '%haiku%'   THEN cost_weight := 1;
    WHEN p_model ILIKE '%sonnet%'  THEN cost_weight := 4;
    WHEN p_model ILIKE '%opus%'    THEN cost_weight := 19;
    ELSE cost_weight := 1;
  END CASE;

  -- Read current counts (NO increment — read only)
  SELECT COALESCE(message_count, 0), COALESCE(heartbeat_count, 0)
  INTO current_count, hb_count
  FROM instaclaw_daily_usage
  WHERE vm_id = p_vm_id AND usage_date = today;

  IF current_count IS NULL THEN current_count := 0; END IF;
  IF hb_count IS NULL THEN hb_count := 0; END IF;

  -- Compute tier budget for non-heartbeat calls
  IF NOT p_is_heartbeat THEN
    CASE p_tier
      WHEN 'starter' THEN sonnet_limit := 30;  opus_limit := 5;
      WHEN 'pro'     THEN sonnet_limit := 75;  opus_limit := 15;
      WHEN 'power'   THEN sonnet_limit := 200; opus_limit := 40;
      ELSE sonnet_limit := 30; opus_limit := 5;
    END CASE;

    SELECT COALESCE(t.tier_2_calls, 0), COALESCE(t.tier_3_calls, 0)
    INTO used_tier_2, used_tier_3
    FROM instaclaw_model_tier_usage t
    WHERE t.vm_id = p_vm_id AND t.usage_date = today;

    IF used_tier_2 IS NULL THEN used_tier_2 := 0; END IF;
    IF used_tier_3 IS NULL THEN used_tier_3 := 0; END IF;

    tier_budget := jsonb_build_object(
      'tier_2_calls', used_tier_2,
      'tier_3_calls', used_tier_3,
      'sonnet_remaining', GREATEST(0, sonnet_limit - used_tier_2),
      'opus_remaining', GREATEST(0, opus_limit - used_tier_3)
    );
  END IF;

  -- === HEARTBEAT CALLS: separate budget, never touches display limit ===
  IF p_is_heartbeat THEN
    IF hb_count + cost_weight <= heartbeat_budget THEN
      RETURN jsonb_build_object(
        'allowed', true,
        'source', 'heartbeat',
        'count', hb_count,
        'limit', heartbeat_budget,
        'display_limit', display_limit,
        'cost_weight', cost_weight
      );
    ELSE
      RETURN jsonb_build_object(
        'allowed', false,
        'source', 'heartbeat_exhausted',
        'count', hb_count,
        'limit', heartbeat_budget,
        'display_limit', display_limit,
        'cost_weight', cost_weight
      );
    END IF;
  END IF;

  -- === USER CALLS: check display limit -> credits -> buffer -> hard block ===
  -- Each return includes tier budget via JSONB concatenation.

  -- 1. Within display limit
  IF current_count + cost_weight <= display_limit THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'source', 'daily_limit',
      'count', current_count,
      'limit', internal_limit,
      'display_limit', display_limit,
      'credits_remaining', COALESCE((SELECT credit_balance FROM instaclaw_vms WHERE id = p_vm_id), 0),
      'cost_weight', cost_weight
    ) || tier_budget;
  END IF;

  -- 2. Over display limit — check credits
  SELECT COALESCE(credit_balance, 0) INTO vm_credits
  FROM instaclaw_vms WHERE id = p_vm_id;

  IF vm_credits >= cost_weight THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'source', 'credits',
      'count', current_count,
      'limit', internal_limit,
      'display_limit', display_limit,
      'credits_remaining', vm_credits,
      'cost_weight', cost_weight
    ) || tier_budget;
  END IF;

  -- 3. No credits — within internal limit (buffer zone)
  IF current_count + cost_weight <= internal_limit THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'source', 'buffer',
      'count', current_count,
      'limit', internal_limit,
      'display_limit', display_limit,
      'credits_remaining', 0,
      'cost_weight', cost_weight
    ) || tier_budget;
  END IF;

  -- 4. Hard block
  RETURN jsonb_build_object(
    'allowed', false,
    'source', null,
    'count', current_count,
    'limit', internal_limit,
    'display_limit', display_limit,
    'credits_remaining', COALESCE(vm_credits, 0),
    'cost_weight', cost_weight
  ) || tier_budget;
END;
$$;
