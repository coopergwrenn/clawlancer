import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { wipeVMForNextUser, connectSSH } from "@/lib/ssh";
import { sendAdminAlertEmail } from "@/lib/email";
import { getProvider } from "@/lib/providers";
import { logger } from "@/lib/logger";
import type { VMRecord } from "@/lib/ssh";
import {
  PROTECTED_INFRA_LINODE_IDS,
  ORPHAN_MIN_AGE_MINUTES,
  MAX_ORPHAN_DELETES_PER_RUN,
  linodeCost,
  listAllLinodes,
  deleteLinodeInstance,
  readLifecycleSettings,
  sshHasRecentActivity,
  userHasLiveSubscription,
  vmHasCredits,
  logOrphan,
} from "@/lib/vm-lifecycle-helpers";
import {
  freezeVM,
  MAX_FREEZE_PER_RUN,
  FREEZE_GRACE_SUSPENDED_DAYS,
  FREEZE_GRACE_HIBERNATING_DAYS,
  type FreezeCandidate,
} from "@/lib/vm-freeze-thaw";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
// 800s — the published Vercel Pro maxDuration cap (900s is Enterprise-only).
// Pass 1 v2 (freeze) does serial Linode ops: shutdown (≤90s) + image-available
// (≤600s) + DB update + delete = ~12 min/VM worst case. With
// MAX_FREEZE_PER_RUN=2 the typical-case fits comfortably; worst-case 1380s
// would exceed the budget — we'd lose the 2nd freeze mid-execution but the
// 1st would have completed cleanly (DB updated before instance delete).
export const maxDuration = 800;

/**
 * VM Lifecycle Cron — Automated deletion of suspended VMs from Linode.
 *
 * Runs every 6 hours. Finds VMs that have been suspended beyond their
 * grace period, wipes user data (privacy), deletes from Linode API,
 * and marks as terminated in the DB.
 *
 * Grace periods:
 *   - Canceled subscription: 3 days after suspended_at
 *   - Past-due (all retries exhausted): 7 days after suspended_at
 *   - No subscription (mini app churn, etc.): 3 days after suspended_at
 *
 * Safety rails:
 *   - Circuit breaker: max 20 deletions per cycle
 *   - NEVER deletes VMs with active/trialing subscription (re-checks Stripe)
 *   - NEVER deletes VMs with credit_balance > 0
 *   - NEVER deletes VMs belonging to protected accounts
 *   - Logs every deletion to instaclaw_vm_lifecycle_log
 *   - Dry-run mode via ?dry_run=true query param
 */

const MAX_DELETIONS_PER_CYCLE = 20;
const HIBERNATE_TO_SUSPEND_DAYS = 7; // After 7 days hibernating → suspend (deallocate VM)
const CANCELED_GRACE_DAYS = 3;
const PAST_DUE_GRACE_DAYS = 7;
const NO_SUB_GRACE_DAYS = 3;

// Cooper's accounts — NEVER delete
const PROTECTED_USER_IDS = new Set([
  "afb3ae69", // coop@instaclaw.io
  "4e0213b3", // coopgwrenn@gmail.com
  "24b0b73a", // coopergrantwrenn@gmail.com
]);

