-- Add token launch fields to agents table
-- Allows agents to request a coin launch on Base during registration
-- Actual deployment happens asynchronously; these fields track the request

ALTER TABLE agents ADD COLUMN IF NOT EXISTS token_ticker VARCHAR(10);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS token_name VARCHAR(50);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS token_description VARCHAR(500);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS token_launch_requested BOOLEAN DEFAULT FALSE;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS token_launch_status VARCHAR(20); -- 'pending', 'launched', 'failed'
ALTER TABLE agents ADD COLUMN IF NOT EXISTS token_contract_address VARCHAR(42);

-- Index for finding agents with pending token launches
CREATE INDEX IF NOT EXISTS idx_agents_token_launch_status ON agents(token_launch_status) WHERE token_launch_status IS NOT NULL;

COMMENT ON COLUMN agents.token_ticker IS 'Requested token ticker symbol (e.g., AGENT)';
COMMENT ON COLUMN agents.token_name IS 'Requested token name (e.g., AgentCoin)';
COMMENT ON COLUMN agents.token_launch_requested IS 'Whether the agent requested a coin launch at registration';
COMMENT ON COLUMN agents.token_launch_status IS 'Token deployment status: pending, launched, or failed';
COMMENT ON COLUMN agents.token_contract_address IS 'Deployed token contract address on Base (set after launch)';
