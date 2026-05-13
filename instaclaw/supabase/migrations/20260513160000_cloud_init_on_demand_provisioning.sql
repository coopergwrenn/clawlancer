-- 20260513160000_cloud_init_on_demand_provisioning.sql
--
-- Phase 1A Day 1-2 of on-demand VM provisioning.
--
-- Foundational schema for the bootstrap+fetch cloud-init architecture per:
--   - docs/on-demand-provisioning-2026-05-12.md (PRD)
--   - docs/cloud-init-builder-plan-2026-05-13.md (v2 plan, bootstrap+fetch)
--   - docs/cloud-init-implementation-map.md
--
-- Additive only. Idempotent (IF NOT EXISTS everywhere). No existing data modified.
-- Safe to re-run. Safe to apply before Phase 1A code lands (columns/tables sit
-- unused until Phase 1A Day 3+ code references them).
--
-- ROLLBACK (per cloud-init-builder-plan §13 Layer 6 — only AFTER Layer 5 code revert):
--   BEGIN;
--   ALTER TABLE instaclaw_vms
--     DROP COLUMN IF EXISTS cloud_init_config_token,
--     DROP COLUMN IF EXISTS cloud_init_config_consumed_at,
--     DROP COLUMN IF EXISTS cloud_init_callback_token,
--     DROP COLUMN IF EXISTS cloud_init_callback_consumed_at,
--     DROP COLUMN IF EXISTS created_via,
--     DROP COLUMN IF EXISTS event_buffer_tag;
--   DROP INDEX IF EXISTS idx_vms_cloud_init_config_token_active;
--   DROP INDEX IF EXISTS idx_vms_cloud_init_callback_token_active;
--   DROP TABLE IF EXISTS instaclaw_cloud_init_outcomes;
--   DROP TABLE IF EXISTS instaclaw_circuit_breakers;
--   COMMIT;

BEGIN;

-- ── New columns on instaclaw_vms ────────────────────────────────────────
--
-- ALTER TABLE ADD COLUMN with no DEFAULT is metadata-only in Postgres 11+ —
-- no table rewrite, no long lock. Safe on the production ~250-row table.

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS cloud_init_config_token TEXT,
  ADD COLUMN IF NOT EXISTS cloud_init_config_consumed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cloud_init_callback_token TEXT,
  ADD COLUMN IF NOT EXISTS cloud_init_callback_consumed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_via TEXT,
  ADD COLUMN IF NOT EXISTS event_buffer_tag TEXT;

COMMENT ON COLUMN instaclaw_vms.cloud_init_config_token IS
  'One-time-use nonce for POST /api/vm/cloud-init-config tarball fetch. Generated server-side by createUserVM at provision time. Atomic claim-and-invalidate via UPDATE consumed_at=now() WHERE token=X AND consumed_at IS NULL. PRD §5.3.1, plan §6.2.';

COMMENT ON COLUMN instaclaw_vms.cloud_init_config_consumed_at IS
  'Timestamp the cloud_init_config_token was consumed (first /api/vm/cloud-init-config success). NULL means unclaimed. Used in WHERE clause of the atomic claim UPDATE.';

COMMENT ON COLUMN instaclaw_vms.cloud_init_callback_token IS
  'One-time-use nonce for POST /api/vm/cloud-init-callback health-mark. Separate from config_token so each event fires exactly once. Same claim pattern.';

COMMENT ON COLUMN instaclaw_vms.cloud_init_callback_consumed_at IS
  'Timestamp the cloud_init_callback_token was consumed. NULL means unclaimed.';

COMMENT ON COLUMN instaclaw_vms.created_via IS
  '"on_demand" if VM was provisioned via cloud-init bootstrap+fetch. NULL = legacy SSH-configure path (the old path that runs configureOpenClaw). Set at createUserVM time; immutable thereafter.';

COMMENT ON COLUMN instaclaw_vms.event_buffer_tag IS
  'Emergency event-buffer tag (PRD §14 Q5/Q6). Pre-provisioned VMs for known burst events like Edge Esmeralda; empty for normal signups. Manually provisioned and manually terminated — NOT replenished by a cron.';


-- ── Partial indexes for atomic claim queries ────────────────────────────
--
-- WHERE consumed_at IS NULL keeps each index small: only unclaimed tokens
-- are indexed. After consumption the row is filtered out → near-zero index
-- footprint over time. The WHERE clause MUST match the claim query exactly
-- for the planner to use it.

CREATE INDEX IF NOT EXISTS idx_vms_cloud_init_config_token_active
  ON instaclaw_vms (cloud_init_config_token)
  WHERE cloud_init_config_consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_vms_cloud_init_callback_token_active
  ON instaclaw_vms (cloud_init_callback_token)
  WHERE cloud_init_callback_consumed_at IS NULL;


