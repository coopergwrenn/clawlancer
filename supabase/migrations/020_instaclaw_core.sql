-- InstaClaw Core Schema
-- Tables: users, bots, subscriptions, credits, messages
-- Plus: helper functions, updated_at triggers, RLS policies

-- ============================================
-- UPDATED_AT TRIGGER FUNCTION (reusable)
-- ============================================
CREATE OR REPLACE FUNCTION instaclaw_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- INSTACLAW_USERS
-- ============================================
CREATE TABLE instaclaw_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  google_id TEXT UNIQUE,
  privy_user_id TEXT,
  wallet_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_instaclaw_users_google_id ON instaclaw_users (google_id);
CREATE INDEX idx_instaclaw_users_privy ON instaclaw_users (privy_user_id) WHERE privy_user_id IS NOT NULL;
CREATE INDEX idx_instaclaw_users_wallet ON instaclaw_users (wallet_address) WHERE wallet_address IS NOT NULL;

CREATE TRIGGER trg_instaclaw_users_updated_at
  BEFORE UPDATE ON instaclaw_users
  FOR EACH ROW
  EXECUTE FUNCTION instaclaw_set_updated_at();

-- ============================================
-- INSTACLAW_BOTS (one per user)
-- ============================================
CREATE TABLE instaclaw_bots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'My AI',
  personality TEXT NOT NULL DEFAULT 'friendly'
    CHECK (personality IN ('friendly', 'professional', 'playful', 'custom')),
  system_prompt TEXT,
  platform TEXT NOT NULL DEFAULT 'telegram'
    CHECK (platform IN ('telegram', 'whatsapp', 'imessage')),
  platform_config JSONB DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_instaclaw_bots_user UNIQUE (user_id)
);

CREATE INDEX idx_instaclaw_bots_user ON instaclaw_bots (user_id);
CREATE INDEX idx_instaclaw_bots_active ON instaclaw_bots (is_active) WHERE is_active = true;
CREATE INDEX idx_instaclaw_bots_platform ON instaclaw_bots (platform);

CREATE TRIGGER trg_instaclaw_bots_updated_at
  BEFORE UPDATE ON instaclaw_bots
  FOR EACH ROW
  EXECUTE FUNCTION instaclaw_set_updated_at();

-- ============================================
-- INSTACLAW_SUBSCRIPTIONS
-- ============================================
CREATE TABLE instaclaw_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  tier TEXT NOT NULL DEFAULT 'free_trial'
    CHECK (tier IN ('free_trial', 'starter', 'pro', 'power', 'byok')),
  platform TEXT NOT NULL DEFAULT 'telegram'
    CHECK (platform IN ('telegram', 'whatsapp', 'imessage')),
  status TEXT NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('active', 'past_due', 'canceled', 'trialing')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  overage_cap_cents INTEGER NOT NULL DEFAULT 5000,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_instaclaw_subscriptions_user UNIQUE (user_id)
);

CREATE INDEX idx_instaclaw_subscriptions_user ON instaclaw_subscriptions (user_id);
CREATE INDEX idx_instaclaw_subscriptions_stripe_customer ON instaclaw_subscriptions (stripe_customer_id);
CREATE INDEX idx_instaclaw_subscriptions_stripe_sub ON instaclaw_subscriptions (stripe_subscription_id);
CREATE INDEX idx_instaclaw_subscriptions_status ON instaclaw_subscriptions (status);
CREATE INDEX idx_instaclaw_subscriptions_tier ON instaclaw_subscriptions (tier);

CREATE TRIGGER trg_instaclaw_subscriptions_updated_at
  BEFORE UPDATE ON instaclaw_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION instaclaw_set_updated_at();

-- ============================================
-- INSTACLAW_CREDITS
-- ============================================
CREATE TABLE instaclaw_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  subscription_credits INTEGER NOT NULL DEFAULT 0,
  subscription_credits_used INTEGER NOT NULL DEFAULT 0,
  topup_credits INTEGER NOT NULL DEFAULT 0,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_instaclaw_credits_user UNIQUE (user_id),
  CONSTRAINT chk_credits_used CHECK (subscription_credits_used >= 0),
  CONSTRAINT chk_credits CHECK (subscription_credits >= 0),
  CONSTRAINT chk_topup CHECK (topup_credits >= 0)
);

CREATE INDEX idx_instaclaw_credits_user ON instaclaw_credits (user_id);

CREATE TRIGGER trg_instaclaw_credits_updated_at
  BEFORE UPDATE ON instaclaw_credits
  FOR EACH ROW
  EXECUTE FUNCTION instaclaw_set_updated_at();

