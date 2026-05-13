-- ════════════════════════════════════════════════════════════════════
-- Fleet-health monitoring via pg_cron — detect stuck VMs within 30 min.
-- ════════════════════════════════════════════════════════════════════
--
-- Background:
--   CLAUDE.md Fleet Health section defines the actionable health metric:
--     fleet_health_actionable = count(
--       instaclaw_vms WHERE health_status='healthy'
--                       AND status='assigned'
--                       AND config_version < VM_MANIFEST.version
--     )
--   Target: 0. Cooper's stated discovery pattern: ~46% of the fleet went
--   stale at cv<95 last week and we found out days later. This migration
--   closes that observability gap with a pg_cron job that alerts when
--   the metric is non-zero sustained beyond 30 minutes.
--
-- This migration:
--   1. Verifies pg_cron extension is installed (precondition).
--   2. Creates two tables:
--        a. instaclaw_fleet_health_state (single-row state machine
--           tracking the streak of non-zero counts).
--        b. instaclaw_fleet_health_alerts (alert log; one row per
--           alert event, polled by future Vercel cron for delivery).
--   3. Creates the check function with streak + cooldown logic.
--   4. Schedules pg_cron hourly invocation.
--   5. Verifies the cron job registered correctly.
--
-- Why a state-tracking table instead of querying history:
--   The "sustained for 30 min" requirement needs streak memory across
--   cron ticks. We could compute streak length from the alerts table
--   alone, but that conflates "have we alerted yet" with "is the
--   current streak past threshold." A separate single-row state
--   table keeps the two concerns clean and the function logic small.
--
-- Cadence choice (hourly vs every 15 min):
--   Cooper specified hourly. With hourly cadence and a 30-min sustained
--   threshold, the FIRST alert lands ~60 min after the actual stuck
--   condition begins (tick T0 starts the streak, tick T0+60min has
--   now-since=60min which crosses 30min → alert). Acceptable per
--   Cooper's stated goal ("never again discover 53 VMs stuck DAYS
--   after the fact"). If Cooper wants sharper detection later, change
--   the schedule to '13,43 * * * *' (every 30 min) — function logic
--   doesn't change.
--
-- Alert delivery:
--   This pg_cron job ONLY records alerts to instaclaw_fleet_health_alerts.
--   It does NOT send emails directly (pg can't). Two follow-up paths
--   to deliver:
--     a. Tiny Vercel cron route /api/cron/fleet-health-notify (every
--        15 min) polls WHERE notified_at IS NULL → emails via
--        lib/email.ts → sets notified_at. The natural follow-up PR.
--     b. Supabase Database Webhook on INSERT to
--        instaclaw_fleet_health_alerts → POSTs to a Vercel route.
--   Until either is wired up, alerts accumulate in the table and can
--   be queried by `SELECT * FROM instaclaw_fleet_health_alerts WHERE
--   notified_at IS NULL ORDER BY created_at DESC;`.
--
-- Manifest version parameter:
--   The function takes manifest_version as an argument. We pin it to 95
--   in the cron command literal below. EVERY MANIFEST BUMP must either
--   re-schedule the cron with the new version or move the constant to
--   a settings table the function reads from. The simplest (hardcode)
--   is what we ship; the followup is to move it into vm-manifest
--   settings if this rule produces drift.
--
-- Rollback:
--   SELECT cron.unschedule('fleet-health-check');
--   DROP FUNCTION IF EXISTS public.check_fleet_health(int);
--   DROP TABLE IF EXISTS public.instaclaw_fleet_health_alerts;
--   DROP TABLE IF EXISTS public.instaclaw_fleet_health_state;
--
-- Prerequisite: pg_cron extension. Verified by §0.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── §0. Precondition: pg_cron must be installed ────────────────────
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION
      'pg_cron extension not installed. Enable via Supabase Dashboard → '
      'Integrations → Cron, then re-run this migration.';
  END IF;
END
$check$;

-- ─── §1. State-machine table (single row) ───────────────────────────
--
-- Single-row pattern via CHECK (id = 1). UPSERT semantics on subsequent
-- runs. The row tracks:
--   - non_zero_since: timestamp the current streak of >0 counts started.
--                     NULL means we're currently in a healthy state.
--   - last_alert_at:  timestamp of the most recent alert (cooldown anchor).
--   - last_check_at / last_count: forensic columns surfaced via dashboards
--                                 if Cooper wants to see "current count"
--                                 without re-running the expensive count
--                                 query.

CREATE TABLE IF NOT EXISTS public.instaclaw_fleet_health_state (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_check_at   TIMESTAMPTZ,
  last_count      INT,
  non_zero_since  TIMESTAMPTZ,
  last_alert_at   TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.instaclaw_fleet_health_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.instaclaw_fleet_health_state IS
  'Single-row state machine for fleet-health monitoring. Tracks the '
  'current streak of non-zero fleet_health_actionable counts so the '
  '30-min sustained-threshold logic can be implemented without re-'
  'computing from history each cron tick. Written exclusively by '
  'public.check_fleet_health(). See migration '
  '20260513170100_fleet_health_pgcron.sql.';

-- Service-role-only access (defense in depth; the function bypasses
-- RLS as SECURITY INVOKER under the postgres role, so this is a
-- belt-and-suspenders for anon/authenticated).
ALTER TABLE public.instaclaw_fleet_health_state ENABLE ROW LEVEL SECURITY;

-- ─── §2. Alert log table ────────────────────────────────────────────
--
-- Append-only log of alert events (stuck + recovered). Each row gets
-- delivered exactly once when a future Vercel notify-cron sets
-- notified_at. Keeps history for forensics.

CREATE TABLE IF NOT EXISTS public.instaclaw_fleet_health_alerts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type        TEXT NOT NULL CHECK (alert_type IN ('stuck', 'recovered')),
  vm_count          INT NOT NULL,
  stuck_since       TIMESTAMPTZ,             -- when the current streak began
  manifest_version  INT NOT NULL,
  details           TEXT NOT NULL,
  notified_at       TIMESTAMPTZ,             -- set by future notify-cron
  notified_via      TEXT,                    -- 'email' | 'slack' | etc.
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fleet_health_alerts_unnotified
  ON public.instaclaw_fleet_health_alerts (created_at DESC)
  WHERE notified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_fleet_health_alerts_created
  ON public.instaclaw_fleet_health_alerts (created_at DESC);

COMMENT ON TABLE public.instaclaw_fleet_health_alerts IS
  'Append-only log of fleet-health alerts (stuck + recovered). Each row '
  'is delivered exactly once: a future Vercel cron polls WHERE notified_at '
  'IS NULL, sends the alert, then sets notified_at. See migration '
  '20260513170100_fleet_health_pgcron.sql.';

ALTER TABLE public.instaclaw_fleet_health_alerts ENABLE ROW LEVEL SECURITY;

-- ─── §3. The check function ─────────────────────────────────────────
--
-- LANGUAGE plpgsql (needed for control flow).
-- Returns jsonb so the cron's job_run_details capture meaningful output
-- for the /api/cron/db-job-health route to surface.
--
-- All names fully-qualified (public.*, cron.*) per pg_cron best practice
-- — search_path is not inherited from the cron-job execution context.

CREATE OR REPLACE FUNCTION public.check_fleet_health(manifest_version INT DEFAULT 95)
RETURNS jsonb
LANGUAGE plpgsql
AS $func$
DECLARE
  current_count    INT;
  state            public.instaclaw_fleet_health_state;
  alert_threshold  INTERVAL := INTERVAL '30 minutes';
  alert_cooldown   INTERVAL := INTERVAL '6 hours';
  result           jsonb;
BEGIN
  -- §3.1 Compute the metric.
  SELECT COUNT(*) INTO current_count
  FROM public.instaclaw_vms
  WHERE health_status = 'healthy'
    AND status        = 'assigned'
    AND config_version < manifest_version;

  -- §3.2 Read the state row. Seed if missing (defensive — the migration
  -- already INSERTs id=1).
  SELECT * INTO state FROM public.instaclaw_fleet_health_state WHERE id = 1;
  IF NOT FOUND THEN
    INSERT INTO public.instaclaw_fleet_health_state (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    SELECT * INTO state FROM public.instaclaw_fleet_health_state WHERE id = 1;
  END IF;

  -- §3.3 Branch on count.
  IF current_count > 0 THEN
    -- Stuck count detected this tick.
    IF state.non_zero_since IS NULL THEN
      -- New streak: just record onset, don't alert yet.
      UPDATE public.instaclaw_fleet_health_state SET
        non_zero_since = NOW(),
        last_check_at  = NOW(),
        last_count     = current_count,
        updated_at     = NOW()
      WHERE id = 1;
      result := jsonb_build_object(
        'status', 'streak_started',
        'count', current_count
      );
    ELSIF (NOW() - state.non_zero_since) >= alert_threshold
          AND (state.last_alert_at IS NULL
               OR (NOW() - state.last_alert_at) >= alert_cooldown) THEN
      -- Streak past threshold AND cooldown elapsed → fire alert.
      INSERT INTO public.instaclaw_fleet_health_alerts
        (alert_type, vm_count, stuck_since, manifest_version, details)
      VALUES (
        'stuck',
        current_count,
        state.non_zero_since,
        manifest_version,
        format(
          '%s VMs healthy+assigned at config_version<%s for %s (stuck since %s).',
          current_count,
          manifest_version,
          (NOW() - state.non_zero_since)::text,
          state.non_zero_since::text
        )
      );

      UPDATE public.instaclaw_fleet_health_state SET
        last_alert_at = NOW(),
        last_check_at = NOW(),
        last_count    = current_count,
        updated_at    = NOW()
      WHERE id = 1;

      result := jsonb_build_object(
        'status', 'alerted',
        'count', current_count,
        'stuck_since', state.non_zero_since
      );
    ELSE
      -- Sustained but within cooldown window → no alert, just update telemetry.
      UPDATE public.instaclaw_fleet_health_state SET
        last_check_at = NOW(),
        last_count    = current_count,
        updated_at    = NOW()
      WHERE id = 1;
      result := jsonb_build_object(
        'status', 'sustained_within_cooldown',
        'count', current_count,
        'stuck_since', state.non_zero_since,
        'last_alert_at', state.last_alert_at
      );
    END IF;
  ELSE
    -- Healthy (count = 0).
    IF state.non_zero_since IS NOT NULL THEN
      -- Was stuck, now recovered → log recovery and clear state.
      INSERT INTO public.instaclaw_fleet_health_alerts
        (alert_type, vm_count, stuck_since, manifest_version, details)
      VALUES (
        'recovered',
        0,
        state.non_zero_since,
        manifest_version,
        format(
          'Fleet recovered after %s (stuck since %s; last alerted %s).',
          (NOW() - state.non_zero_since)::text,
          state.non_zero_since::text,
          COALESCE(state.last_alert_at::text, 'never')
        )
      );
      result := jsonb_build_object(
        'status', 'recovered',
        'previously_stuck_since', state.non_zero_since
      );
    ELSE
      result := jsonb_build_object(
        'status', 'healthy',
        'count', 0
      );
    END IF;

    -- Reset state regardless of whether we logged recovery.
    UPDATE public.instaclaw_fleet_health_state SET
      non_zero_since = NULL,
      last_alert_at  = NULL,
      last_check_at  = NOW(),
      last_count     = 0,
      updated_at     = NOW()
    WHERE id = 1;
  END IF;

  RETURN result;
END;
$func$;

COMMENT ON FUNCTION public.check_fleet_health(int) IS
  'Hourly fleet-health monitor (CLAUDE.md Fleet Health section). '
  'Computes fleet_health_actionable, tracks the streak of >0 counts, '
  'and inserts into instaclaw_fleet_health_alerts when sustained '
  '>30min (6h cooldown between alerts). Returns jsonb status for '
  'pg_cron telemetry. See migration 20260513170100_fleet_health_pgcron.sql.';

-- Restrict execution: only postgres + service_role can call.
REVOKE ALL ON FUNCTION public.check_fleet_health(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_fleet_health(int) TO service_role;

-- ─── §4. Schedule the cron ──────────────────────────────────────────
--
-- Hourly at xx:13 (off-hour offset, avoids thundering herd with other
-- hourly Vercel crons). cron.schedule is upsert-shaped — re-running
-- the migration updates the schedule rather than erroring.
--
-- $cmd$ dollar-quote delimiter avoids conflict with $func$ used above.
--
-- IMPORTANT: the literal '95' below pins the current manifest version.
-- See header note on "Manifest version parameter" — re-schedule with
-- the new number every time vm-manifest.ts:version is bumped, OR
-- migrate to a settings table.

SELECT cron.schedule(
  'fleet-health-check',
  '13 * * * *',
  $cmd$SELECT public.check_fleet_health(95)$cmd$
);

-- ─── §5. Verification ───────────────────────────────────────────────
DO $verify$
DECLARE
  job_count       INT;
  state_row_count INT;
BEGIN
  SELECT COUNT(*) INTO job_count
  FROM cron.job
  WHERE jobname = 'fleet-health-check';
  IF job_count <> 1 THEN
    RAISE EXCEPTION 'Expected 1 fleet-health-check cron job, found %.', job_count;
  END IF;

  SELECT COUNT(*) INTO state_row_count
  FROM public.instaclaw_fleet_health_state;
  IF state_row_count <> 1 THEN
    RAISE EXCEPTION 'Expected single state row, found %.', state_row_count;
  END IF;

  RAISE NOTICE
    'fleet-health-check scheduled hourly at :13; state seeded; '
    '30-min threshold + 6h cooldown; manifest_version=95.';
END
$verify$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- After applying this migration, the cron will fire at the next :13.
-- To trigger immediately for testing:
--   SELECT public.check_fleet_health(95);
--
-- To see scheduled jobs:
--   SELECT jobid, jobname, schedule, command FROM cron.job;
--
-- To see recent runs:
--   SELECT jobid, status, return_message, start_time
--   FROM cron.job_run_details
--   WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='fleet-health-check')
--   ORDER BY start_time DESC LIMIT 10;
--
-- To see pending alerts:
--   SELECT * FROM public.instaclaw_fleet_health_alerts
--   WHERE notified_at IS NULL
--   ORDER BY created_at DESC;
--
-- To inspect current state:
--   SELECT * FROM public.instaclaw_fleet_health_state;
-- ════════════════════════════════════════════════════════════════════
