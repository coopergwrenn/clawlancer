/**
 * Reconcile stuck-unhealthy paying-customer VMs (last line of defense — P1).
 *
 * Sibling to `reconcile-fleet` and `stuck-vm-auto-recover`. The recovery
 * pipeline now has three tiers:
 *
 *   Tier 1 — `stuck-unhealthy-customer-alert` (every 30 min, 1h-stuck):
 *     Pages humans. No automation.
 *   Tier 2 — `stuck-vm-auto-recover` (every 15 min, 2h-stuck):
 *     Auto-fixes the narrow 0-byte openclaw.json signature only.
 *   Tier 3 — `reconcile-stuck-vms` (every 30 min, 2h-stuck + B-deferral):
 *     Runs full reconcileVM against VMs the existing reconcile-fleet
 *     filter excludes. Catches failure modes Tier 2 can't fix
 *     (drift since cv-N, missing scripts, wrong systemd unit, partner
 *     skill drift, etc.) and brings the VM back into the healthy pool.
 *
 * Why a separate cron and not extending reconcile-fleet:
 *   The main reconcile-fleet filter at route.ts:264 (`health_status='healthy'`)
 *   was added 2026-05-09 to fix throughput collapse — 45 stale suspended
 *   VMs were head-of-line blocking 149 healthy stale VMs, throughput
 *   crashed from 60 VMs/hr to 0.4. That filter is RIGHT for the main pass.
 *   But it creates a class of VMs the reconciler is forbidden from
 *   helping. vm-911 (98h silent outage, 2026-05-12 → 2026-05-16) was the
 *   inevitable consequence.
 *
 *   This cron is the sibling recovery path the route.ts:264 comment
 *   explicitly called for: "Every such filter needs a documented sibling
 *   recovery path for the excluded subset" (Rule 33 of CLAUDE.md
 *   v911 incident lessons, lesson 3).
 *
 * Scope: NARROW.
 *   - Only paying customers (assigned_to IS NOT NULL).
 *   - Only VMs unhealthy/unknown for ≥2 hours (gives Tier 1 alert + Tier 2
 *     auto-recovery first crack).
 *   - Defers further if Tier 2 (stuck-vm-auto-recover) attempted in the
 *     last 24h, UNLESS the VM has been stuck ≥6h (escalation cutoff:
 *     Tier 2 obviously can't help if it tried and the VM is still down
 *     6h later).
 *   - At most 2 VMs per tick. Sequential. Each capped at 180s.
 *   - Respects operator-set `reconcile_quarantined_at` (skip).
 *   - Independent failure counter via alert_log row count, separate from
 *     main reconcile's `reconcile_consecutive_failures`. Quarantine after
 *     3 failed reconcile attempts in 24h.
 *
 * What it does NOT do:
 *   - Does NOT change the route.ts:264 filter on main reconcile-fleet.
 *   - Does NOT bump `config_version` on success. The DB update is
 *     `health_status='healthy' + health_fail_count=0 + last_health_check=now`.
 *     After this, the main reconcile-fleet's next tick picks the VM up
 *     (now in the healthy pool) and re-runs reconcile with full strict-mode
 *     verification, advancing cv to current. The "second reconcile" is
 *     a deliberate verification layer.
 *   - Does NOT attempt non-paying VMs. Ready/suspended/hibernating
 *     non-paying VMs stay excluded by design.
 *   - Does NOT attempt quarantined VMs (operator-set state).
 *
 * Original incident: vm-911 (afshinieyesi@gmail.com) 98h silent outage,
 * 2026-05-12 → 2026-05-16. See docs/incidents/2026-05-17-vm911-4day-silent-down.md.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { auditVMConfig, type VMRecord } from "@/lib/ssh";

export const runtime = "nodejs";
export const maxDuration = 300;

const CRON_NAME = "reconcile-stuck-vms";
/** Lock TTL: 6 min (covers worst-case 2 × 180s + overhead). */
const LOCK_TTL_SECONDS = 360;

const STUCK_HOURS_THRESHOLD = 2;
const B_ESCALATION_CUTOFF_HOURS = 6;
/**
 * health-check runs every 2 min, so fail_count × 2min ≈ time stuck.
 * Using `last_health_check < cutoff` is BROKEN — that column is bumped on
 * every probe regardless of outcome (vm-748 incident, 2026-05-18).
 */
