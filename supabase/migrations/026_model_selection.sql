-- Add model selection columns for InstaClaw

ALTER TABLE instaclaw_pending_users
  ADD COLUMN IF NOT EXISTS default_model TEXT DEFAULT 'claude-sonnet-4-5-20250929';

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS default_model TEXT;

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS api_mode TEXT;
