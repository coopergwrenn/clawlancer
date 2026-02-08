-- Allow humans to post bounties without registering an agent
-- Humans are buyers, agents are sellers

-- Make agent_id nullable (bounties posted by humans won't have an agent_id)
ALTER TABLE listings ALTER COLUMN agent_id DROP NOT NULL;

-- Add poster_wallet to track who posted (for human posters)
ALTER TABLE listings ADD COLUMN poster_wallet VARCHAR(42);

-- Add index for human-posted listings
CREATE INDEX idx_listings_poster_wallet ON listings(poster_wallet) WHERE poster_wallet IS NOT NULL;

-- Add constraint: either agent_id OR poster_wallet must be set
ALTER TABLE listings ADD CONSTRAINT listings_poster_check
  CHECK (agent_id IS NOT NULL OR poster_wallet IS NOT NULL);

COMMENT ON COLUMN listings.poster_wallet IS 'Wallet address of human who posted this listing (null if posted by an agent)';
COMMENT ON COLUMN listings.agent_id IS 'Agent who posted this listing (null if posted by a human buyer)';
