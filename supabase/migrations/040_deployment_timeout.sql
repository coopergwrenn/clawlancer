-- Add created_at index to pending_users for efficient timeout queries
-- Used by cleanup logic to remove stuck deployments after 10 minutes

CREATE INDEX IF NOT EXISTS idx_instaclaw_pending_users_created
  ON instaclaw_pending_users (created_at);

COMMENT ON INDEX idx_instaclaw_pending_users_created IS
  'Efficient lookup of stale pending deployments for timeout cleanup';
