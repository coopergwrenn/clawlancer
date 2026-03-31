-- C2 FIX: Add subscription status check to instaclaw_check_limit_only.
-- Past-due and canceled users should NOT receive daily credits.
-- Only users with active/trialing subscriptions OR purchased credits (WLD)
-- should be allowed through.
--
-- Logic:
-- 1. Look up subscription status via vm -> assigned_to -> instaclaw_subscriptions
-- 2. If subscription is past_due or canceled, only allow if user has overflow credits
-- 3. Active/trialing subscriptions get normal daily limits

DROP FUNCTION IF EXISTS instaclaw_check_limit_only(UUID, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN, BOOLEAN);

CREATE OR REPLACE FUNCTION instaclaw_check_limit_only(
  p_vm_id UUID,
  p_tier TEXT,
  p_model TEXT DEFAULT 'minimax-m2.5',
  p_is_heartbeat BOOLEAN DEFAULT false,
  p_timezone TEXT DEFAULT 'America/New_York',
  p_is_virtuals BOOLEAN DEFAULT false,
  p_is_tool_continuation BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  display_limit INTEGER;
  internal_limit INTEGER;
  heartbeat_budget INTEGER := 100;
  virtuals_limit INTEGER;
  cost_weight NUMERIC;
  current_count NUMERIC;
  hb_count NUMERIC;
  virt_count NUMERIC;
  vm_credits NUMERIC;
  today DATE := (NOW() AT TIME ZONE COALESCE(p_timezone, 'America/New_York'))::date;
  sonnet_limit INTEGER;
  opus_limit INTEGER;
  used_tier_2 INTEGER := 0;
  used_tier_3 INTEGER := 0;
  tier_budget JSONB := '{}'::JSONB;
  -- C2: Subscription status vars
  vm_user_id UUID;
  sub_status TEXT;
  has_active_sub BOOLEAN := false;
BEGIN
  -- C2 FIX: Check subscription status
  SELECT assigned_to INTO vm_user_id FROM instaclaw_vms WHERE id = p_vm_id;

  IF vm_user_id IS NOT NULL THEN
    SELECT status INTO sub_status
    FROM instaclaw_subscriptions
    WHERE user_id = vm_user_id
    LIMIT 1;

    has_active_sub := sub_status IN ('active', 'trialing');
  END IF;

  -- If subscription is past_due or canceled, only allow if user has overflow credits
  IF vm_user_id IS NOT NULL AND NOT has_active_sub AND sub_status IS NOT NULL THEN
    SELECT COALESCE(credit_balance, 0) INTO vm_credits
    FROM instaclaw_vms WHERE id = p_vm_id;

    -- Model cost weights (need to compute for credit check)
    CASE
      WHEN p_model ILIKE '%minimax%' THEN cost_weight := 0.2;
      WHEN p_model ILIKE '%haiku%'   THEN cost_weight := 1;
      WHEN p_model ILIKE '%sonnet%'  THEN cost_weight := 4;
      WHEN p_model ILIKE '%opus%'    THEN cost_weight := 19;
      ELSE cost_weight := 1;
    END CASE;

    IF p_is_tool_continuation THEN
      cost_weight := cost_weight * 0.2;
    END IF;

    -- Allow heartbeats to still work if credits remain (keeps agent alive to report status)
    IF p_is_heartbeat THEN
      IF vm_credits >= cost_weight THEN
        RETURN jsonb_build_object(
          'allowed', true,
          'source', 'credits_only_no_sub',
          'credits_remaining', vm_credits,
          'cost_weight', cost_weight,
          'subscription_status', sub_status
        );
      ELSE
        RETURN jsonb_build_object(
          'allowed', false,
          'source', 'no_active_subscription',
          'credits_remaining', vm_credits,
          'cost_weight', cost_weight,
          'subscription_status', sub_status
        );
      END IF;
    END IF;

    -- For user messages: allow ONLY if they have enough overflow credits
    IF vm_credits >= cost_weight THEN
      RETURN jsonb_build_object(
        'allowed', true,
        'source', 'credits_only_no_sub',
        'count', 0,
        'limit', 0,
        'display_limit', 0,
        'credits_remaining', vm_credits,
        'cost_weight', cost_weight,
        'subscription_status', sub_status
      );
    ELSE
      RETURN jsonb_build_object(
        'allowed', false,
        'source', 'no_active_subscription',
        'count', 0,
        'limit', 0,
        'display_limit', 0,
        'credits_remaining', vm_credits,
        'cost_weight', cost_weight,
        'subscription_status', sub_status
      );
    END IF;
  END IF;

  -- === Normal flow for active/trialing subscribers (or no subscription record = WLD-only users) ===

  CASE p_tier
    WHEN 'starter' THEN display_limit := 600;
    WHEN 'pro'     THEN display_limit := 1000;
    WHEN 'power'   THEN display_limit := 2500;
    ELSE display_limit := 600;
  END CASE;

  internal_limit := display_limit + 200;

  CASE p_tier
    WHEN 'starter' THEN virtuals_limit := 100;
    WHEN 'pro'     THEN virtuals_limit := 300;
    WHEN 'power'   THEN virtuals_limit := 1000;
    ELSE virtuals_limit := 100;
  END CASE;

  CASE
    WHEN p_model ILIKE '%minimax%' THEN cost_weight := 0.2;
    WHEN p_model ILIKE '%haiku%'   THEN cost_weight := 1;
    WHEN p_model ILIKE '%sonnet%'  THEN cost_weight := 4;
    WHEN p_model ILIKE '%opus%'    THEN cost_weight := 19;
    ELSE cost_weight := 1;
  END CASE;

  IF p_is_tool_continuation THEN
    cost_weight := cost_weight * 0.2;
  END IF;

  SELECT COALESCE(message_count, 0), COALESCE(heartbeat_count, 0), COALESCE(virtuals_count, 0)
  INTO current_count, hb_count, virt_count
  FROM instaclaw_daily_usage
  WHERE vm_id = p_vm_id AND usage_date = today;

  IF current_count IS NULL THEN current_count := 0; END IF;
  IF hb_count IS NULL THEN hb_count := 0; END IF;
  IF virt_count IS NULL THEN virt_count := 0; END IF;

  IF NOT p_is_heartbeat AND NOT p_is_virtuals THEN
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

  IF p_is_virtuals THEN
    IF virt_count + cost_weight <= virtuals_limit THEN
      RETURN jsonb_build_object(
        'allowed', true, 'source', 'virtuals', 'count', virt_count,
        'limit', virtuals_limit, 'display_limit', display_limit,
        'cost_weight', cost_weight, 'virtuals_count', virt_count,
        'virtuals_limit', virtuals_limit
      );
    ELSE
      RETURN jsonb_build_object(
        'allowed', false, 'source', 'virtuals_exhausted', 'count', virt_count,
        'limit', virtuals_limit, 'display_limit', display_limit,
        'cost_weight', cost_weight, 'virtuals_count', virt_count,
        'virtuals_limit', virtuals_limit
      );
    END IF;
  END IF;

  IF p_is_heartbeat THEN
    IF hb_count + cost_weight <= heartbeat_budget THEN
      RETURN jsonb_build_object(
        'allowed', true, 'source', 'heartbeat', 'count', hb_count,
        'limit', heartbeat_budget, 'display_limit', display_limit,
        'cost_weight', cost_weight
      );
    ELSE
      RETURN jsonb_build_object(
        'allowed', false, 'source', 'heartbeat_exhausted', 'count', hb_count,
        'limit', heartbeat_budget, 'display_limit', display_limit,
        'cost_weight', cost_weight
      );
    END IF;
  END IF;

  IF current_count + cost_weight <= display_limit THEN
    RETURN jsonb_build_object(
      'allowed', true, 'source', 'daily_limit', 'count', current_count,
      'limit', internal_limit, 'display_limit', display_limit,
      'credits_remaining', COALESCE((SELECT credit_balance FROM instaclaw_vms WHERE id = p_vm_id), 0),
      'cost_weight', cost_weight
    ) || tier_budget;
  END IF;

  SELECT COALESCE(credit_balance, 0) INTO vm_credits
  FROM instaclaw_vms WHERE id = p_vm_id;

  IF vm_credits >= cost_weight THEN
    RETURN jsonb_build_object(
      'allowed', true, 'source', 'credits', 'count', current_count,
      'limit', internal_limit, 'display_limit', display_limit,
      'credits_remaining', vm_credits, 'cost_weight', cost_weight
    ) || tier_budget;
  END IF;

  IF current_count + cost_weight <= internal_limit THEN
    RETURN jsonb_build_object(
      'allowed', true, 'source', 'buffer', 'count', current_count,
      'limit', internal_limit, 'display_limit', display_limit,
      'credits_remaining', 0, 'cost_weight', cost_weight
    ) || tier_budget;
  END IF;

  RETURN jsonb_build_object(
    'allowed', false, 'source', null, 'count', current_count,
    'limit', internal_limit, 'display_limit', display_limit,
    'credits_remaining', COALESCE(vm_credits, 0), 'cost_weight', cost_weight
  ) || tier_budget;
END;
$$;
