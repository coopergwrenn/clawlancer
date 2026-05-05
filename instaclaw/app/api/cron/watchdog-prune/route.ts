/**
 * GET /api/cron/watchdog-prune
 *
 * Daily retention prune for instaclaw_watchdog_audit.
 *
 * Background: the watchdog cron writes one audit row per VM per
 * 5-min cycle. Pre-2026-05-05 the table was 96% probe_healthy no-op
 * rows growing 1.8K/hour with no retention policy — by day 3 it was
 * 129K rows and Supabase flagged resource exhaustion the night
 * before Consensus 2026 launch.
 *
 * Two changes shipped that day:
 *   1. The watchdog cron stopped writing probe_healthy rows
 *      (96% reduction in steady-state insert rate).
 *   2. This cron — daily retention prune at 48h.
 *
 * Why 48h: enough to forensically explain anything that fired in the
 * past 2 days. Action rows (probe_failed, restart_*, restart_skipped_*,
 * reset_after_recovery, etc.) should be rare — at projected post-fix
 * write rates the table should sit around 1-5K rows steady-state
 * after this prune lands.
 *
 * Why daily (and not hourly): the writes are now sparse. Pruning more
 * often than once a day is wasted work. If the table starts growing
 * past expected volume (e.g., a fleet-wide outage that produces
 * thousands of probe_failed rows), this cron will naturally catch it
 * the next morning. There's no SLA around the audit table being any
 * particular size at any moment.
 *
 * Idempotent + concurrent-safe via cron lock. Single DELETE statement
 * — does not lock the table for long; concurrent INSERTs (the
 * watchdog cron writing new action rows) are unaffected via MVCC.
 *
 * Configurable retention via WATCHDOG_AUDIT_RETENTION_HOURS env var.
 * Default 48; clamped to [12, 720] (12 hours min so we always keep at
 * least one full day of data; 30 days max so storage doesn't quietly
 * balloon if someone misconfigures).
 *
 * Auth: CRON_SECRET — same as every other cron.
 *
 * PRD: docs/watchdog-v2-and-wake-reconciler-design.md (Rule 17)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
// Single DELETE on a 1-50K-row partition shouldn't take more than a
// few seconds even on a hot table. 60s is generous.
export const maxDuration = 60;

const CRON_NAME = "watchdog-prune";
const CRON_LOCK_TTL_SECONDS = 90;

const DEFAULT_RETENTION_HOURS = 48;
const MIN_RETENTION_HOURS = 12;
const MAX_RETENTION_HOURS = 30 * 24;

function getRetentionHours(): number {
  const raw = process.env.WATCHDOG_AUDIT_RETENTION_HOURS;
  if (!raw) return DEFAULT_RETENTION_HOURS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_HOURS;
  return Math.min(MAX_RETENTION_HOURS, Math.max(MIN_RETENTION_HOURS, parsed));
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("watchdog-prune: lock held, skipping", { route: `cron/${CRON_NAME}` });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();
  const retentionHours = getRetentionHours();
  const cutoff = new Date(Date.now() - retentionHours * 3600 * 1000).toISOString();

  try {
    const supabase = getSupabase();

    // count exact: returns deleted row count from the response. We use
    // it for telemetry only — the prune is best-effort and we don't
    // alarm on anomalous counts here (separate observability).
    const { error, count } = await supabase
      .from("instaclaw_watchdog_audit")
      .delete({ count: "exact" })
      .lt("created_at", cutoff);

    if (error) {
      logger.error("watchdog-prune: delete failed", {
        route: `cron/${CRON_NAME}`,
        error: error.message,
        cutoff,
        retentionHours,
      });
      return NextResponse.json(
        { error: "delete_failed", detail: error.message },
        { status: 500 },
      );
    }

    const elapsedMs = Date.now() - startedAt;
    logger.info("watchdog-prune: complete", {
      route: `cron/${CRON_NAME}`,
      deletedRows: count ?? 0,
      retentionHours,
      cutoff,
      elapsedMs,
    });

    return NextResponse.json({
      ok: true,
      deletedRows: count ?? 0,
      retentionHours,
      cutoff,
      elapsedMs,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
