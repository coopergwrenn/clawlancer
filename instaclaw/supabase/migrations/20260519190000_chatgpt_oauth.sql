-- Login with ChatGPT — Phase 1 schema.
--
-- This is the migration that backs the "Login with ChatGPT" feature
-- (PRD: instaclaw/docs/prd/chatgpt-oauth-history-import.md, Phase 1
-- design doc: chatgpt-oauth-phase-1-design.md).
--
-- WHAT THIS ADDS
--   1. Ten new columns on instaclaw_users — per-user OAuth token store.
--      Tokens are encrypted at rest (AES-256-GCM, versioned key id) by
--      lib/openai-oauth-encryption.ts. JSONB column holds decoded
--      id_token claims subset (cleartext — not sensitive without the
--      token, and we want to query chatgpt_plan_type efficiently).
--   2. One new column on instaclaw_vms — openai_token_version_synced
--      mirrors the per-user openai_token_version. The reconciler step
--      stepChatGPTOAuthToken detects drift (user version > vm synced
--      version) and pushes the new token to disk on the VM. Same
--      pattern as gateway_token / SECRET_VERSION.
--   3. Extends the api_mode CHECK constraint on instaclaw_vms to
--      include 'chatgpt_oauth'. Existing constraint is dynamically
--      located and dropped (we don't hard-code its name because it may
--      vary across environments).
--   4. New table instaclaw_oauth_device_flows tracking in-flight
--      device-code polling state per user. Cleaned up by the cron at
--      /api/cron/cleanup-expired-oauth-flows (built later in Phase 1).
--
-- IDEMPOTENCY CONTRACT
--   All adds use IF NOT EXISTS. Safe to re-run. The constraint drop
--   uses a DO block that handles any existing CHECK on api_mode
--   regardless of its name.
--
-- SECURITY POSTURE
--   - openai_oauth_access_token and openai_oauth_refresh_token are
--     SENSITIVE — encrypted at rest. Service-role-only at the
--     PostgREST layer (existing RLS posture for instaclaw_users
--     already restricts; service role bypasses).
--   - Never log full token values. Prefix-only in any forensic output
--     (mirrors gateway_token discipline).
--   - openai_token_version IS NOT sensitive (a counter); safe to log.
--   - openai_oauth_id_token_claims IS cleartext but contains email
--     and plan_type — still PII; same RLS posture as token columns.
--
-- ROLLBACK
--   The columns are NULLABLE, so disabling the feature (kill switch:
--   OPENAI_OAUTH_ENABLED=false) leaves the data in place. To fully
--   remove:
--     ALTER TABLE instaclaw_users DROP COLUMN openai_oauth_access_token;
--     -- ... (drop other 9 user columns)
--     ALTER TABLE instaclaw_vms   DROP COLUMN openai_token_version_synced;
--     ALTER TABLE instaclaw_vms   DROP CONSTRAINT instaclaw_vms_api_mode_check;
--     ALTER TABLE instaclaw_vms   ADD  CONSTRAINT instaclaw_vms_api_mode_check
--       CHECK (api_mode IS NULL OR api_mode IN ('all_inclusive', 'byok'));
--     DROP TABLE instaclaw_oauth_device_flows;
--   The encryption keys (OPENAI_OAUTH_KEY_V1) become inert.

-- ─── instaclaw_users — OAuth token store ─────────────────────────────────
--
-- Per-user (not per-VM). When a user has multiple VMs, the same token
-- powers all of them. Reconciler step stepChatGPTOAuthToken propagates
-- to each VM based on openai_token_version vs vm.openai_token_version_synced.

ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS openai_oauth_access_token TEXT,
  ADD COLUMN IF NOT EXISTS openai_oauth_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS openai_oauth_id_token_claims JSONB,
  ADD COLUMN IF NOT EXISTS openai_oauth_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS openai_oauth_last_refresh_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS openai_oauth_account_id TEXT,
  ADD COLUMN IF NOT EXISTS openai_oauth_originator TEXT,
  ADD COLUMN IF NOT EXISTS openai_token_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS chatgpt_plan_type TEXT,
  ADD COLUMN IF NOT EXISTS chatgpt_plan_last_seen_at TIMESTAMPTZ;

COMMENT ON COLUMN public.instaclaw_users.openai_oauth_access_token IS
  'Encrypted ChatGPT subscription bearer JWT. Format: "<keyId>$<base64>" per lib/openai-oauth-encryption.ts. SENSITIVE — service-role only; never log full value; prefix only in forensic output.';
COMMENT ON COLUMN public.instaclaw_users.openai_oauth_refresh_token IS
  'Encrypted ChatGPT OAuth refresh token. Same format as access_token. SENSITIVE. Single-use per OpenAI spec — concurrent refresh attempts cause permanent lockout (refresh_token_reused). Cron uses SELECT FOR UPDATE NOWAIT to serialize.';
COMMENT ON COLUMN public.instaclaw_users.openai_oauth_id_token_claims IS
  'Decoded id_token JWT payload (cleartext JSONB). Includes email, chatgpt_user_id, chatgpt_account_id, chatgpt_account_is_fedramp, exp. We extract chatgpt_plan_type into its own column for indexed lookup.';
COMMENT ON COLUMN public.instaclaw_users.openai_oauth_expires_at IS
  'When the current access_token expires (from the exp claim). The cron refreshes 30 min before this. NULL when user has not connected.';
