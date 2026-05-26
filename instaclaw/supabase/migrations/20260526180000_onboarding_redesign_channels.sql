-- 20260526180000_onboarding_redesign_channels.sql
--
-- Schema for the 2026-05-26 onboarding redesign (PRD:
-- docs/prd/onboarding-redesign-2026-05-26.md).
--
-- Adds:
--   1. instaclaw_pending_users: channel, short_code, channel_identity
--      (lets a webhook-initiated signup track which channel started it,
--      which inbound identity bound to it, and a 5-8 char short code
--      used in the Welcome Message 3 link).
--   2. instaclaw_users: preferred_channel (for M_RETURN routing on
--      resume — when a returning user sends a message and we need to
--      pick which transport to reply on, this is the source of truth).
--   3. New table instaclaw_user_profile (one row per user) — name +
--      intended_use + vibe captured on /onboarding/done, injected into
--      the agent's IDENTITY.md / USER.md so M_RETURN can land with
--      personality from message one.
--   4. New table instaclaw_user_channel_bindings — permanent mapping
--      from (channel, channel_identity) → user. Used by inbound
--      webhooks to find which user/VM a given iMessage phone or
--      Telegram chat_id belongs to.
--   5. New table instaclaw_waitlist — Discord/Slack-curious users who
--      land on /channels but pick an unsupported channel. We collect
--      email + which channel they wanted.
--
-- ──────────────────────────────────────────────────────────────────
-- DESIGN DECISIONS
-- ──────────────────────────────────────────────────────────────────
--
-- Why extend instaclaw_pending_users rather than create a new
-- signup_sessions table:
--   The existing pending_users row already represents "in-flight
--   signup state machine, consumed when VM is ready." A new flow
--   that reuses this lifecycle exactly should reuse the table; a
--   parallel table would mean two write paths (and per CLAUDE.md
--   Rule 33, dual write paths are how trap states are born). The
--   three new columns are nullable, so the existing BYOB Telegram
--   flow continues unchanged — its rows just have NULL channel.
--
-- Why CHECK constraints rather than PostgreSQL ENUMs:
--   The OAuth signup flows table (20260522144000) uses the same
--   pattern — TEXT + CHECK. It's easier to extend (a CHECK can be
--   replaced via ALTER TABLE; an ENUM type needs ALTER TYPE which
--   doesn't compose with idempotent migrations). Listed values are
--   load-bearing; adding new ones requires a follow-up migration.
--
-- Why partial unique index on short_code:
--   short_code is NULL for BYOB Telegram pending_users rows (the
--   existing flow). A plain UNIQUE constraint would refuse multiple
--   NULL values on some Postgres versions; a partial unique index
--   only enforces uniqueness where the value is non-NULL.
--
-- Why instaclaw_user_channel_bindings is its own table (not columns
-- on instaclaw_users):
--   A user can have multiple bindings over time (e.g., they sign up
--   via iMessage, then later authorize Telegram too). One row per
--   binding scales; a fixed set of columns on users doesn't. The
--   UNIQUE(channel, channel_identity) constraint prevents one phone
--   from being bound to two users.
--
-- Why no vm_id on user_channel_bindings:
--   The lookup chain is inbound→(channel, channel_identity)→user_id
--   →instaclaw_vms.assigned_to. The VM is already discoverable from
--   the user. A vm_id here would be redundant and would need
--   maintenance on every VM reassignment (freeze/thaw/reclaim).
--
-- ──────────────────────────────────────────────────────────────────
-- RLS POSTURE
-- ──────────────────────────────────────────────────────────────────
--
-- Per Rule 60: every CREATE TABLE in this file enables RLS
-- immediately after creation, with no policies. The "deny all
-- anon/authenticated, allow service-role" posture matches the
-- oauth_signup_flows / oauth_device_flows pattern. Our routes use
-- getSupabase() (the service-role client) which bypasses RLS, so
-- legitimate access works unchanged. Anon-key INSERT/UPDATE/DELETE
-- attacks are blocked at the PostgREST layer before the route ever
-- runs.
--
-- For ALTER TABLE on existing tables (instaclaw_pending_users,
-- instaclaw_users), RLS state is preserved from their original
-- definitions — we don't toggle it here.
--
-- ──────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════
-- 1. EXTEND instaclaw_pending_users
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.instaclaw_pending_users
  ADD COLUMN IF NOT EXISTS channel TEXT
    CHECK (channel IN ('imessage','telegram','discord','slack'));

ALTER TABLE public.instaclaw_pending_users
  ADD COLUMN IF NOT EXISTS short_code VARCHAR(8);

ALTER TABLE public.instaclaw_pending_users
  ADD COLUMN IF NOT EXISTS channel_identity TEXT;