function isProtectedUser(userId: string): boolean {
  return Array.from(PROTECTED_USER_IDS).some((prefix) =>
    userId.startsWith(prefix)
  );
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const dryRun = req.nextUrl.searchParams.get("dry_run") === "true";
  const supabase = getSupabase();

  const report = {
    dry_run: dryRun,
    pass1_deleted: 0,
    pass1_skipped_safety: 0,
    pass1_skipped_grace: 0,
    pass1_wipe_failed: 0,
    pass1_delete_failed: 0,
    pass2_pool_trimmed: 0,
    // Pass 1 v2 (freeze) — populated only when vmLifecycleV2Enabled
    pass1_v2_frozen: 0,
    pass1_v2_skipped_grace: 0,
    pass1_v2_skipped_safety: 0,
    pass1_v2_freeze_failed: 0,
    circuit_breaker_tripped: false,
    deletions: [] as Array<{
      vm_name: string;
      ip_address: string;
      user_email: string;
      reason: string;
      action: string;
    }>,
    freezes: [] as Array<{
      vm_name: string;
      ip_address: string;
      user_email: string;
      health_status: string;
      days_since_pause: number;
      reason: string;
      action: string;
      image_id: string | null;
    }>,
    errors: [] as string[],
  };

  let totalDeletions = 0;
  let hibernateToSuspend = 0;

  // Phase 2 additions ─────────────────────────────────────────────────
  // Read kill switches once per run for a consistent view across all passes.
  // See instaclaw/docs/prd-vm-cost-optimization.md for what each controls.
  // Wrap in try/catch — if Supabase is partially down we MUST still allow
  // the route to return a 500 cleanly rather than crashing the function.
  // Default-to-safe (both flags false) means Pass -1 is OFF during outages.
  let settings: Awaited<ReturnType<typeof readLifecycleSettings>> = {
    orphanReconciliationEnabled: false,
    vmLifecycleV2Enabled: false,
  };
  try {
    settings = await readLifecycleSettings(supabase);
  } catch (err) {
    logger.error("vm-lifecycle: readLifecycleSettings threw, defaulting to all-OFF", {
      route: "cron/vm-lifecycle",
      error: err instanceof Error ? err.message : String(err),
    });
    report.errors.push(`Settings read failed: ${String(err)}`);
  }
  const runId = randomUUID();
  // Pass -1 has its OWN deletion counter, NOT shared with totalDeletions.
  // Otherwise Pass -1 deleting up to MAX_ORPHAN_DELETES_PER_RUN would
  // immediately trip Pass 1's MAX_DELETIONS_PER_CYCLE circuit breaker
  // (both 20) and starve Pass 1 of its budget every cron cycle.
  let orphanDeletions = 0;
  const orphanReport = {
    candidates: 0,
    deleted_db_dead: 0,
    deleted_no_db: 0,
    skipped_active: 0,
    skipped_credits: 0,
    skipped_safety: 0,
    skipped_too_young: 0,
    skipped_bad_date: 0,
    skipped_infra: 0,
    skipped_locked: 0,
    delete_failed: 0,
  };

  logger.info("vm-lifecycle: run start", {
    route: "cron/vm-lifecycle",
    runId,
    dryRun,
    settings,
  });

  // ═══════════════════════════════════════════════════════════════════
  // PASS -1: Linode → DB orphan reconciliation
  //
  // Lists every running Linode and finds:
  //   (a) Linodes whose DB row says terminated/failed/destroyed (DB-dead
  //       orphans — historically un-deleted by this cron because Pass 1
  //       only queries DB rows where health_status='suspended').
  //   (b) Linodes with no DB row at all (failed-provision orphans — DB
  //       insert never happened so the cron has no way to find them).
  //
  // Pure deletes — no freeze. By definition these have no live user
  // (DB says terminated, OR no DB row = nobody assigned to begin with).
  // SSH activity check defends the last edge case (ghost VM that somehow
  // got reused).
  //
  // Gated by orphan_reconciliation_enabled (default true). Flip to false
  // in instaclaw_admin_settings to disable Pass -1 without redeploy.
  // ═══════════════════════════════════════════════════════════════════
  if (settings.orphanReconciliationEnabled) {
    try {
      const linodes = await listAllLinodes();
      const running = linodes.filter((l) => l.status === "running");

      // Pull every Linode-provider DB row regardless of status — we need
      // BOTH alive (assigned/ready/provisioning/configuring) AND dead
      // (terminated/failed/destroyed) so we can categorize correctly.
      const { data: allVms } = await supabase
        .from("instaclaw_vms")
        .select(
          "id, name, ip_address, provider_server_id, status, health_status, assigned_to, credit_balance, lifecycle_locked_at"
        )
        .eq("provider", "linode");

      const dbByPsid = new Map<string, NonNullable<typeof allVms>[number]>();
      for (const vm of allVms ?? []) {
        if (vm.provider_server_id) dbByPsid.set(String(vm.provider_server_id), vm);
      }

      const deadStatuses = new Set(["terminated", "failed", "destroyed"]);

      for (const l of running) {
        // Pass -1's own counter — independent from Pass 1's totalDeletions
        // budget so Pass -1 can't starve Pass 1 of its deletion quota.
        if (orphanDeletions >= MAX_ORPHAN_DELETES_PER_RUN) break;

        const psid = String(l.id);
        const dbRow = dbByPsid.get(psid);

        // Determine if this Linode is a candidate (DB-dead OR not-in-DB).
        const isDbDead = !!dbRow && deadStatuses.has(dbRow.status ?? "");
        const isNotInDb = !dbRow;
        if (!isDbDead && !isNotInDb) continue; // healthy assigned/ready/provisioning — Pass 0/1 territory

        orphanReport.candidates++;

        // ── Safety check: protected infra ──
        if (PROTECTED_INFRA_LINODE_IDS.has(psid)) {
          orphanReport.skipped_infra++;
          await logOrphan(supabase, {
            linodeId: l.id, vmLabel: l.label, vmDbId: dbRow?.id ?? null,
            userId: dbRow?.assigned_to ?? null, userEmail: null,
            action: "skip_infra", reason: "linode id in PROTECTED_INFRA_LINODE_IDS",
            linodeCreatedAt: l.created, linodeTags: l.tags, linodeType: l.type,
            monthlyCostUsd: linodeCost(l.type), runId, dryRun,
          });
          continue;
        }

        // ── Safety check: minimum age (anti-race with replenish-pool) ──
        // Date.parse returns NaN for malformed input. NaN < anything is
        // false, which means a malformed `created` would FAIL OPEN (bypass
        // the age guard). Explicitly guard against that — fail closed by
        // skipping any Linode whose created date we can't parse.
        const createdMs = Date.parse(l.created);
        if (Number.isNaN(createdMs)) {
          orphanReport.skipped_bad_date++;
          await logOrphan(supabase, {
            linodeId: l.id, vmLabel: l.label, vmDbId: dbRow?.id ?? null,
            userId: dbRow?.assigned_to ?? null, userEmail: null,
            action: "skip_bad_date",
            reason: `unparseable created timestamp ${JSON.stringify(l.created).slice(0, 60)} — failing closed`,
            linodeCreatedAt: l.created, linodeTags: l.tags, linodeType: l.type,
            monthlyCostUsd: linodeCost(l.type), runId, dryRun,
          });
          continue;
        }
        const ageMinutes = (Date.now() - createdMs) / 60000;
        if (ageMinutes < ORPHAN_MIN_AGE_MINUTES) {
          orphanReport.skipped_too_young++;
          await logOrphan(supabase, {
            linodeId: l.id, vmLabel: l.label, vmDbId: dbRow?.id ?? null,
            userId: dbRow?.assigned_to ?? null, userEmail: null,
            action: "skip_too_young",
            reason: `age=${Math.round(ageMinutes)}min, threshold=${ORPHAN_MIN_AGE_MINUTES}min (likely just-provisioned, DB row may be in flight)`,
            linodeCreatedAt: l.created, linodeTags: l.tags, linodeType: l.type,
            monthlyCostUsd: linodeCost(l.type), runId, dryRun,
          });
          continue;
        }

        // ── Safety check: credit_balance > 0 (PRD rule 3) ──
        // World mini app users (and any user with leftover paid credits)
        // are protected even when their DB row says terminated. We never
        // delete VM data while there's a non-zero balance.
        if (dbRow && vmHasCredits(dbRow.credit_balance)) {
          orphanReport.skipped_credits++;
          await logOrphan(supabase, {
            linodeId: l.id, vmLabel: l.label, vmDbId: dbRow.id,
            userId: dbRow.assigned_to ?? null, userEmail: null,
            action: "skip_credits",
            reason: `credit_balance=${dbRow.credit_balance} > 0 (paid credits remain) — refuse to delete`,
            linodeCreatedAt: l.created, linodeTags: l.tags, linodeType: l.type,
            monthlyCostUsd: linodeCost(l.type), runId, dryRun,
          });
          continue;
        }

        // ── Safety check: lifecycle lock held? ──
        if (dbRow?.lifecycle_locked_at) {
          const lockAge = (Date.now() - Date.parse(dbRow.lifecycle_locked_at)) / 60000;
          if (lockAge < 15) {
            orphanReport.skipped_locked++;
            await logOrphan(supabase, {
              linodeId: l.id, vmLabel: l.label, vmDbId: dbRow.id,
              userId: dbRow.assigned_to ?? null, userEmail: null,
              action: "skip_locked",
              reason: `lifecycle_locked_at age=${Math.round(lockAge)}min (operation in flight)`,
              linodeCreatedAt: l.created, linodeTags: l.tags, linodeType: l.type,
              monthlyCostUsd: linodeCost(l.type), runId, dryRun,
            });
            continue;
          }
          // Lock older than 15 min = stuck. Log warning and proceed.
          logger.warn("vm-lifecycle: stale lifecycle_locked_at, proceeding", {
            route: "cron/vm-lifecycle", runId,
            vmId: dbRow.id, lockAgeMin: Math.round(lockAge),
          });
        }

        // ── Safety check: re-verify Stripe (only if we have a user_id) ──
        // For "DB-dead" rows we still re-check because a stale dead row
        // might belong to a user who's actively paying on a *different* VM.
        if (dbRow?.assigned_to) {
          const liveSub = await userHasLiveSubscription(supabase, dbRow.assigned_to);
          if (liveSub) {
            orphanReport.skipped_active++;
            await logOrphan(supabase, {
              linodeId: l.id, vmLabel: l.label, vmDbId: dbRow.id,
              userId: dbRow.assigned_to, userEmail: null,
              action: "skip_active",
              reason: "user has active/trialing Stripe subscription — refuse to delete",
              linodeCreatedAt: l.created, linodeTags: l.tags, linodeType: l.type,
              monthlyCostUsd: linodeCost(l.type), runId, dryRun,
            });
            continue;
          }
        }

        // ── Safety check: SSH activity (last-line defense) ──
        // Even pure orphans get SSH-checked. If anything's been modified
        // recently, somebody's using this VM and we DO NOT delete.
        const ip = l.ipv4?.[0];
        const activity = ip
          ? await sshHasRecentActivity(ip)
          : { active: false, reason: "no-ipv4" };
        if (activity.active) {
          orphanReport.skipped_safety++;
          await logOrphan(supabase, {
            linodeId: l.id, vmLabel: l.label, vmDbId: dbRow?.id ?? null,
            userId: dbRow?.assigned_to ?? null, userEmail: null,
            action: "skip_safety",
            reason: `SSH activity detected: ${activity.reason}`,
            linodeCreatedAt: l.created, linodeTags: l.tags, linodeType: l.type,
            monthlyCostUsd: linodeCost(l.type), runId, dryRun,
          });
          continue;
        }

        // All safety checks passed → delete (or pretend to in dry-run).
        const action: "delete_db_dead" | "delete_no_db" = isDbDead ? "delete_db_dead" : "delete_no_db";
        if (!dryRun) {
          try {
            await deleteLinodeInstance(l.id);
            // Mirror DB state for db-dead rows. (No DB row to update for
            // not-in-db case — the entire point is there isn't one.)
            if (dbRow) {
              await supabase
                .from("instaclaw_vms")
                .update({ status: "destroyed", health_status: "unhealthy" })
                .eq("id", dbRow.id);
            }
          } catch (err) {
            orphanReport.delete_failed++;
            await logOrphan(supabase, {
              linodeId: l.id, vmLabel: l.label, vmDbId: dbRow?.id ?? null,
              userId: dbRow?.assigned_to ?? null, userEmail: null,
              action: "delete_failed",
              reason: `Linode DELETE call failed: ${(err as Error).message.slice(0, 200)}`,
              linodeCreatedAt: l.created, linodeTags: l.tags, linodeType: l.type,
              monthlyCostUsd: linodeCost(l.type), runId, dryRun,
            });
            continue;
          }
        }

        if (action === "delete_db_dead") orphanReport.deleted_db_dead++;
        else orphanReport.deleted_no_db++;
        orphanDeletions++;

        await logOrphan(supabase, {
          linodeId: l.id, vmLabel: l.label, vmDbId: dbRow?.id ?? null,
          userId: dbRow?.assigned_to ?? null, userEmail: null,
          action,
          reason: isDbDead
            ? `db_status=${dbRow!.status} health=${dbRow!.health_status}, ssh ${activity.reason}`
            : `not in DB, ssh ${activity.reason}, age=${Math.round(ageMinutes / 60)}h`,
          linodeCreatedAt: l.created, linodeTags: l.tags, linodeType: l.type,
          monthlyCostUsd: linodeCost(l.type), runId, dryRun,
        });
      }

      logger.info("vm-lifecycle: Pass -1 complete", {
        route: "cron/vm-lifecycle", runId, dryRun, ...orphanReport,
      });
    } catch (err) {
      report.errors.push(`Pass -1 (orphan reconciliation) failed: ${String(err)}`);
      logger.error("vm-lifecycle: Pass -1 fatal error", {
        route: "cron/vm-lifecycle", runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    logger.info("vm-lifecycle: Pass -1 disabled by kill switch", {
      route: "cron/vm-lifecycle", runId,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // PASS 0: Transition hibernating VMs → suspended after 7 days
  //
  // LEGACY PATH ONLY. When vmLifecycleV2Enabled=true, Pass 1 v2 freezes
  // hibernating VMs directly at 90 days — the suspended transition is no
  // longer needed because freezing handles deallocation. Skip Pass 0 in
  // v2 to avoid prematurely flipping health_status before Pass 1 v2 sees
  // the row.
  // ═══════════════════════════════════════════════════════════════════
  try {
    if (settings.vmLifecycleV2Enabled) {
      logger.info("vm-lifecycle: Pass 0 skipped (v2 enabled — freeze handles hibernating)", {
        route: "cron/vm-lifecycle", runId,
      });
    } else {
    const { data: hibernatingVms } = await supabase
      .from("instaclaw_vms")
      .select("id, name, assigned_to, suspended_at, credit_balance")
      .eq("health_status", "hibernating")
      .not("suspended_at", "is", null);

    for (const vm of hibernatingVms ?? []) {
      const daysHibernating = (Date.now() - new Date(vm.suspended_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysHibernating < HIBERNATE_TO_SUSPEND_DAYS) continue;

      // Safety: skip if user somehow got credits back
      if ((vm.credit_balance ?? 0) > 0) continue;

      // Safety: skip if subscription reactivated
      if (vm.assigned_to) {
        const { data: sub } = await supabase
          .from("instaclaw_subscriptions")
          .select("status")
          .eq("user_id", vm.assigned_to)
          .single();
        if (sub?.status === "active" || sub?.status === "trialing") continue;
      }

      // Transition: hibernating → suspended
      await supabase
        .from("instaclaw_vms")
        .update({ health_status: "suspended" })
        .eq("id", vm.id);

      hibernateToSuspend++;
      logger.info("VM transitioned from hibernating to suspended", {
        route: "cron/vm-lifecycle",
        vmId: vm.id,
        vmName: vm.name,
        daysHibernating: Math.floor(daysHibernating),
      });
    }
    } // close: legacy Pass 0 (v2 disabled) branch
  } catch (err) {
    report.errors.push(`Hibernate→suspend pass failed: ${String(err)}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PASS 1 v2: FREEZE suspended/hibernating VMs past grace period
  //
  // Active only when vmLifecycleV2Enabled=true. Replaces legacy Pass 1's
  // hard-delete with snapshot-then-delete. Different grace per status:
  //   - suspended:    FREEZE_GRACE_SUSPENDED_DAYS days post-suspended_at
  //   - hibernating:  FREEZE_GRACE_HIBERNATING_DAYS days post-suspended_at
  // Cap MAX_FREEZE_PER_RUN per cycle (Linode image rate limit).
  //
  // All safety checks live in lib/vm-freeze-thaw.ts:freezeVM(). The route
  // just gathers candidates and counts results.
  // ═══════════════════════════════════════════════════════════════════
  if (settings.vmLifecycleV2Enabled) {
    try {
      // PRD rule 2: skip any VM with proxy activity in the last 7 days.
      // last_proxy_call_at is the canonical "user attempted to use the VM"
      // signal — set on every successful gateway/proxy call. SSH file-mtime
      // checks miss paywall-bouncing users (proxy hits don't touch ~/.openclaw).
      const proxyActivityCutoff = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { data: candidates } = await supabase
        .from("instaclaw_vms")
        .select(
          "id, name, ip_address, ssh_port, ssh_user, provider_server_id, assigned_to, credit_balance, bankr_token_address, suspended_at, status, health_status, region, lifecycle_locked_at, last_proxy_call_at, frozen_image_id"
        )
        .in("health_status", ["suspended", "hibernating"])
        .eq("provider", "linode")
        .eq("status", "assigned")
        .not("suspended_at", "is", null)
        .not("provider_server_id", "is", null)
        // Skip thaw-pending-verification rows (frozen_image_id still set
        // post-thaw means SSH never verified — the previous thaw is in a
        // hold state and we shouldn't re-freeze and overwrite the image).
        .is("frozen_image_id", null)
        // Skip VMs with proxy activity in the last 7 days. PostgREST .or
        // syntax: column.op.value comma column.op.value — combined with
        // existing .eq filters via implicit AND.
        .or(`last_proxy_call_at.is.null,last_proxy_call_at.lt.${proxyActivityCutoff}`);

      logger.info("vm-lifecycle: Pass 1 v2 (freeze) — candidates queried", {
        route: "cron/vm-lifecycle", runId, count: candidates?.length ?? 0, dryRun,
      });

      let freezeAttempts = 0;
      for (const vm of candidates ?? []) {
        // Cap on ATTEMPTS not just successes — Linode's image-create rate
        // limit (~50/hr) counts attempts including failures, so a bad day
        // hitting rate limits could otherwise burn through the candidate
        // list trying every VM.
        if (freezeAttempts >= MAX_FREEZE_PER_RUN) {
          logger.info("vm-lifecycle: Pass 1 v2 attempt cap reached", {
            route: "cron/vm-lifecycle", runId, cap: MAX_FREEZE_PER_RUN,
          });
          break;
        }

        const suspendedAt = new Date(vm.suspended_at);
        const daysSincePause = (Date.now() - suspendedAt.getTime()) / (1000 * 60 * 60 * 24);
        const graceDays = vm.health_status === "hibernating"
          ? FREEZE_GRACE_HIBERNATING_DAYS
          : FREEZE_GRACE_SUSPENDED_DAYS;

        if (daysSincePause < graceDays) {
          report.pass1_v2_skipped_grace++;
          continue;
        }

        // Protected user — never freeze (defense in depth; freezeVM also
        // re-checks Stripe live, but skip the call entirely for these).
        if (vm.assigned_to && isProtectedUser(vm.assigned_to)) {
          report.pass1_v2_skipped_safety++;
          if (!dryRun) {
            await logLifecycleEvent(
              supabase, vm, vm.assigned_to ?? null, "(protected)", null,
              "freeze_skipped_safety", "protected user",
            );
          }
          continue;
        }

        // Get user email for logging
        let userEmail = "unassigned";
        if (vm.assigned_to) {
          const { data: user } = await supabase
            .from("instaclaw_users")
            .select("email")
            .eq("id", vm.assigned_to)
            .single();
          userEmail = user?.email ?? "unknown";
        }

        const candidate: FreezeCandidate = {
          id: vm.id,
          name: vm.name ?? null,
          ip_address: vm.ip_address,
          ssh_port: vm.ssh_port,
          ssh_user: vm.ssh_user,
          provider_server_id: vm.provider_server_id ?? null,
          assigned_to: vm.assigned_to ?? null,
          health_status: vm.health_status ?? null,
          status: vm.status ?? null,
          suspended_at: vm.suspended_at,
          credit_balance: vm.credit_balance ?? null,
          bankr_token_address: vm.bankr_token_address ?? null,
          region: vm.region ?? null,
          lifecycle_locked_at: vm.lifecycle_locked_at ?? null,
        };

        // Per-VM try/catch — a single Linode API throw must NOT kill the rest
        // of the pass. Convert thrown errors into a freeze_failed result and
        // continue to the next candidate.
        freezeAttempts++;
        let result: Awaited<ReturnType<typeof freezeVM>>;
        try {
          result = await freezeVM(supabase, candidate, dryRun, runId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("vm-lifecycle: freezeVM threw — caught and continuing", {
            route: "cron/vm-lifecycle", runId,
            vmId: vm.id, vmName: vm.name, error: msg,
          });
          result = { success: false, reason: `freezeVM threw: ${msg.slice(0, 200)}` };
        }

        if (result.success) {
          report.pass1_v2_frozen++;
          report.freezes.push({
            vm_name: vm.name ?? vm.id,
            ip_address: vm.ip_address,
            user_email: userEmail,
            health_status: vm.health_status ?? "?",
            days_since_pause: Math.floor(daysSincePause),
            reason: result.reason,
            action: dryRun ? "WOULD_FREEZE" : "FROZEN",
            image_id: result.imageId ?? null,
          });
          if (!dryRun) {
            await logLifecycleEvent(
              supabase, vm, vm.assigned_to ?? null, userEmail, null,
              "frozen",
              `${result.reason}${result.imageId ? ` image=${result.imageId}` : ""}${result.imageSizeMb ? ` ${result.imageSizeMb}MB` : ""}`,
            );
          }
        } else {
          // Distinguish "expected skip" (safety check fired) from "operation
          // failure" (snapshot/API error). Both increment a counter, but we
          // keep them separate so the email tells us which.
          const isSkip = /refuse|paid credits|active|activity|failing closed|lock|wrong status|wrong health|no provider|unexpected activity-check/i.test(result.reason);
          if (isSkip) {
            report.pass1_v2_skipped_safety++;
          } else {
            report.pass1_v2_freeze_failed++;
            report.errors.push(`freeze failed for ${vm.name}: ${result.reason}`);
          }
          report.freezes.push({
            vm_name: vm.name ?? vm.id,
            ip_address: vm.ip_address,
            user_email: userEmail,
            health_status: vm.health_status ?? "?",
            days_since_pause: Math.floor(daysSincePause),
            reason: result.reason,
            action: isSkip ? "SKIP" : "FAILED",
            image_id: null,
          });
          if (!dryRun) {
            await logLifecycleEvent(
              supabase, vm, vm.assigned_to ?? null, userEmail, null,
              isSkip ? "freeze_skipped_safety" : "freeze_failed",
              result.reason,
            );
          }
        }
      }

      logger.info("vm-lifecycle: Pass 1 v2 complete", {
        route: "cron/vm-lifecycle", runId, dryRun,
        frozen: report.pass1_v2_frozen,
        skippedGrace: report.pass1_v2_skipped_grace,
        skippedSafety: report.pass1_v2_skipped_safety,
        failed: report.pass1_v2_freeze_failed,
      });
    } catch (err) {
      report.errors.push(`Pass 1 v2 (freeze) failed: ${String(err)}`);
      logger.error("vm-lifecycle: Pass 1 v2 fatal error", {
        route: "cron/vm-lifecycle", runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    // ═══════════════════════════════════════════════════════════════════
    // PASS 1 (LEGACY): Delete suspended VMs past their grace period
    //
    // Skipped when vmLifecycleV2Enabled=true (Pass 1 v2 above replaces it).
    // ═══════════════════════════════════════════════════════════════════

    if (settings.vmLifecycleV2Enabled) {
      logger.info("vm-lifecycle: Pass 1 legacy skipped (v2 enabled — freeze pass ran)", {
        route: "cron/vm-lifecycle", runId,
      });
    } else {

    const { data: suspendedVms } = await supabase
      .from("instaclaw_vms")
      .select(
        "id, name, ip_address, ssh_port, ssh_user, provider, provider_server_id, assigned_to, credit_balance, suspended_at, health_status, region"
      )
      .eq("health_status", "suspended")
      .eq("provider", "linode")
      .not("suspended_at", "is", null);

    if (suspendedVms?.length) {
      logger.info("VM lifecycle: found suspended VMs", {
        route: "cron/vm-lifecycle",
        count: suspendedVms.length,
        dryRun,
      });

      for (const vm of suspendedVms) {
        // Circuit breaker
        if (totalDeletions >= MAX_DELETIONS_PER_CYCLE) {
          report.circuit_breaker_tripped = true;
          logger.warn("VM lifecycle: circuit breaker tripped", {
            route: "cron/vm-lifecycle",
            deletions: totalDeletions,
            max: MAX_DELETIONS_PER_CYCLE,
          });
          break;
        }

        const userId = vm.assigned_to;
        const suspendedAt = new Date(vm.suspended_at);
        const daysSuspended = Math.floor(
          (Date.now() - suspendedAt.getTime()) / (1000 * 60 * 60 * 24)
        );

        // ── Safety checks ──

        // 1. Protected user
        if (userId && isProtectedUser(userId)) {
          report.pass1_skipped_safety++;
          continue;
        }

        // 2. Has credits
        if (vm.credit_balance && vm.credit_balance > 0) {
          report.pass1_skipped_safety++;
          continue;
        }

        // 3. Re-check subscription status (don't trust cached state)
        let subStatus: string | null = null;
        if (userId) {
          const { data: sub } = await supabase
            .from("instaclaw_subscriptions")
            .select("status")
            .eq("user_id", userId)
            .single();
          subStatus = sub?.status ?? null;

          // NEVER delete if subscription is active or trialing
          if (subStatus === "active" || subStatus === "trialing") {
            report.pass1_skipped_safety++;
            // This VM shouldn't be suspended — reactivate it
            logger.warn(
              "VM lifecycle: suspended VM has active subscription — skipping and flagging",
              {
                route: "cron/vm-lifecycle",
                vmId: vm.id,
                vmName: vm.name,
                subStatus,
              }
            );
            continue;
          }
        }

        // 4. Check grace period based on subscription status
        let graceDays: number;
        let reason: string;
        if (subStatus === "past_due") {
          graceDays = PAST_DUE_GRACE_DAYS;
          reason = "past_due beyond 7-day grace";
        } else if (subStatus === "canceled") {
          graceDays = CANCELED_GRACE_DAYS;
          reason = "canceled beyond 3-day grace";
        } else {
          graceDays = NO_SUB_GRACE_DAYS;
          reason = "no subscription beyond 3-day grace";
        }

        if (daysSuspended < graceDays) {
          report.pass1_skipped_grace++;
          continue;
        }

        // 5. Check for WLD delegation (confirmed)
        if (userId) {
          const { data: wld } = await supabase
            .from("instaclaw_wld_delegations")
            .select("id")
            .eq("user_id", userId)
            .eq("status", "confirmed")
            .not("transaction_hash", "is", null)
            .limit(1);

          if (wld && wld.length > 0) {
            report.pass1_skipped_safety++;
            continue;
          }
        }

        // 6. Check for World ID verification
        if (userId) {
          const { data: user } = await supabase
            .from("instaclaw_users")
            .select("world_id_verified, world_wallet_address")
            .eq("id", userId)
            .single();

          if (user?.world_id_verified || user?.world_wallet_address) {
            report.pass1_skipped_safety++;
            continue;
          }
        }

        // ── Get user email for logging ──
        let userEmail = "unassigned";
        if (userId) {
          const { data: user } = await supabase
            .from("instaclaw_users")
            .select("email")
            .eq("id", userId)
            .single();
          userEmail = user?.email ?? "unknown";
        }

        // ── DRY RUN: just log ──
        if (dryRun) {
          report.deletions.push({
            vm_name: vm.name ?? vm.id,
            ip_address: vm.ip_address,
            user_email: userEmail,
            reason,
            action: "WOULD_DELETE",
          });
          totalDeletions++;
          report.pass1_deleted++;
          continue;
        }

        // ── LIVE: Wipe → Delete → Update DB ──

        // Step 1: Wipe user data (privacy)
        try {
          const wipeResult = await wipeVMForNextUser(vm as VMRecord);
          if (!wipeResult.success) {
            // Wipe failed — skip deletion, retry next cycle
            // SSH may be down, but we still need to try wiping before deleting
            logger.warn("VM lifecycle: wipe failed, skipping deletion", {
              route: "cron/vm-lifecycle",
              vmId: vm.id,
              vmName: vm.name,
              error: wipeResult.error,
            });
            report.pass1_wipe_failed++;

            // Log to lifecycle table
            await logLifecycleEvent(supabase, vm, userId, userEmail, subStatus, "wipe_failed", reason);
            continue;
          }
        } catch (wipeErr) {
          // SSH completely unreachable — VM may already be dead
          // Proceed with deletion anyway (data will be destroyed with the VM)
          logger.warn("VM lifecycle: wipe threw exception, proceeding with deletion", {
            route: "cron/vm-lifecycle",
            vmId: vm.id,
            vmName: vm.name,
            error: String(wipeErr),
          });
        }

        // Step 2: Delete from Linode
        try {
          const provider = getProvider(vm.provider);
          await provider.deleteServer(vm.provider_server_id);
        } catch (deleteErr) {
          const errMsg = String(deleteErr);
          // 404 = already deleted — mark as terminated anyway
          if (!errMsg.includes("404")) {
            logger.error("VM lifecycle: Linode delete failed", {
              route: "cron/vm-lifecycle",
              vmId: vm.id,
              vmName: vm.name,
              error: errMsg,
            });
            report.pass1_delete_failed++;
            await logLifecycleEvent(supabase, vm, userId, userEmail, subStatus, "linode_delete_failed", reason);
            continue;
          }
        }

        // Step 3: Update DB
        await supabase
          .from("instaclaw_vms")
          .update({ status: "terminated" })
          .eq("id", vm.id);

        // Step 4: Log
        await logLifecycleEvent(supabase, vm, userId, userEmail, subStatus, "deleted", reason);

        report.deletions.push({
          vm_name: vm.name ?? vm.id,
          ip_address: vm.ip_address,
          user_email: userEmail,
          reason,
          action: "DELETED",
        });

        totalDeletions++;
        report.pass1_deleted++;

        logger.info("VM lifecycle: deleted VM", {
          route: "cron/vm-lifecycle",
          vmId: vm.id,
          vmName: vm.name,
          ip: vm.ip_address,
          userEmail,
          reason,
          daysSuspended,
        });
      }
    }

    } // close: legacy Pass 1 (v2 disabled) branch

    // ═══════════════════════════════════════════════════════════════════
    // PASS 2: Trim ready pool if over maximum (30)
    // Runs regardless of v2 — pool trimming is unrelated to freeze flow.
    // ═══════════════════════════════════════════════════════════════════

    const MAX_POOL_SIZE = 30;
    const MAX_POOL_TRIM = 5;

    const { data: readyVms } = await supabase
      .from("instaclaw_vms")
      .select("id, name, ip_address, provider, provider_server_id")
      .eq("status", "ready")
      .eq("provider", "linode")
      .order("created_at", { ascending: true });

    if (readyVms && readyVms.length > MAX_POOL_SIZE) {
      const excess = Math.min(readyVms.length - MAX_POOL_SIZE, MAX_POOL_TRIM);
      const toTrim = readyVms.slice(0, excess);

      for (const vm of toTrim) {
        if (totalDeletions >= MAX_DELETIONS_PER_CYCLE) {
          report.circuit_breaker_tripped = true;
          break;
        }

        if (dryRun) {
          report.deletions.push({
            vm_name: vm.name ?? vm.id,
            ip_address: vm.ip_address,
            user_email: "pool",
            reason: "ready pool excess",
            action: "WOULD_TRIM",
          });
          report.pass2_pool_trimmed++;
          totalDeletions++;
          continue;
        }

        try {
          const provider = getProvider(vm.provider);
          await provider.deleteServer(vm.provider_server_id);
          await supabase
            .from("instaclaw_vms")
            .update({ status: "terminated" })
            .eq("id", vm.id);
          report.pass2_pool_trimmed++;
          totalDeletions++;
        } catch (err) {
          report.errors.push(`Pool trim failed for ${vm.name}: ${String(err)}`);
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════
    // REPORT
    // ═══════════════════════════════════════════════════════════════════

    const orphanDeletes = orphanReport.deleted_db_dead + orphanReport.deleted_no_db;
    const anyAction =
      report.pass1_deleted > 0 ||
      report.pass1_v2_frozen > 0 ||
      orphanDeletes > 0 ||
      report.circuit_breaker_tripped;
    if (anyAction) {
      const subject = dryRun
        ? `VM Lifecycle DRY RUN: ${report.pass1_v2_frozen} frozen + ${report.pass1_deleted} deleted + ${orphanDeletes} orphan`
        : `VM Lifecycle: ${report.pass1_v2_frozen} frozen + ${report.pass1_deleted} deleted + ${orphanDeletes} orphan`;

      const body = [
        `VM lifecycle cron ran at ${new Date().toISOString()}${dryRun ? " (DRY RUN)" : ""}`,
        `Run ID: ${runId}`,
        "",
        `── Pass -1 (orphan reconciliation, enabled=${settings.orphanReconciliationEnabled}) ──`,
        `Candidates considered: ${orphanReport.candidates}`,
        `Deleted (DB-dead orphan): ${orphanReport.deleted_db_dead}`,
        `Deleted (not-in-DB orphan): ${orphanReport.deleted_no_db}`,
        `Skipped (live subscription): ${orphanReport.skipped_active}`,
        `Skipped (paid credits remain): ${orphanReport.skipped_credits}`,
        `Skipped (SSH activity): ${orphanReport.skipped_safety}`,
        `Skipped (too young, anti-race): ${orphanReport.skipped_too_young}`,
        `Skipped (unparseable created date): ${orphanReport.skipped_bad_date}`,
        `Skipped (protected infra): ${orphanReport.skipped_infra}`,
        `Skipped (lifecycle lock held): ${orphanReport.skipped_locked}`,
        `Linode DELETE failed: ${orphanReport.delete_failed}`,
        "",
        `── Pass 1 v2 (FREEZE, v2_enabled=${settings.vmLifecycleV2Enabled}) ──`,
        `Frozen: ${report.pass1_v2_frozen}`,
        `Skipped (grace period): ${report.pass1_v2_skipped_grace}`,
        `Skipped (safety): ${report.pass1_v2_skipped_safety}`,
        `Freeze failed (operation error): ${report.pass1_v2_freeze_failed}`,
        "",
        `── Pass 1 LEGACY (active when v2_enabled=false) ──`,
        `Suspended VMs deleted: ${report.pass1_deleted}`,
        `Skipped (safety): ${report.pass1_skipped_safety}`,
        `Skipped (grace period): ${report.pass1_skipped_grace}`,
        `Wipe failed (retry next cycle): ${report.pass1_wipe_failed}`,
        `Delete failed: ${report.pass1_delete_failed}`,
        `Pool trimmed: ${report.pass2_pool_trimmed}`,
        `Circuit breaker: ${report.circuit_breaker_tripped ? "TRIPPED" : "OK"}`,
        "",
        ...(report.freezes.length > 0
          ? [
              "Freeze attempts:",
              ...report.freezes.map(
                (f) => `  ${f.action} ${f.vm_name} (${f.ip_address}) — ${f.user_email} — ${f.health_status} ${f.days_since_pause}d — ${f.reason}${f.image_id ? ` [image=${f.image_id}]` : ""}`,
              ),
              "",
            ]
          : []),
        "Deletions:",
        ...report.deletions.map(
          (d) => `  ${d.action} ${d.vm_name} (${d.ip_address}) — ${d.user_email} — ${d.reason}`
        ),
        ...(report.errors.length > 0
          ? ["", "Errors:", ...report.errors.map((e) => `  - ${e}`)]
          : []),
        "",
        `Orphan deletion log: SELECT * FROM instaclaw_orphan_deletion_log WHERE run_id='${runId}' ORDER BY created_at;`,
      ].join("\n");

      await sendAdminAlertEmail(subject, body).catch(() => {});
    }

    logger.info("VM lifecycle cron complete", {
      route: "cron/vm-lifecycle",
      runId,
      ...report,
      orphan: orphanReport,
      settings,
    });
  } catch (err) {
    logger.error("VM lifecycle cron failed", {
      route: "cron/vm-lifecycle",
      runId,
      error: String(err),
    });
    report.errors.push(String(err));
  }

  return NextResponse.json({
    ...report,
    runId,
    settings,
    orphan: orphanReport,
    hibernateToSuspend,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function logLifecycleEvent(
  supabase: ReturnType<typeof getSupabase>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vm: any,
  userId: string | null,
  userEmail: string,
  subStatus: string | null,
  action: string,
  reason: string
) {
  try {
    await supabase.from("instaclaw_vm_lifecycle_log").insert({
      vm_id: vm.id,
      vm_name: vm.name,
      ip_address: vm.ip_address,
      user_id: userId,
      user_email: userEmail,
      subscription_status: subStatus,
      credit_balance: vm.credit_balance ?? 0,
      action,
      reason,
      provider_server_id: vm.provider_server_id,
    });
  } catch (err) {
    logger.error("Failed to log lifecycle event", {
      route: "cron/vm-lifecycle",
      vmId: vm.id,
      action,
      error: String(err),
    });
  }
}
