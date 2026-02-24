-- Model tier usage tracking for intelligent routing.
--
-- Tracks per-VM, per-day usage by model tier (Haiku/Sonnet/Opus)
-- so the router can enforce daily tier budgets and gracefully
-- downgrade when budgets are exhausted.
--
-- Also adds RPCs for checking tier budget and incrementing tier usage,
-- integrated alongside the existing limit check / increment flow.

-- ============================================================
-- 1. New table: instaclaw_model_tier_usage
-- ============================================================
CREATE TABLE IF NOT EXISTS instaclaw_model_tier_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vm_id UUID NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  tier_1_calls INTEGER NOT NULL DEFAULT 0,
  tier_2_calls INTEGER NOT NULL DEFAULT 0,
  tier_3_calls INTEGER NOT NULL DEFAULT 0,
  tier_1_cost NUMERIC NOT NULL DEFAULT 0,
  tier_2_cost NUMERIC NOT NULL DEFAULT 0,
  tier_3_cost NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vm_id, usage_date)
);

-- Index for fast lookups by vm_id + date
CREATE INDEX IF NOT EXISTS idx_model_tier_usage_vm_date
  ON instaclaw_model_tier_usage(vm_id, usage_date);

-- ============================================================
-- 2. RPC: instaclaw_check_tier_budget (read-only)
-- Returns remaining Sonnet and Opus calls for today.
-- ============================================================
CREATE OR REPLACE FUNCTION instaclaw_check_tier_budget(
  p_vm_id UUID,
  p_tier TEXT DEFAULT 'starter',
  p_timezone TEXT DEFAULT 'America/New_York'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  sonnet_limit INTEGER;
  opus_limit INTEGER;
  used_tier_2 INTEGER;
  used_tier_3 INTEGER;
  today DATE := (NOW() AT TIME ZONE COALESCE(p_timezone, 'America/New_York'))::date;
BEGIN
  -- Per-tier daily limits by subscription
  CASE p_tier
    WHEN 'starter' THEN sonnet_limit := 30;  opus_limit := 5;
    WHEN 'pro'     THEN sonnet_limit := 75;  opus_limit := 15;
    WHEN 'power'   THEN sonnet_limit := 200; opus_limit := 40;
    ELSE sonnet_limit := 30; opus_limit := 5;
  END CASE;

  -- Read current tier usage
  SELECT COALESCE(tier_2_calls, 0), COALESCE(tier_3_calls, 0)
  INTO used_tier_2, used_tier_3
  FROM instaclaw_model_tier_usage
  WHERE vm_id = p_vm_id AND usage_date = today;

  IF used_tier_2 IS NULL THEN used_tier_2 := 0; END IF;
  IF used_tier_3 IS NULL THEN used_tier_3 := 0; END IF;

  RETURN jsonb_build_object(
    'sonnet_remaining', GREATEST(0, sonnet_limit - used_tier_2),
    'opus_remaining', GREATEST(0, opus_limit - used_tier_3),
    'tier_2_calls', used_tier_2,
    'tier_3_calls', used_tier_3,
    'sonnet_limit', sonnet_limit,
    'opus_limit', opus_limit
  );
END;
$$;

-- ============================================================
-- 3. RPC: instaclaw_increment_tier_usage
-- Increments tier counters after a successful response.
-- ============================================================
CREATE OR REPLACE FUNCTION instaclaw_increment_tier_usage(
  p_vm_id UUID,
  p_tier_level INTEGER,  -- 1, 2, or 3
  p_cost_weight NUMERIC DEFAULT 1,
  p_timezone TEXT DEFAULT 'America/New_York'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  today DATE := (NOW() AT TIME ZONE COALESCE(p_timezone, 'America/New_York'))::date;
  new_calls INTEGER;
BEGIN
  -- Upsert the tier usage row
  INSERT INTO instaclaw_model_tier_usage (vm_id, usage_date)
  VALUES (p_vm_id, today)
  ON CONFLICT (vm_id, usage_date) DO NOTHING;

  -- Increment the appropriate tier counter
  IF p_tier_level = 1 THEN
    UPDATE instaclaw_model_tier_usage
    SET tier_1_calls = tier_1_calls + 1,
        tier_1_cost = tier_1_cost + p_cost_weight,
        updated_at = NOW()
    WHERE vm_id = p_vm_id AND usage_date = today
    RETURNING tier_1_calls INTO new_calls;
  ELSIF p_tier_level = 2 THEN
    UPDATE instaclaw_model_tier_usage
    SET tier_2_calls = tier_2_calls + 1,
        tier_2_cost = tier_2_cost + p_cost_weight,
        updated_at = NOW()
    WHERE vm_id = p_vm_id AND usage_date = today
    RETURNING tier_2_calls INTO new_calls;
  ELSIF p_tier_level = 3 THEN
    UPDATE instaclaw_model_tier_usage
    SET tier_3_calls = tier_3_calls + 1,
        tier_3_cost = tier_3_cost + p_cost_weight,
        updated_at = NOW()
    WHERE vm_id = p_vm_id AND usage_date = today
    RETURNING tier_3_calls INTO new_calls;
  ELSE
    RETURN jsonb_build_object('error', 'invalid tier_level');
  END IF;

  RETURN jsonb_build_object(
    'incremented', true,
    'tier_level', p_tier_level,
    'new_calls', COALESCE(new_calls, 0)
  );
END;
$$;
