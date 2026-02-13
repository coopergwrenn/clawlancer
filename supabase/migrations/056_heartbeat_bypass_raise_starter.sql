-- 056_heartbeat_bypass_raise_starter.sql
-- Raise Starter limit to 400, remove heartbeat buffer from RPC.
-- Heartbeats now bypass the proxy limit check entirely (X-Heartbeat header),
-- so the RPC limits are the actual display limits.
--   Starter: 400 (was 300 = 200 display + 100 buffer)
--   Pro:     700 (was 800 = 700 + 100 buffer)
--   Power:  2500 (was 2600 = 2500 + 100 buffer)
-- Cost weights unchanged: Haiku=1, Sonnet=4, Opus=19

CREATE OR REPLACE FUNCTION instaclaw_check_daily_limit(
  p_vm_id UUID,
  p_tier TEXT,
  p_model TEXT DEFAULT 'claude-haiku-4-5-20251001'
)
RETURNS JSONB AS $$
DECLARE
  daily_limit INTEGER;
  cost_weight INTEGER;
  current_count INTEGER;
  vm_credits INTEGER;
  today DATE := CURRENT_DATE;
BEGIN
  -- Tier limits (actual display limits — heartbeats bypass the proxy)
  CASE p_tier
    WHEN 'starter' THEN daily_limit := 400;
    WHEN 'pro'     THEN daily_limit := 700;
    WHEN 'power'   THEN daily_limit := 2500;
    ELSE daily_limit := 400;
  END CASE;

  -- Model cost weights (match Anthropic pricing ratios)
  CASE
    WHEN p_model ILIKE '%haiku%'  THEN cost_weight := 1;
    WHEN p_model ILIKE '%sonnet%' THEN cost_weight := 4;
    WHEN p_model ILIKE '%opus%'   THEN cost_weight := 19;
    ELSE cost_weight := 4;  -- default to sonnet-level
  END CASE;

  -- Get current count (without incrementing yet)
  SELECT COALESCE(message_count, 0) INTO current_count
  FROM instaclaw_daily_usage
  WHERE vm_id = p_vm_id AND usage_date = today;

  IF current_count IS NULL THEN
    current_count := 0;
  END IF;

  -- Check if adding this message would exceed the daily limit
  IF current_count + cost_weight > daily_limit THEN
    -- Over daily limit — check credit balance
    SELECT COALESCE(credit_balance, 0) INTO vm_credits
    FROM instaclaw_vms
    WHERE id = p_vm_id;

    IF vm_credits >= cost_weight THEN
      -- Deduct from credits and allow
      UPDATE instaclaw_vms
      SET credit_balance = credit_balance - cost_weight
      WHERE id = p_vm_id;

      -- Still increment usage for tracking
      INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count)
      VALUES (p_vm_id, today, cost_weight)
      ON CONFLICT (vm_id, usage_date)
      DO UPDATE SET message_count = instaclaw_daily_usage.message_count + cost_weight,
                    updated_at = NOW();

      RETURN jsonb_build_object(
        'allowed', true,
        'source', 'credits',
        'count', current_count + cost_weight,
        'limit', daily_limit,
        'credits_remaining', vm_credits - cost_weight,
        'cost_weight', cost_weight
      );
    ELSE
      -- No credits — deny
      RETURN jsonb_build_object(
        'allowed', false,
        'count', current_count,
        'limit', daily_limit,
        'credits_remaining', vm_credits,
        'cost_weight', cost_weight
      );
    END IF;
  END IF;

  -- Within daily limit — increment and allow
  INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count)
  VALUES (p_vm_id, today, cost_weight)
  ON CONFLICT (vm_id, usage_date)
  DO UPDATE SET message_count = instaclaw_daily_usage.message_count + cost_weight,
                updated_at = NOW()
  RETURNING message_count INTO current_count;

  RETURN jsonb_build_object(
    'allowed', true,
    'source', 'daily_limit',
    'count', current_count,
    'limit', daily_limit,
    'credits_remaining', COALESCE((SELECT credit_balance FROM instaclaw_vms WHERE id = p_vm_id), 0),
    'cost_weight', cost_weight
  );
END;
$$ LANGUAGE plpgsql;
