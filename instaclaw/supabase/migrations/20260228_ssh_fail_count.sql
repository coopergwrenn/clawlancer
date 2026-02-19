-- Track consecutive SSH connectivity failures for auto-quarantine
ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS ssh_fail_count INTEGER DEFAULT 0;