-- M_RETURN dispatch idempotency. Set when the agent's first message
-- (the real bootstrap greeting after VM is ready) has been successfully
-- sent on the user's channel. Both /api/onboarding/done's form-submit
-- handler AND /api/cron/m-return-sweep check this column before sending
-- so M_RETURN never fires twice. See spec §6.5.8.
ALTER TABLE public.instaclaw_pending_users
  ADD COLUMN IF NOT EXISTS m_return_sent_at TIMESTAMPTZ;

-- Pass 6 abandonment-reclaim audit. Set alongside consumed_at when the
-- reclaim cron returns an abandoned VM to the pool. Distinguishes a
-- "successfully onboarded" consumed row (reclaimed_at IS NULL) from an
-- "abandoned and recycled" consumed row (reclaimed_at IS NOT NULL).
-- Read by funnel-analytics queries to monitor abandonment rate; kept
-- for the same 24h window as other consumed rows (Pass 5 sweeps them).
-- See spec §6.5.10.
ALTER TABLE public.instaclaw_pending_users
  ADD COLUMN IF NOT EXISTS reclaimed_at TIMESTAMPTZ;

-- Hot path: /go/:code resolver looks up short_code → pending_users row.
-- Partial unique index because BYOB users have NULL short_code; we
-- only enforce uniqueness on the channel-onboarding rows that have it.
CREATE UNIQUE INDEX IF NOT EXISTS instaclaw_pending_users_short_code_uniq_idx
  ON public.instaclaw_pending_users(short_code)
  WHERE short_code IS NOT NULL;

-- Hot path: inbound webhook (iMessage, Telegram shared bot) looks up
-- "does this phone/chat_id already have an in-flight signup?" by
-- (channel, channel_identity).
CREATE INDEX IF NOT EXISTS instaclaw_pending_users_channel_identity_idx
  ON public.instaclaw_pending_users(channel, channel_identity)
  WHERE channel_identity IS NOT NULL;

-- Defense-in-depth against double-text race: if the user texts twice
-- within milliseconds, both webhook invocations would otherwise SELECT
-- nothing and INSERT two pending rows. This partial unique index
-- prevents the second INSERT at the DB level. The webhook handler
-- catches the unique-constraint violation and treats it as "already
-- in-flight" — same effect as the SELECT-then-skip path, but race-safe.
-- WHERE consumed_at IS NULL because a returning user (consumed row
-- exists) is allowed to start a fresh signup if their binding was
-- somehow lost; the lookup chain prefers user_channel_bindings first.
CREATE UNIQUE INDEX IF NOT EXISTS instaclaw_pending_users_channel_inflight_uniq_idx
  ON public.instaclaw_pending_users(channel, channel_identity)
  WHERE channel_identity IS NOT NULL AND consumed_at IS NULL;

COMMENT ON COLUMN public.instaclaw_pending_users.channel IS
  'Channel that initiated this signup: imessage, telegram, discord, slack. NULL for legacy BYOB-Telegram flow (where the row is created from /api/billing/checkout for a user who picked Telegram via /signup).';

COMMENT ON COLUMN public.instaclaw_pending_users.short_code IS
  'Server-minted 5-8 char identifier used in the Welcome Message 3 link (e.g., instaclaw.io/go/r7k2x). Unique where present. NULL for BYOB rows.';

COMMENT ON COLUMN public.instaclaw_pending_users.channel_identity IS
  'Inbound identity on the channel: E.164 phone for iMessage, chat_id as text for Telegram shared bot. The webhook handler dedupes by (channel, channel_identity) when a returning user re-initiates before consumed_at.';

COMMENT ON COLUMN public.instaclaw_pending_users.m_return_sent_at IS
  'When M_RETURN (the agent''s first message on the user''s channel) was successfully dispatched. Used for dispatch idempotency — both the /onboarding/done form-submit handler and /api/cron/m-return-sweep check this column to avoid double-sending. NULL until first successful dispatch.';

COMMENT ON COLUMN public.instaclaw_pending_users.reclaimed_at IS
  'When Pass 6 of /api/cron/process-pending reclaimed an abandoned-after-OAuth VM. Set alongside consumed_at; the row remains consumed (single-use semantics) but reclaimed_at distinguishes "successfully onboarded" (NULL) from "abandoned and VM recycled" (NOT NULL). Used by funnel-analytics queries. NULL until reclaim fires. See spec §6.5.10.';

-- ════════════════════════════════════════════════════════════════
-- 2. EXTEND instaclaw_users
-- ════════════════════════════════════════════════════════════════

ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS preferred_channel TEXT
    CHECK (preferred_channel IN ('imessage','telegram','discord','slack'));

