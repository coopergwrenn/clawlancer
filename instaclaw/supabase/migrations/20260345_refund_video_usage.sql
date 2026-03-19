-- Refund video usage for failed Sjinn renders.
--
-- Deletes the matching row from instaclaw_video_usage if it exists and was
-- created today (in the user's timezone). Returns JSON with refund result.

CREATE OR REPLACE FUNCTION instaclaw_refund_video_usage(
  p_vm_id UUID,
  p_sjinn_request_id TEXT,
  p_timezone TEXT DEFAULT 'America/New_York'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_today DATE := (NOW() AT TIME ZONE COALESCE(p_timezone, 'America/New_York'))::date;
  v_day_start TIMESTAMPTZ;
  v_deleted_id UUID;
  v_new_count INTEGER;
BEGIN
  -- Only allow refunds for today's usage
  v_day_start := (v_today::TEXT || ' 00:00:00')::TIMESTAMP
                  AT TIME ZONE COALESCE(p_timezone, 'America/New_York');

  -- Delete the matching row (if it exists and was created today)
  DELETE FROM instaclaw_video_usage
  WHERE vm_id = p_vm_id
    AND sjinn_request_id = p_sjinn_request_id
    AND created_at >= v_day_start
  RETURNING id INTO v_deleted_id;

  IF v_deleted_id IS NULL THEN
    RETURN jsonb_build_object(
      'refunded', false,
      'reason', 'no_matching_usage_found'
    );
  END IF;

  -- Count remaining usage for today
  SELECT COUNT(*)
  INTO v_new_count
  FROM instaclaw_video_usage
  WHERE vm_id = p_vm_id
    AND generation_type = 'video'
    AND created_at >= v_day_start;

  RETURN jsonb_build_object(
    'refunded', true,
    'deleted_id', v_deleted_id,
    'new_count', v_new_count
  );
END;
$$;
