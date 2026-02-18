-- Track when a VM was last sent the daily-limit notification.
-- Used by gateway/proxy to dedup limit messages across Vercel cold starts.
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS limit_notified_date DATE;
