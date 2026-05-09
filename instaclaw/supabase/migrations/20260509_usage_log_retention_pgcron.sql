-- ════════════════════════════════════════════════════════════════════
-- Retention + indexing for instaclaw_usage_log
-- ════════════════════════════════════════════════════════════════════
--
-- Background:
--   instaclaw_usage_log is the per-LLM-call forensic log written from
--   app/api/gateway/proxy/route.ts:1480 on every chat completion.
--   The original migration (20260325_usage_log.sql) declared
--   "Auto-prunes entries older than 14 days to prevent table bloat"
--   as design intent but never implemented it. Audit on 2026-05-09
--   found 898K rows / 62 days of history (4.4× the intended window),
--   ~12K/day insert rate, and the table is the dominant write-IOPS
--   contributor on this Supabase project. See investigation doc at
--   docs/usage-log-retention-investigation-2026-05-09.md.
--
-- This migration:
--   1. Verifies pg_cron is installed (precondition).
--   2. Tunes autovacuum on instaclaw_usage_log to be aggressive on
--      insert-heavy workloads (5% scale_factor vs 20% default; 5K
--      insert threshold).
--   3. Replaces the standalone btree on created_at with a BRIN index
--      (~50× smaller, ~10× lower insert overhead). The composite
--      btree (vm_id, created_at DESC) stays in place for per-VM
--      forensic queries.
--   4. Creates a chunked-DELETE stored procedure with COMMIT between
--      chunks (10K rows/chunk, 0.5s sleep) so autovacuum can reclaim
--      dead tuples mid-procedure rather than waiting for the whole
--      run to finish.
--   5. Schedules a daily pg_cron job at 09:17 UTC to call the
--      procedure with 14-day retention. Steady state: ~12K rows/day
--      deleted.
--   6. Schedules a sibling pg_cron job at 10:00 UTC to retain only
--      14 days of cron.job_run_details (which itself grows unbounded
--      otherwise — pg_cron does not self-prune).
--   7. Exposes a SECURITY DEFINER read-only RPC for the Vercel
--      monitoring cron at /api/cron/db-job-health to surface failed
--      pg_cron runs via admin email. (pg_cron writes failures to
--      cron.job_run_details but does not alert; this closes that
--      observability gap.)
--
-- Idempotent: re-runnable safely.
--   - DROP INDEX IF EXISTS / CREATE INDEX IF NOT EXISTS
--   - CREATE OR REPLACE PROCEDURE / FUNCTION
--   - cron.schedule with the same jobname is upsert-shaped
--     (UPDATEs the existing row).
--
-- Prerequisite: pg_cron extension installed via Supabase Dashboard
--   → Integrations → Cron. Verified by the DO block at the top.
--
-- Robustness notes (from initial 2026-05-09 Studio paste):
--   - All function/procedure bodies use distinct dollar-quote
--     delimiters ($check$, $proc$, $func$, $verify$) and cron.schedule
--     command literals use $cmd$. Repeated $$ delimiters in a single
--     paste can confuse some SQL parsers and we hit it the first time
--     this migration was applied.
--   - The cutoff calculation uses make_interval(days => N) instead of
--     (N || ' days')::interval. The string-concat form depends on
--     int→text coercion that's flaky across Postgres versions and was
--     the load-bearing failure on the first paste.
--
-- Rollback:
--   SELECT cron.unschedule('prune-usage-log');
--   SELECT cron.unschedule('prune-cron-history');
--   DROP PROCEDURE IF EXISTS public.prune_usage_log(int);
--   DROP FUNCTION IF EXISTS public.recent_failed_cron_jobs(int);
--   DROP INDEX IF EXISTS public.idx_usage_log_created_brin;
--   CREATE INDEX idx_usage_log_created
--     ON public.instaclaw_usage_log (created_at);
--   ALTER TABLE public.instaclaw_usage_log
--     RESET (autovacuum_vacuum_scale_factor,
--            autovacuum_vacuum_insert_scale_factor,
--            autovacuum_vacuum_insert_threshold,
--            autovacuum_analyze_scale_factor);
--
-- See:
--   - docs/usage-log-retention-investigation-2026-05-09.md (analysis)
--   - existing pattern: app/api/cron/watchdog-prune/route.ts
-- ════════════════════════════════════════════════════════════════════

