-- Split instaclaw_check_daily_limit into check-only + increment-only.
--
-- Problem: the old RPC increments usage atomically BEFORE the API call,
-- so failed requests (4xx/5xx from Anthropic) still burn daily limits.
--
-- New flow:
--   1. instaclaw_check_limit_only  — read-only, returns allowed/source/count
--   2. Proxy forwards to Anthropic
--   3. instaclaw_increment_usage   — called ONLY on 2xx success
--
-- The old instaclaw_check_daily_limit is left untouched for backward compat.

-- ============================================================
-- 1. CHECK-ONLY: returns the same JSONB shape but never writes
-- ============================================================
CREATE OR REPLACE FUNCTION instaclaw_check_limit_only(
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
  CASE
    WHEN p_model ILIKE '%haiku%'  THEN cost_weight := 1;
    WHEN p_model ILIKE '%sonnet%' THEN cost_weight := 4;
    WHEN p_model ILIKE '%opus%'   THEN cost_weight := 19;
    ELSE cost_weight := 4;
  END CASE;

  -- Read current count (NO increment)
  SELECT COALESCE(message_count, 0) INTO current_count
  FROM instaclaw_daily_usage
  WHERE vm_id = p_vm_id AND usage_date = today;

  IF current_count IS NULL THEN current_count := 0; END IF;

  -- 1. Within display limit — allowed via daily_limit
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
$$ LANGUAGE plpgsql STABLE;


-- ============================================================
-- 2. INCREMENT-ONLY: called after successful Anthropic response
-- ============================================================
CREATE OR REPLACE FUNCTION instaclaw_increment_usage(
  p_vm_id UUID,
  p_model TEXT DEFAULT 'claude-haiku-4-5-20251001'
)
RETURNS JSONB AS $$
DECLARE
  cost_weight INTEGER;
  new_count INTEGER;
  display_limit INTEGER;
  vm_tier TEXT;
  vm_credits INTEGER;
  today DATE := CURRENT_DATE;
  current_count INTEGER;
BEGIN
  -- Look up tier for this VM
  SELECT COALESCE(tier, 'starter') INTO vm_tier
  FROM instaclaw_vms WHERE id = p_vm_id;

  -- Display limits
  CASE vm_tier
    WHEN 'starter' THEN display_limit := 600;
    WHEN 'pro'     THEN display_limit := 1000;
    WHEN 'power'   THEN display_limit := 2500;
    ELSE display_limit := 600;
  END CASE;

  -- Model cost weights
  CASE
    WHEN p_model ILIKE '%haiku%'  THEN cost_weight := 1;
    WHEN p_model ILIKE '%sonnet%' THEN cost_weight := 4;
    WHEN p_model ILIKE '%opus%'   THEN cost_weight := 19;
    ELSE cost_weight := 4;
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
    -- If no credits, it's buffer zone — still increment for tracking
  END IF;

  -- Increment usage counter
  INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count)
  VALUES (p_vm_id, today, cost_weight)
  ON CONFLICT (vm_id, usage_date)
  DO UPDATE SET message_count = instaclaw_daily_usage.message_count + cost_weight,
                updated_at = NOW()
  RETURNING message_count INTO new_count;

  RETURN jsonb_build_object(
    'incremented', true,
    'cost_weight', cost_weight,
    'new_count', new_count
  );
END;
$$ LANGUAGE plpgsql;
