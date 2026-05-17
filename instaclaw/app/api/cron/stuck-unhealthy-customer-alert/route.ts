/**
 * Stuck-unhealthy customer-impact alerter (P1 — added 2026-05-17 post vm-911 incident).
 *
 * Pages on paying-customer VMs that have been in `health_status` ∈
 * (unhealthy, unknown) for >1h. This closes the detection gap exposed by
 * the 2026-05-12 → 2026-05-16 vm-911 silent outage where afshinieyesi@gmail.com
 * was effectively down for 4 days, 2 hours with zero admin alerts.
 *
 * Why the existing health-check cron didn't catch it:
 *   - `ALERT_THRESHOLD = 3`: fires admin email at fail_count = 3 (~6 min)
 *     and again every 3 failures via `fail_count % 3 === 0` periodic block.
 *   - `SUSTAINED_UNHEALTHY_THRESHOLD = 6`: fires ONCE at exact `=== 6`.
 *   - `AUTO_RECOVERY_THRESHOLD = 10`: tries `systemctl restart`; capped at
 *     1 attempt per VM per 24h.
 *
 * The vm-911 failure mode (0-byte openclaw.json from a likely past ENOSPC
 * event) cannot be fixed by `systemctl restart` — the gateway crashes on
 * config-parse before it ever reaches a runnable state. So:
 *   1. Auto-recovery fired once at fail_count=10, restart failed (config
 *      parse error), recovery was logged as "attempted" in the alert_log,
 *      dedup key locked further attempts for 24h.
 *   2. The periodic-multiple-of-3 alert path may have kept firing but
 *      either (a) was suppressed by AlertCollector batching, (b) was
 *      delivered to a noisy channel and missed, or (c) the alert was
 *      indistinguishable from transient noise.
 *   3. The reconcile-fleet cron explicitly excludes
 *      `health_status='healthy'` (route.ts:264, added 2026-05-09 to fix
 *      head-of-line blocking by stale suspended VMs). So the reconciler
 *      never visited vm-911 across the 4-day window, leaving it stuck at
 *      cv=91 while the fleet advanced to cv=101.
 *
 * This cron is the SAFETY NET that should have caught the gap. It runs
 * every 30 min, queries paying VMs stuck in unhealthy/unknown state for
 * >1h, dedups via `instaclaw_admin_alert_log` with a 6-hour bucket key
 * (so the same VM re-alerts every 6h while stuck — NOT the once-per-
 * incident pattern that lost vm-911), and pages an admin email with
 * paste-ready diagnostic commands.
 *
 * Failure modes this should catch:
 *   - Corrupt `openclaw.json` (vm-911 — 0-byte from ENOSPC)
 *   - Gateway in repeated start-fail loops where `systemctl restart` is
 *     useless because the underlying config / dependency is broken
 *   - SSH-reachable but unresponsive gateways (process hung mid-init)
 *   - Any case where `health_status` is sticky at unhealthy and the
 *     existing health-check cron's recovery path failed silently
 *
 * Out of scope (not yet covered):
 *   - Auto-recovery for config-corruption (separate work — would detect
 *     0-byte openclaw.json on the VM and restore from `.clobbered`).
 *   - Re-including unhealthy VMs in reconcile-fleet (the route.ts:264
 *     filter was added specifically to fix throughput collapse; lifting
 *     it requires a different safeguard).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Minimum hours unhealthy before paging. */
const STUCK_HOURS_WARN = 1;
/** Hours unhealthy before subject is elevated to P1-shape. */
const STUCK_HOURS_CRITICAL = 24;
/**
 * Bucket size for dedup keys. While a VM stays stuck, it re-alerts every
 * DEDUP_WINDOW_HOURS instead of once-per-incident. 6h is the right trade-off:
 * frequent enough to surface 4-day-class outages (would have alerted ~16
 * times for vm-911 instead of ~once) without being so noisy that operators
 * tune it out.
 */