-- ── instaclaw_cloud_init_outcomes — provisioning audit log ──────────────
--
-- One row per provision attempt (initial, respawn, admin force). Powers:
--   1. Respawn circuit breaker (count rows in last hour to detect >10/hr)
--   2. Admin observability during Phase 1B/1C/1D canary windows
--   3. Post-incident forensics (cloud_init_log_excerpt captures the failing
--      bootstrap/setup.sh log tail when the row's status='failed')
--
-- Foreign keys ON DELETE CASCADE so terminated VMs / deleted users don't leave
-- orphan outcome rows.

CREATE TABLE IF NOT EXISTS instaclaw_cloud_init_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id UUID REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('initial_provision','respawn','admin_force')),
  status TEXT NOT NULL CHECK (status IN ('healthy','failed','timeout')),
  cloud_init_log_excerpt TEXT,
  failure_reason TEXT,
  duration_seconds INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE instaclaw_cloud_init_outcomes IS
  'Audit log for VM provisioning attempts via the cloud-init path (one row per provision/respawn). Used by respawn circuit breaker and admin observability. Cooper''s 30-min review cycle during canary phases is mandatory pre-1C/1D.';

COMMENT ON COLUMN instaclaw_cloud_init_outcomes.action IS
  '"initial_provision" = first attempt for this user/VM. "respawn" = retry after a prior failure. "admin_force" = manual operator action (e.g., emergency reset).';

COMMENT ON COLUMN instaclaw_cloud_init_outcomes.status IS
  '"healthy" = gateway up + callback succeeded. "failed" = explicit failure sentinel /tmp/.instaclaw-failed. "timeout" = no sentinel after 30 min (cloud-init-poll cron timeout).';

COMMENT ON COLUMN instaclaw_cloud_init_outcomes.cloud_init_log_excerpt IS
  'Last ~5KB of /var/log/instaclaw-bootstrap.log + setup.log captured via SSH on failure. Powers post-incident triage without preserving full logs.';


CREATE INDEX IF NOT EXISTS idx_cloud_init_outcomes_created_at
  ON instaclaw_cloud_init_outcomes (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cloud_init_outcomes_action_created
  ON instaclaw_cloud_init_outcomes (action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cloud_init_outcomes_vm
  ON instaclaw_cloud_init_outcomes (vm_id, created_at DESC);


-- ── instaclaw_circuit_breakers — respawn rate limit state ───────────────
--
-- Single-row-per-breaker pattern. UPSERT on breaker_name.
-- For Phase 1A, exactly one breaker: 'respawn'. Auto-tripped by lib/respawn-vm.ts
-- when last-hour respawn count > 10. Manual reset required (UPDATE tripped_at
-- = NULL OR DELETE row).
--
-- Future breakers (e.g., 'tarball_gen', 'callback_post') can be added with
-- the same upsert pattern; no schema change needed.

CREATE TABLE IF NOT EXISTS instaclaw_circuit_breakers (
  breaker_name TEXT PRIMARY KEY,
  tripped_at TIMESTAMPTZ,
  tripped_count INT,
  respawn_paused_until TIMESTAMPTZ,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE instaclaw_circuit_breakers IS
  'Per-breaker state for respawn + future circuit breakers. Auto-tripped by respawn-vm.ts when respawn rate > 10/hr. Operator clears by UPDATE tripped_at=NULL after investigating the underlying cause.';

COMMENT ON COLUMN instaclaw_circuit_breakers.breaker_name IS
  'PRIMARY KEY. Stable identifier for the breaker (e.g., "respawn"). Add new breakers as new rows; no schema change needed.';

COMMENT ON COLUMN instaclaw_circuit_breakers.tripped_at IS
  'Timestamp the breaker tripped. NULL = breaker is open (allowing operations). NOT NULL = breaker has tripped, blocking operations until operator resets.';

COMMENT ON COLUMN instaclaw_circuit_breakers.respawn_paused_until IS
  'Optional auto-clear timestamp. If NULL when tripped, breaker stays tripped until manual reset. If NOT NULL, code may auto-clear when NOW() > respawn_paused_until.';


-- ── Enable RLS on the new tables ────────────────────────────────────────
--
-- Both writers and readers are server-side (createUserVM, callback endpoint,
-- lib/respawn-vm.ts), so they use SUPABASE_SERVICE_ROLE_KEY — which bypasses
-- RLS. Enabling RLS with no policies = "deny by default" for anon and
-- authenticated, which is correct: no browser/client code touches these
-- tables. Without RLS, the anon key could read cloud_init_log_excerpt
-- (leaking VM names + user IDs + setup failure tails via PostgREST) and
-- the authenticated key could trip the respawn breaker, DoS'ing the
-- provisioning rate limiter — both real attack surfaces.
--
-- Already applied in production on 2026-05-13 via Supabase SQL Editor's
-- "Run and enable RLS" button. Duplicated into this migration file so
-- future fresh-environment applies (preview branches, new dev DBs) match
-- production state. ALTER ... ENABLE ROW LEVEL SECURITY is idempotent —
-- re-runs on already-enabled tables are silent no-ops.

ALTER TABLE instaclaw_cloud_init_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE instaclaw_circuit_breakers    ENABLE ROW LEVEL SECURITY;


COMMIT;
