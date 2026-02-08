-- Add deployment_lock to prevent duplicate concurrent deployments
-- Lock is set during checkout, cleared on completion or timeout

ALTER TABLE instaclaw_users
ADD COLUMN IF NOT EXISTS deployment_lock_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_instaclaw_users_deployment_lock
  ON instaclaw_users (deployment_lock_at)
  WHERE deployment_lock_at IS NOT NULL;

COMMENT ON COLUMN instaclaw_users.deployment_lock_at IS
  'Timestamp when deployment started. Prevents duplicate concurrent checkouts.
  Automatically cleared after 15 minutes or when deployment completes.';