const DEDUP_WINDOW_HOURS = 6;

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Vercel cron auth (same pattern as every other cron route).
  if (
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const now = new Date();
  const stuckCutoff = new Date(
    now.getTime() - STUCK_HOURS_WARN * 3600_000,
  ).toISOString();

  // Candidates: paying-customer VMs that are unhealthy/unknown for >1h.
  const { data: candidates, error } = await supabase
    .from("instaclaw_vms")
    .select(
      "id, name, ip_address, health_status, last_health_check, assigned_to, partner, config_version, health_fail_count, reconcile_consecutive_failures",
    )
    .eq("status", "assigned")
    .eq("provider", "linode")
    .in("health_status", ["unhealthy", "unknown"])
    .lt("last_health_check", stuckCutoff)
    .not("assigned_to", "is", null)
    .order("last_health_check", { ascending: true });

  if (error) {
    logger.error("stuck-unhealthy-customer-alert: query failed", {
      route: "cron/stuck-unhealthy-customer-alert",
      error: error.message,
    });
    return NextResponse.json(
      { error: error.message },
      { status: 500 },
    );
  }

  if (!candidates || candidates.length === 0) {
    logger.info("stuck-unhealthy-customer-alert: fleet clean", {
      route: "cron/stuck-unhealthy-customer-alert",
    });
    return NextResponse.json({ stuck: 0, alerted: 0, suppressed: 0, critical: 0 });
  }

  // Fetch user emails in one query for context.
  const userIds = [
    ...new Set(candidates.map((c) => c.assigned_to).filter(Boolean) as string[]),
  ];
  const userMap = new Map<string, { id: string; email: string; name?: string | null }>();
  if (userIds.length > 0) {
    const { data: users } = await supabase
      .from("instaclaw_users")
      .select("id, email, name")
      .in("id", userIds);
    for (const u of users ?? []) userMap.set(u.id, u);
  }

  let alerted = 0;
  let suppressed = 0;
  let critical = 0;
  const alertedNames: string[] = [];

  for (const vm of candidates) {
    const user = userMap.get(vm.assigned_to);
    const hoursStuck = vm.last_health_check
      ? (now.getTime() - new Date(vm.last_health_check).getTime()) / 3600_000
      : -1;
    const isCritical = hoursStuck >= STUCK_HOURS_CRITICAL;
    if (isCritical) critical++;

    // Dedup: rotating 6-hour bucket. Same VM in two consecutive crons within
    // the same bucket → suppress. New bucket → re-alert. Across a 4-day
    // outage, this produces ~16 alerts (one every 6h), making it impossible
    // for any single email to be the only signal.
    const bucket = Math.floor(now.getTime() / (DEDUP_WINDOW_HOURS * 3600_000));
    const alertKey = `stuck_unhealthy:${vm.id}:${bucket}`;

    const { data: existing } = await supabase
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", alertKey)
      .limit(1);
    if (existing && existing.length > 0) {
      suppressed++;
      continue;
    }

    const tag = isCritical ? "🔴 P1" : "⚠";
    const subject = `${tag} VM stuck ${hoursStuck.toFixed(1)}h unhealthy: ${vm.name}`;

    const details = [
      `VM:                ${vm.name} (${vm.ip_address ?? "no ip"})`,
      `Customer:          ${user?.email ?? "(unknown)"}${user?.name ? ` — ${user.name}` : ""}`,
      `health_status:     ${vm.health_status}`,
      `last_health_check: ${vm.last_health_check} (${hoursStuck.toFixed(1)}h ago)`,
      `health_fail_count: ${vm.health_fail_count ?? 0}`,
      `config_version:    ${vm.config_version} (current manifest is the gospel)`,
      `reconcile_consecutive_failures: ${vm.reconcile_consecutive_failures ?? 0}`,
      `partner:           ${vm.partner ?? "(none)"}`,
      ``,
      `## Likely causes`,
      `1. Corrupt ~/.openclaw/openclaw.json (vm-911 pattern — 0 bytes from past ENOSPC)`,
      `2. Gateway repeated start-fail (systemctl restart cannot fix)`,
      `3. Process hung mid-init (SSH reachable, no /health response)`,
      `4. reconcile-fleet skipped this VM (health_status='healthy' filter at`,
      `   reconcile-fleet/route.ts:264 excludes unhealthy VMs)`,
      ``,
      `## Manual diagnostic commands (paste-ready)`,
      `ssh -i /tmp/instaclaw-ssh-key openclaw@${vm.ip_address ?? "<no-ip>"} 'systemctl --user status openclaw-gateway --no-pager -l | head -30'`,
      `ssh -i /tmp/instaclaw-ssh-key openclaw@${vm.ip_address ?? "<no-ip>"} 'ls -la ~/.openclaw/openclaw.json* | head -10'`,
      `ssh -i /tmp/instaclaw-ssh-key openclaw@${vm.ip_address ?? "<no-ip>"} 'journalctl --user -u openclaw-gateway -n 50 --no-pager | tail -30'`,
      ``,
      `## If openclaw.json is 0 bytes (vm-911 fix recipe)`,
      `# 1. Find the latest non-zero .clobbered backup`,
      `ls -la ~/.openclaw/openclaw.json.clobbered.* | sort -k5 -n | tail -1`,
      `# 2. Validate it parses`,
      `python3 -c "import json; json.load(open('~/.openclaw/openclaw.json.clobbered.<TS>'))"`,
      `# 3. Restore`,
      `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.zero-byte-bak.\\$(date -u +%Y%m%dT%H%M%SZ)`,
      `cp ~/.openclaw/openclaw.json.clobbered.<TS> ~/.openclaw/openclaw.json`,
      `# 4. Reset start-limit (crash loop hits StartLimitBurst=10) and restart`,
      `systemctl --user reset-failed openclaw-gateway`,
      `systemctl --user restart openclaw-gateway`,
      ``,
      `## Re-alert cadence`,
      `This subject re-fires every ${DEDUP_WINDOW_HOURS}h while the VM stays stuck (dedup bucket key: ${alertKey}).`,
    ].join("\n");

    try {
      await sendAdminAlertEmail(subject, details);
      await supabase.from("instaclaw_admin_alert_log").insert({
        alert_key: alertKey,
        sent_at: now.toISOString(),
      });
      alerted++;
      alertedNames.push(vm.name ?? vm.id);
      logger.info("stuck-unhealthy-customer-alert: sent", {
        route: "cron/stuck-unhealthy-customer-alert",
        vmId: vm.id,
        vmName: vm.name,
        userEmail: user?.email,
        hoursStuck: Number(hoursStuck.toFixed(2)),
        critical: isCritical,
        alertKey,
      });
    } catch (e) {
      logger.error("stuck-unhealthy-customer-alert: send failed", {
        route: "cron/stuck-unhealthy-customer-alert",
        vmId: vm.id,
        error: String(e),
      });
    }
  }

  logger.info("stuck-unhealthy-customer-alert: complete", {
    route: "cron/stuck-unhealthy-customer-alert",
    stuck: candidates.length,
    alerted,
    suppressed,
    critical,
    alertedNames,
  });

  return NextResponse.json({
    stuck: candidates.length,
    alerted,
    suppressed,
    critical,
    alertedNames,
  });
}
