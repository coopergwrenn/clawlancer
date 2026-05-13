/**
 * GET /api/cron/fleet-health-notify
 *
 * Delivery side of the fleet-health pg_cron monitor (see
 * supabase/migrations/20260513170100_fleet_health_pgcron.sql).
 *
 * The pg_cron job public.check_fleet_health(95) runs hourly at xx:13,
 * INSERTs a row into instaclaw_fleet_health_alerts when the
 * fleet_health_actionable metric (healthy + assigned + cv < manifest)
 * is sustained > 30 minutes. That row sits in the table with
 * notified_at = NULL until something polls it and emails admin.
 *
 * This route is that something. Polls every 15 minutes, sends one
 * email per unnotified alert via lib/email.ts:sendAdminAlertEmail,
 * sets notified_at + notified_via='email'.
 *
 * Each row is delivered exactly once: the UPDATE on notified_at is
 * gated on notified_at IS NULL so any future re-poll naturally
 * skips already-delivered rows.
 *
 * Auth: standard CRON_SECRET bearer (matches /api/cron/db-job-health,
 *       /api/cron/health-check, etc.).
 * Lock: distributed cron lock via lib/cron-lock.ts. TTL 90s — generous
 *       given the route handles up to MAX_PER_TICK rows in ~15s worst case.
 * Cap:  MAX_PER_TICK = 50 limits worst-case Resend API calls per fire,
 *       leaving room under maxDuration=60. Backlogs drain across ticks.
 *
 * Why hardcoded 50 not unlimited:
 *   In normal operation the pg_cron's 6h alert-cooldown means at most
 *   1 'stuck' row is queued per 6h, and 'recovered' rows fire only on
 *   count-transitions-to-zero. A 50-row backlog implies pg_cron has
 *   been alerting for ~50 × 6h = ~12 days without delivery — at which
 *   point we have a deeper problem the limit highlights, not masks.
 *
 * Schedule:
 *   "schedule": "*\/15 * * * *"  (15-min cadence aligned to the
 *   30-min sustained threshold — first stuck alert lands within
 *   ~60 min worst-case from issue onset).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { sendAdminAlertEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_NAME = "fleet-health-notify";
const CRON_LOCK_TTL_SECONDS = 90;
const MAX_PER_TICK = 50;

interface FleetHealthAlertRow {
  id: string;
  alert_type: "stuck" | "recovered";
  vm_count: number;
  stuck_since: string | null;
  manifest_version: number;
  details: string;
  notified_at: string | null;
  notified_via: string | null;
  created_at: string;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("fleet-health-notify: lock held, skipping", { route: `cron/${CRON_NAME}` });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();

  try {
    const supabase = getSupabase();

    const { data: alerts, error } = await supabase
      .from("instaclaw_fleet_health_alerts")
      .select("*")
      .is("notified_at", null)
      .order("created_at", { ascending: true })
      .limit(MAX_PER_TICK);

    if (error) {
      logger.error("fleet-health-notify: query failed", {
        route: `cron/${CRON_NAME}`,
        error: error.message,
        code: (error as { code?: string }).code,
      });
      return NextResponse.json(
        { error: "query_failed", details: error.message },
        { status: 500 },
      );
    }

    const rows = (alerts ?? []) as FleetHealthAlertRow[];

    if (rows.length === 0) {
      logger.info("fleet-health-notify: nothing to deliver", {
        route: `cron/${CRON_NAME}`,
        elapsedMs: Date.now() - startedAt,
      });
      return NextResponse.json({ ok: true, sent: 0, elapsedMs: Date.now() - startedAt });
    }

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const subject =
        row.alert_type === "stuck"
          ? `Fleet stuck — ${row.vm_count} VM(s) at cv<${row.manifest_version}`
          : `Fleet recovered — was stuck since ${row.stuck_since ?? "unknown"}`;

      const body = [
        row.details,
        "",
        `Alert ID:        ${row.id}`,
        `Alert created:   ${row.created_at}`,
        `Alert type:      ${row.alert_type}`,
        `Manifest target: cv=${row.manifest_version}`,
        row.stuck_since ? `Stuck since:     ${row.stuck_since}` : "",
        "",
        "Inspect:",
        "  SELECT name, config_version, last_health_check, reconcile_last_error",
        "  FROM instaclaw_vms",
        `  WHERE health_status='healthy' AND status='assigned' AND config_version < ${row.manifest_version}`,
        "  ORDER BY config_version, last_health_check DESC;",
        "",
        "Suppress further alerts until recovery:",
        "  UPDATE instaclaw_fleet_health_state SET last_alert_at = NOW() WHERE id = 1;",
        "",
        "Source: pg_cron fleet-health-check (migration 20260513170100_fleet_health_pgcron.sql)",
      ]
        .filter(Boolean)
        .join("\n");

      try {
        await sendAdminAlertEmail(subject, body);
      } catch (e) {
        failed++;
        errors.push(`${row.id}: ${String(e)}`);
        // Don't mark notified_at — let the next tick retry. Logging only.
        logger.error("fleet-health-notify: email send failed", {
          route: `cron/${CRON_NAME}`,
          alertId: row.id,
          error: String(e),
        });
        continue;
      }

      // Mark delivered. Gated on notified_at IS NULL so concurrent writers
      // can never double-deliver (defensive — the cron-lock above is the
      // primary guard).
      const { error: updErr } = await supabase
        .from("instaclaw_fleet_health_alerts")
        .update({
          notified_at: new Date().toISOString(),
          notified_via: "email",
        })
        .eq("id", row.id)
        .is("notified_at", null);

      if (updErr) {
        // Email sent, mark FAILED — risk of duplicate email if next tick
        // sees this row as still unnotified. The cron-lock makes this
        // a single-instance concern. Worth a loud log.
        logger.error("fleet-health-notify: mark-delivered UPDATE failed", {
          route: `cron/${CRON_NAME}`,
          alertId: row.id,
          error: updErr.message,
        });
        errors.push(`${row.id} marked-delivered failed: ${updErr.message}`);
      }

      sent++;
    }

    const elapsedMs = Date.now() - startedAt;
    logger.info("fleet-health-notify: tick complete", {
      route: `cron/${CRON_NAME}`,
      pending: rows.length,
      sent,
      failed,
      elapsedMs,
    });

    return NextResponse.json({
      ok: failed === 0,
      pending: rows.length,
      sent,
      failed,
      errors: errors.slice(0, 10),
      elapsedMs,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
