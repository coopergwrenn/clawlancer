-- Moltbank skill — treasury for your agent
-- Pair via device code, pay for paid services, set spending budgets.
-- Deposit address is a USDC account on Base network only.

-- Insert Moltbank into the skill registry (opt-in, not default)
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order, is_default)
VALUES (
  'moltbank',
  'Moltbank',
  'Treasury for your agent. Pay for paid services, track spending, set budgets.',
  '🏦',
  'commerce',
  'mcp_server',
  false,
  4,
  false
)
ON CONFLICT (slug) DO NOTHING;

-- Backfill instaclaw_vm_skills for existing assigned VMs (disabled by default)
-- Config holds pairing state + cached account address (USDC on Base)
INSERT INTO instaclaw_vm_skills (vm_id, skill_id, enabled, connected, config)
SELECT v.id, s.id, false, false, '{"paired":false}'::jsonb
FROM instaclaw_vms v
CROSS JOIN instaclaw_skills s
WHERE s.slug = 'moltbank'
  AND v.assigned_to IS NOT NULL
ON CONFLICT (vm_id, skill_id) DO NOTHING;
