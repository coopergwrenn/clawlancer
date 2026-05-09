/**
 * GET /api/cron/db-job-health
 *
 * Daily monitor for Supabase pg_cron job failures. Pages admin on
 * any failed run within the last 25 hours.
 *
 * Background:
 *   pg_cron writes job execution rows to cron.job_run_details with
 *   status in {starting, running, succeeded, failed}. Failures land
 *   silently — pg_cron does NOT alert anyone. This route closes
 *   that observability gap by polling the table once a day via a
 *   SECURITY DEFINER RPC and emailing admin if anything failed.
 *
 *   As of 2026-05-09 the pg_cron jobs in scope are:
 *     - prune-usage-log     (daily, 09:17 UTC)
 *     - prune-cron-history  (daily, 10:00 UTC)
 *
 * Schedule: daily at 11:00 UTC — runs after both pg_cron jobs above
 *   so any same-day failures will be visible in the 25h lookback.
 *
 * Security: standard CRON_SECRET bearer auth. RPC is SECURITY DEFINER
 *   on service_role, returns only cron status metadata.
 *
 * Why a Vercel cron monitoring a pg_cron: pg_cron is correct for the
 *   work itself (zero round-trips, runs in DB), but its observability
 *   is DB-only. This route gives us Vercel-log + email alerting on
 *   top of pg_cron's storage. Best of both.
 *
 * Migration: supabase/migrations/20260509_usage_log_retention_pgcron.sql
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
// Single RPC call against a small (capped at 14d via prune-cron-history)
// table. 60s is generous — actual runtime is <1s.
export const maxDuration = 60;

const CRON_NAME = "db-job-health";
const CRON_LOCK_TTL_SECONDS = 90;
const HOURS_BACK = 25;

interface FailedJobRow {
  jobname: string;
  status: string;
  return_message: string | null;
  start_time: string;
  end_time: string | null;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("db-job-health: lock held, skipping", { route: `cron/${CRON_NAME}` });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();

  try {
    const supabase = getSupabase();
    const { data: failedJobs, error } = await supabase.rpc(
      "recent_failed_cron_jobs",
      { hours_back: HOURS_BACK },
    );

    if (error) {
      // The RPC failing is itself a critical signal — it means we
      // can no longer detect pg_cron failures. Alert hard.
      logger.error("db-job-health: RPC failed — losing pg_cron observability", {
        route: `cron/${CRON_NAME}`,
        error: error.message,
        code: (error as { code?: string }).code,
      });
      sendAdminAlertEmail(
        "DB job health monitor: RPC unavailable",
        `recent_failed_cron_jobs() returned an error and we cannot detect pg_cron failures right now.\n\nError: ${error.message}\n\nInvestigate: Supabase Dashboard → Database → Cron Jobs.\nMigration: supabase/migrations/20260509_usage_log_retention_pgcron.sql`,
      ).catch(() => {});
      return NextResponse.json(
        { error: "rpc_failed", details: error.message },
        { status: 500 },
      );
    }

    const failures = (failedJobs ?? []) as FailedJobRow[];
    const elapsedMs = Date.now() - startedAt;

    if (failures.length === 0) {
      logger.info("db-job-health: clean", {
        route: `cron/${CRON_NAME}`,
        hoursBack: HOURS_BACK,
        elapsedMs,
      });
      return NextResponse.json({
        ok: true,
        failed_runs: 0,
        hours_back: HOURS_BACK,
        elapsedMs,
      });
    }

    // Group by jobname so the alert email reads naturally even when
    // a single job fails multiple times in the lookback window.
    const byJob: Record<string, FailedJobRow[]> = {};
    for (const f of failures) {
      if (!byJob[f.jobname]) byJob[f.jobname] = [];
      byJob[f.jobname].push(f);
    }

    const alertBody = Object.entries(byJob)
      .map(([jobname, runs]) => {
        const lines = runs.map(
          (r) =>
            `  ${r.start_time}: ${r.return_message?.slice(0, 200) ?? "(no return_message)"}`,
        );
        return `${jobname} (${runs.length} failure${runs.length === 1 ? "" : "s"}):\n${lines.join("\n")}`;
      })
      .join("\n\n");

    logger.error("db-job-health: pg_cron failures detected", {
      route: `cron/${CRON_NAME}`,
      total_failures: failures.length,
      jobs: Object.keys(byJob),
      elapsedMs,
    });

    sendAdminAlertEmail(
      `pg_cron job failures (${failures.length} in last ${HOURS_BACK}h)`,
      `One or more pg_cron jobs failed in the last ${HOURS_BACK} hours.\n\n${alertBody}\n\nInvestigate:\n- Supabase Dashboard → Database → Cron Jobs\n- Run: SELECT * FROM cron.job_run_details WHERE status = 'failed' ORDER BY start_time DESC LIMIT 20;\n- Migration: supabase/migrations/20260509_usage_log_retention_pgcron.sql`,
    ).catch(() => {});

    return NextResponse.json({
      ok: false,
      failed_runs: failures.length,
      hours_back: HOURS_BACK,
      jobs_with_failures: Object.keys(byJob),
      elapsedMs,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
