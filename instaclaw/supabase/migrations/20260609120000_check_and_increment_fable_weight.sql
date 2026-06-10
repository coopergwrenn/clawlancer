-- D1 step (a): close the Fable under-bill leak in the daily-grant governor.
--
-- instaclaw_check_and_increment is THE governor: it decrements the daily grant
-- (display_limit 600/1000/2500) by a per-model cost_weight computed from the
-- model string. Before this migration, "claude-fable-5" matched none of the
-- minimax/haiku/sonnet/opus ILIKE branches and fell to ELSE -> 1, so a served
-- Fable message would decrement the grant by 1 instead of its real 38 weight
-- (serve the priciest model, charge the cheapest). This adds the missing Fable
-- branch.
--
-- INERT + NON-RIPPLING by construction: this is a single additive WHEN placed
-- before the ELSE. minimax/haiku/sonnet/opus still match their own branches
-- first (unchanged), so every existing model's weight is byte-identical. The
-- ONLY behavior change is that a p_model containing "fable" now yields 38
-- instead of 1 -- and nothing serves Fable to a credit user until D1 step (c)
-- (the modal). The weight (38) mirrors lib/model-registry.ts:getRegistryCreditWeight
-- ("claude-fable-5" -> 38); keep the two in sync if Fable's weight ever changes.
--
-- The rest of the function is copied verbatim from
-- 20260410b_remove_buffer_zone.sql (the current live definition). Only line 49
-- (the new Fable WHEN) is added.
--
-- Apply: paste into Supabase Studio SQL editor (prod), confirm success, then
-- git mv this file into supabase/migrations/ (Rule 56).

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
  heartbeat_budget INTEGER := 100;
  virtuals_limit INTEGER;
  cost_weight NUMERIC;
  current_count NUMERIC;
  hb_count NUMERIC;
  virt_count NUMERIC;
  vm_credits NUMERIC;
  new_count NUMERIC;
  today DATE;
BEGIN
  today := (NOW() AT TIME ZONE p_timezone)::DATE;

  -- Cost weight by model
  CASE
    WHEN p_model ILIKE '%minimax%' THEN cost_weight := 0.2;
    WHEN p_model ILIKE '%haiku%'   THEN cost_weight := 1;
    WHEN p_model ILIKE '%sonnet%'  THEN cost_weight := 4;
    WHEN p_model ILIKE '%opus%'    THEN cost_weight := 19;
    WHEN p_model ILIKE '%fable%'   THEN cost_weight := 38;
    ELSE cost_weight := 1;
  END CASE;

  -- Tool continuation discount
  IF p_is_tool_continuation THEN
    cost_weight := cost_weight * 0.2;
  END IF;

  -- Display limit by tier
  CASE p_tier
    WHEN 'starter' THEN display_limit := 600;
    WHEN 'pro'     THEN display_limit := 1000;
    WHEN 'power'   THEN display_limit := 2500;
    ELSE display_limit := 600;
  END CASE;
  -- internal_limit removed: was display_limit + 200, now identical to display_limit

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

  -- Virtuals (own budget)
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

  -- Heartbeat (own budget)
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

  -- User messages: daily limit -> credits -> hard block
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

  -- No credits, no daily room: hard block at exactly display_limit
  RETURN jsonb_build_object('allowed', false, 'incremented', false, 'source', 'exhausted', 'cost_weight', cost_weight, 'credits_remaining', COALESCE(vm_credits, 0));
END;
$$;
