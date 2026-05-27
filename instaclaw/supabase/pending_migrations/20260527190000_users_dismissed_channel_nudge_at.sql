-- 20260527190000_users_dismissed_channel_nudge_at.sql
--
-- Add one nullable column to instaclaw_users that powers the "connect a
-- channel" nudge banner cadence on /dashboard for skip-to-command-center
-- users.
--
-- preferred_channel is NOT touched here. It already exists on
-- instaclaw_users (NULL on all 1000 users today, verified 2026-05-27).
-- The new /onboarding/web route sets it to 'web' on first land; the
-- existing /api/onboarding/done/submit route sets it to 'imessage' /
-- 'telegram' at the end of the channel-first flow (lib/auth.ts already
-- doesn't read this column — added in Phase 1's auth.ts edit).
--
-- dismissed_channel_nudge_at is consumed in Phase 2 by the persistent
-- nudge banner. Phase 1 ships the column so it exists on disk before
-- the Phase 2 deploy ever reads it. NULL = banner shows; non-null with
-- age < 14 days = hidden; non-null with age >= 14 days = re-show.
--
-- Per Rule 60: column lives on a table that already has RLS enabled
-- (instaclaw_users RLS-on since 020_instaclaw_core.sql). Service-role
-- bypasses; user-level read via the session callback uses the
-- service-role key. No new policies needed.
--
-- Per Rule 56: this file lives in pending_migrations/ until applied
-- to prod via Supabase Studio, then git-mv'd to migrations/ as the
-- atomic promote step.

ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS dismissed_channel_nudge_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.instaclaw_users.dismissed_channel_nudge_at IS
  'Last time the user dismissed the "connect a channel" nudge banner on
   /dashboard. Banner re-appears if NULL or older than 14 days. Set by
   POST /api/onboarding/dismiss-channel-nudge (Phase 2 follow-up). The
   14-day cadence vs the 7-day default: web-only users chose
   deliberately at /channels; 7 is the right cadence for accidental
   states, 14 for deliberate ones.';
