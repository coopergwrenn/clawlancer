-- Add missing columns to instaclaw_waitlist that the API route expects.
-- The table was originally created with a minimal schema; migration 019
-- defined these columns but the production table predates that migration.

ALTER TABLE instaclaw_waitlist ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'landing';
ALTER TABLE instaclaw_waitlist ADD COLUMN IF NOT EXISTS referrer VARCHAR(500);
ALTER TABLE instaclaw_waitlist ADD COLUMN IF NOT EXISTS ip_hash VARCHAR(64);
ALTER TABLE instaclaw_waitlist ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- Index for rate-limiting queries (ip_hash + created_at)
CREATE INDEX IF NOT EXISTS idx_instaclaw_waitlist_rate_limit
  ON instaclaw_waitlist (ip_hash, created_at);
