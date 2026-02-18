-- Raise display limits: Starter 400→600, Pro 700→1000, Power unchanged.
-- Credits now kick in at the display limit (not internal), so credit packs
-- give immediate value instead of requiring the buffer to be exhausted first.
-- Returns 'source' field: 'daily_limit' | 'credits' | 'buffer' | null (denied).

CREATE OR REPLACE FUNCTION instaclaw_check_daily_limit(
  p_vm_id UUID,
  p_tier TEXT,
  p_model TEXT DEFAULT 'claude-haiku-4-5-20251001'
)
RETURNS JSONB AS $$
DECLARE
  display_limit INTEGER;
  internal_limit INTEGER;
  cost_weight INTEGER;
  current_count INTEGER;
  vm_credits INTEGER;
  today DATE := CURRENT_DATE;
BEGIN
  -- Display limits (what the user sees)
  CASE p_tier
    WHEN 'starter' THEN display_limit := 600;
    WHEN 'pro'     THEN display_limit := 1000;
    WHEN 'power'   THEN display_limit := 2500;
    ELSE display_limit := 600;
  END CASE;

  -- Internal limit = display + 200 heartbeat buffer
  internal_limit := display_limit + 200;

  -- Model cost weights (reflect Anthropic pricing ratios)
  -- Haiku: $0.0028/call, Sonnet: $0.0105/call (3.75x), Opus: $0.0525/call (18.75x)
  CASE
    WHEN p_model ILIKE '%haiku%'  THEN cost_weight := 1;
    WHEN p_model ILIKE '%sonnet%' THEN cost_weight := 4;
    WHEN p_model ILIKE '%opus%'   THEN cost_weight := 19;
    ELSE cost_weight := 4;
  END CASE;

  -- Read current count (no increment yet)
  SELECT COALESCE(message_count, 0) INTO current_count
  FROM instaclaw_daily_usage
  WHERE vm_id = p_vm_id AND usage_date = today;

  IF current_count IS NULL THEN current_count := 0; END IF;

  -- 1. Within display limit — increment and allow
  IF current_count + cost_weight <= display_limit THEN
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
      'limit', internal_limit,
      'display_limit', display_limit,
      'credits_remaining', COALESCE((SELECT credit_balance FROM instaclaw_vms WHERE id = p_vm_id), 0),
      'cost_weight', cost_weight
    );
  END IF;

  -- 2. Over display limit — try credits first
  SELECT COALESCE(credit_balance, 0) INTO vm_credits
  FROM instaclaw_vms WHERE id = p_vm_id;

  IF vm_credits >= cost_weight THEN
    -- Deduct from credits, still track usage
    UPDATE instaclaw_vms
    SET credit_balance = credit_balance - cost_weight
    WHERE id = p_vm_id;

    INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count)
    VALUES (p_vm_id, today, cost_weight)
    ON CONFLICT (vm_id, usage_date)
    DO UPDATE SET message_count = instaclaw_daily_usage.message_count + cost_weight,
                  updated_at = NOW()
    RETURNING message_count INTO current_count;

    RETURN jsonb_build_object(
      'allowed', true,
      'source', 'credits',
      'count', current_count,
      'limit', internal_limit,
      'display_limit', display_limit,
      'credits_remaining', vm_credits - cost_weight,
      'cost_weight', cost_weight
    );
  END IF;

  -- 3. No credits — within internal limit (buffer zone for heartbeats)
  IF current_count + cost_weight <= internal_limit THEN
    INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count)
    VALUES (p_vm_id, today, cost_weight)
    ON CONFLICT (vm_id, usage_date)
    DO UPDATE SET message_count = instaclaw_daily_usage.message_count + cost_weight,
                  updated_at = NOW()
    RETURNING message_count INTO current_count;

    RETURN jsonb_build_object(
      'allowed', true,
      'source', 'buffer',
      'count', current_count,
      'limit', internal_limit,
      'display_limit', display_limit,
      'credits_remaining', 0,
      'cost_weight', cost_weight
    );
  END IF;

  -- 4. Hard block — everything exhausted
  RETURN jsonb_build_object(
    'allowed', false,
    'source', null,
    'count', current_count,
    'limit', internal_limit,
    'display_limit', display_limit,
    'credits_remaining', COALESCE(vm_credits, 0),
    'cost_weight', cost_weight
  );
END;
$$ LANGUAGE plpgsql;
