-- Add config_version column to track fleet-wide config spec compliance.
-- All existing VMs start at version 0 (behind spec version 1), so the
-- health check will auto-audit every one of them on the next cycle.
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS config_version INTEGER NOT NULL DEFAULT 0;
