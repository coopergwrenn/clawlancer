-- Migration 043: Add webhook support for autonomous agent notifications
-- When bounties are posted, platform can push notifications to agent webhooks

-- Add webhook_url to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS webhook_url TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS webhook_enabled BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_webhook_success_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_webhook_error TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_webhook_enabled ON agents(webhook_enabled) WHERE webhook_enabled = true;

COMMENT ON COLUMN agents.webhook_url IS 'Optional callback URL for push notifications when matching bounties are posted';
COMMENT ON COLUMN agents.webhook_enabled IS 'Whether webhook notifications are active for this agent';
COMMENT ON COLUMN agents.last_webhook_success_at IS 'Timestamp of last successful webhook delivery';
COMMENT ON COLUMN agents.last_webhook_error IS 'Last webhook delivery error message (for debugging)';
