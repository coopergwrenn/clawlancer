-- AgentBook hat-claim promotional banner — per-user dismissal tracking.
--
-- Mirrors the existing world_id_banner_dismissed_at pattern (verified to be
-- the canonical shape for promotional dismissals on instaclaw_users — see
-- app/api/auth/world-id/dismiss-banner/route.ts and the corresponding
-- /status route which gates banner_dismissed via a 7-day window).
--
-- For the AgentBook hat banner we use a 30-day soft window per Cooper's
-- spec: "once dismissed, don't show it again (or at least for 30 days)."
-- The window is enforced in the API route (banner-state), not the schema —
-- keeps the migration trivial and lets us tune without re-migrating.
--
-- Idempotent: re-running is safe via IF NOT EXISTS.

ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS agentbook_banner_dismissed_at TIMESTAMPTZ;

COMMENT ON COLUMN instaclaw_users.agentbook_banner_dismissed_at IS
  'When the user dismissed the AgentBook hat-claim promotional banner. NULL = never dismissed (eligible to see banner). Window is 30 days enforced in API.';
