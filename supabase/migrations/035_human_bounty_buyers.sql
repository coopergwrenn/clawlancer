-- Migration 035: Support human bounty buyers in transactions and notifications
-- Humans can post bounties and need to receive notifications about claims and deliveries

-- Create users table to track human users with Privy wallets
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address VARCHAR(42) NOT NULL UNIQUE,
  privy_did TEXT UNIQUE,  -- Privy decentralized ID
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address);
CREATE INDEX IF NOT EXISTS idx_users_privy_did ON users(privy_did) WHERE privy_did IS NOT NULL;

-- Enable RLS on users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Users can view their own record
CREATE POLICY "Users can view own record" ON users
  FOR SELECT USING (true);

-- Service role can manage users
CREATE POLICY "Service role can manage users" ON users
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE users IS 'Human users who interact with the platform via Privy auth';
COMMENT ON COLUMN users.privy_did IS 'Privy decentralized identifier for signing transactions';

-- Add buyer_wallet to transactions for human buyers (when buyer is not an agent)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS buyer_wallet VARCHAR(42);

-- Add index for human buyer lookups
CREATE INDEX IF NOT EXISTS idx_transactions_buyer_wallet ON transactions(buyer_wallet) WHERE buyer_wallet IS NOT NULL;

-- Add constraint: either buyer_agent_id OR buyer_wallet must be set
ALTER TABLE transactions ADD CONSTRAINT transactions_buyer_check
  CHECK (buyer_agent_id IS NOT NULL OR buyer_wallet IS NOT NULL);

-- Add user_wallet to notifications for human users
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS user_wallet VARCHAR(42);

-- Add index for user wallet lookups
CREATE INDEX IF NOT EXISTS idx_notifications_user_wallet ON notifications(user_wallet) WHERE user_wallet IS NOT NULL;

-- Drop the old constraint that required agent_id
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_agent_id_required;

-- Add new constraint: either agent_id OR user_wallet must be set
ALTER TABLE notifications ADD CONSTRAINT notifications_recipient_check
  CHECK (agent_id IS NOT NULL OR user_wallet IS NOT NULL);

-- Make agent_id nullable
ALTER TABLE notifications ALTER COLUMN agent_id DROP NOT NULL;

-- Update RLS policies for notifications to include user_wallet
DROP POLICY IF EXISTS "Agents can view own notifications" ON notifications;
CREATE POLICY "Users can view own notifications" ON notifications
  FOR SELECT USING (
    agent_id IS NOT NULL OR
    user_wallet IS NOT NULL
  );

COMMENT ON COLUMN transactions.buyer_wallet IS 'Wallet address of human buyer (null if buyer is an agent)';
COMMENT ON COLUMN notifications.user_wallet IS 'Wallet address of human user receiving notification (null if recipient is an agent)';
