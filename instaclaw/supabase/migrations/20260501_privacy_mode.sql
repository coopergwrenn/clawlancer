-- Maximum Privacy Mode v0 — user-controlled toggle that gates operator
-- read access to the user's agent data on edge_city VMs.
--
-- Default state: NULL (privacy mode OFF — operators have normal access).
-- Active state:  a future timestamptz (privacy mode ON until that time).
-- The toggle endpoint sets this to NOW() + 24h on enable, NULL on disable.
-- A cron at /api/cron/expire-privacy-mode clears expired entries.
--
-- This column is added to ALL users for schema simplicity, but the toggle
-- API hard-gates on partner === "edge_city" — non-edge_city users cannot
-- set it, and the VM-side SSH bridge is only deployed on edge_city VMs.
-- See PRD § 4.16 / § 6.1 (Maximum Privacy Mode) for the full design.

ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS privacy_mode_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_privacy_mode_active
  ON instaclaw_users(privacy_mode_until)
  WHERE privacy_mode_until IS NOT NULL;

COMMENT ON COLUMN instaclaw_users.privacy_mode_until IS
  'Maximum Privacy Mode (edge_city only). NULL = OFF (operators have normal access). Future timestamp = ON until that time. The expire-privacy-mode cron clears expired entries. The VM-side SSH bridge reads this through /api/internal/check-privacy-mode and gates operator command access accordingly.';
