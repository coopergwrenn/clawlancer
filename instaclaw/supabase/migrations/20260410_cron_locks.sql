-- Distributed cron lock table
--
-- Used to prevent two instances of the same Vercel cron job from running
-- concurrently. Race-safe via PRIMARY KEY constraint:
--   1. DELETE expired locks (idempotent cleanup)
--   2. INSERT — atomic, fails with 23505 if held by another instance
--
-- Acquired locks have an expires_at; if a holder crashes without releasing,
-- the next run cleans up the expired row before trying to acquire.

CREATE TABLE IF NOT EXISTS instaclaw_cron_locks (
  name        TEXT PRIMARY KEY,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  holder      TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_locks_expires
  ON instaclaw_cron_locks(expires_at);
