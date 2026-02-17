-- Heartbeat dashboard: add heartbeat tracking columns to instaclaw_vms
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS heartbeat_interval TEXT NOT NULL DEFAULT '3h',
  ADD COLUMN IF NOT EXISTS heartbeat_last_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_next_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_credits_used_today INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS heartbeat_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS heartbeat_custom_schedule JSONB;
