-- Dependencies tracking table for /hq/dependencies
CREATE TABLE IF NOT EXISTS instaclaw_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
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

CREATE INDEX idx_deps_category ON instaclaw_dependencies (category);
CREATE INDEX idx_deps_status ON instaclaw_dependencies (status);

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
  ('Playwright', 'Browser automation (on VMs)', 'skill', 'pypi', 'playwright', 'https://github.com/microsoft/playwright-python', NULL, 'medium', 'Pre-installed on VM base image.'),
  ('Anthropic API', 'LLM backbone for all agents', 'api', 'http_health', 'https://status.anthropic.com/api/v2/us.json', NULL, NULL, 'high', 'Primary LLM provider. Outage = full service down.'),
  ('Hetzner API', 'VM provisioning (legacy)', 'api', 'http_health', 'https://api.hetzner.cloud/v1/servers', NULL, NULL, 'low', 'Legacy provider — migrating to Linode only.'),
  ('Linode API', 'VM provisioning (primary)', 'api', 'http_health', 'https://api.linode.com/v4/regions', NULL, NULL, 'high', 'Primary VM provider.'),
  ('Supabase Platform', 'Hosted PostgreSQL + Auth', 'infra', 'http_health', 'https://api.supabase.com/platform/health', NULL, NULL, 'high', 'Database + auth backbone.'),
  ('Vercel', 'Hosting platform for instaclaw.io', 'infra', 'http_health', 'https://instaclaw.io/api/health', NULL, NULL, 'high', 'Production hosting.'),
  ('PostHog', 'Product analytics', 'npm', 'npm', 'posthog-js', 'https://github.com/PostHog/posthog-js', '1.347.1', 'low', 'Analytics tracking.');
