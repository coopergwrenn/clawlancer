-- 20260527210000_allow_web_channel_in_check_constraints.sql
--
-- HOTFIX — adds 'web' to the CHECK constraints on:
--   1. instaclaw_users.preferred_channel
--   2. instaclaw_pending_users.channel
--
-- Why this exists: migration 20260526180000_onboarding_redesign_channels.sql
-- (channel-first onboarding redesign, landed 2026-05-26) added these
-- constraints with valid values {'imessage','telegram','discord','slack'}.
-- Phase 1 of the skip-to-command-center work (PR commit 73b57e81,
-- shipped 2026-05-27) introduced a new value 'web' but missed the
-- constraint check during research — the spec verified `preferred_channel`
-- existed and was NULL on all 1000 users but never queried pg_constraint
-- for valid values.
--
-- Symptom: /onboarding/web's UPDATE for `preferred_channel = 'web'` has
-- been failing silently since deploy with HTTP 400 / SQLSTATE 23514
-- (instaclaw_users_preferred_channel_check). The route's UPDATE is
-- best-effort (no await error check) so the user still completes the
-- skip flow — pending row created, VM provisioned, redirect happens —
-- but the user-level flag never lands. Phase 2's nudge banner never
-- fires (gated on preferredChannel === 'web') and the reconciler's
-- WEB_ONLY_USER step never has anything to do.
--
-- Discovered: during Rule 64 verification on 2026-05-27, when trying to
-- manually flip a test user's preferred_channel to 'web' for the canary
-- run. The PATCH returned HTTP 400 with the constraint name in the
-- error message.
--
-- Fix shape: DROP the existing CHECK constraints, ADD new ones that
-- extend the allow-list with 'web'. Idempotent — uses IF EXISTS / IF
-- NOT EXISTS where the SQL grammar allows. (CHECK constraints don't
-- have IF NOT EXISTS for ADD, so the DROP IF EXISTS + ADD pattern is
-- the standard idempotent form.)
--
-- The 'web' value semantically means: user explicitly chose "skip to
-- your command center" on /channels. Distinct from NULL (legacy users
-- created before this column was populated) and from
-- 'imessage'/'telegram'/'discord'/'slack' (channel-first onboarding).
--
-- Per Rule 60: both tables already have RLS enabled (instaclaw_users
-- since 020_instaclaw_core.sql; instaclaw_pending_users since the
-- channel-first redesign). Service-role bypasses; this migration adds
-- no new policies.
--
-- Per Rule 56: this file lives in pending_migrations/ until applied
-- via Supabase Studio, then git-mv'd to migrations/.

-- ─── 1. instaclaw_users.preferred_channel ──
ALTER TABLE public.instaclaw_users
  DROP CONSTRAINT IF EXISTS instaclaw_users_preferred_channel_check;

ALTER TABLE public.instaclaw_users
  ADD CONSTRAINT instaclaw_users_preferred_channel_check
  CHECK (preferred_channel IN ('imessage', 'telegram', 'discord', 'slack', 'web'));

COMMENT ON COLUMN public.instaclaw_users.preferred_channel IS
  'Channel the user signed up through OR explicitly chose. Used by
   M_RETURN dispatch and future re-engagement flows to pick a transport
   without recomputing from bindings. Valid values: ''imessage'',
   ''telegram'', ''discord'', ''slack'' (channel-first onboarding paths)
   OR ''web'' (skip-to-command-center path via /onboarding/web). NULL
   for legacy users created before this column was populated.';

-- ─── 2. instaclaw_pending_users.channel ──
ALTER TABLE public.instaclaw_pending_users
  DROP CONSTRAINT IF EXISTS instaclaw_pending_users_channel_check;

ALTER TABLE public.instaclaw_pending_users
  ADD CONSTRAINT instaclaw_pending_users_channel_check
  CHECK (channel IN ('imessage', 'telegram', 'discord', 'slack', 'web'));

COMMENT ON COLUMN public.instaclaw_pending_users.channel IS
  'Channel that initiated this pending signup. Valid values: ''imessage''
   / ''telegram'' (set by the inbound webhook in lib/onboarding-signup.ts
   on receipt of a public-funnel message), ''discord'' / ''slack''
   (waitlist only in v1, not yet routed), OR ''web'' (set by
   /onboarding/web for users who chose "skip to your command center"
   on /channels).';
