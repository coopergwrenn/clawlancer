-- Add user_timezone column to instaclaw_users and instaclaw_vms.
--
-- Daily usage resets at UTC midnight, which means US users (PST = UTC-8)
-- see their counter reset at 4 PM local time. Evening usage burns
-- tomorrow's budget. Fix: reset at each user's local midnight.
--
-- Default is America/New_York since the user base is US-heavy.

-- 1. Add timezone columns
ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS user_timezone TEXT DEFAULT 'America/New_York';

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS user_timezone TEXT DEFAULT 'America/New_York';

-- 2. Backfill existing rows
UPDATE instaclaw_users SET user_timezone = 'America/New_York' WHERE user_timezone IS NULL;
UPDATE instaclaw_vms SET user_timezone = 'America/New_York' WHERE user_timezone IS NULL;

-- 3. Recreate instaclaw_check_limit_only with p_timezone parameter
DROP FUNCTION IF EXISTS instaclaw_check_limit_only(UUID, TEXT, TEXT, BOOLEAN);

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

-- 4. Recreate instaclaw_increment_usage with p_timezone parameter
DROP FUNCTION IF EXISTS instaclaw_increment_usage(UUID, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION instaclaw_increment_usage(
  p_vm_id UUID,
  p_model TEXT DEFAULT 'minimax-m2.5',
  p_is_heartbeat BOOLEAN DEFAULT false,
  p_timezone TEXT DEFAULT 'America/New_York'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  cost_weight NUMERIC;
  new_count NUMERIC;
  display_limit INTEGER;
  vm_tier TEXT;
  vm_credits NUMERIC;
  today DATE := (NOW() AT TIME ZONE COALESCE(p_timezone, 'America/New_York'))::date;
  current_count NUMERIC;
BEGIN
  -- Model cost weights: MiniMax=0.2, Haiku=1, Sonnet=4, Opus=19
  CASE
    WHEN p_model ILIKE '%minimax%' THEN cost_weight := 0.2;
    WHEN p_model ILIKE '%haiku%'   THEN cost_weight := 1;
    WHEN p_model ILIKE '%sonnet%'  THEN cost_weight := 4;
    WHEN p_model ILIKE '%opus%'    THEN cost_weight := 19;
    ELSE cost_weight := 1;
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
