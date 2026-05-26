-- 20260526220000_pending_users_channel_onboarding_nullable.sql
--
-- HOTFIX: the 2026-05-26 channel-onboarding redesign INSERTs a minimal
-- pending_users row when an inbound iMessage/Telegram message arrives
-- BEFORE the user OAuth's. The handler at lib/onboarding-signup.ts
-- provides only { channel, channel_identity, short_code } — everything
-- else is meant to be NULL (user_id, bot_token) or default-filled (tier,
-- api_mode) until /onboarding/done populates them.
--
-- The 20260526180000 migration that added the channel columns ASSUMED
-- those four legacy columns were already nullable or had defaults. They
-- weren't. The smoke test surfaced this immediately: Sendblue dispatched
-- the webhook, the handler tried to INSERT, Postgres returned 23502
-- "null value in column 'user_id' violates not-null constraint" — a
-- cascade of four NOT NULL violations (one per attempt to provide
-- defaults defensively).
--
-- This migration:
--   1. Drops NOT NULL on user_id (channel-onboarding has no user yet)
--   2. Drops NOT NULL on telegram_bot_token (legacy BYOB-only field)
--   3. Sets DEFAULT 'all_inclusive' on api_mode (matches the new flow)
--   4. Sets DEFAULT 'starter' on tier (matches the new flow)
--
-- Legacy invariant preserved: the BYOB-Telegram flow STILL provides
-- user_id + telegram_bot_token + tier + api_mode on every INSERT (see
-- app/api/billing/checkout/route.ts), so dropping NOT NULL doesn't
-- change its semantics. Channel-onboarding rows get NULL for the
-- first two and defaults for the latter two, then /onboarding/done's
-- UPDATE fills in user_id once OAuth completes.
--
-- Per Rule 56: this migration lives in pending_migrations/ until it's
-- applied to prod via Supabase Studio. After apply, `git mv` to
-- migrations/ in a commit that documents the apply timestamp.

ALTER TABLE public.instaclaw_pending_users
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.instaclaw_pending_users
  ALTER COLUMN telegram_bot_token DROP NOT NULL;

ALTER TABLE public.instaclaw_pending_users
  ALTER COLUMN api_mode SET DEFAULT 'all_inclusive';

ALTER TABLE public.instaclaw_pending_users
  ALTER COLUMN tier SET DEFAULT 'starter';

COMMENT ON COLUMN public.instaclaw_pending_users.user_id IS
  'Legacy BYOB-Telegram flow sets this at INSERT time (the user has already authed via /signup before checkout creates the row). Channel-onboarding flow leaves NULL until /onboarding/done UPDATE fills it post-OAuth.';

COMMENT ON COLUMN public.instaclaw_pending_users.telegram_bot_token IS
  'Legacy BYOB-Telegram only. NULL for channel-onboarding rows; the iMessage/Telegram-shared-bot flows do not require a per-user bot token.';
