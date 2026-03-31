-- C5 FIX: Atomic check-and-increment to eliminate race condition.
-- Combines instaclaw_check_limit_only + instaclaw_increment_usage into
-- a single RPC call. The check and increment happen in ONE transaction
-- so two concurrent requests can't both pass the check.
--
-- The gateway proxy should call this INSTEAD of the two separate RPCs.
-- Returns { allowed: bool, incremented: bool, ... } — if not allowed,
-- no increment happens.

CREATE OR REPLACE FUNCTION instaclaw_check_and_increment(
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
  new_count NUMERIC;
  vm_tier TEXT;
  today DATE := (NOW() AT TIME ZONE COALESCE(p_timezone, 'America/New_York'))::date;
  -- Subscription check
  vm_user_id UUID;
  sub_status TEXT;
  has_active_sub BOOLEAN := false;
BEGIN
  -- Lock the VM row to prevent concurrent modifications
  PERFORM 1 FROM instaclaw_vms WHERE id = p_vm_id FOR UPDATE;

  -- Subscription status check (C2)
  SELECT assigned_to INTO vm_user_id FROM instaclaw_vms WHERE id = p_vm_id;
  IF vm_user_id IS NOT NULL THEN
    SELECT status INTO sub_status FROM instaclaw_subscriptions WHERE user_id = vm_user_id LIMIT 1;
    has_active_sub := sub_status IN ('active', 'trialing');
  END IF;

  -- Model cost
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

  -- If no active subscription, only allow with overflow credits
  IF vm_user_id IS NOT NULL AND NOT has_active_sub AND sub_status IS NOT NULL THEN
    SELECT COALESCE(credit_balance, 0) INTO vm_credits FROM instaclaw_vms WHERE id = p_vm_id;
    IF vm_credits >= cost_weight THEN
      -- Deduct credits and increment usage atomically
      UPDATE instaclaw_vms SET credit_balance = credit_balance - cost_weight WHERE id = p_vm_id;

      IF p_is_heartbeat THEN
        INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count, virtuals_count)
        VALUES (p_vm_id, today, 0, cost_weight, 0)
        ON CONFLICT (vm_id, usage_date) DO UPDATE SET heartbeat_count = instaclaw_daily_usage.heartbeat_count + cost_weight, updated_at = NOW();
      ELSIF p_is_virtuals THEN
        INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count, virtuals_count)
        VALUES (p_vm_id, today, 0, 0, cost_weight)
        ON CONFLICT (vm_id, usage_date) DO UPDATE SET virtuals_count = instaclaw_daily_usage.virtuals_count + cost_weight, updated_at = NOW();
      ELSE
        INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count, virtuals_count)
        VALUES (p_vm_id, today, cost_weight, 0, 0)
        ON CONFLICT (vm_id, usage_date) DO UPDATE SET message_count = instaclaw_daily_usage.message_count + cost_weight, updated_at = NOW();
      END IF;

      RETURN jsonb_build_object(
        'allowed', true, 'incremented', true, 'source', 'credits_only_no_sub',
        'cost_weight', cost_weight, 'credits_remaining', vm_credits - cost_weight,
        'subscription_status', sub_status
      );
    ELSE
      RETURN jsonb_build_object(
        'allowed', false, 'incremented', false, 'source', 'no_active_subscription',
        'cost_weight', cost_weight, 'credits_remaining', vm_credits,
        'subscription_status', sub_status
      );
    END IF;
  END IF;

  -- Normal flow: active/trialing subscriber
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

  SELECT COALESCE(message_count, 0), COALESCE(heartbeat_count, 0), COALESCE(virtuals_count, 0)
  INTO current_count, hb_count, virt_count
  FROM instaclaw_daily_usage WHERE vm_id = p_vm_id AND usage_date = today;
  IF current_count IS NULL THEN current_count := 0; END IF;
  IF hb_count IS NULL THEN hb_count := 0; END IF;
  IF virt_count IS NULL THEN virt_count := 0; END IF;

  -- Virtuals
  IF p_is_virtuals THEN
    IF virt_count + cost_weight <= virtuals_limit THEN
      INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count, virtuals_count)
      VALUES (p_vm_id, today, 0, 0, cost_weight)
      ON CONFLICT (vm_id, usage_date) DO UPDATE SET virtuals_count = instaclaw_daily_usage.virtuals_count + cost_weight, updated_at = NOW()
      RETURNING virtuals_count INTO new_count;
      RETURN jsonb_build_object('allowed', true, 'incremented', true, 'source', 'virtuals', 'cost_weight', cost_weight, 'new_count', new_count);
    ELSE
      RETURN jsonb_build_object('allowed', false, 'incremented', false, 'source', 'virtuals_exhausted', 'cost_weight', cost_weight);
    END IF;
  END IF;

  -- Heartbeat
  IF p_is_heartbeat THEN
    IF hb_count + cost_weight <= heartbeat_budget THEN
      INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count, virtuals_count)
      VALUES (p_vm_id, today, 0, cost_weight, 0)
      ON CONFLICT (vm_id, usage_date) DO UPDATE SET heartbeat_count = instaclaw_daily_usage.heartbeat_count + cost_weight, updated_at = NOW()
      RETURNING heartbeat_count INTO new_count;
      RETURN jsonb_build_object('allowed', true, 'incremented', true, 'source', 'heartbeat', 'cost_weight', cost_weight, 'new_count', new_count);
    ELSE
      RETURN jsonb_build_object('allowed', false, 'incremented', false, 'source', 'heartbeat_exhausted', 'cost_weight', cost_weight);
    END IF;
  END IF;

  -- User messages: daily limit -> credits -> buffer -> block
  IF current_count + cost_weight <= display_limit THEN
    INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count, virtuals_count)
    VALUES (p_vm_id, today, cost_weight, 0, 0)
    ON CONFLICT (vm_id, usage_date) DO UPDATE SET message_count = instaclaw_daily_usage.message_count + cost_weight, updated_at = NOW()
    RETURNING message_count INTO new_count;
    RETURN jsonb_build_object('allowed', true, 'incremented', true, 'source', 'daily_limit', 'cost_weight', cost_weight, 'new_count', new_count, 'display_limit', display_limit);
  END IF;

  -- Over daily limit: try credits
  SELECT COALESCE(credit_balance, 0) INTO vm_credits FROM instaclaw_vms WHERE id = p_vm_id;
  IF vm_credits >= cost_weight THEN
    UPDATE instaclaw_vms SET credit_balance = credit_balance - cost_weight WHERE id = p_vm_id;
    INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count, virtuals_count)
    VALUES (p_vm_id, today, cost_weight, 0, 0)
    ON CONFLICT (vm_id, usage_date) DO UPDATE SET message_count = instaclaw_daily_usage.message_count + cost_weight, updated_at = NOW()
    RETURNING message_count INTO new_count;
    RETURN jsonb_build_object('allowed', true, 'incremented', true, 'source', 'credits', 'cost_weight', cost_weight, 'new_count', new_count, 'credits_remaining', vm_credits - cost_weight);
  END IF;

  -- No credits: buffer zone
  IF current_count + cost_weight <= internal_limit THEN
    INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count, virtuals_count)
    VALUES (p_vm_id, today, cost_weight, 0, 0)
    ON CONFLICT (vm_id, usage_date) DO UPDATE SET message_count = instaclaw_daily_usage.message_count + cost_weight, updated_at = NOW()
    RETURNING message_count INTO new_count;
    RETURN jsonb_build_object('allowed', true, 'incremented', true, 'source', 'buffer', 'cost_weight', cost_weight, 'new_count', new_count);
  END IF;

  -- Hard block
  RETURN jsonb_build_object('allowed', false, 'incremented', false, 'source', 'exhausted', 'cost_weight', cost_weight, 'credits_remaining', COALESCE(vm_credits, 0));
END;
$$;
