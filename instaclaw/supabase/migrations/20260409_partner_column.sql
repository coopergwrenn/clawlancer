-- Add partner column to instaclaw_users and instaclaw_vms.
-- Used to gate partner-specific skills during VM configuration.
-- Values: NULL (normal user), 'edge_city', etc.

ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS partner TEXT DEFAULT NULL;

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS partner TEXT DEFAULT NULL;

COMMENT ON COLUMN instaclaw_users.partner IS
  'Partner tag set during signup via partner portal (e.g. edge_city). Gates partner-specific skills during VM configuration.';

COMMENT ON COLUMN instaclaw_vms.partner IS
  'Partner tag propagated from user during configureOpenClaw. Used for quick lookups during health checks and fleet queries.';
