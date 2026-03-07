-- Add Prediction Markets and Freelance & Digital Products skills
-- These exist on the Earn page but were missing from the Skills page

-- 1. Prediction Markets skill
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order, is_default)
VALUES (
  'prediction-markets',
  'Prediction Markets',
  'Trade on Polymarket and Kalshi — the world''s largest prediction markets',
  '📈',
  'commerce',
  'skill',
  true,
  5,
  false
)
ON CONFLICT (slug) DO NOTHING;

-- 2. Freelance & Digital Products skill
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order, is_default)
VALUES (
  'freelance-digital',
  'Freelance & Digital Products',
  'Sell services and digital products on Gumroad, Fiverr, and Upwork',
  '💼',
  'commerce',
  'skill',
  true,
  6,
  false
)
ON CONFLICT (slug) DO NOTHING;

-- 3. Backfill instaclaw_vm_skills for existing assigned VMs (disabled by default)
INSERT INTO instaclaw_vm_skills (vm_id, skill_id, enabled, connected)
SELECT v.id, s.id, false, false
FROM instaclaw_vms v
CROSS JOIN instaclaw_skills s
WHERE s.slug IN ('prediction-markets', 'freelance-digital')
  AND v.assigned_to IS NOT NULL
ON CONFLICT (vm_id, skill_id) DO NOTHING;
