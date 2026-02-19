-- Separate heartbeat budget: heartbeat calls get their own 400-unit/day budget
-- and never touch the user's display limit. This prevents heartbeats from
-- eating the user's daily credits.

-- Add heartbeat_count column to track heartbeat usage separately
ALTER TABLE instaclaw_daily_usage
  ADD COLUMN IF NOT EXISTS heartbeat_count INTEGER NOT NULL DEFAULT 0;

-- Drop old function signatures to avoid overload ambiguity
DROP FUNCTION IF EXISTS instaclaw_check_limit_only(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS instaclaw_increment_usage(UUID, TEXT);

-- Recreate check_limit_only with p_is_heartbeat parameter
CREATE OR REPLACE FUNCTION instaclaw_check_limit_only(
  p_vm_id UUID,
  p_tier TEXT,
  p_model TEXT DEFAULT 'claude-haiku-4-5-20251001',
  p_is_heartbeat BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  display_limit INTEGER;
  internal_limit INTEGER;
  heartbeat_budget INTEGER := 400;
  cost_weight INTEGER;
  current_count INTEGER;
  hb_count INTEGER;
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

  internal_limit := display_limit + 200;

  -- Model cost weights
  CASE
    WHEN p_model ILIKE '%haiku%'  THEN cost_weight := 1;
    WHEN p_model ILIKE '%sonnet%' THEN cost_weight := 4;
    WHEN p_model ILIKE '%opus%'   THEN cost_weight := 19;
    ELSE cost_weight := 4;
  END CASE;

  -- Read current counts (NO increment — read only)
  SELECT COALESCE(message_count, 0), COALESCE(heartbeat_count, 0)
  INTO current_count, hb_count
  FROM instaclaw_daily_usage
  WHERE vm_id = p_vm_id AND usage_date = today;

  IF current_count IS NULL THEN current_count := 0; END IF;
  IF hb_count IS NULL THEN hb_count := 0; END IF;

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
      -- Heartbeat budget exhausted — deny silently
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

  -- === USER CALLS: check display limit → credits → buffer → hard block ===

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
    );
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
    );
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
    );
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
  );
END;
$$;

-- Recreate increment_usage with p_is_heartbeat parameter
CREATE OR REPLACE FUNCTION instaclaw_increment_usage(
  p_vm_id UUID,
  p_model TEXT DEFAULT 'claude-haiku-4-5-20251001',
  p_is_heartbeat BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  cost_weight INTEGER;
  new_count INTEGER;
  display_limit INTEGER;
  vm_tier TEXT;
  vm_credits INTEGER;
  today DATE := CURRENT_DATE;
  current_count INTEGER;
BEGIN
  -- Model cost weights
  CASE
    WHEN p_model ILIKE '%haiku%'  THEN cost_weight := 1;
    WHEN p_model ILIKE '%sonnet%' THEN cost_weight := 4;
    WHEN p_model ILIKE '%opus%'   THEN cost_weight := 19;
    ELSE cost_weight := 4;
  END CASE;

  -- HEARTBEAT: increment heartbeat_count only, never touches message_count
  IF p_is_heartbeat THEN
    INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count)
    VALUES (p_vm_id, today, 0, cost_weight)
    ON CONFLICT (vm_id, usage_date)
    DO UPDATE SET heartbeat_count = instaclaw_daily_usage.heartbeat_count + cost_weight,
                  updated_at = NOW()
    RETURNING heartbeat_count INTO new_count;

    RETURN jsonb_build_object(
      'incremented', true,
      'cost_weight', cost_weight,
      'new_count', new_count,
      'is_heartbeat', true
    );
  END IF;

  -- USER: existing logic — increment message_count, deduct credits if needed
  SELECT COALESCE(tier, 'starter') INTO vm_tier
  FROM instaclaw_vms WHERE id = p_vm_id;

  CASE vm_tier
    WHEN 'starter' THEN display_limit := 600;
    WHEN 'pro'     THEN display_limit := 1000;
    WHEN 'power'   THEN display_limit := 2500;
    ELSE display_limit := 600;
  END CASE;

  -- Get current count to determine if we need credits
  SELECT COALESCE(message_count, 0) INTO current_count
  FROM instaclaw_daily_usage
  WHERE vm_id = p_vm_id AND usage_date = today;

  IF current_count IS NULL THEN current_count := 0; END IF;

  -- If over display limit, deduct from credits
  IF current_count + cost_weight > display_limit THEN
    SELECT COALESCE(credit_balance, 0) INTO vm_credits
    FROM instaclaw_vms WHERE id = p_vm_id;

    IF vm_credits >= cost_weight THEN
      UPDATE instaclaw_vms
      SET credit_balance = credit_balance - cost_weight
      WHERE id = p_vm_id;
    END IF;
  END IF;

  -- Increment user usage counter
  INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count)
  VALUES (p_vm_id, today, cost_weight, 0)
  ON CONFLICT (vm_id, usage_date)
  DO UPDATE SET message_count = instaclaw_daily_usage.message_count + cost_weight,
                updated_at = NOW()
  RETURNING message_count INTO new_count;

  RETURN jsonb_build_object(
    'incremented', true,
    'cost_weight', cost_weight,
    'new_count', new_count,
    'is_heartbeat', false
  );
END;
$$;
