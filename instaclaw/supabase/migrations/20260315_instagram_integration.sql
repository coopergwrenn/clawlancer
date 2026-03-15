-- Instagram Graph API Integration
-- Tables for OAuth tokens, rate limiting, and keyword triggers
-- Uses Instagram API with Instagram Login (new scopes, mandatory since Jan 27 2025)

-- ============================================================
-- 1. instaclaw_instagram_integrations — OAuth tokens + account info
-- ============================================================
CREATE TABLE instaclaw_instagram_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  instagram_user_id TEXT NOT NULL,
  instagram_username TEXT,
  access_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  webhook_subscribed BOOLEAN DEFAULT false,
  scopes TEXT[],
  connected_at TIMESTAMPTZ DEFAULT now(),
  last_webhook_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active',
  UNIQUE(user_id),
  UNIQUE(instagram_user_id)
);

-- Index for webhook lookups (find user by IG account)
CREATE INDEX idx_instagram_integrations_ig_user
  ON instaclaw_instagram_integrations (instagram_user_id);

-- ============================================================
-- 2. instaclaw_instagram_rate_limits — per-hour message counter
-- ============================================================
CREATE TABLE instaclaw_instagram_rate_limits (
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  hour_bucket TIMESTAMPTZ NOT NULL,
  messages_sent INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, hour_bucket)
);

-- ============================================================
-- 3. instaclaw_instagram_triggers — keyword automation rules
-- ============================================================
CREATE TABLE instaclaw_instagram_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  keywords TEXT[],
  response_template TEXT,
  ai_response BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_instagram_triggers_user
  ON instaclaw_instagram_triggers (user_id, active);

-- ============================================================
-- 4. Add instagram-automation to skills registry
-- ============================================================
INSERT INTO instaclaw_skills (slug, name, description, icon, category, item_type, auth_type, requires_restart, sort_order, is_default)
VALUES (
  'instagram-automation',
  'Instagram Automation',
  'Read and reply to DMs, auto-respond to comments, manage story replies via Instagram Graph API',
  'camera',
  'social',
  'integration',
  'oauth',
  false,
  4,
  true
);

-- Backfill existing assigned VMs with the new skill (disabled by default since it's an integration)
INSERT INTO instaclaw_vm_skills (vm_id, skill_id, enabled, connected)
SELECT v.id, s.id, false, false
FROM instaclaw_vms v
CROSS JOIN instaclaw_skills s
WHERE s.slug = 'instagram-automation'
  AND v.assigned_to IS NOT NULL
ON CONFLICT (vm_id, skill_id) DO NOTHING;
