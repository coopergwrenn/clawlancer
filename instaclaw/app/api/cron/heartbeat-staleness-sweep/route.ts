/**
 * GET /api/cron/heartbeat-staleness-sweep
 *
 * Backstop monitor for Bug A (stuck heartbeat_next_at → user msgs routed to
 * MiniMax). Runs every 30 min, finds VMs where `heartbeat_next_at` has drifted
 * more than 1 hour into the past, auto-fixes them, and alerts with escalating
 * severity.
 *
 * Background
 * ----------
 * The 2026-05-11 fleet-wide silent-downgrade incident was caused by a self-
 * reinforcing loop in app/api/gateway/proxy/route.ts: heartbeat_next_at only
 * advanced AFTER a successful upstream call. Any heartbeat failure (MiniMax
 * 1008, Anthropic outage, 5xx, timeout) left next_at frozen in the past
 * forever. Every subsequent user message then satisfied heartbeatDue=true and
 * routed to MiniMax — until something manually unstuck the VM.
 *
 * The proxy was fixed in commit 6db05d8e to advance heartbeat_next_at BEFORE
 * the upstream call (fire-and-forget). That's the primary defense.
 *
 * This cron is the SECONDARY defense — it catches any VM that slips back into
 * the stuck state from any cause we haven't anticipated yet:
 *   - Supabase write latency / failure during the proxy's fire-and-forget advance
 *   - A future regression that re-introduces the loop
 *   - Manual ops error (someone bulk-editing VMs and accidentally writing the wrong timestamp)
 *
 * Behavior
 * --------
 * 1. Pull all assigned linode VMs where heartbeat_next_at < NOW() - 1 hour.
 * 2. For each: push heartbeat_next_at forward to NOW() + heartbeat_interval
 *    (default 3h, matches vm.heartbeat_interval), reset cycle_calls = 0.
 * 3. Alert based on stuck count:
 *    - 0:    silent (the healthy steady state)
 *    - 1-2:  log only to admin_alert_log (race-condition noise)
 *    - 3-9:  send admin email (P2 — likely a real gap in the proxy fix)
 *    - 10+:  send admin email + critical tag (P1 — incident-class)
 * 4. Dedup: max 1 email per severity bucket per hour via instaclaw_admin_alert_log.
 *
 * Why auto-fix-AND-alert (not just alert): the fix is cheap (one column update),
 * fully reversible if wrong, and keeps the agent reachable for users in the
 * meantime. The alert ensures we still investigate root-cause rather than
 * masking a regression.
 *
 * Skip cases (intentional):
 *   - status != 'assigned' (terminated, provisioning — out of scope)
 *   - health_status in ('hibernating', 'suspended') — sleeping by design, stale next_at is expected
 *   - heartbeat_interval missing / unparseable — fall back to 3h
 *
 * Schedule: every 30 minutes (cron pattern lives in vercel.json — keeping
 * literal-asterisks out of this JSDoc to avoid the early `*\/` terminator).
 * Lock: 10 minutes via instaclaw_cron_locks (well above expected runtime).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
// Single SELECT + per-VM UPDATEs. Even at fleet size 300 with serial updates,
// well under 60s. Set maxDuration generously to absorb a future fleet 10× larger.
export const maxDuration = 120;

const CRON_NAME = "heartbeat-staleness-sweep";
const CRON_LOCK_TTL_SECONDS = 600;
const STALE_THRESHOLD_HOURS = 1;
const DEFAULT_INTERVAL_HOURS = 3;
const ONE_HOUR_MS = 60 * 60 * 1000;

interface StuckVm {
  id: string;
  name: string | null;
  ip_address: string | null;
  tier: string | null;
  health_status: string | null;
  heartbeat_interval: string | null;
  heartbeat_next_at: string;
  age_minutes: number;
}

function parseIntervalHours(intervalStr: string | null): number {
  if (!intervalStr) return DEFAULT_INTERVAL_HOURS;
  const m = intervalStr.match(/^(\d+(?:\.\d+)?)h$/);
  if (!m) return DEFAULT_INTERVAL_HOURS;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_INTERVAL_HOURS;
}

function severityForCount(stuckCount: number): "silent" | "log_only" | "p2" | "p1" {
  if (stuckCount === 0) return "silent";
  if (stuckCount <= 2) return "log_only";
  if (stuckCount <= 9) return "p2";
  return "p1";
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("heartbeat-staleness-sweep: lock held, skipping", { route: `cron/${CRON_NAME}` });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();
  try {
    const supabase = getSupabase();
    const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_HOURS * ONE_HOUR_MS).toISOString();

    // 1. Find stuck VMs. Include healthy + unhealthy; EXCLUDE hibernating/suspended
    // (they're sleeping by design and stale next_at is expected for them).
    const { data: stuckRows, error: queryErr } = await supabase
      .from("instaclaw_vms")
      .select("id,name,ip_address,tier,health_status,heartbeat_interval,heartbeat_next_at")
      .eq("status", "assigned")
      .eq("provider", "linode")
      .in("health_status", ["healthy", "unhealthy", "unknown"])
      .lt("heartbeat_next_at", staleCutoff);

    if (queryErr) {
      logger.error("heartbeat-staleness-sweep: query failed", {
        route: `cron/${CRON_NAME}`,
        error: queryErr.message,
      });
      // The query failing is itself a critical signal (we've lost visibility).
      sendAdminAlertEmail(
        "[InstaClaw] heartbeat-staleness-sweep: query failed",
        `The heartbeat staleness query returned an error and we cannot detect stuck VMs right now.\n\nError: ${queryErr.message}\n\nInvestigate: instaclaw_vms table availability + supabase service health.`,
      ).catch(() => {});
      return NextResponse.json({ error: "query_failed", details: queryErr.message }, { status: 500 });
    }

    const stuck: StuckVm[] = (stuckRows ?? []).map((r: any) => ({
      id: r.id,
      name: r.name,
      ip_address: r.ip_address,
      tier: r.tier,
      health_status: r.health_status,
      heartbeat_interval: r.heartbeat_interval,
      heartbeat_next_at: r.heartbeat_next_at,
      age_minutes: Math.floor((Date.now() - new Date(r.heartbeat_next_at).getTime()) / 60_000),
    }));

    logger.info("heartbeat-staleness-sweep: query complete", {
      route: `cron/${CRON_NAME}`,
      stuck_count: stuck.length,
      threshold_hours: STALE_THRESHOLD_HOURS,
    });

    const severity = severityForCount(stuck.length);

    // 2. Auto-fix: push each stuck VM's heartbeat_next_at forward, reset cycle_calls.
    //    Per-VM update so a single failure doesn't block the rest.
    const fixSuccessful: string[] = [];
    const fixFailed: { name: string; err: string }[] = [];

    for (const v of stuck) {
      const hoursAhead = parseIntervalHours(v.heartbeat_interval);
      const newNextAt = new Date(Date.now() + hoursAhead * ONE_HOUR_MS).toISOString();
      const { error: updateErr } = await supabase
        .from("instaclaw_vms")
        .update({
          heartbeat_next_at: newNextAt,
          heartbeat_cycle_calls: 0,
        })
        .eq("id", v.id);
      if (updateErr) {
        fixFailed.push({ name: v.name ?? v.id, err: updateErr.message });
      } else {
        fixSuccessful.push(v.name ?? v.id);
      }
    }

    const elapsedMs = Date.now() - startedAt;
    logger.info("heartbeat-staleness-sweep: fix complete", {
      route: `cron/${CRON_NAME}`,
      stuck_count: stuck.length,
      fixed: fixSuccessful.length,
      fix_failed: fixFailed.length,
      severity,
      elapsed_ms: elapsedMs,
    });

    // 3. Alert with dedup. Only fire email at p2/p1 and only if not deduped in last hour.
    if (severity === "p2" || severity === "p1") {
      const oneHourAgo = new Date(Date.now() - ONE_HOUR_MS).toISOString();
      const alertKey = `heartbeat_staleness_sweep:${severity}`;
      const { count: dupCount } = await supabase
        .from("instaclaw_admin_alert_log")
        .select("id", { count: "exact", head: true })
        .eq("alert_key", alertKey)
        .gte("sent_at", oneHourAgo);
      const isFirstFireThisHour = (dupCount ?? 0) === 0;

      const top10ByAge = [...stuck].sort((a, b) => b.age_minutes - a.age_minutes).slice(0, 10);
      const tier1Affected = stuck.filter((v) => v.tier === "power" || v.tier === "pro").length;

      if (isFirstFireThisHour) {
        const subject = severity === "p1"
          ? `[InstaClaw P1] Heartbeat staleness sweep — ${stuck.length} stuck VMs (incident-class)`
          : `[InstaClaw P2] Heartbeat staleness sweep — ${stuck.length} stuck VMs`;
        const body = [
          `${stuck.length} VMs had heartbeat_next_at > ${STALE_THRESHOLD_HOURS}h in the past.`,
          `Auto-fixed: ${fixSuccessful.length}.  Fix failed: ${fixFailed.length}.`,
          `Paying tier (power/pro) affected: ${tier1Affected}`,
          ``,
          `This means the proxy's Bug A fix (commit 6db05d8e) did NOT advance heartbeat_next_at on those VMs.`,
          `Possible causes:`,
          `  - Supabase write transient failure during the proxy's fire-and-forget UPDATE`,
          `  - A regression that re-introduced the stuck-loop pattern`,
          `  - VMs that lost connectivity for >1h and are now catching up`,
          ``,
          `Top 10 by age (most stuck first):`,
          ...top10ByAge.map((v) => `  ${v.name ?? v.id.slice(0, 8)}  age=${v.age_minutes}min  tier=${v.tier ?? "?"}  health=${v.health_status ?? "?"}  next_at=${v.heartbeat_next_at}`),
          ``,
          fixFailed.length > 0 ? `Fix failures:\n${fixFailed.map((f) => `  ${f.name}: ${f.err}`).join("\n")}` : "",
          ``,
          `Investigate:`,
          `  1. Tail Vercel logs for /api/gateway/proxy for "heartbeat_next_at" write errors`,
          `  2. SSH the worst-stuck VM and check journal for any recent gateway errors`,
          `  3. If pattern is fleet-wide (>20 stuck): the proxy's Bug A fix may be broken — check recent deploys`,
          ``,
          `Self-heal: this cron auto-pushed next_at forward; affected users are unblocked for next 3h.`,
          `If the same VMs reappear in the next 30min sweep, root cause is unresolved.`,
        ].filter(Boolean).join("\n");
        await sendAdminAlertEmail(subject, body).catch((e) => {
          logger.error("heartbeat-staleness-sweep: email send failed", { error: String(e) });
        });
      } else {
        logger.info("heartbeat-staleness-sweep: alert deduped (already fired this hour)", {
          route: `cron/${CRON_NAME}`,
          severity,
          dup_count: dupCount,
        });
      }

      // Always log the fire to admin_alert_log so the dedup count is accurate
      await supabase.from("instaclaw_admin_alert_log").insert({
        alert_key: alertKey,
        vm_count: stuck.length,
        details: isFirstFireThisHour
          ? `sent: ${severity} (stuck=${stuck.length}, fixed=${fixSuccessful.length}, paying_affected=${tier1Affected})`
          : `suppressed (dedup): ${severity} (stuck=${stuck.length})`,
      });
    } else if (severity === "log_only" && stuck.length > 0) {
      // 1-2 stuck — log only, no email. Race-condition noise is expected.
      const alertKey = `heartbeat_staleness_sweep:log_only`;
      await supabase.from("instaclaw_admin_alert_log").insert({
        alert_key: alertKey,
        vm_count: stuck.length,
        details: `low-severity (stuck=${stuck.length}, fixed=${fixSuccessful.length}): ${stuck.map((v) => v.name ?? v.id.slice(0, 8)).join(", ")}`,
      });
    }

    return NextResponse.json({
      ok: true,
      stuck_count: stuck.length,
      fixed: fixSuccessful.length,
      fix_failed: fixFailed.length,
      severity,
      elapsed_ms: elapsedMs,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
