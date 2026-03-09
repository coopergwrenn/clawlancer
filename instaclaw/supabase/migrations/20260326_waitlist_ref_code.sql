-- Add ref_code column to instaclaw_waitlist for tracking ambassador referrals on waitlist signups
ALTER TABLE instaclaw_waitlist ADD COLUMN IF NOT EXISTS ref_code TEXT;
CREATE INDEX IF NOT EXISTS idx_waitlist_ref_code ON instaclaw_waitlist (ref_code) WHERE ref_code IS NOT NULL;
