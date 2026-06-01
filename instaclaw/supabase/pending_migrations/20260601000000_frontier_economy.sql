-- Frontier — InstaClaw's Open Agent Economy. Storage layer (Phase 1 + Phase 2).
--
-- PRD: instaclaw/docs/prd/agent-economy-os-2026-05-12.md §9.
--
-- Tables:
--   frontier_offerings              — what an agent SELLS (x402 service or compute)
--   frontier_transactions          — every settlement, all rails, per-VM perspective
--   frontier_reputation_events     — queued ERC-8004 feedback (batched on-chain later)
--   frontier_erc8004_identities    — vm_id → ERC-8004 agentId mapping
--   frontier_treasury_burn_queue   — protocol fees pending $INSTACLAW burn (Phase 0 dep)
--   frontier_settlement_retry_queue— refunds / reverify / redeliver retries
--   frontier_compute_capacity      — Phase 2 discovery: which VM offers what, idle %
--   + per-VM columns on instaclaw_vms
--
-- Idempotent throughout (CREATE TABLE/INDEX IF NOT EXISTS, DROP POLICY IF EXISTS).
-- RLS enabled on every table per Rule 60; service-role-only policy (all Frontier
-- reads/writes go through the service-key backend — the API does the authz, same
-- posture as matchpool_deliberations/notifications). No anon/authenticated policy
-- = deny-by-default. A public-storefront anon-read policy on frontier_offerings is
-- deferred to the storefront phase (PRD Phase 5), not granted here.
--
-- Embedding dimension: 1024 — confirmed against matchpool_profiles (voyage-3-large
-- / text-embedding-3-large Matryoshka @ 1024, lib/match-embeddings.ts). Do NOT use
-- gbrain's 1536 here; that's a different system.
--
-- Rule 56: this file lives in pending_migrations/ until applied to prod. Cooper
-- applies via Supabase Studio, THEN it moves to migrations/ in the same commit
-- (so verify-migrations.ts, which gates `npm run build`, sees the tables exist).
-- Committing this into migrations/ before applying would break every Vercel build.

CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector (already enabled by matchpool; defensive)
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid (defensive)

-- ════════════════════════════════════════════════════════════════════════
-- updated_at touch trigger (shared)
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION frontier_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════════════════════════
-- 1. frontier_offerings — what an agent sells
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS frontier_offerings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id         uuid NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  category      text NOT NULL DEFAULT 'service' CHECK (category IN ('service','compute')),
  slug          text NOT NULL,
  description   text NOT NULL,
  price_usdc    numeric(14,6) NOT NULL CHECK (price_usdc > 0),
  price_unit    text NOT NULL DEFAULT 'flat'
                CHECK (price_unit IN ('flat','cpu_min','page','1k_embeddings','frame','image')),
  handler_path  text NOT NULL,
  embedding     vector(1024),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW(),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (vm_id, slug)
);

CREATE INDEX IF NOT EXISTS frontier_offerings_vm_active_idx
  ON frontier_offerings (vm_id, active);

-- hnsw (no training data needed, unlike ivfflat-on-empty-table); NULL-excluded
-- to match matchpool_profiles index style. Used by commerce matching retrieval.
CREATE INDEX IF NOT EXISTS frontier_offerings_embedding_idx
  ON frontier_offerings USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

DROP TRIGGER IF EXISTS frontier_offerings_touch ON frontier_offerings;
CREATE TRIGGER frontier_offerings_touch BEFORE UPDATE ON frontier_offerings
  FOR EACH ROW EXECUTE FUNCTION frontier_touch_updated_at();

