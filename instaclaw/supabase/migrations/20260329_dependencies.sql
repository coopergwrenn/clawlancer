-- Dependencies tracking table for /hq/dependencies
CREATE TABLE IF NOT EXISTS instaclaw_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('core','skill','npm','api','infra')),
  check_type TEXT NOT NULL CHECK (check_type IN ('github_release','npm','pypi','http_health','manual')),
  check_target TEXT,
  repo_url TEXT,
  our_version TEXT,
  latest_version TEXT,
  is_behind BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('current','behind','anomaly','unknown','manual')),
  update_impact TEXT NOT NULL DEFAULT 'low' CHECK (update_impact IN ('high','medium','low')),
  auto_update_enabled BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deps_category ON instaclaw_dependencies (category);
CREATE INDEX IF NOT EXISTS idx_deps_status ON instaclaw_dependencies (status);

-- Seed all known dependencies
INSERT INTO instaclaw_dependencies (name, description, category, check_type, check_target, repo_url, our_version, update_impact, notes) VALUES
  ('OpenClaw', 'AI agent gateway running on each VM', 'core', 'npm', 'openclaw', 'https://github.com/open-claw/open-claw', '2026.2.24', 'high', 'Fleet-wide upgrade required. Use /hq/fleet-upgrade.'),
  ('Next.js', 'App framework', 'core', 'npm', 'next', 'https://github.com/vercel/next.js', '16.1.6', 'high', 'Major version bumps need full QA pass.'),
  ('Supabase JS', 'Database client SDK', 'core', 'npm', '@supabase/supabase-js', 'https://github.com/supabase/supabase-js', '2.95.2', 'high', 'Auth + realtime depends on this.'),
  ('React', 'UI library', 'core', 'npm', 'react', 'https://github.com/facebook/react', '19.2.3', 'high', 'Must match react-dom version.'),
  ('viem', 'Ethereum interaction library (Base mainnet)', 'core', 'npm', 'viem', 'https://github.com/wevm/viem', '2.47.1', 'medium', 'Used for ambassador NFT minting + USDC payments.'),
  ('Stripe', 'Payment processing SDK', 'npm', 'npm', 'stripe', 'https://github.com/stripe/stripe-node', '20.3.1', 'medium', 'Subscription billing.'),
  ('Resend', 'Transactional email SDK', 'npm', 'npm', 'resend', 'https://github.com/resend/resend-node', '6.9.1', 'low', 'Invite + alert emails.'),
  ('Sentry', 'Error tracking SDK', 'npm', 'npm', '@sentry/nextjs', 'https://github.com/getsentry/sentry-javascript', '10.38.0', 'low', 'Monitoring + error reporting.'),
  ('Crawlee', 'Stealth web scraping (Python, on VMs)', 'skill', 'pypi', 'crawlee', 'https://github.com/apify/crawlee-python', '1.5.0', 'medium', 'Pinned ==1.5.0 in provisioning. VM-side dependency.'),
  ('Playwright', 'Browser automation (on VMs)', 'skill', 'pypi', 'playwright', 'https://github.com/microsoft/playwright-python', '1.58.0', 'medium', 'Pre-installed on VM base image.'),
  ('Anthropic API', 'LLM backbone for all agents', 'api', 'http_health', 'https://status.anthropic.com/api/v2/us.json', NULL, NULL, 'high', 'Primary LLM provider. Outage = full service down.'),
  ('Hetzner API', 'VM provisioning (legacy)', 'api', 'http_health', 'https://api.hetzner.cloud/v1/servers', NULL, NULL, 'low', 'Legacy provider — migrating to Linode only.'),
  ('Linode API', 'VM provisioning (primary)', 'api', 'http_health', 'https://api.linode.com/v4/regions', NULL, NULL, 'high', 'Primary VM provider.'),
  ('Supabase Platform', 'Hosted PostgreSQL + Auth', 'infra', 'http_health', 'https://status.supabase.com/api/v2/status.json', NULL, NULL, 'high', 'Database + auth backbone.'),
  ('Vercel', 'Hosting platform for instaclaw.io', 'infra', 'http_health', 'https://instaclaw.io/api/health', NULL, NULL, 'high', 'Production hosting.'),
  ('PostHog', 'Product analytics', 'npm', 'npm', 'posthog-js', 'https://github.com/PostHog/posthog-js', '1.347.1', 'low', 'Analytics tracking.'),
  ('Open-Higgsfield-AI', 'AI video generation skill (Seedance, Kling, Veo, etc.)', 'skill', 'github_release', 'Anil-matcha/Open-Higgsfield-AI', 'https://github.com/Anil-matcha/Open-Higgsfield-AI', NULL, 'high', 'Custom Python scripts wrap the Muapi API. New models/endpoints need manual script updates + fleet deploy.'),
  ('Virtuals ACP', 'Agent commerce protocol — agents earn on marketplace', 'skill', 'github_release', 'Virtual-Protocol/openclaw-acp', 'https://github.com/Virtual-Protocol/openclaw-acp', NULL, 'medium', 'Cloned at HEAD with --depth 1 on each VM. New releases need manual fleet deploy.'),
  ('Remotion', 'Motion graphics rendering on VMs', 'skill', 'npm', 'remotion', 'https://github.com/remotion-dev/remotion', '^4.0.0', 'medium', 'Installed once during provisioning. VMs provisioned at different times may have different patch versions.'),
  ('AgentMail', 'Email outreach for agents', 'api', 'manual', NULL, 'https://agentmail.to', NULL, 'medium', 'Monitor for API changes. No versioning available.'),
  ('ElevenLabs', 'Premium text-to-speech', 'api', 'manual', NULL, 'https://elevenlabs.io', NULL, 'medium', 'Monitor voice model deprecations.'),
  ('OpenAI TTS', 'Text-to-speech for voice skill', 'api', 'manual', NULL, 'https://platform.openai.com', NULL, 'medium', 'Monitor tts-1/tts-2 model deprecations.'),
  ('Kalshi', 'Prediction market trading', 'api', 'http_health', 'https://trading-api.kalshi.com/trade-api/v2/exchange/status', NULL, NULL, 'medium', '13 Python scripts depend on response schema. No API versioning.'),
  ('Polymarket CLOB', 'Prediction market trading', 'api', 'http_health', 'https://clob.polymarket.com', NULL, NULL, 'medium', 'Python scripts deployed via fleet-push. No API version pinning.'),
  ('DexScreener', 'Token prices for Solana trading', 'api', 'http_health', 'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', NULL, NULL, 'low', 'Used in solana-defi skill. Stable API.'),
  ('Brave Search', 'Web search for competitive intelligence skill', 'api', 'http_health', 'https://api.search.brave.com/res/v1/web/search?q=test', NULL, NULL, 'low', 'Stable API, low risk.')
ON CONFLICT (name) DO NOTHING;
