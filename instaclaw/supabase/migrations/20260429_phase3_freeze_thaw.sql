-- Phase 3 — vm freeze/thaw pattern
-- See: instaclaw/docs/prd-vm-cost-optimization.md
--
-- Adds 3 columns to instaclaw_vms that track per-user personal-snapshot
-- state. When a VM is frozen:
--   1. Linode disk is snapshotted to a private image (image ID stored
--      in frozen_image_id)
--   2. Linode instance is deleted (provider_server_id cleared, ip_address
--      cleared)
--   3. status='frozen', health_status='frozen', frozen_at=NOW()
-- When the user reactivates:
--   1. New Linode is provisioned from frozen_image_id
--   2. provider_server_id, ip_address, status='assigned' restored
--   3. frozen_image_id, frozen_at, frozen_image_size_mb cleared
--   4. Personal image deleted (no longer needed)
--
-- Cost: ~$0.50/mo per frozen image vs ~$29/mo per running instance.
-- Net savings target: ~$1,993/mo across ~70 currently-paid-for-but-idle VMs.
--
-- Safety: ALL Phase 3 destructive operations are gated by the existing
-- vm_lifecycle_v2_enabled kill switch (added in Phase 2 migration).
-- This migration is purely additive — adds nullable columns. Phase 2's
-- code paths don't read them, so no behavioral change until v2 is flipped on.

-- ─── Columns for personal-snapshot tracking ───────────────────────────────

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS frozen_image_id TEXT,
  ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS frozen_image_size_mb INTEGER;

COMMENT ON COLUMN instaclaw_vms.frozen_image_id IS
  'Linode private image ID (e.g. "private/12345678") created when this VM was frozen. NULL when VM is running or has never been frozen. Used by the thaw flow to provision a new instance from the user''s personal snapshot.';

COMMENT ON COLUMN instaclaw_vms.frozen_at IS
  'Timestamp when this VM transitioned to status=frozen. Used to compute frozen-image retention windows (37 days suspended-frozen, 127 days hibernating-frozen — see prd-vm-cost-optimization.md for the full retention policy).';

COMMENT ON COLUMN instaclaw_vms.frozen_image_size_mb IS
  'Image size in MB at freeze time. Stored for cost-tracking and capacity-planning queries (e.g. SUM(frozen_image_size_mb)/1024 GB to project storage cost).';

-- Useful index: thaw flow looks up frozen VMs by user_id, so the existing
-- index on assigned_to is sufficient for the dominant query pattern. Add a
-- partial index on frozen_at for retention sweeps:

CREATE INDEX IF NOT EXISTS idx_vms_frozen_at
  ON instaclaw_vms(frozen_at)
  WHERE frozen_at IS NOT NULL;
