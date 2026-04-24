-- Phase 2c — Strict reconcile mode
--
-- This migration introduces the DB surface that supports strict-mode fleet
-- reconciliation: event logging, per-VM streak tracking, daily aggregate
-- stats, and the runtime kill-switch feature flags.
--
-- Defaults are chosen so EVERY object is backward compatible with
-- pre-phase-2c behavior:
--   - strict_mode_enabled  = true  (allowlist-gated at reconcile-fleet)
--   - canary_enabled       = true  (canary runs when strict runs)
--   - strict_hold_streak   = 0     (VM starts with clean streak)
-- Flipping either flag to false in instaclaw_admin_settings is a sub-second
-- kill switch — the cron re-reads both on every invocation.

-- ── 1. Per-event log of strict holds ─────────────────────────────────────
-- One row per time the strict gate holds a VM back from a config_version
-- bump. Source of truth for alerting, admin queries, and weekly digests.
CREATE TABLE IF NOT EXISTS instaclaw_strict_holds (
  id bigserial PRIMARY KEY,
  vm_id uuid NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  event_time timestamptz NOT NULL DEFAULT now(),
  strict_errors text[] NOT NULL DEFAULT '{}',
  canary_healthy boolean,
  at_version integer,
  manifest_version integer NOT NULL,
  -- Snapshot of strict_hold_streak at the moment of the hold, so the event
  -- log is interpretable without joining back to instaclaw_vms.
  strict_hold_streak integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS instaclaw_strict_holds_vm_time_idx
  ON instaclaw_strict_holds(vm_id, event_time DESC);
CREATE INDEX IF NOT EXISTS instaclaw_strict_holds_time_idx
  ON instaclaw_strict_holds(event_time DESC);

-- ── 2. Streak column on instaclaw_vms ────────────────────────────────────
-- Increments on every strict hold, resets to 0 on any successful (non-held)
-- reconcile. Used by the "persistently held" query on /api/admin/strict-holds.
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS strict_hold_streak integer NOT NULL DEFAULT 0;

-- ── 3. Daily aggregate stats ─────────────────────────────────────────────
-- One row per day. UPSERT from reconcile-fleet at the end of each cron cycle.
-- Lets us answer "is strict mode still running at all?" with a single-row
-- lookup instead of counting strict_holds events (which misses clean probes).
CREATE TABLE IF NOT EXISTS instaclaw_strict_daily_stats (
  stat_date date PRIMARY KEY,
  probes_run integer NOT NULL DEFAULT 0,           -- total VMs audited in strict mode
  probes_clean integer NOT NULL DEFAULT 0,         -- strictErrors=[] AND canary healthy/null
  probes_held integer NOT NULL DEFAULT 0,          -- strictErrors>0 or canary=false → held
  probes_errored integer NOT NULL DEFAULT 0,       -- audit threw (SSH dead, etc.)
  canaries_skipped_budget integer NOT NULL DEFAULT 0, -- skipped per budget-gate
  first_probe_at timestamptz,
  last_probe_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── 4. Runtime kill-switch settings ──────────────────────────────────────
-- Single-row-per-key table. Rows are read on every reconcile-fleet cron
-- fire, making flips effectively sub-second (next cron cycle). Why a table
-- and not env vars: Vercel env changes require a redeploy; DB flips don't.
CREATE TABLE IF NOT EXISTS instaclaw_admin_settings (
  setting_key text PRIMARY KEY,
  bool_value boolean,
  text_value text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  notes text
);

-- Seed rows with default=true (backward compat).
INSERT INTO instaclaw_admin_settings (setting_key, bool_value, notes)
VALUES
  ('strict_mode_enabled', true,
   'Master on/off for strict reconcile. When false, reconcile-fleet runs all VMs in legacy mode regardless of STRICT_RECONCILE_VM_IDS.'),
  ('canary_enabled', true,
   'Enables the post-reconcile canary round-trip probe. When false, strict mode runs config-set validation only; canary step is skipped.')
ON CONFLICT (setting_key) DO NOTHING;

-- NOTE on alert dedup: strict-mode alerting uses instaclaw_admin_alert_log
-- with alert_key of the form "strict_hold:{vm_id}:{error_hash}". The
-- required composite index (alert_key, sent_at DESC) is already created by
-- migration 20260315_admin_alert_log.sql as idx_alert_log_key_sent — no
-- new index needed.