-- ─── 0. Precondition: pg_cron must be installed ─────────────────────
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron extension not installed. Enable via Supabase Dashboard → Integrations → Cron, then re-run this migration.';
  END IF;
END
$check$;

-- ─── 1. Autovacuum tuning ───────────────────────────────────────────
-- Defaults assume 20% changes before triggering autovacuum. For an
-- insert-heavy table this leaves visibility maps and dead tuples to
-- accumulate too long. Lowering the thresholds keeps maintenance
-- continuous and small.
ALTER TABLE public.instaclaw_usage_log SET (
  autovacuum_vacuum_scale_factor        = 0.05,
  autovacuum_vacuum_insert_scale_factor = 0.02,
  autovacuum_vacuum_insert_threshold    = 5000,
  autovacuum_analyze_scale_factor       = 0.02
);

-- ─── 2. BRIN swap on created_at ─────────────────────────────────────
-- The standalone btree on created_at (~30 MB) only ever serves
-- monotonically-ordered range scans (the retention DELETE; one
-- ad-hoc forensic outage script). BRIN is ~50× smaller and ~10×
-- cheaper at insert time — perfect fit. The composite index
-- idx_usage_log_vm_date (vm_id, created_at DESC) is unaffected and
-- continues to serve every per-VM forensic query.
--
-- Trade-off: this is a non-CONCURRENTLY swap. Migration files run in
-- a single transaction, where CONCURRENTLY is illegal. The DROP and
-- CREATE here briefly hold ACCESS EXCLUSIVE / SHARE locks. BRIN
-- builds in <2s on a 900K-row table, so the proxy INSERT path queues
-- for at most a few seconds.
DROP INDEX IF EXISTS public.idx_usage_log_created;

CREATE INDEX IF NOT EXISTS idx_usage_log_created_brin
  ON public.instaclaw_usage_log
  USING BRIN (created_at)
  WITH (pages_per_range = 32);

-- ─── 3. Prune procedure ────────────────────────────────────────────
-- Chunked DELETE with COMMIT between chunks. Why a procedure with
-- explicit COMMIT (not a function): we WANT each chunk to commit
-- independently so autovacuum can reclaim dead tuples without
-- waiting for the entire backfill to finish. A function runs in a
-- single implicit transaction and would hold all those dead tuples
-- until completion.
--
-- All names fully-qualified (public.*, cron.*) per pg_cron best
-- practice — search_path is not inherited from the calling session.
--
-- The DELETE shape (`WHERE id IN (SELECT id ... LIMIT 10000)`) is
-- robust against concurrent INSERTs: new rows have current
-- timestamps and never appear in the SELECT subquery.
--
-- The 0.5s pg_sleep between chunks lets WAL drain and gives
-- autovacuum continuous breathing room rather than producing a
-- single large gap.
--
-- make_interval() preferred over (retention_days || ' days')::interval —
-- the string-concat form failed on initial Studio paste due to
-- int→text coercion ambiguity.
CREATE OR REPLACE PROCEDURE public.prune_usage_log(retention_days int DEFAULT 14)
LANGUAGE plpgsql
AS $proc$
DECLARE
  cutoff         timestamptz := now() - make_interval(days => retention_days);
  deleted_total  int := 0;
  deleted_chunk  int := 0;
BEGIN
  LOOP
    DELETE FROM public.instaclaw_usage_log
    WHERE id IN (
      SELECT id FROM public.instaclaw_usage_log
      WHERE created_at < cutoff
      LIMIT 10000
    );
    GET DIAGNOSTICS deleted_chunk = ROW_COUNT;
    deleted_total := deleted_total + deleted_chunk;
    EXIT WHEN deleted_chunk = 0;
    COMMIT;
    PERFORM pg_sleep(0.5);
  END LOOP;

  -- Ensure the final (no-op) iteration's transaction is committed
  -- before ANALYZE so it sees the post-prune state.
  COMMIT;
  ANALYZE public.instaclaw_usage_log;
  RAISE NOTICE 'prune_usage_log: deleted % rows older than %', deleted_total, cutoff;
