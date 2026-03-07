-- Add anomaly alerting to instaclaw_increment_usage:
-- When message_count exceeds 2x the display_limit, log to instaclaw_admin_alert_log.
-- Deduplicates: one alert per VM per day (alert_key = 'usage_anomaly:<vm_id>:<date>').

CREATE OR REPLACE FUNCTION instaclaw_increment_usage(
  p_vm_id UUID,
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
  cost_weight NUMERIC;
  new_count NUMERIC;
  display_limit INTEGER;
  vm_tier TEXT;
  vm_credits NUMERIC;
  today DATE := (NOW() AT TIME ZONE COALESCE(p_timezone, 'America/New_York'))::date;
  current_count NUMERIC;
  vm_name TEXT;
  alert_key TEXT;
BEGIN
  -- Model cost weights: MiniMax=0.2, Haiku=1, Sonnet=4, Opus=19
  CASE
    WHEN p_model ILIKE '%minimax%' THEN cost_weight := 0.2;
    WHEN p_model ILIKE '%haiku%'   THEN cost_weight := 1;
    WHEN p_model ILIKE '%sonnet%'  THEN cost_weight := 4;
    WHEN p_model ILIKE '%opus%'    THEN cost_weight := 19;
    ELSE cost_weight := 1;
  END CASE;

  -- Tool-use continuation discount: 0.2x multiplier
  IF p_is_tool_continuation THEN
    cost_weight := cost_weight * 0.2;
  END IF;

  -- VIRTUALS: increment virtuals_count only, never touches message_count
  IF p_is_virtuals THEN
    INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count, virtuals_count)
    VALUES (p_vm_id, today, 0, 0, cost_weight)
    ON CONFLICT (vm_id, usage_date)
    DO UPDATE SET virtuals_count = instaclaw_daily_usage.virtuals_count + cost_weight,
                  updated_at = NOW()
    RETURNING virtuals_count INTO new_count;

    RETURN jsonb_build_object(
      'incremented', true,
      'cost_weight', cost_weight,
      'new_count', new_count,
      'is_virtuals', true
    );
  END IF;

  -- HEARTBEAT: increment heartbeat_count only, never touches message_count
  IF p_is_heartbeat THEN
    INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count, virtuals_count)
    VALUES (p_vm_id, today, 0, cost_weight, 0)
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
  SELECT COALESCE(tier, 'starter'), name INTO vm_tier, vm_name
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
  INSERT INTO instaclaw_daily_usage (vm_id, usage_date, message_count, heartbeat_count, virtuals_count)
  VALUES (p_vm_id, today, cost_weight, 0, 0)
  ON CONFLICT (vm_id, usage_date)
  DO UPDATE SET message_count = instaclaw_daily_usage.message_count + cost_weight,
                updated_at = NOW()
  RETURNING message_count INTO new_count;

  -- ANOMALY ALERT: if message_count exceeds 2x the display_limit, log once per VM per day
  IF new_count > (display_limit * 2) THEN
    alert_key := 'usage_anomaly:' || p_vm_id::text || ':' || today::text;

    -- Only insert if no alert for this key yet (dedup)
    INSERT INTO instaclaw_admin_alert_log (alert_key, vm_count, details)
    SELECT alert_key, 1,
      'VM ' || COALESCE(vm_name, p_vm_id::text) ||
      ' exceeded 2x daily limit: message_count=' || new_count ||
      ', display_limit=' || display_limit ||
      ', tier=' || vm_tier ||
      ', model=' || p_model ||
      ', date=' || today::text ||
      ', cost_weight=' || cost_weight
    WHERE NOT EXISTS (
      SELECT 1 FROM instaclaw_admin_alert_log
      WHERE instaclaw_admin_alert_log.alert_key = alert_key
    );
  END IF;

  RETURN jsonb_build_object(
    'incremented', true,
    'cost_weight', cost_weight,
    'new_count', new_count,
    'is_heartbeat', false
  );
END;
$$;
