-- Bump starter tier video limit from 3 to 5 per day.
-- Re-creates instaclaw_check_video_limit with updated limits.

CREATE OR REPLACE FUNCTION instaclaw_check_video_limit(
  p_vm_id UUID,
  p_generation_type TEXT,
  p_timezone TEXT DEFAULT 'America/New_York'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tier TEXT;
  v_api_mode TEXT;
  v_daily_limit INTEGER;
  v_used INTEGER;
  v_today DATE := (NOW() AT TIME ZONE COALESCE(p_timezone, 'America/New_York'))::date;
  v_day_start TIMESTAMPTZ;
BEGIN
  SELECT tier, api_mode INTO v_tier, v_api_mode
  FROM instaclaw_vms
  WHERE id = p_vm_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'approved', false,
      'used', 0,
      'limit', 0,
      'remaining', 0,
      'error', 'vm_not_found'
    );
  END IF;

  IF v_api_mode = 'byok' THEN
    IF p_generation_type = 'video' THEN
      v_daily_limit := 5;
    ELSE
      v_daily_limit := 15;
    END IF;
  ELSE
    IF p_generation_type = 'video' THEN
      CASE COALESCE(v_tier, 'starter')
        WHEN 'starter' THEN v_daily_limit := 5;
        WHEN 'pro'     THEN v_daily_limit := 10;
        WHEN 'power'   THEN v_daily_limit := 30;
        ELSE v_daily_limit := 5;
      END CASE;
    ELSE
      CASE COALESCE(v_tier, 'starter')
        WHEN 'starter' THEN v_daily_limit := 10;
        WHEN 'pro'     THEN v_daily_limit := 30;
        WHEN 'power'   THEN v_daily_limit := 100;
        ELSE v_daily_limit := 10;
      END CASE;
    END IF;
  END IF;

  v_day_start := (v_today::TEXT || ' 00:00:00')::TIMESTAMP
                  AT TIME ZONE COALESCE(p_timezone, 'America/New_York');

  SELECT COUNT(*)
  INTO v_used
  FROM instaclaw_video_usage
  WHERE vm_id = p_vm_id
    AND generation_type = p_generation_type
    AND created_at >= v_day_start;

  RETURN jsonb_build_object(
    'approved', v_used < v_daily_limit,
    'used', v_used,
    'limit', v_daily_limit,
    'remaining', GREATEST(v_daily_limit - v_used, 0)
  );
END;
$$;
