-- Add previous_gateway_token column for token rotation grace period.
-- During a resync, the old token is saved here so in-flight requests
-- using the old token don't get 401'd while the gateway restarts.
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS previous_gateway_token TEXT;

-- Index for fallback lookup in proxy routes
CREATE INDEX IF NOT EXISTS idx_instaclaw_vms_previous_gateway_token
  ON instaclaw_vms (previous_gateway_token)
  WHERE previous_gateway_token IS NOT NULL;
