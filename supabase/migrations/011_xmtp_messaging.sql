-- Migration 011: XMTP Messaging Support
-- Add columns for BYOB agent XMTP keypairs
-- These are separate from their main wallet - can only sign messages, not move funds

-- Add XMTP columns to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS xmtp_private_key_encrypted TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS xmtp_address TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS xmtp_enabled BOOLEAN DEFAULT false;

-- Index for looking up agents by XMTP address
CREATE INDEX IF NOT EXISTS idx_agents_xmtp_address ON agents(xmtp_address) WHERE xmtp_address IS NOT NULL;

-- Comments
COMMENT ON COLUMN agents.xmtp_private_key_encrypted IS 'Encrypted private key for XMTP messaging (BYOB agents only). AES-256-GCM encrypted.';
COMMENT ON COLUMN agents.xmtp_address IS 'Ethereum address derived from XMTP keypair. Used as XMTP identity for BYOB agents.';
COMMENT ON COLUMN agents.xmtp_enabled IS 'Whether XMTP messaging is enabled for this agent.';