-- ============================================
-- INSTACLAW_MESSAGES
-- ============================================
CREATE TABLE instaclaw_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL REFERENCES instaclaw_bots(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  model TEXT,
  platform_message_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_instaclaw_messages_bot ON instaclaw_messages (bot_id);
CREATE INDEX idx_instaclaw_messages_bot_created ON instaclaw_messages (bot_id, created_at DESC);
CREATE INDEX idx_instaclaw_messages_platform_msg ON instaclaw_messages (platform_message_id) WHERE platform_message_id IS NOT NULL;

-- ============================================
-- HELPER: instaclaw_get_credits(user_id)
-- Returns remaining credits (subscription remaining + topup)
-- ============================================
CREATE OR REPLACE FUNCTION instaclaw_get_credits(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
  remaining INTEGER;
BEGIN
  SELECT
    GREATEST(c.subscription_credits - c.subscription_credits_used, 0) + c.topup_credits
  INTO remaining
  FROM instaclaw_credits c
  WHERE c.user_id = p_user_id;

  RETURN COALESCE(remaining, 0);
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================
-- HELPER: instaclaw_use_credit(user_id, amount)
-- Deducts credits: subscription first, then topup
-- Returns TRUE if sufficient credits, FALSE otherwise
-- ============================================
CREATE OR REPLACE FUNCTION instaclaw_use_credit(p_user_id UUID, p_amount INTEGER)
RETURNS BOOLEAN AS $$
DECLARE
  rec RECORD;
  sub_remaining INTEGER;
  still_needed INTEGER;
BEGIN
  SELECT * INTO rec
  FROM instaclaw_credits
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Available subscription credits
  sub_remaining := GREATEST(rec.subscription_credits - rec.subscription_credits_used, 0);

  IF sub_remaining >= p_amount THEN
    -- Fully covered by subscription credits
    UPDATE instaclaw_credits
    SET subscription_credits_used = subscription_credits_used + p_amount
    WHERE user_id = p_user_id;
    RETURN TRUE;
  END IF;

  -- Use all remaining subscription credits, then dip into topup
  still_needed := p_amount - sub_remaining;

  IF rec.topup_credits >= still_needed THEN
    UPDATE instaclaw_credits
    SET
      subscription_credits_used = subscription_credits,  -- fully used
      topup_credits = topup_credits - still_needed
    WHERE user_id = p_user_id;
    RETURN TRUE;
  END IF;

  -- Not enough credits
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- ENABLE ROW LEVEL SECURITY
-- ============================================
ALTER TABLE instaclaw_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE instaclaw_bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE instaclaw_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE instaclaw_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE instaclaw_messages ENABLE ROW LEVEL SECURITY;

-- ============================================
-- RLS POLICIES: instaclaw_users
-- Users can read/update their own row
-- ============================================
CREATE POLICY "Users can view own profile" ON instaclaw_users
  FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "Users can update own profile" ON instaclaw_users
  FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "Service role full access to instaclaw_users" ON instaclaw_users
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================
-- RLS POLICIES: instaclaw_bots
-- Users can CRUD their own bot
-- ============================================
CREATE POLICY "Users can view own bot" ON instaclaw_bots
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own bot" ON instaclaw_bots
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own bot" ON instaclaw_bots
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own bot" ON instaclaw_bots
  FOR DELETE
  USING (user_id = auth.uid());

CREATE POLICY "Service role full access to instaclaw_bots" ON instaclaw_bots
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================
-- RLS POLICIES: instaclaw_subscriptions
-- Users can read their own subscription
-- ============================================
CREATE POLICY "Users can view own subscription" ON instaclaw_subscriptions
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Service role full access to instaclaw_subscriptions" ON instaclaw_subscriptions
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================
-- RLS POLICIES: instaclaw_credits
-- Users can read their own credits
-- ============================================
CREATE POLICY "Users can view own credits" ON instaclaw_credits
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Service role full access to instaclaw_credits" ON instaclaw_credits
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================
-- RLS POLICIES: instaclaw_messages
-- Users can read messages for their own bots
-- ============================================
CREATE POLICY "Users can view own bot messages" ON instaclaw_messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM instaclaw_bots
      WHERE instaclaw_bots.id = instaclaw_messages.bot_id
      AND instaclaw_bots.user_id = auth.uid()
    )
  );

CREATE POLICY "Service role full access to instaclaw_messages" ON instaclaw_messages
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
