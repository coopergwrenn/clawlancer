-- Muapi platform-provided credits: pivot Higgsfield from BYOK to platform proxy.
--
-- 1. Mark skill as no longer requiring user API key
-- 2. Create increment_media_usage RPC for weighted credit deduction
--    (same pattern as instaclaw_increment_usage but takes explicit credit weight)

-- 1. Remove BYOK requirement from Higgsfield skill
UPDATE instaclaw_skills
SET requires_api_key = false
WHERE slug = 'higgsfield-video';

-- 2. Media usage increment RPC
-- Increments message_count by the given credit weight (shared daily pool).
-- Deducts from credit_balance when over display_limit (same as LLM usage).
CREATE OR REPLACE FUNCTION instaclaw_increment_media_usage(
  p_vm_id UUID,
  p_credit_weight NUMERIC,
  p_timezone TEXT DEFAULT 'America/New_York'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  display_limit INTEGER;
  vm_tier TEXT;
  vm_credits NUMERIC;
  current_count NUMERIC;
  new_count NUMERIC;
  today DATE := (NOW() AT TIME ZONE COALESCE(p_timezone, 'America/New_York'))::date;
BEGIN
  -- Look up tier
  SELECT COALESCE(tier, 'starter') INTO vm_tier
  FROM instaclaw_vms WHERE id = p_vm_id;

  CASE vm_tier
    WHEN 'starter' THEN display_limit := 600;
    WHEN 'pro'     THEN display_limit := 1000;
    WHEN 'power'   THEN display_limit := 2500;
    WHEN 'internal' THEN display_limit := 5000;
    ELSE display_limit := 600;
  END CASE;

  -- Get current count
  SELECT COALESCE(message_count, 0) INTO current_count
  FROM instaclaw_daily_usage
  WHERE vm_id = p_vm_id AND usage_date = today;

  IF current_count IS NULL THEN current_count := 0; END IF;

  -- If over display limit, deduct from credit_balance
  IF current_count + p_credit_weight > display_limit THEN
    SELECT COALESCE(credit_balance, 0) INTO vm_credits
    FROM instaclaw_vms WHERE id = p_vm_id;

    IF vm_credits >= p_credit_weight THEN
      UPDATE instaclaw_vms
      SET credit_balance = credit_balance - p_credit_weight
      WHERE id = p_vm_id;
    END IF;
  END IF;

  -- Increment message_count by credit weight
  INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count, virtuals_count)
  VALUES (p_vm_id, today, p_credit_weight, 0, 0)
  ON CONFLICT (vm_id, usage_date)
  DO UPDATE SET message_count = instaclaw_daily_usage.message_count + p_credit_weight,
                updated_at = NOW()
  RETURNING message_count INTO new_count;

  RETURN jsonb_build_object(
    'incremented', true,
    'credit_weight', p_credit_weight,
    'new_count', new_count,
    'display_limit', display_limit,
    'tier', vm_tier
  );
END;
$$;
