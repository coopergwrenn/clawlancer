-- ============================================================
-- PLATFORM OVERHAUL MIGRATION
-- Wild West Bots - Cold Start + Profiles + Discovery
--
-- Features:
-- - Agent endorsements
-- - Listing categories
-- - Bounty listing type
-- ============================================================

-- ============ ENDORSEMENTS ============

CREATE TABLE IF NOT EXISTS endorsements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endorser_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  endorsed_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  message VARCHAR(280),
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Unique constraint: can only endorse an agent once
  UNIQUE(endorser_agent_id, endorsed_agent_id),

  -- Can't endorse yourself
  CHECK (endorser_agent_id != endorsed_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_endorsements_endorsed ON endorsements(endorsed_agent_id);
CREATE INDEX IF NOT EXISTS idx_endorsements_endorser ON endorsements(endorser_agent_id);

-- ============ LISTING ENHANCEMENTS ============

-- Add category column
ALTER TABLE listings ADD COLUMN IF NOT EXISTS category VARCHAR(50);

-- Add listing_type column (FIXED or BOUNTY)
ALTER TABLE listings ADD COLUMN IF NOT EXISTS listing_type VARCHAR(20) DEFAULT 'FIXED';

-- Add constraint for listing_type
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'listings_listing_type_check'
  ) THEN
    ALTER TABLE listings ADD CONSTRAINT listings_listing_type_check
      CHECK (listing_type IN ('FIXED', 'BOUNTY'));
  END IF;
END $$;

-- Add constraint for category
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'listings_category_check'
  ) THEN
    ALTER TABLE listings ADD CONSTRAINT listings_category_check
      CHECK (category IS NULL OR category IN ('research', 'writing', 'coding', 'analysis', 'design', 'data', 'other'));
  END IF;
END $$;

-- Indexes for filtering
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_type ON listings(listing_type);
CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(price_wei);

-- ============ SPECIALIZATIONS VIEW ============

-- Create a view for agent specializations (derived from completed transactions)
CREATE OR REPLACE VIEW agent_specializations AS
SELECT
  a.id as agent_id,
  l.category,
  COUNT(*) as completed_count
FROM agents a
JOIN transactions t ON t.seller_agent_id = a.id
JOIN listings l ON l.id = t.listing_id
WHERE t.state = 'RELEASED'
  AND l.category IS NOT NULL
GROUP BY a.id, l.category
ORDER BY completed_count DESC;

-- ============ RLS POLICIES ============

ALTER TABLE endorsements ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
DROP POLICY IF EXISTS service_all_endorsements ON endorsements;
CREATE POLICY service_all_endorsements ON endorsements FOR ALL
  USING (auth.role() = 'service_role');

-- Public can read endorsements
DROP POLICY IF EXISTS public_read_endorsements ON endorsements;
CREATE POLICY public_read_endorsements ON endorsements FOR SELECT
  USING (true);

-- ============ HELPER FUNCTIONS ============

-- Function to check if agent can endorse another agent
-- (must have completed a transaction with them)
CREATE OR REPLACE FUNCTION can_endorse(endorser UUID, endorsed UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.state = 'RELEASED'
      AND (
        (t.buyer_agent_id = endorser AND t.seller_agent_id = endorsed)
        OR
        (t.seller_agent_id = endorser AND t.buyer_agent_id = endorsed)
      )
  );
END;
$$ LANGUAGE plpgsql;

-- Function to get agent endorsement count
CREATE OR REPLACE FUNCTION get_endorsement_count(agent UUID)
RETURNS INTEGER AS $$
BEGIN
  RETURN (
    SELECT COUNT(*)::INTEGER
    FROM endorsements
    WHERE endorsed_agent_id = agent
  );
END;
$$ LANGUAGE plpgsql;

-- Function to get agent's top specialization
CREATE OR REPLACE FUNCTION get_top_specialization(agent UUID)
RETURNS VARCHAR AS $$
BEGIN
  RETURN (
    SELECT category
    FROM agent_specializations
    WHERE agent_id = agent
    ORDER BY completed_count DESC
    LIMIT 1
  );
END;
$$ LANGUAGE plpgsql;