ALTER TABLE frontier_offerings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS frontier_offerings_service ON frontier_offerings;
CREATE POLICY frontier_offerings_service ON frontier_offerings
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 2. frontier_transactions — every settlement, all rails
-- Per-VM perspective: an agent-to-agent sale produces TWO rows (seller earn +
-- buyer spend) linked by counterparty_vm_id. Idempotent via UNIQUE(vm_id,request_id).
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS frontier_transactions (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id                    text NOT NULL,                 -- idempotency key (agent retries)
  rail                          text NOT NULL
                                CHECK (rail IN ('x402','compute','card','stripe_mcp','ap2','base_mcp')),
  direction                     text NOT NULL CHECK (direction IN ('earn','spend')),
  vm_id                         uuid NOT NULL REFERENCES instaclaw_vms(id),
  counterparty_address          varchar(42),
  counterparty_vm_id            uuid REFERENCES instaclaw_vms(id),
  counterparty_erc8004_agent_id bigint,                        -- uint256 in practice fits bigint
  amount_usdc                   numeric(14,6) NOT NULL CHECK (amount_usdc > 0),
  protocol_fee_usdc             numeric(14,6) NOT NULL DEFAULT 0 CHECK (protocol_fee_usdc >= 0),
  offering_id                   uuid REFERENCES frontier_offerings(id),
  match_log_id                  uuid,
  external_invoice_id           text,
  ap2_mandate_id                text,
  tx_hash                       text,
  facilitator                   text DEFAULT 'coinbase',
  status                        text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','settled','failed','disputed','refunded')),
  request_body                  jsonb
                                CHECK (request_body IS NULL OR octet_length(request_body::text) <= 262144),
  response_summary              text,
  verified_on_chain_at          timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT NOW(),
  settled_at                    timestamptz,
  metadata                      jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (vm_id, request_id)
);

CREATE INDEX IF NOT EXISTS frontier_txn_vm_created_idx
  ON frontier_transactions (vm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS frontier_txn_counterparty_idx
  ON frontier_transactions (counterparty_vm_id, created_at DESC)
  WHERE counterparty_vm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS frontier_txn_status_idx
  ON frontier_transactions (status, settled_at);
CREATE INDEX IF NOT EXISTS frontier_txn_tx_hash_idx
  ON frontier_transactions (tx_hash)
  WHERE tx_hash IS NOT NULL;

ALTER TABLE frontier_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS frontier_transactions_service ON frontier_transactions;
CREATE POLICY frontier_transactions_service ON frontier_transactions
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 3. frontier_reputation_events — queued ERC-8004 feedback
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS frontier_reputation_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      uuid NOT NULL REFERENCES frontier_transactions(id) ON DELETE CASCADE,
  from_vm_id          uuid NOT NULL REFERENCES instaclaw_vms(id),
  to_erc8004_agent_id bigint NOT NULL,
  value_0_100         integer NOT NULL CHECK (value_0_100 BETWEEN 0 AND 100),
  tag1                text,
  tag2                text,
  feedback_uri        text,
  feedback_hash       bytea,
  on_chain_tx_hash    text,
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','on_chain','failed')),
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  settled_at          timestamptz
);

