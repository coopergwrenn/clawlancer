-- Skills audit fixes (2026-03-09)
-- 1. Fix remotion-video slug to match codebase directory name "motion-graphics"
-- 2. Deactivate freelance-digital (no working code behind it)
-- 3. Add marketplace-earning skill (production-ready, doc-only, uses MCP)

-- 1. Rename remotion-video → motion-graphics
UPDATE instaclaw_skills
SET slug = 'motion-graphics'
WHERE slug = 'remotion-video';

-- Also update any vm_skills references (foreign key follows skill_id, not slug, so no action needed)

-- 2. Deactivate freelance-digital
UPDATE instaclaw_skills
SET is_active = false
WHERE slug = 'freelance-digital';

-- 3. Add marketplace-earning skill
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order, is_default)
VALUES (
  'marketplace-earning',
  'Marketplace Earning',
  'Earn money autonomously via Clawlancer bounties and digital product creation. Poll bounties, claim tasks, create and sell digital products.',
  '💰',
  'earn',
  'skill',
  false,
  8,
  false
)
ON CONFLICT (slug) DO NOTHING;

-- Backfill instaclaw_vm_skills for existing assigned VMs (disabled by default)
INSERT INTO instaclaw_vm_skills (vm_id, skill_id, enabled, connected, config)
SELECT v.id, s.id, false, false, '{}'::jsonb
FROM instaclaw_vms v
CROSS JOIN instaclaw_skills s
WHERE s.slug = 'marketplace-earning'
  AND v.assigned_to IS NOT NULL
ON CONFLICT (vm_id, skill_id) DO NOTHING;
