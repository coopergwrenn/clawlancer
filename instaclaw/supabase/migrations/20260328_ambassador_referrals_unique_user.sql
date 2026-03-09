-- Prevent duplicate referral rows for the same ambassador + user combo.
-- Handles the race condition where both auth.ts and the Stripe webhook
-- try to insert a referral row for the same user simultaneously.
CREATE UNIQUE INDEX IF NOT EXISTS idx_amb_referrals_ambassador_user_unique
  ON instaclaw_ambassador_referrals (ambassador_id, referred_user_id)
  WHERE referred_user_id IS NOT NULL;

-- Add paid_out_at column for tracking when admin marks commission as paid
ALTER TABLE instaclaw_ambassador_referrals ADD COLUMN IF NOT EXISTS paid_out_at TIMESTAMPTZ;
