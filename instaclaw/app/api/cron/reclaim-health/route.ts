/**
 * GET /api/cron/reclaim-health
 *
 * Defense-in-depth monitor for Pass 6 (the abandoned-after-OAuth
 * reclaimer in /api/cron/process-pending). Runs every 5 min.
 *
 * Normal operation: 0 stuck VMs, 0 alerts. This is the canary that
 * fires when Pass 6 itself is broken — DB unavailable, route erroring,
 * Vercel cron not firing, etc.
 *
 * Predicate for "stuck":
 *   channel IS NOT NULL          — channel-onboarding only (BYOB handled
 *                                  by Pass 4 of process-pending)
 *   consumed_at IS NULL          — Pass 6 should have set this by now
 *   created_at < NOW - 15 min    — Pass 6 fires at 10 min; 15 min is
 *                                  the operational SLA
 *   AND the user still has a VM with status='assigned'
 *
 * The second-step VM check matters because:
 *   - Pass 6 also handles "no VM" cases (consumed without wipe) — those
 *     don't represent stuck COST (no Linode instance to bill), so we
 *     don't alert on them.
 *   - A pending row with no VM at >15min is a different category of
 *     drift; logged but not alerted (rare; Pass 6 cleans up next tick).
 *
 * Alert dedup: 6 hours via instaclaw_admin_alert_log, keyed by
 * "reclaim-health-stuck". A persistent issue (Vercel cron stopped)
 * gets ONE alert per 6h period — operators have time to fix without
 * inbox spam.
 *
 * Cost exposure if this cron fires:
 *   Stuck VM bills at $29/mo = $0.04/hr. Caught at 15min worst-case.
 *   So 15min × $0.04/hr = $0.01 per stuck VM at first detection.
 *   Even 100 stuck VMs (catastrophic Pass-6 failure) = $1 in caught
 *   time. The cost of the LATE alert (hours/days before someone
 *   notices) is what this cron prevents.
 *
 * See spec §6.5.10 "The reclaim path — abandonment recovery without
 * silent cost leak" for the full design context.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_NAME = "reclaim-health";
const CRON_LOCK_TTL_SECONDS = 90;
const STUCK_THRESHOLD_MINUTES = 15;
const ALERT_DEDUP_HOURS = 6;
const ALERT_DEDUP_KEY = "reclaim-health-stuck";

interface StuckCandidate {
  pendingId: string;
  channel: string;
  userId: string;
  ageMinutes: number;
  vmId: string;
  vmName: string;
}

export async function GET(req: NextRequest) {
  // CRON_SECRET bearer auth — standard for /api/cron/*.
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Concurrency lock — every 5 min, ~5s wall time per run. Lock TTL of 90s
  // gives huge headroom against overlap.
  const acquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS, "vercel-cron");
  if (!acquired) {
    return NextResponse.json({ skipped: "lock-busy" });
  }

  try {
    const supabase = getSupabase();
    const stuckThresholdIso = new Date(
      Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000,
    ).toISOString();

    // ─── Step 1: find candidates ──
    // Pending rows from channel-onboarding that should have been
    // reclaimed by Pass 6 (>15 min old, still unconsumed).
    const { data: candidates, error: candErr } = await supabase
      .from("instaclaw_pending_users")
      .select("id, channel, user_id, created_at")
      .not("channel", "is", null)
      .is("consumed_at", null)
      .lt("created_at", stuckThresholdIso);

    if (candErr) {
      logger.error("[reclaim-health] candidate query failed", {
        route: "cron/reclaim-health",
        error: candErr.message,
      });
      return NextResponse.json(
        { error: "DB query failed", message: candErr.message },
        { status: 500 },
      );
    }

    if (!candidates || candidates.length === 0) {
      return NextResponse.json({ ok: true, stuckCount: 0 });
    }

    // ─── Step 2: cross-check VM existence ──
    // A pending row with no VM (user OAuth'd but assignment failed,
    // or user never OAuth'd) doesn't represent a stuck Linode cost.
    // Pass 6 cleans those up too, but they're not P1.
    const stuck: StuckCandidate[] = [];
    const candidatesWithoutVm: string[] = [];

    for (const row of candidates) {
      if (!row.user_id) {
        candidatesWithoutVm.push(row.id);
        continue;
      }

      const { data: vm, error: vmErr } = await supabase
        .from("instaclaw_vms")
        .select("id, name")
        .eq("assigned_to", row.user_id)
        .eq("status", "assigned")
        .maybeSingle();

      if (vmErr) {
        logger.warn("[reclaim-health] VM lookup failed for candidate", {
          route: "cron/reclaim-health",
          pendingId: row.id,
          userId: row.user_id,
          error: vmErr.message,
        });
        // Conservative: if we can't confirm VM existence, don't include
        // in the stuck-and-billing list. Next cron tick will re-check.
        continue;
      }

      if (!vm) {
        candidatesWithoutVm.push(row.id);
        continue;
      }

      const ageMinutes = Math.floor(
        (Date.now() - new Date(row.created_at).getTime()) / 1000 / 60,
      );

      stuck.push({
        pendingId: row.id,
        channel: row.channel,
        userId: row.user_id,
        ageMinutes,
        vmId: vm.id,
        vmName: vm.name,
      });
    }

    // ─── Step 3: alert if any stuck-and-billing VMs ──
    if (stuck.length === 0) {
      return NextResponse.json({
        ok: true,
        stuckCount: 0,
        candidatesWithoutVm: candidatesWithoutVm.length,
      });
    }

    // Dedup check — 6h window keyed on a stable alert_key.
    const dedupSince = new Date(
      Date.now() - ALERT_DEDUP_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const { data: recentAlert } = await supabase
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", ALERT_DEDUP_KEY)
      .gte("sent_at", dedupSince)
      .limit(1);

    if (recentAlert && recentAlert.length > 0) {
      logger.info("[reclaim-health] stuck VMs detected; alert dedup'd", {
        route: "cron/reclaim-health",
        stuckCount: stuck.length,
        dedupHours: ALERT_DEDUP_HOURS,
      });
      return NextResponse.json({
        ok: true,
        stuckCount: stuck.length,
        alertSent: false,
        reason: "dedup",
      });
    }

    // Compose alert body. Paste-ready debug steps for ops.
    const body = [
      `${stuck.length} VM(s) stuck in "assigned but unconsumed" state for >${STUCK_THRESHOLD_MINUTES}min.`,
      `Pass 6 of /api/cron/process-pending should have reclaimed these.`,
      ``,
      `Stuck VMs:`,
      ...stuck.map(
        (c) =>
          `  - vm=${c.vmName} (id=${c.vmId}) channel=${c.channel} ageMin=${c.ageMinutes} pendingId=${c.pendingId}`,
      ),
      ``,
      `Possible causes (in order of likelihood):`,
      `  1. process-pending Vercel cron not firing (check Vercel cron logs)`,
      `  2. Pass 6 hitting an error before claim (check function logs for "Pass 6: candidate query failed")`,
      `  3. wipeVMForNextUser failing — VMs got quarantined via status='failed' instead (different alert path, this should not produce repeat alerts here)`,
      `  4. Compare-and-swap losing races repeatedly (impossible with current write pattern)`,
      ``,
      `Debug:`,
      `  curl -H "Authorization: Bearer $CRON_SECRET" https://instaclaw.io/api/cron/process-pending`,
      `  Check pass6 counters in response.`,
      ``,
      `Cost exposure: ${stuck.length} × $0.04/hr ≈ $${(stuck.length * 0.04).toFixed(2)}/hr until resolved.`,
    ].join("\n");

    // Record the alert BEFORE sending to prevent races on retry.
    const { error: logErr } = await supabase
      .from("instaclaw_admin_alert_log")
      .insert({
        alert_key: ALERT_DEDUP_KEY,
        vm_count: stuck.length,
        details: body.slice(0, 1000),
      });

    if (logErr) {
      logger.error("[reclaim-health] alert log insert failed", {
        route: "cron/reclaim-health",
        error: logErr.message,
      });
      // Don't bail — better to send the alert without the log row than
      // to swallow a P1 condition silently.
    }

    try {
      await sendAdminAlertEmail("[P1] Reclaim health: stuck VMs detected", body);
      logger.error("[reclaim-health] P1 alert sent", {
        route: "cron/reclaim-health",
        stuckCount: stuck.length,
        candidates: stuck.map((c) => ({
          vmName: c.vmName,
          ageMinutes: c.ageMinutes,
        })),
      });
    } catch (err) {
      logger.error("[reclaim-health] sendAdminAlertEmail threw", {
        route: "cron/reclaim-health",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return NextResponse.json({
      ok: true,
      stuckCount: stuck.length,
      alertSent: true,
      candidatesWithoutVm: candidatesWithoutVm.length,
      candidates: stuck.map((c) => ({
        pendingId: c.pendingId,
        vmName: c.vmName,
        ageMinutes: c.ageMinutes,
      })),
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
