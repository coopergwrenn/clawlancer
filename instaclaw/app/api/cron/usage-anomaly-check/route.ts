/**
 * GET /api/cron/usage-anomaly-check
 *
 * Hourly monitor that compares last-hour usage_log distribution to a
 * same-hour-last-week baseline and fires admin alerts on anomalies. The
 * three signals it watches:
 *
 *   1. CRITICAL — user→minimax: rows where call_type='user' AND model
 *      contains 'minimax'. Post-Bug-B-fix (commit 6db05d8e), this should
 *      be exactly 0 forever. Any non-zero count means the proxy's
 *      isManualMessage short-circuit isn't firing somewhere — silent
 *      regression of the 7,653-msg-over-7-days silent-downgrade bug.
 *
 *   2. WARNING — volume drop: total rows in last hour < 30% of the same
 *      hour 7 days ago. The 2026-05-11 MiniMax-1008 cascade dropped
 *      fleet-wide usage_log volume to near-zero within 5 min. Catching
 *      this gives us a 15-60 min lead on the next cascade vs waiting for
 *      a paying user to report a dead bot.
 *
 *   3. WARNING — cost spike: total cost_weight in last hour > 2× baseline.
 *      Cost-spike could mean (a) Bug-B-fix is over-shooting (legitimate
 *      heartbeats routing to Sonnet at 20× MiniMax cost), (b) genuine
 *      organic traffic growth (positive signal but worth knowing), or
 *      (c) a runaway agent (cron loop, fork bomb of API calls).
 *
 * Why same-hour-7-days-ago and not same-hour-yesterday:
 *   - usage_log retention is 14 days, plenty of headroom.
 *   - Weekly seasonality (weekday vs weekend) dominates hourly seasonality
 *     for this fleet (paying users mostly chat M-F evenings).
 *   - 7-day baseline naturally handles weekend dips.
 *
 * Dedup: max 1 email per condition per hour via instaclaw_admin_alert_log
 * (key = "usage_anomaly_check:<condition>").
 *
 * Schedule: hourly at minute 7 (lets usage_log writes from the top-of-hour
 * settle before we aggregate — cleaner numbers than running at minute 0).
 * Lock: 10 minutes (well above expected runtime of ~5s).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
// Two SELECTs against an indexed table (vm_id, created_at DESC). Generous
// timeout to absorb growth.
export const maxDuration = 60;

const CRON_NAME = "usage-anomaly-check";
const CRON_LOCK_TTL_SECONDS = 600;
const ONE_HOUR_MS = 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * ONE_HOUR_MS;

// Thresholds (tunable)
const VOLUME_DROP_PCT = 0.30;   // alert if last-hour < 30% of baseline
const COST_SPIKE_X = 2.0;       // alert if last-hour cost > 2× baseline
const MIN_BASELINE_ROWS = 50;   // skip volume/cost alerts if baseline window had too few rows (noisy)
const USER_TO_MINIMAX_ALERT_THRESHOLD = 1; // any non-zero count is interesting

interface Stats {
  totalRows: number;
  totalCostWeight: number;
  userToMinimax: number;
  byModelClass: Record<string, number>;
  byCallType: Record<string, number>;
}

function modelClass(model: string | null): string {
  if (!model) return "other";
  const m = model.toLowerCase();
  if (m.includes("minimax")) return "minimax";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  return "other";
}

async function fetchStats(supabase: ReturnType<typeof getSupabase>, startIso: string, endIso: string): Promise<Stats> {
  const stats: Stats = {
    totalRows: 0,
    totalCostWeight: 0,
    userToMinimax: 0,
    byModelClass: {},
    byCallType: {},
  };
  // Paginate — usage_log can have tens of thousands of rows per hour at scale.
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    const { data, error } = await supabase
      .from("instaclaw_usage_log")
      .select("model,call_type,cost_weight")
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ model: string | null; call_type: string | null; cost_weight: string | number | null }>) {
      stats.totalRows += 1;
      stats.totalCostWeight += Number(r.cost_weight ?? 0);
      const cls = modelClass(r.model);
      stats.byModelClass[cls] = (stats.byModelClass[cls] ?? 0) + 1;
      stats.byCallType[r.call_type ?? "?"] = (stats.byCallType[r.call_type ?? "?"] ?? 0) + 1;
      if (r.call_type === "user" && cls === "minimax") {
        stats.userToMinimax += 1;
      }
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return stats;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("usage-anomaly-check: lock held, skipping", { route: `cron/${CRON_NAME}` });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();
  try {
    const supabase = getSupabase();
    const now = Date.now();

    // Last-hour window (current hour, capped at "now" — partial-hour OK since we
    // also compare to a partial-hour-7-days-ago window for fairness).
    const lastHourStart = new Date(now - ONE_HOUR_MS).toISOString();
    const lastHourEnd = new Date(now).toISOString();
    // Baseline: same window 7 days ago.
    const baselineStart = new Date(now - ONE_HOUR_MS - SEVEN_DAYS_MS).toISOString();
    const baselineEnd = new Date(now - SEVEN_DAYS_MS).toISOString();

    const [lastHour, baseline] = await Promise.all([
      fetchStats(supabase, lastHourStart, lastHourEnd),
      fetchStats(supabase, baselineStart, baselineEnd),
    ]);

    const elapsedMs = Date.now() - startedAt;

    logger.info("usage-anomaly-check: stats", {
      route: `cron/${CRON_NAME}`,
      window: { last_hour_start: lastHourStart, baseline_start: baselineStart },
      last_hour_rows: lastHour.totalRows,
      last_hour_cost: lastHour.totalCostWeight,
      last_hour_user_to_minimax: lastHour.userToMinimax,
      baseline_rows: baseline.totalRows,
      baseline_cost: baseline.totalCostWeight,
      elapsed_ms: elapsedMs,
    });

    const alerts: Array<{ severity: "critical" | "warning"; condition: string; subject: string; body: string }> = [];

    // ─── Signal 1: user→minimax (CRITICAL) ───
    if (lastHour.userToMinimax >= USER_TO_MINIMAX_ALERT_THRESHOLD) {
      alerts.push({
        severity: "critical",
        condition: "user_to_minimax",
        subject: `[InstaClaw CRITICAL] ${lastHour.userToMinimax} user msgs routed to MiniMax in last hour`,
        body: [
          `${lastHour.userToMinimax} rows in instaclaw_usage_log had call_type='user' AND model contains 'minimax' in the last hour.`,
          ``,
          `Post-fix expected: ZERO. Any non-zero count means the Bug B fix (proxy isManualMessage short-circuit) is not firing somewhere.`,
          ``,
          `Baseline (same hour 7 days ago): ${baseline.userToMinimax} (was high pre-fix — should be the historical baseline now).`,
          ``,
          `Investigate:`,
          `  - Did a deploy revert app/api/gateway/proxy/route.ts (commit 6db05d8e)?`,
          `  - Is there a code path that bypasses the isManualMessage check (e.g., a new bypass header)?`,
          `  - Which VMs are affected? SELECT vm_id, count(*) FROM instaclaw_usage_log`,
          `    WHERE created_at > NOW() - INTERVAL '1 hour' AND call_type='user' AND model ILIKE '%minimax%'`,
          `    GROUP BY vm_id ORDER BY count DESC LIMIT 10;`,
          ``,
          `Last-hour distribution by model_class: ${JSON.stringify(lastHour.byModelClass)}`,
          `Last-hour distribution by call_type: ${JSON.stringify(lastHour.byCallType)}`,
        ].join("\n"),
      });
    }

    // ─── Signal 2: volume drop (WARNING) ───
    // Skip if baseline is too small (low-traffic period, noisy ratio)
    if (baseline.totalRows >= MIN_BASELINE_ROWS) {
      const volumeRatio = lastHour.totalRows / baseline.totalRows;
      if (volumeRatio < VOLUME_DROP_PCT) {
        alerts.push({
          severity: "warning",
          condition: "volume_drop",
          subject: `[InstaClaw WARN] usage_log volume dropped to ${(volumeRatio * 100).toFixed(0)}% of last-week baseline`,
          body: [
            `Last hour: ${lastHour.totalRows} rows (cost-weight ${lastHour.totalCostWeight.toFixed(0)})`,
            `Same hour 7 days ago: ${baseline.totalRows} rows (cost-weight ${baseline.totalCostWeight.toFixed(0)})`,
            `Ratio: ${(volumeRatio * 100).toFixed(1)}% (alert threshold: <${(VOLUME_DROP_PCT * 100).toFixed(0)}%)`,
            ``,
            `Possible causes:`,
            `  - Upstream cascade (MiniMax or Anthropic returning errors at high rate — those calls don't reach usage_log)`,
            `  - Fleet-wide gateway issue (mass restart, deploy regression)`,
            `  - VM provisioning halted (no new VM activity)`,
            `  - Genuine low-traffic period (holiday, conference, weekend dip)`,
            ``,
            `Distribution comparison:`,
            `  Last hour    model_class: ${JSON.stringify(lastHour.byModelClass)}`,
            `  Last hour    call_type:   ${JSON.stringify(lastHour.byCallType)}`,
            `  Baseline     model_class: ${JSON.stringify(baseline.byModelClass)}`,
            `  Baseline     call_type:   ${JSON.stringify(baseline.byCallType)}`,
            ``,
            `Investigate first:`,
            `  1. Check Vercel logs for /api/gateway/proxy 5xx rate in the last hour`,
            `  2. Check admin_alert_log for any unrelated alerts in the same window`,
            `  3. SSH a sample of healthy VMs and check journal for gateway errors`,
          ].join("\n"),
        });
      }
    }

    // ─── Signal 3: cost spike (WARNING) ───
    if (baseline.totalCostWeight >= 10) {
      const costRatio = lastHour.totalCostWeight / baseline.totalCostWeight;
      if (costRatio > COST_SPIKE_X) {
        alerts.push({
          severity: "warning",
          condition: "cost_spike",
          subject: `[InstaClaw WARN] usage cost ${costRatio.toFixed(1)}× last-week baseline`,
          body: [
            `Last hour cost-weight: ${lastHour.totalCostWeight.toFixed(0)} (${lastHour.totalRows} rows)`,
            `Baseline cost-weight:  ${baseline.totalCostWeight.toFixed(0)} (${baseline.totalRows} rows)`,
            `Ratio: ${costRatio.toFixed(2)}× (alert threshold: >${COST_SPIKE_X}×)`,
            ``,
            `Possible causes (in order of likelihood):`,
            `  - Genuine traffic growth — check daily-active-VMs metric (positive signal)`,
            `  - Bug-B fix over-shoot — heartbeats misclassified as user msgs, routed to Sonnet/Opus at 4-19× MiniMax cost`,
            `  - Runaway agent — a single VM stuck in a tool-call loop`,
            `  - A new feature with heavy LLM usage (e.g., gbrain expansion if rolled out fleet-wide)`,
            ``,
            `Per-VM concentration check (run this SQL):`,
            `  SELECT vm_id, sum(cost_weight) AS cost FROM instaclaw_usage_log`,
            `  WHERE created_at > NOW() - INTERVAL '1 hour'`,
            `  GROUP BY vm_id ORDER BY cost DESC LIMIT 10;`,
            ``,
            `If the top 3 VMs account for >50% of the spike → likely a runaway agent.`,
            `If the spike is fleet-wide and even → likely Bug-B-fix over-shoot or organic growth.`,
            ``,
            `Distribution by call_type:`,
            `  Last hour: ${JSON.stringify(lastHour.byCallType)}`,
            `  Baseline:  ${JSON.stringify(baseline.byCallType)}`,
          ].join("\n"),
        });
      }
    }

    // ─── Dispatch alerts (with per-condition dedup) ───
    const oneHourAgo = new Date(now - ONE_HOUR_MS).toISOString();
    for (const a of alerts) {
      const alertKey = `${CRON_NAME}:${a.condition}`;
      const { count: dupCount } = await supabase
        .from("instaclaw_admin_alert_log")
        .select("id", { count: "exact", head: true })
        .eq("alert_key", alertKey)
        .gte("sent_at", oneHourAgo);
      const isFirstFireThisHour = (dupCount ?? 0) === 0;
      if (isFirstFireThisHour) {
        await sendAdminAlertEmail(a.subject, a.body).catch((e) => {
          logger.error("usage-anomaly-check: email send failed", { error: String(e), condition: a.condition });
        });
      }
      await supabase.from("instaclaw_admin_alert_log").insert({
        alert_key: alertKey,
        vm_count: 0,
        details: isFirstFireThisHour ? `sent: ${a.subject.slice(0, 100)}` : `suppressed (dedup)`,
      });
      logger.info("usage-anomaly-check: alert", {
        route: `cron/${CRON_NAME}`,
        condition: a.condition,
        severity: a.severity,
        dispatched: isFirstFireThisHour,
      });
    }

    return NextResponse.json({
      ok: true,
      last_hour: lastHour,
      baseline: baseline,
      alerts_fired: alerts.length,
      elapsed_ms: elapsedMs,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("usage-anomaly-check: unhandled error", { route: `cron/${CRON_NAME}`, error: msg });
    return NextResponse.json({ error: "unhandled", details: msg }, { status: 500 });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
