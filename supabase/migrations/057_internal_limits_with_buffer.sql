-- 057_internal_limits_with_buffer.sql
-- Switch to internal limits that include the heartbeat buffer.
-- The proxy derives displayLimit = internalLimit - 100.
--
-- Display limits:  Starter=400, Pro=700, Power=2500
-- Internal limits: Starter=500, Pro=800, Power=2600
-- Cost weights:    Haiku=1, Sonnet=4, Opus=19

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
  -- Internal tier limits (display + 100 heartbeat buffer)
  -- Display: Starter=400, Pro=700, Power=2500
  CASE p_tier
    WHEN 'starter' THEN daily_limit := 500;
    WHEN 'pro'     THEN daily_limit := 800;
    WHEN 'power'   THEN daily_limit := 2600;
    ELSE daily_limit := 500;
  END CASE;

  -- Model cost weights (match Anthropic pricing ratios)
  -- Haiku: $0.0028/call, Sonnet: $0.0105/call (3.75x), Opus: $0.0525/call (18.75x)
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