COMMENT ON COLUMN public.instaclaw_users.preferred_channel IS
  'Set to the channel the user signed up through; used by M_RETURN dispatch and by future re-engagement flows to pick a transport without recomputing from bindings.';

-- ════════════════════════════════════════════════════════════════
-- 3. NEW: instaclaw_user_profile
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.instaclaw_user_profile (
  user_id UUID PRIMARY KEY
    REFERENCES public.instaclaw_users(id) ON DELETE CASCADE,

  -- Free-text first name. Skippable. If null, the agent infers from
  -- OAuth profile or just doesn't use a name in M_RETURN.
  name TEXT,

  -- Three-state intent flag used by IDENTITY.md generation:
  --   work     → agent leans pragmatic, business-context defaults
  --   personal → agent leans casual, personal-context defaults
  --   both     → agent asks before context-switching
  intended_use TEXT
    CHECK (intended_use IN ('work','personal','both')),

  -- Three-state voice preference. Translated into a sentence in
  -- IDENTITY.md that the bootstrap process reads on first turn.
  --   just-get-things-done → minimal small-talk, action-oriented
  --   chatty-and-warm      → conversational, asks follow-ups
  --   wry-and-minimal      → terse + dry humor (the v122 default)
  vibe TEXT
    CHECK (vibe IN ('just-get-things-done','chatty-and-warm','wry-and-minimal')),

  -- Optional free-text "what brings you to Edge?" answer for Edge
  -- Esmeralda attendees. Surfaced into the agent's IDENTITY.md when
  -- partner='edge_city'. NULL for non-Edge users.
  edge_intent TEXT,

  filled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.instaclaw_user_profile ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.instaclaw_user_profile IS
  'Personalization captured on /onboarding/done. One row per user. Read by configureOpenClaw to inject into IDENTITY.md so the agent reads it before M_RETURN. Skippable end-to-end — all fields nullable except user_id.';

-- ════════════════════════════════════════════════════════════════
-- 4. NEW: instaclaw_user_channel_bindings
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.instaclaw_user_channel_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL
    REFERENCES public.instaclaw_users(id) ON DELETE CASCADE,

  channel TEXT NOT NULL
    CHECK (channel IN ('imessage','telegram','discord','slack')),

  -- For iMessage: E.164 phone (+14155551234).
  -- For Telegram shared bot: chat_id as decimal string.
  channel_identity TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT instaclaw_user_channel_bindings_identity_uniq
    UNIQUE (channel, channel_identity)
);

ALTER TABLE public.instaclaw_user_channel_bindings ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS instaclaw_user_channel_bindings_user_id_idx
  ON public.instaclaw_user_channel_bindings(user_id);

COMMENT ON TABLE public.instaclaw_user_channel_bindings IS
  'Permanent (channel, channel_identity) → user_id mapping. Created at /onboarding/done success; persists past pending_users.consumed_at. Used by inbound webhooks to route returning users to their VM.';

-- ════════════════════════════════════════════════════════════════
-- 5. EXTEND existing instaclaw_waitlist (NOT a new table)
-- ════════════════════════════════════════════════════════════════
--
-- The instaclaw_waitlist table already exists (added in a prior
-- migration for the landing-page email-capture waitlist) and has:
-- id, email, source, ip_hash, position, referrer, invite_code,
-- invite_sent_at, ref_code, notified_at, created_at.
--
-- We extend it (NOT recreate) for channel-onboarding waitlist
-- (Discord/Slack — users who pick those on /channels). Adding
-- ONE nullable column + a partial unique index. Existing landing
-- waitlist rows have requested_channel = NULL; channel waitlist
-- rows have requested_channel set. The two flows coexist in the
-- same table.
--
-- RLS posture: the existing table's RLS state is preserved. We
-- don't touch it here. (Rule 60 applies to NEW CREATE TABLE; this
-- is ALTER on an existing table.)

ALTER TABLE public.instaclaw_waitlist
  ADD COLUMN IF NOT EXISTS requested_channel TEXT
    CHECK (requested_channel IN ('discord','slack'));

-- Partial unique: one row per (email, channel) on the channel-
-- waitlist subset. The legacy landing-waitlist rows (channel NULL)
-- already have their own UNIQUE on `email` via the original
-- migration; this index doesn't conflict.
CREATE UNIQUE INDEX IF NOT EXISTS instaclaw_waitlist_email_channel_uniq_idx
  ON public.instaclaw_waitlist(email, requested_channel)
  WHERE requested_channel IS NOT NULL;

COMMENT ON COLUMN public.instaclaw_waitlist.requested_channel IS
  'Set when this row is a channel-onboarding waitlist signup (Discord/Slack picked on /channels). NULL for legacy landing-waitlist rows. Distinguished by a partial unique index so the two flows coexist in the same table.';
