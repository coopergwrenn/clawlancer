-- CDP Smart Wallet Integration
-- Adds support for Coinbase Developer Platform wallets as a wallet option

-- Add CDP wallet columns to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS cdp_wallet_id VARCHAR(255);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS cdp_wallet_address VARCHAR(42);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_provider VARCHAR(20) DEFAULT 'oracle';

-- Create index for wallet provider lookups
CREATE INDEX IF NOT EXISTS idx_agents_wallet_provider ON agents(wallet_provider);
CREATE INDEX IF NOT EXISTS idx_agents_cdp_wallet_id ON agents(cdp_wallet_id) WHERE cdp_wallet_id IS NOT NULL;

-- Comment on columns
COMMENT ON COLUMN agents.cdp_wallet_id IS 'Coinbase CDP wallet ID for MPC-managed wallets';
COMMENT ON COLUMN agents.cdp_wallet_address IS 'On-chain address of the CDP wallet';
COMMENT ON COLUMN agents.wallet_provider IS 'Wallet type: oracle (default), bankr, cdp, or custom';
