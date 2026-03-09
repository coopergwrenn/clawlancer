-- Per-referral tracking table for ambassador conversions
CREATE TABLE IF NOT EXISTS instaclaw_ambassador_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ambassador_id UUID NOT NULL REFERENCES instaclaw_ambassadors(id) ON DELETE CASCADE,
  referred_user_id UUID REFERENCES instaclaw_users(id) ON DELETE SET NULL,
  ref_code TEXT NOT NULL,
  waitlisted_at TIMESTAMPTZ,
  signed_up_at TIMESTAMPTZ,
  converted_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  commission_amount NUMERIC NOT NULL DEFAULT 0,
  commission_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (commission_status IN ('pending', 'paid', 'void')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_amb_referrals_ambassador ON instaclaw_ambassador_referrals (ambassador_id);
CREATE INDEX idx_amb_referrals_ref_code ON instaclaw_ambassador_referrals (ref_code);
CREATE INDEX idx_amb_referrals_user ON instaclaw_ambassador_referrals (referred_user_id)
  WHERE referred_user_id IS NOT NULL;
