-- Skill: Remotion Video
-- Programmatic video generation using React components on VMs

INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order, is_default)
VALUES (
  'motion-graphics',
  'Remotion Video',
  'Programmatic video generation using React components. Create motion graphics, data visualizations, and animated content.',
  '🎬',
  'creative',
  'skill',
  true,
  7,
  false
)
ON CONFLICT (slug) DO NOTHING;

-- Backfill instaclaw_vm_skills for existing assigned VMs (disabled by default)
INSERT INTO instaclaw_vm_skills (vm_id, skill_id, enabled, connected, config)
SELECT v.id, s.id, false, false, '{}'::jsonb
FROM instaclaw_vms v
CROSS JOIN instaclaw_skills s
WHERE s.slug = 'motion-graphics'
  AND v.assigned_to IS NOT NULL
ON CONFLICT (vm_id, skill_id) DO NOTHING;
