-- ============================================================
-- TRUST INFRASTRUCTURE MIGRATION
-- Wild West Bots v2
--
-- Trust Model (see Section 1 of PRD):
-- - Money movement: ON-CHAIN (escrow contract)
-- - Convenience data: LOCAL (this database)
-- - All local data includes on-chain references for verification
-- ============================================================

-- ============ ERC-8004 IDENTITY (LOCAL, formatted for future migration) ============

ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_registration JSONB;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_token_id VARCHAR(78);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_registered_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_tx_hash VARCHAR(66);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS erc8004_chain VARCHAR(20) DEFAULT 'local';

-- ============ COMPUTE (transfers are ON-CHAIN, logs are LOCAL with tx_hash) ============

ALTER TABLE agents ADD COLUMN IF NOT EXISTS compute_credits DECIMAL(18, 6) DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS needs_funding BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS heartbeat_failures INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS compute_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  amount_usdc DECIMAL(18, 6) NOT NULL,
  tx_hash VARCHAR(66), -- ON-CHAIN reference for verification
  balance_before DECIMAL(18, 6),
  balance_after DECIMAL(18, 6),
  status VARCHAR(30) NOT NULL CHECK (status IN (
    'charged', 'success', 'refunded', 'transfer_failed', 'insufficient_balance', 'compute_failed'
  )),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compute_ledger_agent ON compute_ledger(agent_id);
CREATE INDEX IF NOT EXISTS idx_compute_ledger_created ON compute_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_compute_ledger_status ON compute_ledger(status);
CREATE INDEX IF NOT EXISTS idx_compute_ledger_tx ON compute_ledger(tx_hash) WHERE tx_hash IS NOT NULL;

-- Credit purchases (verified against ON-CHAIN transfers)
CREATE TABLE IF NOT EXISTS credit_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tx_hash VARCHAR(66) NOT NULL UNIQUE, -- ON-CHAIN reference
  amount_usdc DECIMAL(18, 6) NOT NULL,
  verified BOOLEAN DEFAULT false,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_purchases_agent ON credit_purchases(agent_id);
CREATE INDEX IF NOT EXISTS idx_credit_purchases_tx ON credit_purchases(tx_hash);

-- ============ TRANSACTIONS (state changes are ON-CHAIN, metadata is LOCAL) ============

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS contract_version INTEGER DEFAULT 1;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_window_hours INTEGER DEFAULT 24;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deliverable_content TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deliverable_hash VARCHAR(66); -- Stored ON-CHAIN
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS disputed BOOLEAN DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_reason TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_evidence JSONB;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS seller_evidence JSONB;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_resolved_at TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_resolution VARCHAR(20);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_resolution_reason TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dispute_resolved_by UUID;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS pending_until TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS release_failures INTEGER DEFAULT 0;

-- Update state constraint to include new states
-- First drop the old constraint if it exists
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_state_check;

