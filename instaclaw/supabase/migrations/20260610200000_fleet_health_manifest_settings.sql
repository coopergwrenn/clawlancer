-- ════════════════════════════════════════════════════════════════════
-- Fleet-health detector: DURABLE manifest-version threshold (kills drift)
-- ════════════════════════════════════════════════════════════════════
--
-- Background — the bug this closes:
--   The 2026-05-11 P0 follow-up shipped a fleet-health pg_cron detector
--   (migration 20260513170100_fleet_health_pgcron.sql) that counts
--     healthy + assigned + config_version < manifest_version
--   and alerts when sustained > 30 min. It was created to catch the May 11
--   shape: 53 paying customers stuck at cv<84 with ZERO signal for days.
--
--   But the threshold was passed as a HARDCODED LITERAL `95` in the
--   cron command (`SELECT public.check_fleet_health(95)`). The migration's
--   own header warned: "EVERY MANIFEST BUMP must either re-schedule the
--   cron with the new version or move the constant to a settings table."
--   Nobody re-scheduled. The manifest bumped 95 → 128 (33 versions). On
--   2026-06-10 a verification found the detector had drifted into the
--   exact blind spot it was built to close: any healthy VM stuck in
--   cv 95–127 was invisible. vm-917 (healthy, cv=125) registered as
--   actionable=0 when it should be 1.
--
--   Re-scheduling with `128` is the same bug wearing a new number. This
--   migration implements the DURABLE shape the original header prescribed:
--   a settings row that holds the canonical manifest version, written by
--   the reconcile-fleet cron from VM_MANIFEST.version on every tick (the
--   SAME constant + SAME read-site that drives the candidate filter
--   `lt(config_version, VM_MANIFEST.version)`). The detector reads that
--   row instead of taking a parameter. Drift is unrepresentable by
--   construction: one read of VM_MANIFEST.version feeds both the
--   reconciler's filter and the settings write, in one function execution.
--
-- This migration:
--   §1. Creates public.instaclaw_app_settings (generic key/value config),
--       RLS-enabled (Rule 60), seeded with manifest_version='128' (the
--       current truth — detector goes live-correct the moment this applies).
--   §2. Replaces check_fleet_health: NEW no-arg function reads the settings
--       row; FAILS LOUD (returns error jsonb) if the row is missing rather
--       than computing against a guessed threshold (a wrong threshold is
--       the exact bug we're killing).
--   §3. Re-schedules the cron to call the no-arg function.
--   §4. Drops the old check_fleet_health(int) overload.
--   §5. Verification.
--
-- The write path lives in app/api/cron/reconcile-fleet/route.ts (shipped
-- alongside this migration): an UPSERT of manifest_version=String(VM_MANIFEST.version)
-- co-located with the candidate-filter read. See that file's comment block.
--
-- Rollback:
--   SELECT cron.unschedule('fleet-health-check');
--   DROP FUNCTION IF EXISTS public.check_fleet_health();
--   -- (re-create the old int-arg version from 20260513170100 if needed)
--   DROP TABLE IF EXISTS public.instaclaw_app_settings;
--
-- Prerequisite: 20260513170100_fleet_health_pgcron.sql already applied
-- (provides instaclaw_fleet_health_state + instaclaw_fleet_health_alerts).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── §0. Precondition: pg_cron + prior fleet-health tables ──────────
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron extension not installed.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='instaclaw_fleet_health_state'
  ) THEN
    RAISE EXCEPTION
      'instaclaw_fleet_health_state missing — apply 20260513170100_fleet_health_pgcron.sql first.';
  END IF;
END
$check$;

-- ─── §1. Generic app-settings key/value table ──────────────────────
--
-- Single source of truth for runtime config values that Postgres-side
-- code (pg_cron functions, triggers) needs but cannot import from the
-- TypeScript bundle. `value` is TEXT — callers cast as needed.

CREATE TABLE IF NOT EXISTS public.instaclaw_app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Row Level Security — load-bearing (Rule 60). Service-role bypasses RLS;
-- anon and authenticated get full deny absent explicit policies. The
-- reconcile-fleet cron writes via the service-role client; check_fleet_health
-- reads under the pg_cron execution role (superuser context, bypasses RLS).
-- Idempotent — no-op on re-run.
ALTER TABLE public.instaclaw_app_settings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.instaclaw_app_settings IS
  'Generic key/value runtime config readable by Postgres-side code that '
  'cannot import the TypeScript bundle. manifest_version is written by '
  'app/api/cron/reconcile-fleet from VM_MANIFEST.version every tick; '
  'check_fleet_health() reads it. See migration '
  '20260610200000_fleet_health_manifest_settings.sql.';

