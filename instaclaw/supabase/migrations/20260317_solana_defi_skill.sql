-- Skill 15: Solana DeFi Trading
-- Adds skill registry entry, VM columns for wallet tracking, and backfills vm_skills

-- 1. Add columns to instaclaw_vms for wallet + feature tracking
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS solana_wallet_address TEXT,
  ADD COLUMN IF NOT EXISTS solana_defi_enabled BOOLEAN DEFAULT false;

-- 2. Insert skill into instaclaw_skills registry (opt-in, not default)
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order, is_default)
VALUES (
  'solana-defi',
  'Solana DeFi Trading',
  'Trade tokens on Solana via Jupiter and PumpPortal with built-in safety rails. Auto-provisioned wallet, position tracking, and risk limits.',
  '◎',
  'commerce',
  'skill',
  true,
  4,
  false
)
ON CONFLICT (slug) DO NOTHING;

-- 3. Backfill instaclaw_vm_skills for existing assigned VMs (disabled by default)
INSERT INTO instaclaw_vm_skills (vm_id, skill_id, enabled, connected, config)
SELECT v.id, s.id, false, false, '{"max_trade_sol":0.1,"daily_loss_limit_sol":0.5,"auto_trade":false}'::jsonb
FROM instaclaw_vms v
CROSS JOIN instaclaw_skills s
WHERE s.slug = 'solana-defi'
  AND v.assigned_to IS NOT NULL
ON CONFLICT (vm_id, skill_id) DO NOTHING;