END;
$proc$;

COMMENT ON PROCEDURE public.prune_usage_log(int) IS
  '14-day retention prune for instaclaw_usage_log. Chunked DELETE '
  '(10K rows/chunk, 0.5s sleep, COMMIT between chunks). Called by '
  'pg_cron job ''prune-usage-log''. Manual invocation safe: CALL '
  'public.prune_usage_log(14). See migration '
  '20260509_usage_log_retention_pgcron.sql.';

-- ─── 4. Schedule the prune ──────────────────────────────────────────
-- 09:17 UTC daily. Off-peak, intentionally off the hour to avoid
-- thundering-herd with Vercel hourly crons. cron.schedule is
-- upsert-shaped — re-running the migration updates the schedule
-- rather than failing.
--
-- Command literal uses $cmd$ delimiter to avoid any conflict with
-- $$ used elsewhere in this migration.
SELECT cron.schedule(
  'prune-usage-log',
  '17 9 * * *',
  $cmd$CALL public.prune_usage_log(14)$cmd$
);

-- ─── 5. cron.job_run_details retention ──────────────────────────────
-- pg_cron's own log table grows unbounded — every cron run appends a
-- row. 14-day retention matches the prune-usage-log retention so
-- forensics windows stay aligned.
SELECT cron.schedule(
  'prune-cron-history',
  '0 10 * * *',
  $cmd$DELETE FROM cron.job_run_details WHERE start_time < now() - interval '14 days'$cmd$
);

-- ─── 6. RPC for the Vercel monitoring route ─────────────────────────
-- /api/cron/db-job-health calls this daily to surface any failed
-- pg_cron run within the last 25 hours.
--
-- SECURITY DEFINER + SET search_path = cron, pg_catalog so the
-- function can read cron.* tables without exposing the entire cron
-- schema to PostgREST. The function returns ONLY job-status
-- metadata (jobname, status, error message, timestamps) — no DML,
-- no row data from application tables.
CREATE OR REPLACE FUNCTION public.recent_failed_cron_jobs(hours_back int DEFAULT 25)
RETURNS TABLE(
  jobname        text,
  status         text,
  return_message text,
  start_time     timestamptz,
  end_time       timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = cron, pg_catalog
AS $func$
  SELECT
    j.jobname,
    d.status,
    d.return_message,
    d.start_time,
    d.end_time
  FROM cron.job_run_details d
  JOIN cron.job j ON j.jobid = d.jobid
  WHERE d.status = 'failed'
    AND d.start_time > now() - make_interval(hours => hours_back)
  ORDER BY d.start_time DESC;
$func$;

-- Restrict execution. PostgREST exposes any function callable by
-- `authenticated` to logged-in users via /rpc/<name>. We don't want
-- arbitrary users probing our cron history. service_role only.
REVOKE ALL ON FUNCTION public.recent_failed_cron_jobs(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recent_failed_cron_jobs(int) TO service_role;

COMMENT ON FUNCTION public.recent_failed_cron_jobs(int) IS
  'Returns failed pg_cron runs within hours_back. SECURITY DEFINER, '
  'service_role only. Used by /api/cron/db-job-health to alert on '
  'silent pg_cron failures. See migration '
  '20260509_usage_log_retention_pgcron.sql.';

-- ─── 7. Verification ────────────────────────────────────────────────
-- Sanity-check that both cron jobs registered. Fails the migration
-- if they didn't, so we get a clear error rather than silent
-- breakage.
DO $verify$
DECLARE
  job_count int;
BEGIN
  SELECT COUNT(*) INTO job_count
  FROM cron.job
  WHERE jobname IN ('prune-usage-log', 'prune-cron-history');

  IF job_count <> 2 THEN
    RAISE EXCEPTION 'Expected 2 cron jobs registered, found %. Check cron.job table.', job_count;
  END IF;

  RAISE NOTICE 'Migration complete: 2 cron jobs scheduled, prune procedure ready, monitoring RPC granted';
END
$verify$;