-- Backfill the current truth. The detector is live-correct the moment this
-- applies. reconcile-fleet then keeps it synced on every 3-min tick.
INSERT INTO public.instaclaw_app_settings (key, value, updated_at)
VALUES ('manifest_version', '128', NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- ─── §2. The check function — reads settings, no parameter ──────────
--
-- Identical streak + cooldown logic to the original. The ONLY change is
-- the threshold source: SELECT from instaclaw_app_settings instead of a
-- function argument. Fail-loud on missing setting — a guessed threshold
-- is the exact class of bug we are eliminating.

CREATE OR REPLACE FUNCTION public.check_fleet_health()
RETURNS jsonb
LANGUAGE plpgsql
AS $func$
DECLARE
  target_version   INT;
  current_count    INT;
  state            public.instaclaw_fleet_health_state;
  alert_threshold  INTERVAL := INTERVAL '30 minutes';
  alert_cooldown   INTERVAL := INTERVAL '6 hours';
  result           jsonb;
BEGIN
  -- §2.0 Read the canonical manifest version from settings. This row is
  -- written by reconcile-fleet from VM_MANIFEST.version every tick, so it
  -- can never drift from the version the reconciler is actually targeting.
  SELECT value::int INTO target_version
  FROM public.instaclaw_app_settings
  WHERE key = 'manifest_version';

  IF target_version IS NULL THEN
    -- Setting missing → DO NOT compute against a guessed threshold. Fail
    -- loud in the pg_cron telemetry (surfaced by /api/cron/db-job-health).
    -- This is the anti-drift guard: a wrong threshold is worse than none.
    RETURN jsonb_build_object(
      'status', 'error',
      'reason', 'manifest_version setting missing from instaclaw_app_settings'
    );
  END IF;

  -- §2.1 Compute the metric against the live threshold.
  SELECT COUNT(*) INTO current_count
  FROM public.instaclaw_vms
  WHERE health_status = 'healthy'
    AND status        = 'assigned'
    AND config_version < target_version;

  -- §2.2 Read state row (seed defensively).
  SELECT * INTO state FROM public.instaclaw_fleet_health_state WHERE id = 1;
  IF NOT FOUND THEN
    INSERT INTO public.instaclaw_fleet_health_state (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    SELECT * INTO state FROM public.instaclaw_fleet_health_state WHERE id = 1;
  END IF;

  -- §2.3 Branch on count (unchanged from original).
  IF current_count > 0 THEN
    IF state.non_zero_since IS NULL THEN
      UPDATE public.instaclaw_fleet_health_state SET
        non_zero_since = NOW(), last_check_at = NOW(),
        last_count = current_count, updated_at = NOW()
      WHERE id = 1;
      result := jsonb_build_object('status', 'streak_started', 'count', current_count, 'threshold', target_version);
    ELSIF (NOW() - state.non_zero_since) >= alert_threshold
          AND (state.last_alert_at IS NULL
               OR (NOW() - state.last_alert_at) >= alert_cooldown) THEN
      INSERT INTO public.instaclaw_fleet_health_alerts
        (alert_type, vm_count, stuck_since, manifest_version, details)
      VALUES (
        'stuck', current_count, state.non_zero_since, target_version,
        format(
          '%s VMs healthy+assigned at config_version<%s for %s (stuck since %s).',
          current_count, target_version,
          (NOW() - state.non_zero_since)::text, state.non_zero_since::text
        )
      );
      UPDATE public.instaclaw_fleet_health_state SET
        last_alert_at = NOW(), last_check_at = NOW(),
        last_count = current_count, updated_at = NOW()
      WHERE id = 1;
      result := jsonb_build_object('status', 'alerted', 'count', current_count, 'stuck_since', state.non_zero_since, 'threshold', target_version);
    ELSE
      UPDATE public.instaclaw_fleet_health_state SET
        last_check_at = NOW(), last_count = current_count, updated_at = NOW()
      WHERE id = 1;
      result := jsonb_build_object('status', 'sustained_within_cooldown', 'count', current_count, 'stuck_since', state.non_zero_since, 'last_alert_at', state.last_alert_at, 'threshold', target_version);
    END IF;
  ELSE
    IF state.non_zero_since IS NOT NULL THEN
      INSERT INTO public.instaclaw_fleet_health_alerts
        (alert_type, vm_count, stuck_since, manifest_version, details)
      VALUES (
        'recovered', 0, state.non_zero_since, target_version,
        format(
          'Fleet recovered after %s (stuck since %s; last alerted %s).',
          (NOW() - state.non_zero_since)::text, state.non_zero_since::text,
          COALESCE(state.last_alert_at::text, 'never')
        )
      );
      result := jsonb_build_object('status', 'recovered', 'previously_stuck_since', state.non_zero_since, 'threshold', target_version);
    ELSE
      result := jsonb_build_object('status', 'healthy', 'count', 0, 'threshold', target_version);
    END IF;
    UPDATE public.instaclaw_fleet_health_state SET
      non_zero_since = NULL, last_alert_at = NULL,
      last_check_at = NOW(), last_count = 0, updated_at = NOW()
    WHERE id = 1;
  END IF;

  RETURN result;
END;
$func$;

COMMENT ON FUNCTION public.check_fleet_health() IS
  'Hourly fleet-health monitor. Reads the canonical manifest version from '
  'instaclaw_app_settings (written by reconcile-fleet from VM_MANIFEST.version '
  'every tick — drift-proof by construction), counts healthy+assigned VMs '
  'below it, alerts when sustained >30min (6h cooldown). Fails loud if the '
  'manifest_version setting is missing. See migration '
  '20260610200000_fleet_health_manifest_settings.sql.';

REVOKE ALL ON FUNCTION public.check_fleet_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_fleet_health() TO service_role;

-- ─── §3. Re-schedule the cron to the no-arg function ────────────────
-- cron.schedule is upsert-shaped on jobname — overwrites the old command
-- (`SELECT public.check_fleet_health(95)`) with the parameterless call.
SELECT cron.schedule(
  'fleet-health-check',
  '13 * * * *',
  $cmd$SELECT public.check_fleet_health()$cmd$
);

-- ─── §4. Drop the old int-arg overload ──────────────────────────────
-- Done AFTER the reschedule so no tick can resolve to a dropped function.
-- (Whole migration is one transaction; pg_cron can't fire mid-txn anyway.)
DROP FUNCTION IF EXISTS public.check_fleet_health(int);

-- ─── §5. Verification ───────────────────────────────────────────────
DO $verify$
DECLARE
  job_count    INT;
  cmd          TEXT;
  seeded       TEXT;
BEGIN
  SELECT COUNT(*) INTO job_count FROM cron.job WHERE jobname = 'fleet-health-check';
  IF job_count <> 1 THEN
    RAISE EXCEPTION 'Expected 1 fleet-health-check cron job, found %.', job_count;
  END IF;

  SELECT command INTO cmd FROM cron.job WHERE jobname = 'fleet-health-check';
  IF cmd NOT LIKE '%check_fleet_health()%' THEN
    RAISE EXCEPTION 'cron command not pointed at no-arg function: %', cmd;
  END IF;

  SELECT value INTO seeded FROM public.instaclaw_app_settings WHERE key = 'manifest_version';
  IF seeded IS NULL THEN
    RAISE EXCEPTION 'manifest_version setting was not seeded.';
  END IF;

  RAISE NOTICE
    'fleet-health-check re-scheduled to no-arg check_fleet_health(); '
    'manifest_version seeded = %; threshold now drift-proof (reconcile-fleet '
    'syncs it from VM_MANIFEST.version each tick).', seeded;
END
$verify$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY (run in Studio for instant proof, else wait for next :13 tick):
--   SELECT public.check_fleet_health();
--   -- expect {"status":"streak_started","count":1,"threshold":128}
--   --   (vm-917, healthy, cv=125 < 128 — the live test case the frozen
--   --    threshold missed; blind before, sees it after, same fleet state)
--   SELECT last_count, non_zero_since FROM public.instaclaw_fleet_health_state;
--   -- expect last_count=1
-- ════════════════════════════════════════════════════════════════════