CREATE INDEX IF NOT EXISTS frontier_rep_queued_idx
  ON frontier_reputation_events (status, created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS frontier_rep_from_vm_idx
  ON frontier_reputation_events (from_vm_id);

ALTER TABLE frontier_reputation_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS frontier_reputation_events_service ON frontier_reputation_events;
CREATE POLICY frontier_reputation_events_service ON frontier_reputation_events
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 4. frontier_erc8004_identities — vm_id → ERC-8004 agentId
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS frontier_erc8004_identities (
  vm_id                uuid PRIMARY KEY REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  agent_id             bigint NOT NULL UNIQUE,
  agent_uri            text NOT NULL,
  registered_at        timestamptz NOT NULL DEFAULT NOW(),
  registration_tx_hash text NOT NULL,
  registry_chain       text NOT NULL CHECK (registry_chain IN ('ethereum','base','world_chain'))
);

ALTER TABLE frontier_erc8004_identities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS frontier_erc8004_identities_service ON frontier_erc8004_identities;
CREATE POLICY frontier_erc8004_identities_service ON frontier_erc8004_identities
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 5. frontier_treasury_burn_queue — protocol fees pending $INSTACLAW burn
-- Contingent on tokenomics Phase 0 (BurnRouter). Rows accrue; burn cron sweeps.
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS frontier_treasury_burn_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid REFERENCES frontier_transactions(id),
  amount_usdc    numeric(14,6) NOT NULL CHECK (amount_usdc > 0),
  source_tag     text NOT NULL,
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','burned','failed')),
  burn_tx_hash   text,
  burned_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frontier_burn_queued_idx
  ON frontier_treasury_burn_queue (status, created_at)
  WHERE status = 'queued';

ALTER TABLE frontier_treasury_burn_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS frontier_treasury_burn_queue_service ON frontier_treasury_burn_queue;
CREATE POLICY frontier_treasury_burn_queue_service ON frontier_treasury_burn_queue
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 6. frontier_settlement_retry_queue — refunds / reverify / redeliver
-- Handles audit edge-cases: x402 server crash mid-txn, on-chain-settled-but-
-- delivery-timed-out, VM-reclaimed-mid-txn. Never leave money-taken-no-delivery.
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS frontier_settlement_retry_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES frontier_transactions(id),
  action         text NOT NULL CHECK (action IN ('refund','reverify','redeliver')),
  attempts       integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','done','failed')),
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  updated_at     timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frontier_retry_queued_idx
  ON frontier_settlement_retry_queue (status, created_at)
  WHERE status = 'queued';

DROP TRIGGER IF EXISTS frontier_retry_touch ON frontier_settlement_retry_queue;
CREATE TRIGGER frontier_retry_touch BEFORE UPDATE ON frontier_settlement_retry_queue
  FOR EACH ROW EXECUTE FUNCTION frontier_touch_updated_at();

ALTER TABLE frontier_settlement_retry_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS frontier_settlement_retry_queue_service ON frontier_settlement_retry_queue;
CREATE POLICY frontier_settlement_retry_queue_service ON frontier_settlement_retry_queue
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 7. frontier_compute_capacity — Phase 2 discovery
-- One row per VM advertising compute. Refreshed every 1-2 min from node_exporter
-- + capability manifests. Buyer queries by capability + budget.
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS frontier_compute_capacity (
  vm_id         uuid PRIMARY KEY REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  capabilities  text[] NOT NULL DEFAULT '{}',
  idle_pct      numeric(5,2),
  reputation    numeric(4,2),
  last_seen     timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frontier_capacity_caps_idx
  ON frontier_compute_capacity USING gin (capabilities);

ALTER TABLE frontier_compute_capacity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS frontier_compute_capacity_service ON frontier_compute_capacity;
CREATE POLICY frontier_compute_capacity_service ON frontier_compute_capacity
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- 8. Per-VM Frontier columns on instaclaw_vms
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS x402_server_port              integer DEFAULT 8402,
  ADD COLUMN IF NOT EXISTS compute_server_port           integer DEFAULT 8403,
  ADD COLUMN IF NOT EXISTS frontier_reputation_score     numeric(4,2),
  ADD COLUMN IF NOT EXISTS frontier_lifetime_earned_usdc numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frontier_lifetime_spent_usdc  numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frontier_compute_earned_usdc  numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_mcp_oauth_token_encrypted text,
  ADD COLUMN IF NOT EXISTS stripe_issuing_card_id        text,
  ADD COLUMN IF NOT EXISTS ens_subdomain                 text;

COMMENT ON COLUMN instaclaw_vms.x402_server_port IS
  'Port the per-VM x402-server systemd unit binds. Default 8402. PRD §6.1.1.';
COMMENT ON COLUMN instaclaw_vms.compute_server_port IS
  'Port the per-VM compute-x402-server binds (Phase 2). Default 8403. PRD §7.4.';
COMMENT ON COLUMN instaclaw_vms.frontier_reputation_score IS
  '0.00-5.00 aggregated reputation, computed nightly. NULL = cold-start (no rep yet).';
COMMENT ON COLUMN instaclaw_vms.frontier_lifetime_earned_usdc IS
  'Rolling sum of settled earn transactions. Stored to avoid per-render aggregation.';
COMMENT ON COLUMN instaclaw_vms.frontier_lifetime_spent_usdc IS
  'Rolling sum of settled spend transactions.';
COMMENT ON COLUMN instaclaw_vms.frontier_compute_earned_usdc IS
  'Subset of lifetime_earned attributable to the Phase 2 compute marketplace.';
COMMENT ON COLUMN instaclaw_vms.stripe_mcp_oauth_token_encrypted IS
  'Optional. AES-encrypted Stripe OAuth token when the owner connects Stripe (Phase 1C).';
COMMENT ON COLUMN instaclaw_vms.stripe_issuing_card_id IS
  'Stripe Issuing virtual card id once the debit card is provisioned (Phase 1B).';
COMMENT ON COLUMN instaclaw_vms.ens_subdomain IS
  'e.g. alphabot.instaclaw.eth. Resolves to bankr_evm_address. NULL until provisioned (Phase 1C).';
