-- Watchdog v2 + Wake Reconciler — schema additions
-- Spec: instaclaw/docs/watchdog-v2-and-wake-reconciler-design.md (2026-05-02)
-- All ADD COLUMN / CREATE TABLE are IF NOT EXISTS — re-runnable.
--
-- Privacy-mode column NOT added here: instaclaw_users.privacy_mode_until
-- already exists (applied 2026-05-01). Watchdog reads that column directly;
-- there is exactly one source of truth.

-- ─── Distinguish user activity from heartbeats (Lesson 6) ──────────────────
-- last_proxy_call_at includes heartbeats (system-driven, every 3h). Using it
-- as an "active user" signal lets long-idle users avoid restarts they need.
-- last_user_activity_at is populated only on real user-initiated requests
-- (the proxy update is a separate follow-up; until then we backfill from
-- last_proxy_call_at as a safe upper-bound — being MORE protective of
-- "active" users in the interim, not less).
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS last_user_activity_at timestamptz;

UPDATE instaclaw_vms
  SET last_user_activity_at = last_proxy_call_at
  WHERE last_user_activity_at IS NULL;

-- ─── Watchdog v2 state tracking (derived state computed from these) ────────
-- We do NOT store the derived state itself (HEALTHY/DEGRADED/UNHEALTHY/etc)
-- as a column. State is computed from these inputs in lib/watchdog.ts so
-- there is no risk of state-vs-inputs drift.
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS watchdog_consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watchdog_first_failure_at timestamptz,
  ADD COLUMN IF NOT EXISTS watchdog_last_restart_at timestamptz,
  ADD COLUMN IF NOT EXISTS watchdog_restart_attempts_24h integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watchdog_restart_attempts_24h_window_start timestamptz,
  ADD COLUMN IF NOT EXISTS watchdog_quarantined_at timestamptz;

-- ─── Audit trail (every watchdog action) ───────────────────────────────────
-- One row per cron-cycle decision per VM. Used for:
--   1. Shadow-mode validation: see what v2 would do before flipping it active.
--   2. Forensics when a customer reports "my agent restarted unexpectedly".
--   3. Trend analysis: which VMs trip the watchdog most often.
CREATE TABLE IF NOT EXISTS instaclaw_watchdog_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id uuid NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  user_id uuid REFERENCES instaclaw_users(id) ON DELETE SET NULL,
  -- Action taxonomy. Keep this in sync with lib/watchdog.ts WatchdogAction.
  -- Migration would need updating if new actions added.
  action text NOT NULL CHECK (action IN (
    'probe_healthy',
    'probe_failed',
    'restart_attempted',
    'restart_succeeded',
    'restart_failed',
    'restart_skipped_active_user',
    'restart_skipped_cooldown',
    'restart_skipped_quarantined',
    'restart_skipped_unowned',
    'restart_skipped_global_anomaly',
    'restart_skipped_billing_unverified',
    'restart_skipped_shadow_mode',
    'inspection_skipped_privacy_mode',
    'reset_after_recovery',
    'quarantined',
    'wake_reconciler_attempted',
    'wake_reconciler_succeeded',
    'wake_reconciler_failed',
    'wake_reconciler_skipped_not_paying',
    'wake_reconciler_halted_ssh_failure'
  )),
  prior_state text NOT NULL,
  new_state text NOT NULL,
  reason text,
  consecutive_failures integer,
  -- Anything else worth keeping (probe latency, response code, error message,
  -- privacy_mode_until, billing source, mode=shadow|active, etc.)
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_watchdog_audit_vm_time
  ON instaclaw_watchdog_audit (vm_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_watchdog_audit_action_time
  ON instaclaw_watchdog_audit (action, created_at DESC);

-- Retention is NOT enforced in this migration. A separate cleanup cron will
-- be added once we see actual growth (estimate: ~50K rows/week at current
-- fleet size). Default to keeping everything until then.
