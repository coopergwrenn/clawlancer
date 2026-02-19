-- Per-cycle heartbeat cap: limit each heartbeat cycle to 10 API calls max.
-- Previously heartbeats could make 50-60 calls per cycle (reading workspace,
-- running MCP tools, updating memory, etc.) which burned through budgets.
--
-- Also reduces daily heartbeat budget from 400 to 100 units.
-- With 10 calls/cycle × 8 cycles/day (3h interval) = 80, budget of 100 gives margin.

-- Track per-cycle heartbeat calls on the VM itself (not daily_usage)
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS heartbeat_cycle_calls INTEGER NOT NULL DEFAULT 0;

-- Update check_limit_only: reduce heartbeat budget 400 → 100
DROP FUNCTION IF EXISTS instaclaw_check_limit_only(UUID, TEXT, TEXT, BOOLEAN);

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
  heartbeat_budget INTEGER := 100;  -- was 400, reduced to match 10/cycle × 8 cycles
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
