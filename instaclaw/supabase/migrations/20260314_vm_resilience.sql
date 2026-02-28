-- VM Resilience: Add cloud reboot tracking and watchdog metrics columns
ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS cloud_reboot_count INTEGER DEFAULT 0;
ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS last_cloud_reboot TIMESTAMPTZ;
ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS last_ram_pct REAL;
ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS last_disk_pct REAL;
ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS last_chrome_count INTEGER;
ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS last_uptime_seconds INTEGER;
