-- Migration 036: Create users table for human Privy users
-- Tracks humans who post bounties and interact with the platform

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
