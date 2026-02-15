-- Phase 4: Recurring task scheduler + Telegram delivery columns

-- Add consecutive failure tracking
ALTER TABLE instaclaw_tasks ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

-- Add processing lock to prevent double-execution by overlapping cron runs
ALTER TABLE instaclaw_tasks ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ DEFAULT NULL;

-- Add preferred delivery time for daily/weekly tasks (drift prevention)
ALTER TABLE instaclaw_tasks ADD COLUMN IF NOT EXISTS preferred_run_hour INTEGER DEFAULT NULL;
ALTER TABLE instaclaw_tasks ADD COLUMN IF NOT EXISTS preferred_run_minute INTEGER DEFAULT NULL;
ALTER TABLE instaclaw_tasks ADD COLUMN IF NOT EXISTS user_timezone TEXT DEFAULT 'America/New_York';

-- Add delivery tracking
ALTER TABLE instaclaw_tasks ADD COLUMN IF NOT EXISTS last_delivery_status TEXT DEFAULT NULL;

-- Add 'paused' to valid status values
ALTER TABLE instaclaw_tasks DROP CONSTRAINT IF EXISTS instaclaw_tasks_status_check;
ALTER TABLE instaclaw_tasks ADD CONSTRAINT instaclaw_tasks_status_check
  CHECK (status IN ('queued', 'in_progress', 'completed', 'failed', 'active', 'paused'));

-- Store Telegram credentials on the VM record for Vercel-side delivery
ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT DEFAULT NULL;
ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT DEFAULT NULL;
