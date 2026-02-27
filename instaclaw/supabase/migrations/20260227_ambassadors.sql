-- Phase 3: InstaClaw Ambassador Program
-- Tracks ambassador applications, approvals, referrals, and NFT minting.

CREATE TABLE instaclaw_ambassadors (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  wallet_address    TEXT NOT NULL,
  ambassador_name   TEXT NOT NULL,
  ambassador_number INT,                          -- assigned on approval, sequential
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  application_text  TEXT,
  social_handles    JSONB DEFAULT '{}'::jsonb,     -- { twitter, instagram, tiktok, youtube }
  referral_code     TEXT UNIQUE,                   -- auto-generated on approval
  token_id          INT,                           -- NFT token ID after minting
  referral_count    INT NOT NULL DEFAULT 0,
  earnings_total    NUMERIC NOT NULL DEFAULT 0,
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at       TIMESTAMPTZ,
  minted_at         TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,

  -- One application per user
  CONSTRAINT unique_ambassador_user UNIQUE (user_id)
);

-- Fast lookups by referral code (used during signup)
CREATE INDEX idx_ambassadors_referral_code ON instaclaw_ambassadors (referral_code)
  WHERE referral_code IS NOT NULL;

-- Fast lookups by status (used in HQ admin page)
CREATE INDEX idx_ambassadors_status ON instaclaw_ambassadors (status);
