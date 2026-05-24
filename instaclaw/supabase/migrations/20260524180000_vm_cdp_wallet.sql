-- Coinbase Developer Platform (CDP) BACKUP wallet columns on instaclaw_vms.
--
-- Background: every InstaClaw agent has a primary Bankr wallet for EVM
-- operations (trading, swaps, fee claims, token launches). This works
-- great when Bankr is operational, but during a Bankr outage / maintenance
-- window, paying users have no transaction wallet at all. The original
-- pre-Bankr-partnership design provisioned a Coinbase CDP smart wallet
-- for every agent; it got lost during the Bankr cutover and never
-- restored. This migration restores it as the BACKUP wallet.
--
-- Architecture: CDP is ADDITIVE, not a replacement for Bankr. Every VM
-- gets BOTH wallets. The agent uses Bankr by default; CDP serves as a
-- receive-only fallback when Bankr is unavailable. CDP wallets are
-- server-managed via Coinbase MPC — the agent on the VM only holds the
-- public address, never any signing material. Users can send funds to
-- the CDP address at any time; spending from CDP requires our backend
-- (out of scope for this migration; tracked as Phase 2 work).
--
-- Mirrors the original CDP migrations on the root marketplace codebase
-- (supabase/migrations/044_cdp_wallet_integration.sql + 045 unique
-- constraint), adapted for instaclaw_vms.
--
-- Columns:
--   cdp_wallet_id VARCHAR(255)
--     CDP-side identifier. For the current SDK shape this equals the
--     EVM address; storing both columns separately leaves room for
--     CDP introducing a distinct internal ID in the future without
--     forcing a follow-up migration.
--   cdp_wallet_address VARCHAR(42)
--     The on-chain 0x... address on Base. Public; safe to write to
--     ~/.openclaw/.env on the VM, embed in WALLET.md, surface in the
--     dashboard, etc. Never accompanied by a private key on the VM.
--
-- Idempotency gates:
--   idx_instaclaw_vms_cdp_wallet_id_unique
--   idx_instaclaw_vms_cdp_wallet_address_unique
--     Partial UNIQUE indexes (WHERE NOT NULL) — same shape as
--     bankr_wallet_id's protection. Provisioning re-entry races
--     between vm/assign + billing webhook + the backfill cron get
--     caught at the DB layer: the loser of the race gets a 23505 on
--     UPDATE, the provisioning helper logs the orphan CDP account
--     (cannot be deleted in CDP — accumulates inert in our Coinbase
--     org), and returns null cleanly. lib/cdp-wallet.ts also does a
--     SELECT-first idempotency check to avoid mints in the common case.
--
-- NO `wallet_provider` enum: CDP runs in parallel with Bankr, not as
-- an alternative provider. The marketplace migration 044 had a
-- wallet_provider column for the original mutually-exclusive design;
-- InstaClaw's pattern is additive.

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS cdp_wallet_id VARCHAR(255);

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS cdp_wallet_address VARCHAR(42);

CREATE UNIQUE INDEX IF NOT EXISTS idx_instaclaw_vms_cdp_wallet_id_unique
  ON instaclaw_vms(cdp_wallet_id)
  WHERE cdp_wallet_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_instaclaw_vms_cdp_wallet_address_unique
  ON instaclaw_vms(cdp_wallet_address)
  WHERE cdp_wallet_address IS NOT NULL;

COMMENT ON COLUMN instaclaw_vms.cdp_wallet_id IS
  'Coinbase Developer Platform wallet identifier (currently == cdp_wallet_address; SDK uses address as id). Server-managed MPC; never on-VM signing material.';

COMMENT ON COLUMN instaclaw_vms.cdp_wallet_address IS
  'Public 0x address of the agent''s CDP backup wallet on Base. Written to ~/.openclaw/.env as CDP_WALLET_ADDRESS and surfaced in WALLET.md. Receive-only from the VM''s perspective.';
