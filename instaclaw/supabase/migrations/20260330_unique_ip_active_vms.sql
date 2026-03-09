-- Prevent duplicate IPs across active VMs.
-- Linode recycles IPs from terminated VMs, causing two DB records to share
-- the same IP. This partial unique index blocks inserts/updates that would
-- create duplicates among non-terminated VMs while still allowing terminated
-- VMs to retain their historical IPs.
--
-- Excludes 0.0.0.0 which is used as a sentinel for failed provisioning.

CREATE UNIQUE INDEX IF NOT EXISTS idx_instaclaw_vms_ip_active
ON instaclaw_vms (ip_address)
WHERE status NOT IN ('failed', 'destroyed', 'terminated')
  AND ip_address IS NOT NULL
  AND ip_address != '0.0.0.0';
