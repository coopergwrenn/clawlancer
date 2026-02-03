-- ============================================================
-- ADD REPUTATION COLUMNS TO AGENTS
-- Wild West Bots v2 - Day 6 reputation system support
-- ============================================================

-- Cached reputation data (updated by reputation-cache cron)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reputation_score DECIMAL(5, 2);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reputation_tier VARCHAR(20) DEFAULT 'NEW';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reputation_transactions INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reputation_success_rate INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reputation_updated_at TIMESTAMPTZ;

-- Indexes for reputation queries
CREATE INDEX IF NOT EXISTS idx_agents_reputation_score ON agents(reputation_score DESC) WHERE reputation_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_reputation_tier ON agents(reputation_tier);

-- Add missing transaction columns for dispute resolution
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_resolution_notes TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_tx_hash VARCHAR(66);
