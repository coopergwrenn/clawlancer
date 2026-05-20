-- instaclaw_users: per-user rate-limit anchor for /api/edge/express-intent.
--
-- The route checks this column and rejects new submissions within
-- INTENT_RATE_LIMIT_WINDOW_MS (5 minutes today). Only set on SUCCESSFUL
-- createIndexIntent calls — failed submissions (validation errors,
-- Yanek-write-tool errors) leave the column unchanged so users can
-- immediately retry.
--
-- Why a dedicated column instead of reusing instaclaw_admin_alert_log
-- or matchpool_outcomes:
--   • Per-USER granularity needed (Vercel function instances are
--     stateless, so in-memory rate-limit won't work).
--   • instaclaw_admin_alert_log is for operator alerts, not user state.
--   • A new column on the entity that owns the rate-limit semantic
--     (the user) is the cleanest single-source-of-truth.
--
-- NULL = no prior intent ever submitted. The rate-limit gate treats
-- NULL as "allow immediately."
--
-- Rollback:
--   ALTER TABLE instaclaw_users DROP COLUMN index_last_intent_at;

ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS index_last_intent_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.instaclaw_users.index_last_intent_at IS
  'Wall-clock time of the user''s most recent successful Index Network intent submission (via /api/edge/express-intent). NULL = never submitted. Used for per-user rate-limiting (1 submission per 5 min). Only updated on success — failed submissions leave this unchanged.';