const FAIL_COUNT_FOR_STUCK = Math.ceil((STUCK_HOURS_THRESHOLD * 60) / 2); // 60
const FAIL_COUNT_FOR_ESCALATION = Math.ceil((B_ESCALATION_CUTOFF_HOURS * 60) / 2); // 180
const MAX_VMS_PER_RUN = 2;
const PER_VM_TIMEOUT_MS = 180_000;
const QUARANTINE_FAILURE_THRESHOLD = 3;
const FAILURE_COUNT_WINDOW_HOURS = 24;

interface VmCandidate {
  id: string;
  name: string | null;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  gateway_url: string | null;
  gateway_token: string | null;
  region: string | null;
  health_status: string | null;
  last_health_check: string | null;
  assigned_to: string | null;
  partner: string | null;
  config_version: number | null;
  health_fail_count: number | null;
  tier: string | null;
  api_mode: string | null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Distributed lock — separate namespace from main reconcile-fleet so we
  // can run concurrently without contention.
  const lockAcquired = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("reconcile-stuck-vms: lock held by another instance, skipping", {
      route: `cron/${CRON_NAME}`,
    });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startMs = Date.now();
  const supabase = getSupabase();
  const now = new Date();
  const failureWindowStart = new Date(
    now.getTime() - FAILURE_COUNT_WINDOW_HOURS * 3600_000,
  ).toISOString();