COMMENT ON COLUMN public.instaclaw_users.openai_oauth_last_refresh_at IS
  'Wall-clock timestamp of last successful refresh. Used by monitoring to detect stuck refresh cycles.';
COMMENT ON COLUMN public.instaclaw_users.openai_oauth_account_id IS
  'ChatGPT workspace/account id from id_token. Used as the ChatGPT-Account-ID header at inference time by pi-ai on the VM.';
COMMENT ON COLUMN public.instaclaw_users.openai_oauth_originator IS
  'Per-user originator/install-fingerprint string we send on the OAuth flow. Stable per user across rotations.';
COMMENT ON COLUMN public.instaclaw_users.openai_token_version IS
  'Monotonic counter bumped on every successful refresh. The reconciler step compares this to vm.openai_token_version_synced to detect drift and rewrite auth-profiles.json on each VM the user owns.';
COMMENT ON COLUMN public.instaclaw_users.chatgpt_plan_type IS
  'Cached plan tier from id_token. One of: free | plus | pro | business | enterprise | edu. Used for tier-gating without an extra OpenAI API call.';
COMMENT ON COLUMN public.instaclaw_users.chatgpt_plan_last_seen_at IS
  'When chatgpt_plan_type was last observed in a refreshed id_token. Stale = the user may have downgraded.';

-- ─── instaclaw_vms — version-sync counter ────────────────────────────────

ALTER TABLE public.instaclaw_vms
  ADD COLUMN IF NOT EXISTS openai_token_version_synced INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.instaclaw_vms.openai_token_version_synced IS
  'Which openai_token_version is currently written to ~/.openclaw/agents/main/agent/auth-profiles.json on this VM. Compared against instaclaw_users.openai_token_version by stepChatGPTOAuthToken (lib/vm-reconcile.ts). Mirrors the SECRET_VERSION pattern.';

-- ─── api_mode CHECK constraint — accept 'chatgpt_oauth' ───────────────────
--
-- The existing constraint may have any of several names depending on when
-- it was created. Drop any CHECK that references api_mode, then add the
-- new one. NULL is allowed (existing behavior — some unassigned VMs have
-- NULL api_mode transiently).

DO $$
DECLARE
  cname TEXT;
BEGIN
  FOR cname IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname = 'instaclaw_vms'
      AND nsp.nspname = 'public'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%api_mode%'
  LOOP
    EXECUTE format('ALTER TABLE public.instaclaw_vms DROP CONSTRAINT IF EXISTS %I', cname);
  END LOOP;
END $$;

ALTER TABLE public.instaclaw_vms
  ADD CONSTRAINT instaclaw_vms_api_mode_check
  CHECK (api_mode IS NULL OR api_mode IN ('all_inclusive', 'byok', 'chatgpt_oauth'));

-- ─── instaclaw_oauth_device_flows — in-flight polling state ──────────────
--
-- One row per device-code OAuth attempt. Created by the device-code/start
-- endpoint, polled by device-code/poll, cleaned up by a future cron when
-- expires_at has passed.
--
-- The partial unique index on (user_id, status='pending') prevents a user
-- from having two concurrent flows — if they retry, we either reuse the
-- existing pending row or supersede it.

CREATE TABLE IF NOT EXISTS public.instaclaw_oauth_device_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.instaclaw_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'openai_codex',
  device_auth_id TEXT NOT NULL,
  user_code TEXT NOT NULL,
  verification_uri TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'expired', 'denied', 'error')),
  status_message TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup by user + status for poll route and resume-on-reopen UI.
CREATE INDEX IF NOT EXISTS instaclaw_oauth_device_flows_user_status_idx
  ON public.instaclaw_oauth_device_flows(user_id, status, expires_at);

-- Cleanup cron: find all expired pending rows.
CREATE INDEX IF NOT EXISTS instaclaw_oauth_device_flows_expires_at_idx
  ON public.instaclaw_oauth_device_flows(expires_at)
  WHERE status = 'pending';

-- Race protection: only one pending flow per user at a time.
-- If a user clicks "Connect" twice in two browser tabs, the second insert
-- conflicts and the API route returns the existing pending row.
CREATE UNIQUE INDEX IF NOT EXISTS instaclaw_oauth_device_flows_one_pending_per_user_idx
  ON public.instaclaw_oauth_device_flows(user_id)
  WHERE status = 'pending';

COMMENT ON TABLE public.instaclaw_oauth_device_flows IS
  'In-flight device-code OAuth flow state. One pending row per user at a time (enforced by partial unique idx). Cleaned up by a cleanup cron when expires_at < NOW().';
COMMENT ON COLUMN public.instaclaw_oauth_device_flows.device_auth_id IS
  'Opaque ID returned by OpenAI deviceauth/usercode. Used with user_code on every poll to /deviceauth/token.';
COMMENT ON COLUMN public.instaclaw_oauth_device_flows.user_code IS
  'Human-readable code (e.g., "92PM-PLU8N") shown to the user. Entered at https://auth.openai.com/codex/device.';
COMMENT ON COLUMN public.instaclaw_oauth_device_flows.status IS
  'pending = waiting for user to authorize. completed = tokens exchanged + stored on instaclaw_users. expired = 15-min window elapsed. denied = user clicked Deny in OpenAI''s browser. error = internal failure (see status_message).';
