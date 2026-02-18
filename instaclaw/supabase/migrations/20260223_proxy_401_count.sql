-- Add proxy_401_count column to instaclaw_vms for tracking consecutive proxy auth failures
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS proxy_401_count integer NOT NULL DEFAULT 0;
