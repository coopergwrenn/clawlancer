-- Add referred_by column to instaclaw_users for ambassador referral tracking
ALTER TABLE instaclaw_users ADD COLUMN IF NOT EXISTS referred_by TEXT;

-- Index for lookup when crediting ambassadors
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON instaclaw_users (referred_by) WHERE referred_by IS NOT NULL;
