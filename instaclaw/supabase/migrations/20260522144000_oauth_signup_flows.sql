-- 20260522144000_oauth_signup_flows.sql
--
-- New table: public.instaclaw_oauth_signup_flows
-- Tracks in-flight OpenAI device-code OAuth flows that originate from
-- /signin (session-less first-time signup), NOT from /settings
-- (post-signup account connection).
--
-- WHY A SEPARATE TABLE FROM instaclaw_oauth_device_flows
-- ──────────────────────────────────────────────────────
-- The existing instaclaw_oauth_device_flows table (added 2026-05-19) has
-- `user_id UUID NOT NULL REFERENCES instaclaw_users(id)` because every
-- post-signup connect has an authenticated user. The new signup path
-- starts BEFORE the user exists in our DB — the device-code completion
-- is itself what creates the user. So the row needs to track flow state
-- WITHOUT a user_id during the polling window.
--
-- Two clean options were considered:
--   (a) Make device_flows.user_id nullable + add anonymous_session_id.
--       Risk: existing routes/queries that assume NOT NULL would need
--       reworking; the partial unique index on user_id would need to
--       gracefully degrade to anonymous_session_id when null.
--   (b) Separate table for signup flows.
--       Risk: minor code duplication on the DB-helper layer; cleaner
--       boundary between "session-less signup" and "session-required
--       connect" use cases.
-- We chose (b) — the boundary is real (different auth model, different
-- API endpoints, different consumer state machines), and the duplication
-- is small (~80 lines of TS).
--
-- ANONYMOUS_SESSION_ID LIFECYCLE
-- ──────────────────────────────
-- 1. /signup/start generates a 32-byte random hex string, sets it as an
--    HTTPOnly cookie (`openai_signup_session`), inserts a row here with
--    status='pending'.
-- 2. /signup/poll reads the cookie, looks up the row, polls OpenAI.
-- 3. On `completed`: resolves user identity from claims.email (creates
--    user if needed), stores tokens via existing storeOAuthTokens helper,
--    updates this row with status='completed' + resolved_user_id +
--    completed_at.
-- 4. Cleanup cron (future) wipes rows where expires_at < NOW() AND
--    status='pending' (~15-min window). resolved_user_id keeps them
--    around for forensics on completed flows.
--
-- ATTACK SURFACE
-- ──────────────
-- The anonymous_session_id is HTTPOnly + SameSite=Lax + Secure (in prod).
-- An attacker who steals the cookie can resume polling but cannot complete
-- the flow without also authorizing at OpenAI under their account — and
-- if they do that, they get an account under THEIR email, not the
-- victim's. Cookie itself doesn't expose any user-identifying data.
--
-- RLS DECISION
-- ────────────
-- RLS is ENABLED at table-creation time (via Supabase Studio's "Run
-- and enable RLS" prompt, 2026-05-22). No policies are defined, which
-- produces the "deny all anon/authenticated, allow service-role"
-- posture: every PostgREST request from the anon/authenticated key is
-- rejected; the service-role bypasses RLS so our API routes (which use
-- getSupabase() — the service-role client) work normally.
--
-- Why RLS is load-bearing here (not just defense-in-depth):
-- /api/auth/openai/signup/poll has a code path that, given a flow row
-- with status='completed' and a non-null resolved_user_id, mints a
-- one-shot signupToken for that user_id. Without RLS, an attacker with
-- the public anon key (NEXT_PUBLIC_SUPABASE_ANON_KEY) could INSERT a
-- row with status='completed' + resolved_user_id=<any victim>, set the
-- matching openai_signup_session cookie, and call /signup/poll to
-- receive a session-issuing token for the victim. RLS-on + no-policies
-- closes that primitive.
--
-- Brute force on anonymous_session_id (32-byte hex = 2^256 keyspace) is
-- not a meaningful attack vector independently; RLS is required to
-- prevent attacker-INSERTED rows from being picked up by the legitimate
-- poll flow.
--
-- Future maintenance: do NOT add policies that grant anon or
-- authenticated access to this table. The table is service-role-only
-- by design.

CREATE TABLE IF NOT EXISTS public.instaclaw_oauth_signup_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Server-minted, 32-byte hex; stored in the openai_signup_session
  -- HTTPOnly cookie. Used as the lookup key during the polling window.
  anonymous_session_id TEXT NOT NULL UNIQUE,

  -- Mirrors instaclaw_oauth_device_flows columns 1:1 so the
  -- lib/openai-oauth.ts helpers can write to either table without
  -- field-name remapping.
  provider TEXT NOT NULL DEFAULT 'openai_codex',
  device_auth_id TEXT NOT NULL,
  user_code TEXT NOT NULL,
  verification_uri TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'expired', 'denied', 'error')),
  status_message TEXT,

  -- Set when status='completed'. Points to the instaclaw_users row that
  -- was found or created during identity resolution. ON DELETE SET NULL
  -- because deleting a user shouldn't erase the forensic record of how
  -- they signed up (the flow stays as a "completed" row referencing a
  -- now-null user).
  resolved_user_id UUID REFERENCES public.instaclaw_users(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable RLS — load-bearing for the security model documented above.
-- Idempotent: ENABLE ROW LEVEL SECURITY on an already-enabled table
-- is a no-op. No policies are defined, which produces the "deny all
-- anon/authenticated, allow service-role" posture. See the RLS DECISION
-- comment block at the top of this file for full reasoning.
ALTER TABLE public.instaclaw_oauth_signup_flows ENABLE ROW LEVEL SECURITY;

-- Hot path: poll route reads by anonymous_session_id + status='pending'.
CREATE INDEX IF NOT EXISTS instaclaw_oauth_signup_flows_session_status_idx
  ON public.instaclaw_oauth_signup_flows(anonymous_session_id, status, expires_at);

-- Cleanup cron: find expired pending rows.
CREATE INDEX IF NOT EXISTS instaclaw_oauth_signup_flows_expires_at_idx
  ON public.instaclaw_oauth_signup_flows(expires_at)
  WHERE status = 'pending';

COMMENT ON TABLE public.instaclaw_oauth_signup_flows IS
  'In-flight ChatGPT-as-signup OAuth device-code flows (session-less). One row per attempt, keyed by anonymous_session_id (HTTPOnly cookie). Separate from instaclaw_oauth_device_flows which handles post-signup account-connect from /settings.';

COMMENT ON COLUMN public.instaclaw_oauth_signup_flows.anonymous_session_id IS
  '32-byte hex random. Stored in the openai_signup_session HTTPOnly cookie; used as the lookup key during polling.';

COMMENT ON COLUMN public.instaclaw_oauth_signup_flows.resolved_user_id IS
  'instaclaw_users.id of the user found-or-created when the flow completed. NULL while pending; set on completion.';
