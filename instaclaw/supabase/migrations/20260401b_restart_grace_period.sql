-- Fix 1: Add restart grace period column to prevent false unhealthy marks
-- during legitimate gateway restarts. The health cron will skip marking VMs
-- unhealthy if they were restarted within the last 120 seconds.

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS last_gateway_restart TIMESTAMPTZ;

COMMENT ON COLUMN instaclaw_vms.last_gateway_restart IS
  'Timestamp of most recent gateway restart. Health cron skips marking unhealthy within 120s of this.';
