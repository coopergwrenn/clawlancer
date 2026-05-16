-- Migration: gbrain coverage cron schema (Rule 35 followup, P1)
-- Status: PENDING — apply via `supabase db push` before deploying gbrain-coverage cron code.
-- Per CLAUDE.md Rule 56: migration lives in pending_migrations/ until applied to prod;
-- then moved to migrations/ in the same PR as the consuming code.
--
-- Purpose: support the gbrain-coverage cron — periodic deep-health check that runs
-- verify-gbrain-mcp.py (put_page + get_page round-trip) against every edge_city VM
-- with gbrain installed. Catches broken-but-appears-healthy state that the cheap
-- V+T+S+P idempotency check in stepGbrain misses.
--
-- Design doc: docs/prd/gbrain-coverage-cron-2026-05-16.md
-- Consuming code: lib/gbrain-coverage.ts, app/api/cron/gbrain-coverage/route.ts
--
-- Rollback: DROP TABLE instaclaw_gbrain_health_log; ALTER TABLE instaclaw_vms
-- DROP COLUMN gbrain_last_check_at, DROP COLUMN gbrain_last_check_status,
-- DROP COLUMN gbrain_consecutive_failures;

-- ─── 1. Audit log table (append-only) ───
CREATE TABLE IF NOT EXISTS instaclaw_gbrain_health_log (
  id BIGSERIAL PRIMARY KEY,
  vm_id UUID NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'ok' | 'fail' | 'skipped'
  status TEXT NOT NULL,
  -- when status='fail', one of verify-gbrain-mcp.py's RESULT_FAIL codes
  -- (NO_TOKEN, HEALTH_UNREACHABLE, HEALTH_NOT_OK, AUTH_401, INIT_HTTP_ERROR,
  -- INIT_ERROR, INIT_UNEXPECTED_SERVER, INIT_MCP_ERROR, TOOLS_LIST_ERROR,
  -- NO_PUT_PAGE, NO_RETRIEVE_TOOL, PUT_ISERROR, PUT_UNEXPECTED, RETRIEVE_ISERROR,
  -- MARKER_NOT_FOUND, etc.)
  -- when status='skipped', a free-form skip reason (ssh_timeout, no_bearer, etc.)
  fail_code TEXT,
  -- end-to-end wall-clock for the verify run (NULL on skip)
  latency_ms INTEGER,
  -- correlation marker passed to verify-gbrain-mcp.py for log dives
  marker_ts TEXT,
  -- full RESULT_OK / RESULT_FAIL kvpairs as a JSON object
  details_json JSONB
);

CREATE INDEX IF NOT EXISTS idx_gbrain_health_log_vm_at
  ON instaclaw_gbrain_health_log(vm_id, checked_at DESC);

-- Partial index — operator queries to find currently-failing VMs are common,
-- and the partial index is small (only fails) so cheap to maintain.
CREATE INDEX IF NOT EXISTS idx_gbrain_health_log_failures
  ON instaclaw_gbrain_health_log(checked_at DESC, vm_id)
  WHERE status = 'fail';

-- ─── 2. Per-VM rolling state on instaclaw_vms ───
-- Used by the cron's batch query (NULLS FIRST ordering) and the
-- consecutive-failure escalation logic.
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS gbrain_last_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gbrain_last_check_status TEXT,
  ADD COLUMN IF NOT EXISTS gbrain_consecutive_failures INTEGER DEFAULT 0;

-- Partial index over VMs that need a check sooner (NULL or oldest first).
-- Speeds up the cron's candidate query.
CREATE INDEX IF NOT EXISTS idx_vms_gbrain_check_due
  ON instaclaw_vms(gbrain_last_check_at NULLS FIRST)
  WHERE partner = 'edge_city' AND health_status = 'healthy' AND status = 'assigned';

-- ─── 3. Sanity verification ───
-- Run after `supabase db push` to confirm the migration landed:
--
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='instaclaw_vms'
--       AND column_name IN ('gbrain_last_check_at','gbrain_last_check_status','gbrain_consecutive_failures');
--   -- expect: 3 rows
--
--   SELECT table_name FROM information_schema.tables
--     WHERE table_name = 'instaclaw_gbrain_health_log';
--   -- expect: 1 row
--
--   \d+ instaclaw_gbrain_health_log
--   -- expect: id (BIGSERIAL), vm_id (UUID FK), checked_at (TIMESTAMPTZ), status (TEXT),
--   --   fail_code (TEXT), latency_ms (INTEGER), marker_ts (TEXT), details_json (JSONB)
