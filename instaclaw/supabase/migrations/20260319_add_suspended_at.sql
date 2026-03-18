-- Add suspended_at column to track when a VM was suspended.
-- Used by the 30-day reclaim pass to auto-wipe VMs after grace period.
ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

-- Backfill any currently suspended VMs
UPDATE instaclaw_vms SET suspended_at = NOW()
WHERE health_status = 'suspended' AND suspended_at IS NULL;