-- Add new constraint with all states
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_state_check'
  ) THEN
    ALTER TABLE transactions ADD CONSTRAINT transactions_state_check
      CHECK (state IN ('PENDING', 'FUNDED', 'DELIVERED', 'DISPUTED', 'RELEASED', 'REFUNDED',
                       'ABANDONED', 'DELIVERY_FAILED', 'RELEASE_FAILED', 'ORPHANED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_transactions_contract_version ON transactions(contract_version);
CREATE INDEX IF NOT EXISTS idx_transactions_disputed ON transactions(disputed) WHERE disputed = true;
CREATE INDEX IF NOT EXISTS idx_transactions_state_delivered ON transactions(state, delivered_at) WHERE state = 'DELIVERED';
CREATE INDEX IF NOT EXISTS idx_transactions_pending ON transactions(state, pending_until) WHERE state = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_transactions_release_failed ON transactions(state) WHERE state = 'RELEASE_FAILED';

-- ============ REPUTATION (derived from ON-CHAIN events, cached LOCAL) ============

CREATE TABLE IF NOT EXISTS reputation_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  context JSONB NOT NULL, -- Includes txHash for ON-CHAIN verification
  -- Future on-chain posting
  posted_onchain BOOLEAN DEFAULT false,
  merkle_root VARCHAR(66),
  merkle_proof JSONB,
  onchain_tx_hash VARCHAR(66),
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_feedback_agent ON reputation_feedback(agent_id);
CREATE INDEX IF NOT EXISTS idx_reputation_feedback_transaction ON reputation_feedback(transaction_id);
CREATE INDEX IF NOT EXISTS idx_reputation_feedback_pending ON reputation_feedback(posted_onchain) WHERE posted_onchain = false;

CREATE TABLE IF NOT EXISTS reputation_cache (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  score DECIMAL(5, 2) NOT NULL,
  tier VARCHAR(20) NOT NULL CHECK (tier IN ('new', 'established', 'trusted', 'veteran')),
  transaction_count INTEGER NOT NULL,
  success_rate DECIMAL(5, 4) NOT NULL,
  total_volume_usd DECIMAL(18, 2) NOT NULL,
  avg_completion_time_hours DECIMAL(10, 2),
  dispute_rate DECIMAL(5, 4) NOT NULL,
  calculated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reputation_cache_score ON reputation_cache(score DESC);
CREATE INDEX IF NOT EXISTS idx_reputation_cache_tier ON reputation_cache(tier);

CREATE TABLE IF NOT EXISTS reputation_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merkle_root VARCHAR(66) NOT NULL UNIQUE,
  feedback_count INTEGER NOT NULL,
  tx_hash VARCHAR(66),
  chain VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============ MONITORING ============

CREATE TABLE IF NOT EXISTS oracle_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type VARCHAR(30) NOT NULL CHECK (run_type IN (
    'auto_release', 'auto_refund', 'reputation_cache', 'reconciliation', 'heartbeat'
  )),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  processed_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  error_message TEXT,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_oracle_runs_type ON oracle_runs(run_type, started_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level VARCHAR(20) NOT NULL CHECK (level IN ('info', 'warning', 'error', 'critical')),
  message TEXT NOT NULL,
  context JSONB,
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_level ON alerts(level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unacknowledged ON alerts(acknowledged) WHERE acknowledged = false;

-- ============ FEATURE FLAGS ============

CREATE TABLE IF NOT EXISTS feature_flags (
  name VARCHAR(100) PRIMARY KEY,
  enabled BOOLEAN DEFAULT false,
  description TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID
);

-- Insert default feature flags (all OFF)
INSERT INTO feature_flags (name, enabled, description) VALUES
  ('v2_contract', false, 'Use V2 escrow contract for new transactions'),
  ('compute_charging', false, 'Charge agents USDC for compute'),
  ('auto_release', false, 'Enable oracle auto-release after dispute window'),
  ('auto_refund', false, 'Enable oracle auto-refund after deadline'),
  ('erc8004_identity', false, 'Store identity in ERC-8004 format'),
  ('erc8004_reputation', false, 'Post reputation to ERC-8004 registry')
ON CONFLICT (name) DO NOTHING;

-- ============ FUNCTIONS ============

-- Get agent transaction stats (for reputation calculation)
-- These stats are derived from transactions table which mirrors ON-CHAIN events
CREATE OR REPLACE FUNCTION get_agent_transaction_stats(p_agent_id UUID)
RETURNS TABLE (
  transaction_count BIGINT,
  successful_count BIGINT,
  disputed_count BIGINT,
  total_volume_usd DECIMAL,
  avg_completion_hours DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT as transaction_count,
    COUNT(*) FILTER (WHERE state = 'RELEASED')::BIGINT as successful_count,
    COUNT(*) FILTER (WHERE disputed = true)::BIGINT as disputed_count,
    COALESCE(SUM(
      CASE WHEN currency = 'USDC'
        THEN CAST(price_wei AS DECIMAL) / 1000000
        ELSE 0
      END
    ), 0) as total_volume_usd,
    COALESCE(AVG(
      EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600
    ), 0)::DECIMAL as avg_completion_hours
  FROM transactions
  WHERE seller_agent_id = p_agent_id OR buyer_agent_id = p_agent_id;
END;
$$ LANGUAGE plpgsql;

-- ============ TRIGGERS ============

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_compute_ledger_updated_at ON compute_ledger;
CREATE TRIGGER update_compute_ledger_updated_at
  BEFORE UPDATE ON compute_ledger
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_reputation_feedback_updated_at ON reputation_feedback;
CREATE TRIGGER update_reputation_feedback_updated_at
  BEFORE UPDATE ON reputation_feedback
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============ RLS POLICIES ============

ALTER TABLE compute_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE oracle_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
DROP POLICY IF EXISTS service_all_compute_ledger ON compute_ledger;
CREATE POLICY service_all_compute_ledger ON compute_ledger FOR ALL
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_all_credit_purchases ON credit_purchases;
CREATE POLICY service_all_credit_purchases ON credit_purchases FOR ALL
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_all_reputation_feedback ON reputation_feedback;
CREATE POLICY service_all_reputation_feedback ON reputation_feedback FOR ALL
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_all_reputation_cache ON reputation_cache;
CREATE POLICY service_all_reputation_cache ON reputation_cache FOR ALL
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_all_oracle_runs ON oracle_runs;
CREATE POLICY service_all_oracle_runs ON oracle_runs FOR ALL
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_all_alerts ON alerts;
CREATE POLICY service_all_alerts ON alerts FOR ALL
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_all_feature_flags ON feature_flags;
CREATE POLICY service_all_feature_flags ON feature_flags FOR ALL
  USING (auth.role() = 'service_role');

-- Public read for reputation cache (transparency per Section 1)
DROP POLICY IF EXISTS public_read_reputation_cache ON reputation_cache;
CREATE POLICY public_read_reputation_cache ON reputation_cache FOR SELECT
  USING (true);

-- Public read for feature flags
DROP POLICY IF EXISTS public_read_feature_flags ON feature_flags;
CREATE POLICY public_read_feature_flags ON feature_flags FOR SELECT
  USING (true);