  try {
    // Candidate pool: paying-customer, unhealthy ≥2h (fail_count ≥ 60),
    // not quarantined, has IP + gateway_url. Overfetch for B-deferral filtering.
    const { data: unhealthyPool, error: queryErr } = await supabase
      .from("instaclaw_vms")
      .select(
        "id, name, ip_address, ssh_port, ssh_user, gateway_url, gateway_token, region, health_status, last_health_check, assigned_to, partner, config_version, health_fail_count, tier, api_mode, updated_at",
      )
      .eq("status", "assigned")
      .eq("provider", "linode")
      .in("health_status", ["unhealthy", "unknown"])
      .gte("health_fail_count", FAIL_COUNT_FOR_STUCK)
      .not("assigned_to", "is", null)
      .not("ip_address", "is", null)
      .not("gateway_url", "is", null)
      .is("reconcile_quarantined_at", null)
      .order("health_fail_count", { ascending: false }) // longest-stuck first
      .limit(MAX_VMS_PER_RUN * 6); // overfetch — many may be B-deferred

    if (queryErr) {
      logger.error("reconcile-stuck-vms: query failed", {
        route: `cron/${CRON_NAME}`,
        error: queryErr.message,
      });
      return NextResponse.json({ error: queryErr.message }, { status: 500 });
    }

    // ── 2026-05-26 incident addendum: configure_failed orphan-state recovery ──
    //
    // Three paying users sat in health_status='configure_failed' for ~2 months.
    // Their gateways were healthy on disk (/health=200, npm openclaw installed,
    // openclaw.json present), but the DB row never got flipped back to healthy.
    // The 3-tier recovery pipeline (this cron + alert + auto-recover) all
    // filtered .in("health_status", ["unhealthy","unknown"]), excluding
    // configure_failed entirely. Plus the fail_count gate doesn't help —
    // health-check explicitly skips configure_failed VMs per Rule 33, so
    // health_fail_count stays at whatever value the configure-failure write
    // left it at and never grows.
    //
    // Fix: separate query for configure_failed VMs with age-based gating via
    // updated_at. Any configure_failed VM whose row hasn't been touched in
    // ≥2h is stuck. We feed them into the same eligibility filter (B-deferral,
    // C-failure-quarantine) and run the same auditVMConfig recovery path —
    // which is exactly the right action: drift-repair only, no wipe (Rule
    // 22/30), gateway restart for the freshly-written config.
    //
    // On success, auditVMConfig completes cleanly → the loop's update block
    // flips health_status='healthy' → main reconcile-fleet picks it up next
    // tick → cv advances to current manifest.
    const stuckHoursThresholdIso = new Date(
      now.getTime() - STUCK_HOURS_THRESHOLD * 3600_000,
    ).toISOString();
    const { data: configureFailedPool, error: cfQueryErr } = await supabase
      .from("instaclaw_vms")
      .select(
        "id, name, ip_address, ssh_port, ssh_user, gateway_url, gateway_token, region, health_status, last_health_check, assigned_to, partner, config_version, health_fail_count, tier, api_mode, updated_at",
      )
      .eq("status", "assigned")
      .eq("provider", "linode")
      .eq("health_status", "configure_failed")
      .lt("updated_at", stuckHoursThresholdIso)
      .not("assigned_to", "is", null)
      .not("ip_address", "is", null)
      .not("gateway_url", "is", null)
      .is("reconcile_quarantined_at", null)
      .order("updated_at", { ascending: true }) // oldest-stuck first
      .limit(MAX_VMS_PER_RUN * 6);

    if (cfQueryErr) {
      logger.warn("reconcile-stuck-vms: configure_failed query failed (non-fatal)", {
        route: `cron/${CRON_NAME}`,
        error: cfQueryErr.message,
      });
    }

    // Merge the two pools. configure_failed VMs sorted to the front
    // (typically the longest-stuck, paying customers with no recovery path).
    const pool = [
      ...(configureFailedPool ?? []),
      ...(unhealthyPool ?? []),
    ].filter((v, i, arr) => arr.findIndex((u) => u.id === v.id) === i);

    if (!pool || pool.length === 0) {
      return NextResponse.json({
        candidates: 0,
        attempted: 0,
        recovered: 0,
        failed: 0,
        quarantined: 0,
        bDeferred: 0,
        cFailureLocked: 0,
      });
    }

    // Filter: B-deferral + C-failure-quarantine check
    const eligible: VmCandidate[] = [];
    let bDeferred = 0;
    let cFailureLocked = 0;

    for (const vm of pool as VmCandidate[]) {
      // Escalated past 6h-stuck (fail_count ≥ 180). The pre-fix version
      // compared last_health_check < (now - 6h), which is structurally never
      // true because health-check refreshes that column every 2 min.
      const escalated = (vm.health_fail_count ?? 0) >= FAIL_COUNT_FOR_ESCALATION;

      // B-deferral check (unless escalated past 6h)
      if (!escalated) {
        const { data: bAttempts } = await supabase
          .from("instaclaw_admin_alert_log")
          .select("id")
          .like("alert_key", `stuck_vm_auto_recover:${vm.id}:%`)
          .gte("sent_at", failureWindowStart)
          .limit(1);
        if (bAttempts && bAttempts.length > 0) {
          bDeferred++;
          continue;
        }
      }

      // C-failure-count check: count failure rows in last 24h
      const { data: cFailures, count: cFailCount } = await supabase
        .from("instaclaw_admin_alert_log")
        .select("id", { count: "exact" })
        .like("alert_key", `stuck_vm_reconcile_failure:${vm.id}:%`)
        .gte("sent_at", failureWindowStart);
      // Use count or array length as fallback
      const failCount = cFailCount ?? (cFailures?.length ?? 0);
      if (failCount >= QUARANTINE_FAILURE_THRESHOLD) {
        cFailureLocked++;
        continue;
      }

      eligible.push(vm);
      if (eligible.length >= MAX_VMS_PER_RUN) break;
    }

    if (eligible.length === 0) {
      return NextResponse.json({
        candidates: pool.length,
        attempted: 0,
        recovered: 0,
        failed: 0,
        quarantined: 0,
        bDeferred,
        cFailureLocked,
      });
    }

    let attempted = 0;
    let recovered = 0;
    let failed = 0;
    let quarantined = 0;
    const perVmLog: Array<Record<string, unknown>> = [];

    // Look up user emails for the eligible set (one query)
    const userIds = eligible.map((v) => v.assigned_to!).filter(Boolean);
    const userMap = new Map<string, { id: string; email: string; name?: string | null }>();
    if (userIds.length > 0) {
      const { data: users } = await supabase
        .from("instaclaw_users")
        .select("id, email, name")
        .in("id", userIds);
      for (const u of users ?? []) userMap.set(u.id, u);
    }

    // Sequential processing — Promise.race per-VM for timeout
    for (const vm of eligible) {
      attempted++;
      const user = userMap.get(vm.assigned_to!);
      const userEmail = user?.email ?? "(unknown)";
      const cvBefore = vm.config_version;
      const vmRecord: VMRecord & { gateway_token?: string; api_mode?: string; tier?: string | null; user_timezone?: string | null } = {
        id: vm.id,
        ip_address: vm.ip_address!,
        ssh_port: vm.ssh_port ?? 22,
        ssh_user: vm.ssh_user ?? "openclaw",
        region: vm.region ?? undefined,
        gateway_token: vm.gateway_token ?? undefined,
        api_mode: vm.api_mode ?? undefined,
        tier: vm.tier,
      };

      type AuditOutcome =
        | { kind: "success"; fixed: string[]; errors: string[]; alreadyCorrect: string[] }
        | { kind: "errors"; errors: string[]; fixed: string[]; alreadyCorrect: string[] }
        | { kind: "timeout" }
        | { kind: "exception"; error: string };

      let outcome: AuditOutcome;
      try {
        const auditResult = await Promise.race([
          auditVMConfig(vmRecord, {
            strict: false, // legacy mode — prioritize recovery over per-key verification
            dryRun: false,
            canary: false, // canary is a strict-mode probe; skip in legacy
            skipGatewayRestart: false, // unhealthy VMs need a restart to recover
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(new Error(`per-VM reconcile timeout after ${PER_VM_TIMEOUT_MS / 1000}s`)),
              PER_VM_TIMEOUT_MS,
            ),
          ),
        ]);
        if (auditResult.errors.length === 0) {
          outcome = {
            kind: "success",
            fixed: auditResult.fixed,
            errors: auditResult.errors,
            alreadyCorrect: auditResult.alreadyCorrect,
          };
        } else {
          outcome = {
            kind: "errors",
            errors: auditResult.errors,
            fixed: auditResult.fixed,
            alreadyCorrect: auditResult.alreadyCorrect,
          };
        }
      } catch (e) {
        const msg = String(e);
        if (msg.includes("per-VM reconcile timeout")) {
          outcome = { kind: "timeout" };
        } else {
          outcome = { kind: "exception", error: msg.slice(0, 500) };
        }
      }

      // Handle outcome
      if (outcome.kind === "success") {
        recovered++;
        // Flip health_status to healthy + reset failure counters.
        // For configure_failed VMs, also reset configure_attempts + lock
        // so /api/vm/status and any retry-configure UI report clean state.
        const wasConfigureFailed = vm.health_status === "configure_failed";
        const { error: updErr } = await supabase
          .from("instaclaw_vms")
          .update({
            health_status: "healthy",
            health_fail_count: 0,
            last_health_check: new Date().toISOString(),
            ...(wasConfigureFailed
              ? { configure_attempts: 0, configure_lock_at: null }
              : {}),
          })
          .eq("id", vm.id);
        if (updErr) {
          logger.error("reconcile-stuck-vms: DB update failed after successful reconcile", {
            vmId: vm.id,
            error: updErr.message,
          });
        }
        logger.info("reconcile-stuck-vms: recovered", {
          route: `cron/${CRON_NAME}`,
          vmId: vm.id,
          vmName: vm.name,
          userEmail,
          fixedCount: outcome.fixed.length,
          alreadyCorrectCount: outcome.alreadyCorrect.length,
          cvBefore,
        });
        sendAdminAlertEmail(
          `✅ Stuck-VM reconciled: ${vm.name} (${userEmail})`,
          [
            `VM ${vm.name} was reconciled to healthy via stuck-VM recovery pass.`,
            ``,
            `Customer:           ${userEmail}`,
            `IP:                 ${vm.ip_address}`,
            `cv before:          ${cvBefore}  (main reconcile-fleet will advance to current on next tick)`,
            `fixed steps:        ${outcome.fixed.length}`,
            `already correct:    ${outcome.alreadyCorrect.length}`,
            ``,
            `Fixed details: ${outcome.fixed.slice(0, 10).join(", ")}${outcome.fixed.length > 10 ? ` ... +${outcome.fixed.length - 10} more` : ""}`,
            ``,
            `health_status updated to 'healthy'. The main reconcile-fleet cron will`,
            `re-reconcile within ~3min (now in the healthy pool) as a verification layer,`,
            `advancing cv to the current manifest version with full strict-mode checks.`,
            ``,
            `No human action required.`,
          ].join("\n"),
        ).catch((e) =>
          logger.error("reconcile-stuck-vms: success email failed", { error: String(e) }),
        );
      } else {
        // Failure (errors / timeout / exception)
        failed++;
        const failureCode =
          outcome.kind === "timeout"
            ? "RECONCILE_TIMEOUT"
            : outcome.kind === "exception"
              ? "RECONCILE_EXCEPTION"
              : "RECONCILE_ERRORS";

        const failureKey = `stuck_vm_reconcile_failure:${vm.id}:${now.toISOString()}`;
        await supabase
          .from("instaclaw_admin_alert_log")
          .insert({ alert_key: failureKey, sent_at: now.toISOString() });

        // Check if this hit quarantine threshold (count again post-insert)
        const { count: cFailCountAfter } = await supabase
          .from("instaclaw_admin_alert_log")
          .select("id", { count: "exact" })
          .like("alert_key", `stuck_vm_reconcile_failure:${vm.id}:%`)
          .gte("sent_at", failureWindowStart);
        const failCountAfter = cFailCountAfter ?? 0;

        let didQuarantine = false;
        if (failCountAfter >= QUARANTINE_FAILURE_THRESHOLD) {
          await supabase
            .from("instaclaw_vms")
            .update({
              reconcile_quarantined_at: new Date().toISOString(),
              reconcile_last_error: `stuck-vm-reconcile: ${failureCode} (${failCountAfter}/${QUARANTINE_FAILURE_THRESHOLD} attempts in ${FAILURE_COUNT_WINDOW_HOURS}h)`,
            })
            .eq("id", vm.id);
          quarantined++;
          didQuarantine = true;
        }

        logger.error("reconcile-stuck-vms: failed", {
          route: `cron/${CRON_NAME}`,
          vmId: vm.id,
          vmName: vm.name,
          userEmail,
          failureCode,
          failCountAfter,
          didQuarantine,
          outcome,
        });

        const errorDetails =
          outcome.kind === "errors"
            ? outcome.errors.slice(0, 5).join("\n  - ")
            : outcome.kind === "timeout"
              ? `Reconcile exceeded ${PER_VM_TIMEOUT_MS / 1000}s timeout`
              : outcome.error;

        sendAdminAlertEmail(
          `${didQuarantine ? "🚨 QUARANTINED" : "🔴"} Stuck-VM reconcile failed: ${vm.name} (${userEmail})`,
          [
            `VM ${vm.name} was a stuck-unhealthy paying-customer candidate but reconcile failed.`,
            ``,
            `Customer:        ${userEmail}`,
            `IP:              ${vm.ip_address}`,
            `Failure code:    ${failureCode}`,
            `Failure count:   ${failCountAfter} / ${QUARANTINE_FAILURE_THRESHOLD} (window: ${FAILURE_COUNT_WINDOW_HOURS}h)`,
            `Quarantined now: ${didQuarantine ? "YES — operator action required" : "no (still under threshold)"}`,
            ``,
            `Error details:`,
            `  - ${errorDetails}`,
            ``,
            `Pipeline state for this VM:`,
            `  - Tier 1 (alert cron): continues paging every 6h while stuck`,
            `  - Tier 2 (auto-recover): dedup-locked or already failed`,
            `  - Tier 3 (this cron):    ${didQuarantine ? "QUARANTINED — no more automation" : `will retry in ~30min unless attempts ≥ ${QUARANTINE_FAILURE_THRESHOLD}`}`,
            ``,
            `Manual SSH for investigation:`,
            `  ssh -i /tmp/instaclaw-ssh-key openclaw@${vm.ip_address}`,
            `  systemctl --user status openclaw-gateway --no-pager -l | head -30`,
            `  journalctl --user -u openclaw-gateway -n 50 --no-pager | tail -30`,
            ``,
            `${didQuarantine ? `To un-quarantine after manual fix:\n  UPDATE instaclaw_vms SET reconcile_quarantined_at = NULL WHERE name = '${vm.name}';` : ""}`,
          ].join("\n"),
        ).catch((e) =>
          logger.error("reconcile-stuck-vms: failure email send failed", { error: String(e) }),
        );
      }

      perVmLog.push({
        vm: vm.name,
        outcome: outcome.kind,
        userEmail,
      });
    }

    const durationMs = Date.now() - startMs;
    logger.info("reconcile-stuck-vms: cycle complete", {
      route: `cron/${CRON_NAME}`,
      candidates: pool.length,
      eligible: eligible.length,
      attempted,
      recovered,
      failed,
      quarantined,
      bDeferred,
      cFailureLocked,
      durationMs,
      perVmLog,
    });

    return NextResponse.json({
      candidates: pool.length,
      eligible: eligible.length,
      attempted,
      recovered,
      failed,
      quarantined,
      bDeferred,
      cFailureLocked,
      durationMs,
      perVmLog,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
