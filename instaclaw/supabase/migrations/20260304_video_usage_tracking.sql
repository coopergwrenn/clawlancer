-- Video usage tracking for Sjinn proxy.
--
-- One row per generation request (video, image, or audio).
-- RPCs: instaclaw_check_video_limit (read-only) and instaclaw_increment_video_usage (insert).
-- Daily limits enforced per tier: Starter=3, Pro=10, Power=30, BYOK=5 videos/day.

-- Table: one row per generation request
CREATE TABLE IF NOT EXISTS instaclaw_video_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id UUID NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  generation_type TEXT NOT NULL CHECK (generation_type IN ('video', 'image', 'audio')),
  sjinn_api TEXT CHECK (sjinn_api IN ('agent', 'tool')),
  sjinn_request_id TEXT,       -- chat_id or task_id from Sjinn
  sjinn_tool_type TEXT,        -- e.g. veo3-text-to-video-fast-api
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_usage_daily
  ON instaclaw_video_usage(vm_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- RPC: instaclaw_check_video_limit
-- Read-only check. Returns JSON: { approved, used, limit, remaining }
-- ─────────────────────────────────────────────────────────────
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
  -- Get tier and api_mode from instaclaw_vms
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

  -- BYOK users get a flat limit regardless of tier
  IF v_api_mode = 'byok' THEN
    IF p_generation_type = 'video' THEN
      v_daily_limit := 5;
    ELSE
      v_daily_limit := 15;  -- image + audio
    END IF;
  ELSE
    -- All-inclusive: tier-based limits
    IF p_generation_type = 'video' THEN
      CASE COALESCE(v_tier, 'starter')
        WHEN 'starter' THEN v_daily_limit := 3;
        WHEN 'pro'     THEN v_daily_limit := 10;
        WHEN 'power'   THEN v_daily_limit := 30;
        ELSE v_daily_limit := 3;
      END CASE;
    ELSE
      -- image + audio limits
      CASE COALESCE(v_tier, 'starter')
        WHEN 'starter' THEN v_daily_limit := 10;
        WHEN 'pro'     THEN v_daily_limit := 30;
        WHEN 'power'   THEN v_daily_limit := 100;
        ELSE v_daily_limit := 10;
      END CASE;
    END IF;
  END IF;

  -- Start of user's local day in UTC
  v_day_start := (v_today::TEXT || ' 00:00:00')::TIMESTAMP
                  AT TIME ZONE COALESCE(p_timezone, 'America/New_York');

  -- Count today's usage for this generation type
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

-- ─────────────────────────────────────────────────────────────
-- RPC: instaclaw_increment_video_usage
-- Inserts a row. Returns the new row's id.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION instaclaw_increment_video_usage(
  p_vm_id UUID,
  p_generation_type TEXT,
  p_sjinn_api TEXT DEFAULT NULL,
  p_sjinn_request_id TEXT DEFAULT NULL,
  p_sjinn_tool_type TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO instaclaw_video_usage (vm_id, generation_type, sjinn_api, sjinn_request_id, sjinn_tool_type)
  VALUES (p_vm_id, p_generation_type, p_sjinn_api, p_sjinn_request_id, p_sjinn_tool_type)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
