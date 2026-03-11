-- WDP 71 AgentKit: AgentBook registration tracking + x402 usage storage
-- Phase 1 — instaclaw only (no Clawlancer changes)

-- 1. Add AgentBook columns to instaclaw_vms
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS agentbook_registered BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agentbook_nullifier_hash TEXT,
  ADD COLUMN IF NOT EXISTS agentbook_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS agentbook_registered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agentbook_wallet_address TEXT;

CREATE INDEX IF NOT EXISTS idx_vms_agentbook
  ON instaclaw_vms (agentbook_registered)
  WHERE agentbook_registered = true;

-- 2. x402 AgentKit usage tracking (implements AgentKitStorage interface)
CREATE TABLE IF NOT EXISTS instaclaw_agentkit_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint TEXT NOT NULL,
  human_id TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint, human_id)
);

-- 3. Nonce replay protection
CREATE TABLE IF NOT EXISTS instaclaw_agentkit_nonces (
  nonce TEXT PRIMARY KEY,
  used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
