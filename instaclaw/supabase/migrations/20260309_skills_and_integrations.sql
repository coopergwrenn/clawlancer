-- Skills & Integrations: registry table + per-VM state table + seed data
--
-- instaclaw_skills: catalog of all available skills and integrations
-- instaclaw_vm_skills: per-VM enabled/connected state for each skill
-- Auto-provisions default skills when a new VM is created
-- Backfills existing VMs with default skill rows

-- ============================================================
-- 1. instaclaw_skills — registry of all available skills/integrations
-- ============================================================
CREATE TABLE instaclaw_skills (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  long_description TEXT,
  icon TEXT NOT NULL,
  category TEXT NOT NULL,
  item_type TEXT NOT NULL,
  auth_type TEXT,
  auth_config JSONB,
  requires_restart BOOLEAN DEFAULT true,
  requires_api_key BOOLEAN DEFAULT false,
  tier_minimum TEXT DEFAULT 'starter',
  is_default BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- 2. instaclaw_vm_skills — per-VM skill/integration state
-- ============================================================
CREATE TABLE instaclaw_vm_skills (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vm_id UUID NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES instaclaw_skills(id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT true,
  connected BOOLEAN DEFAULT false,
  credentials JSONB,
  config JSONB DEFAULT '{}',
  connected_account TEXT,
  installed_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(vm_id, skill_id)
);

-- Reuse existing trigger function for updated_at (created in 20260215_tasks.sql)
CREATE TRIGGER update_instaclaw_vm_skills_updated_at
  BEFORE UPDATE ON instaclaw_vm_skills
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 3. Seed 16 skills
-- ============================================================

-- Creative
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order)
VALUES
  ('sjinn-video', 'The Director', 'Full creative studio — produces videos with Seedance 2.0, Sora2, Veo3, Flux 2 Pro', '🎬', 'creative', 'skill', true, 1),
  ('brand-design', 'Brand Design', 'Creates logos, brand assets, and visual identity materials', '🎨', 'creative', 'skill', true, 2),
  ('voice-audio-production', 'Voice & Audio', 'Produces podcasts, voiceovers, and audio content', '🎙️', 'creative', 'skill', true, 3);

-- Productivity
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order)
VALUES
  ('email-outreach', 'Email Outreach', 'Sends, manages, and automates email campaigns', '📧', 'productivity', 'skill', true, 1),
  ('financial-analysis', 'Financial Analysis', 'Analyzes financial data, builds models, generates reports', '📊', 'productivity', 'skill', true, 2),
  ('competitive-intelligence', 'Competitive Intel', 'Monitors competitors, tracks market changes, generates intel', '🔍', 'productivity', 'skill', true, 3);

-- Commerce
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order)
VALUES
  ('ecommerce-marketplace', 'E-Commerce', 'Lists and sells products on Shopify, eBay, and marketplaces', '🛒', 'commerce', 'skill', true, 1),
  ('clawlancer', 'Clawlancer', 'Picks up bounties and earns crypto on Clawlancer', '🦀', 'commerce', 'mcp_server', false, 2),
  ('virtuals-agdp', 'Virtuals aGDP', 'Finds and completes jobs on the Virtuals aGDP marketplace', '🌐', 'commerce', 'skill', true, 3);

-- Social
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order)
VALUES
  ('social-media-content', 'Social Media', 'Creates and manages content across social platforms', '📱', 'social', 'skill', true, 1),
  ('web-search', 'Web Search', 'Searches the web in real-time for current information', '🔎', 'social', 'mcp_server', false, 2);
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order, status)
VALUES
  ('x-twitter-search', 'X/Twitter Search', 'Searches X/Twitter for latest posts and trends', '🐦', 'social', 'mcp_server', false, 3, 'coming_soon');

-- Communication
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order)
VALUES
  ('language-teacher', 'Language Tutor', 'Gamified language lessons personalized to your life — like a private Duolingo that knows you', '🗣️', 'communication', 'skill', true, 1);

-- Developer
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, requires_restart, sort_order)
VALUES
  ('code-execution', 'Code Execution', 'Writes and runs Python and Node.js in a sandbox', '💻', 'developer', 'built_in', false, 1),
  ('web-browsing', 'Web Browsing', 'Navigates and interacts with live websites', '🌍', 'developer', 'built_in', false, 2),
  ('file-management', 'File Management', 'Creates, reads, edits, and organizes files', '📁', 'developer', 'built_in', false, 3);

-- ============================================================
-- 4. Seed 8 integrations
-- ============================================================
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, auth_type, requires_restart, sort_order, status)
VALUES
  ('google-workspace', 'Google Workspace', 'Gmail, Calendar, Drive access', 'G', 'productivity', 'integration', 'oauth', false, 10, 'active'),
  ('notion', 'Notion', 'Create, search, and organize pages', '📝', 'productivity', 'integration', 'oauth', false, 11, 'active'),
  ('shopify', 'Shopify', 'Store management and product listings', '🛍️', 'commerce', 'integration', 'api_key', false, 10, 'active'),
  ('github', 'GitHub', 'Repository access and issue management', '🐙', 'developer', 'integration', 'oauth', false, 10, 'active'),
  ('apple-notes', 'Apple Notes', 'Create, search, and organize notes', '🍎', 'productivity', 'integration', 'cli_bridge', false, 12, 'coming_soon'),
  ('apple-reminders', 'Apple Reminders', 'Add, list, and complete reminders', '⏰', 'productivity', 'integration', 'cli_bridge', false, 13, 'coming_soon'),
  ('trello', 'Trello', 'Board and card management', '📋', 'productivity', 'integration', 'oauth', false, 14, 'coming_soon'),
  ('slack', 'Slack', 'Workspace messaging and channels', '💬', 'social', 'integration', 'oauth', false, 10, 'coming_soon');

-- ============================================================
-- 5. Auto-provisioning trigger — new VMs get default skills
-- ============================================================
CREATE OR REPLACE FUNCTION instaclaw_provision_default_skills()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO instaclaw_vm_skills (vm_id, skill_id, enabled, connected)
  SELECT NEW.id, s.id,
    CASE WHEN s.item_type = 'integration' THEN false ELSE true END,
    false
  FROM instaclaw_skills s
  WHERE s.is_default = true;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER provision_vm_skills
  AFTER INSERT ON instaclaw_vms
  FOR EACH ROW EXECUTE FUNCTION instaclaw_provision_default_skills();

-- ============================================================
-- 6. Backfill existing VMs with default skills
-- ============================================================
INSERT INTO instaclaw_vm_skills (vm_id, skill_id, enabled, connected)
SELECT v.id, s.id,
  CASE WHEN s.item_type = 'integration' THEN false ELSE true END,
  false
FROM instaclaw_vms v
CROSS JOIN instaclaw_skills s
WHERE s.is_default = true
  AND v.assigned_to IS NOT NULL
ON CONFLICT (vm_id, skill_id) DO NOTHING;
