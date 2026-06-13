import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { wipeVMForNextUser, connectSSH } from "@/lib/ssh";
import { sendAdminAlertEmail } from "@/lib/email";
import { getProvider } from "@/lib/providers";
import { logger } from "@/lib/logger";
import { isUserBillableForVmAssignment, classifyFreezeBilling } from "@/lib/billing-status";
import { getStripe } from "@/lib/stripe";
import type { VMRecord } from "@/lib/ssh";
import {
  PROTECTED_INFRA_LINODE_IDS,
  ORPHAN_MIN_AGE_MINUTES,
  MAX_ORPHAN_DELETES_PER_RUN,
  linodeCost,
  listAllLinodes,
  deleteLinodeInstance,
  readLifecycleSettings,
  // sshHasRecentActivity: deprecated in Pass -1 per 2026-05-22 fix —
  // produces false-positive "SSH activity" on dead-DB orphans because
  // platform crons (strip-thinking.py, file-drift, reconciler) touch
  // workspace .md + sessions .jsonl on every healthy or sleeping VM.
  // See Rule 50 (CLAUDE.md). Replaced with userHasRecentActivity (DB
  // column based) for assigned VMs + skip-entirely for no-assignee
  // orphans (no user to protect → SSH-check is overcaution).
  userHasRecentActivity,
  vmHasCredits,
  logOrphan,
} from "@/lib/vm-lifecycle-helpers";
import {
  freezeVM,
  imageExists,
  MAX_FREEZE_PER_RUN,
  FREEZE_GRACE_SUSPENDED_DAYS,
  FREEZE_GRACE_HIBERNATING_DAYS,
  FREEZE_BILLING_UNVERIFIABLE_PREFIX,
  type FreezeCandidate,
} from "@/lib/vm-freeze-thaw";
import { deleteVMDNSRecord } from "@/lib/godaddy";
import { randomUUID } from "node:crypto";
import { fetchAllOrThrow, IncompleteFetchError } from "@/lib/complete-set";

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

// Billing-exempt (comp/founder/family) accounts — NEVER freeze.
//
// 2026-06-10: replaced the hardcoded PROTECTED_USER_IDS prefix set (which had
// drifted — its "coopergrantwrenn" entry pointed at jwrenn@me.com, the real
// coopergrantwrenn account was missing, and coop@instaclaw.io had no live
// account) with the first-class instaclaw_users.billing_exempt flag. The flag
// is the single source of truth read by lib/billing-status.ts Path 0, so this
// freeze pre-check and the billing classification can no longer disagree.
// Fetched once per cron run; isProtectedUser is a pure membership test.
// Returns { ids, verified }. `verified` distinguishes a genuinely-empty exempt
// list (clean read, no comp accounts → verified:true) from an UNVERIFIABLE read
// (DB error/exception → verified:false). 2026-06-11 fail-closed fix (sibling of
// F1): the consumers gate IRREVERSIBLE freeze (:768) + Pass-1 reclaim (:987),
// and the OLD empty-Set-on-error made a transient DB blip read as "nobody is
// protected" → freeze/reclaim every candidate (fail-OPEN on the destroy side).
// Consumers MUST treat verified=false as "EVERYONE is potentially protected"
// and skip ALL freeze/reclaim candidates that tick, logged loudly.
async function fetchBillingExemptUserIds(
  supabase: ReturnType<typeof getSupabase>,
): Promise<{ ids: Set<string>; verified: boolean }> {
  try {
    const { data, error } = await supabase
      .from("instaclaw_users")
      .select("id")
      .eq("billing_exempt", true);
    // Read ERROR — unverifiable. Empty set but verified:false → consumers fail
    // closed (skip all destructive candidates), NOT fail open.
    if (error) return { ids: new Set(), verified: false };
    // Clean read (rows OR genuinely none) — authoritative.
    return { ids: new Set(((data ?? []) as Array<{ id: string }>).map((u) => u.id)), verified: true };
  } catch {
    // Exception — unverifiable.
    return { ids: new Set(), verified: false };
  }
}

function isProtectedUser(userId: string, exemptUserIds: Set<string>): boolean {
  return exemptUserIds.has(userId);
}

/**
 * Row shape the Pass -1 orphan reaper reads. Explicit (not supabase-inferred)
 * because the rows now come through fetchAllOrThrow<OrphanDbRow>. Must cover
 * every `dbRow.<field>` access in the reaper loop.
 */
type OrphanDbRow = {
  id: string;
  name: string | null;
  ip_address: string | null;
  provider_server_id: number | string | null;
  status: string | null;
  health_status: string | null;
  assigned_to: string | null;
  credit_balance: number | null;
  lifecycle_locked_at: string | null;
  last_user_activity_at: string | null;
};

/**
 * P0 admin alert when the orphan reaper refuses to run because it could not
 * prove its DB-row set was complete (Rule 85 / INC-2026-06-12). Deduped to one
 * email per 6h so an ongoing truncation doesn't spam, but loud enough that an
 * operator knows the cost-cleanup is paused AND why. Best-effort; never throws.
 */
async function alertOrphanReaperAbort(
  supabase: ReturnType<typeof getSupabase>,
  err: IncompleteFetchError,
  runId: string,
): Promise<void> {
  const alertKey = `orphan_reaper_abort:${err.table}`;
  try {
    const sixHrAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", alertKey)
      .gte("sent_at", sixHrAgo)
      .limit(1);
    if (existing && existing.length > 0) return; // already alerted this window
    await supabase
      .from("instaclaw_admin_alert_log")
      .insert({ alert_key: alertKey, vm_count: 0, details: err.message });
  } catch {
    // dedup bookkeeping failed — fall through and still send (better a dup
    // alert than a silent paused reaper).
  }
  await sendAdminAlertEmail(
    "[P0] Orphan reaper ABORTED — incomplete DB set (deleted nothing)",
    `vm-lifecycle Pass -1 refused to run: the instaclaw_vms set could not be proven complete ` +
      `(fetched ${err.fetched}, server count(*) = ${err.expected}). NO Linodes were deleted this run.\n\n` +
      `This is the Rule 85 / INC-2026-06-12 fail-closed guard firing. Investigate why the fetch is ` +
      `incomplete — PostgREST 1000-row cap exceeded, pagination bug, or count drift under concurrent ` +
      `writes. Cost-cleanup stays paused (safe) until resolved; it retries every run.\n\nrunId=${runId}`,
  ).catch(() => {});
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const dryRun = req.nextUrl.searchParams.get("dry_run") === "true";
  const supabase = getSupabase();

  // Billing-exempt accounts (founder/family/comp) — fetched once, used by the
  // freeze pre-checks below via isProtectedUser. Single source of truth:
  // instaclaw_users.billing_exempt (migration 20260610210000).
  // `exemptVerified=false` means the exempt-list read FAILED — the destructive
  // passes treat that as "everyone is potentially protected" and skip ALL
  // freeze/reclaim candidates this tick (fail-closed; 2026-06-11 sibling of F1).
  const { ids: exemptUserIds, verified: exemptVerified } =
    await fetchBillingExemptUserIds(supabase);
  if (!exemptVerified) {
    logger.error(
      "vm-lifecycle: billing-exempt list UNVERIFIABLE — skipping ALL freeze/reclaim/transition candidates this tick (fail-closed)",
      { route: "cron/vm-lifecycle", dryRun },
    );
  }

  const report = {
    dry_run: dryRun,
    pass1_deleted: 0,
    pass1_skipped_safety: 0,
    pass1_skipped_grace: 0,
    pass1_wipe_failed: 0,
    pass1_delete_failed: 0,
    pass2_pool_trimmed: 0,
    // Pass 0.5 (stale frozen_image_id sweep) — populated only when vmLifecycleV2Enabled
    pass05_stale_image_cleared: 0,
    pass05_image_probe_failed: 0,
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
  // SoT billing gate (Rule 14 + Rule 82): both the orphan-delete pass and the
  // freeze pass verify against Stripe ground truth before any destructive op.
  const stripe = getStripe();
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
      // `let` not `const`: on an incomplete DB fetch we set this to [] so the
      // candidate loop below iterates nothing (fail closed). See Rule 85.
      let running = linodes.filter((l) => l.status === "running");

      // ── Build the COMPLETE DB-row map (Rule 85 / INC-2026-06-12) ──
      // The candidate loop deletes a running Linode whose id is ABSENT from
      // this map ("not in DB → orphan"). A bare PostgREST select silently caps
      // at 1000 rows; on 2026-06-12 the table had 1004 linode rows, so 4
      // PRESENT rows read as "not in DB" and the reaper deleted 13 customer
      // VMs (10 paying, 0 recoverable) — 100% false positives.
      //
      // fetchAllOrThrow paginates AND asserts fetched.length === count(*),
      // throwing IncompleteFetchError on any mismatch. We FAIL CLOSED: if the
      // set can't be proven complete we delete NOTHING this run (running = []),
      // alert, and retry next cycle. We need BOTH alive
      // (assigned/ready/provisioning) AND dead (terminated/failed/destroyed)
      // rows, so the only filter is provider=linode.
      const dbByPsid = new Map<string, OrphanDbRow>();
      try {
        const allVms = await fetchAllOrThrow<OrphanDbRow>(supabase, {
          table: "instaclaw_vms",
          columns:
            "id, name, ip_address, provider_server_id, status, health_status, assigned_to, credit_balance, lifecycle_locked_at, last_user_activity_at",
          applyFilters: (q) => q.eq("provider", "linode"),
          context: "vm-lifecycle Pass -1 orphan reconciliation",
        });
        for (const vm of allVms) {
          if (vm.provider_server_id) dbByPsid.set(String(vm.provider_server_id), vm);
        }
      } catch (fetchErr) {
        if (fetchErr instanceof IncompleteFetchError) {
          report.errors.push(`Pass -1 ABORTED (incomplete DB set): ${fetchErr.message}`);
          logger.error(
            "vm-lifecycle: Pass -1 ABORT — instaclaw_vms set provably incomplete; refusing to delete on row-absence (Rule 85 / INC-2026-06-12)",
            {
              route: "cron/vm-lifecycle",
              runId,
              fetched: fetchErr.fetched,
              expected: fetchErr.expected,
            },
          );
          await alertOrphanReaperAbort(supabase, fetchErr, runId);
          running = []; // fail closed — iterate nothing, delete nothing
        } else {
          throw fetchErr;
        }
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

        // ── Safety check: SoT billing verify before deleting an orphan instance ──
        // (Rule 14 + Rule 82) Replaces the prior active/trialing-only check — a
        // stale dead row might belong to a user paying by ANY means (sub,
        // past_due-grace, credits, partner, all-inclusive, comp-exempt) on a
        // *different* VM. "unverifiable" (Stripe OR exempt read failed) → refuse
        // to delete this orphan (Lesson 2 — never act destructively on an
        // untrustworthy non-paying signal); a Stripe outage skips each in turn.
        if (dbRow?.assigned_to) {
          const verdict = await classifyFreezeBilling(supabase, stripe, dbRow.id);
          if (verdict === "paying" || verdict === "unverifiable") {
            orphanReport.skipped_active++;
            await logOrphan(supabase, {
              linodeId: l.id, vmLabel: l.label, vmDbId: dbRow.id,
              userId: dbRow.assigned_to, userEmail: null,
              action: "skip_active",
              reason: verdict === "paying"
                ? "owner isPaying per SoT (Rule 14: sub/grace/credits/partner/all-inclusive/comp-exempt) — refuse to delete"
                : "billing unverifiable (Stripe or comp-exempt read failed) — refuse to delete (Lesson 2)",
              linodeCreatedAt: l.created, linodeTags: l.tags, linodeType: l.type,
              monthlyCostUsd: linodeCost(l.type), runId, dryRun,
            });
            continue;
          }
        }

        // ── Safety check: user activity (Rule 50 — 2026-05-22 fix) ──
        //
        // Previously this used sshHasRecentActivity (`find -mtime -N` on
        // workspace .md + sessions .jsonl). That's the Rule 50 anti-pattern:
        // platform crons (strip-thinking.py per-min, reconcile-fleet,
        // file-drift) touch the SAME files on every VM regardless of user
        // activity. False-positive "SSH activity detected" on dead-DB
        // orphans whose gateway is still running.
        //
        // The incident: 7 status='failed' + no-assignee Linodes accumulated
        // (~$203/mo waste) because Pass -1 kept marking them skip_safety on
        // the broken SSH check. Cooper terminated them manually on
        // 2026-05-21 ~23:55 UTC. This fix prevents recurrence.
        //
        // New logic — three cases:
        //   (a) No DB row at all: nothing to protect. Skip activity check.
        //   (b) DB row but assigned_to IS NULL (the dead-DB orphan case —
        //       status='failed', 'terminated', 'destroyed' post-release):
        //       no current user. Skip activity check entirely. The Rule 50
        //       fail-closed semantics protect ACTIVE users; orphans with no
        //       assignee have no user to protect, so the check is overcaution.
        //   (c) DB row WITH assigned_to (rare for status=failed per Rule 41,
        //       but defensive): use Rule 50's userHasRecentActivity. Reads
        //       instaclaw_vms.last_user_activity_at (only touched by genuine
        //       user-initiated proxy calls, NOT platform crons). Fail-closed
        //       on NULL (protect uncertain users from accidental deletion).
        //
        // Type-cast note: dbRow's TypeScript type comes from supabase-js's
        // schema inference. last_user_activity_at was added to the SELECT
        // above so it's present at runtime; the explicit cast handles the
        // schema-generator lag for VMActivityFields compatibility.
        let activity: { active: boolean; reason: string };
        if (!dbRow) {
          // Case (a) — no DB row, no user, no platform data. Safe to delete.
          activity = { active: false, reason: "no-db-row (no user to protect)" };
        } else if (!dbRow.assigned_to) {
          // Case (b) — dead-DB orphan with no assignee. The 2026-05-22 fix
          // target. Skip activity check — there's no user, just a forgotten
          // Linode bill. The Stripe-sub check above already returned (skipped)
          // for assigned_to=NULL since `if (dbRow?.assigned_to)` guarded it.
          activity = { active: false, reason: "db-row-no-assignee (orphan, no user)" };
        } else {
          // Case (c) — dead-DB row WITH a stale assignee. Could happen if
          // status flipped to 'failed' before assigned_to was cleared.
          // Use Rule 50's user-activity check (NOT sshHasRecentActivity).
          const userAct = userHasRecentActivity(
            dbRow as { last_user_activity_at: string | null },
          );
          activity = { active: userAct.active, reason: `user-activity: ${userAct.reason}` };
        }
        if (activity.active) {
          orphanReport.skipped_safety++;
          await logOrphan(supabase, {
            linodeId: l.id, vmLabel: l.label, vmDbId: dbRow?.id ?? null,
            userId: dbRow?.assigned_to ?? null, userEmail: null,
            action: "skip_safety",
            reason: `User activity detected: ${activity.reason}`,
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
            // Clean up the <vm.id>.vm DNS record for db-dead orphans so the
            // zone doesn't refill to its cap. No-db orphans have no UUID to
            // key a record by, so the dns-zone-gc sweep (no-db-row pass) is
            // their cleaner. Best-effort; never throws.
            if (dbRow) await deleteVMDNSRecord(dbRow.id);
            // Mirror DB state for db-dead rows. (No DB row to update for
            // not-in-db case — the entire point is there isn't one.)
            if (dbRow) {
              // Split write: load-bearing terminal flip + clear assigned_to
              // commits unconditionally; last_assigned_to stamp is best-effort
              // because its FK targets auth.users (NOT instaclaw_users) and a
              // user hard-deleted from Supabase auth would otherwise reject
              // the entire compound update atomically.
              await supabase
                .from("instaclaw_vms")
                .update({
                  // 2026-05-25: was "destroyed" — rejected by
                  // instaclaw_vms_status_check (valid values:
                  // assigned/failed/ready/terminated). The Linode-ghost
                  // auto-fix would have 500'd here if it ever fired.
                  // Use 'terminated' — same intent (row is dead, exclude
                  // from candidate queries) + legal per the CHECK.
                  status: "terminated",
                  health_status: "unhealthy",
                  assigned_to: null,
                  assigned_at: null,
                  // Per eec2cf95: null IP at terminal flip — recovery probe
                  // can never re-select this row after Linode reuses its IP.
                  ip_address: null,
                })
                .eq("id", dbRow.id);
              if (dbRow.assigned_to) {
                const { error: stampErr } = await supabase
                  .from("instaclaw_vms")
                  .update({ last_assigned_to: dbRow.assigned_to })
                  .eq("id", dbRow.id)
                  .is("last_assigned_to", null);
                if (stampErr && !stampErr.message.includes("last_assigned_to_fkey")) {
                  logger.warn("vm-lifecycle: orphan stamp last_assigned_to failed (non-FK)", {
                    route: "cron/vm-lifecycle", vmId: dbRow.id, error: stampErr.message,
                  });
                }
              }
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
      .not("status", "in", '("terminated","destroyed","failed")')
      .not("suspended_at", "is", null);

    for (const vm of hibernatingVms ?? []) {
      const daysHibernating = (Date.now() - new Date(vm.suspended_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysHibernating < HIBERNATE_TO_SUSPEND_DAYS) continue;

      // Safety: skip if user somehow got credits back
      if ((vm.credit_balance ?? 0) > 0) continue;

      // Safety: skip if user is still billable (sub reactivated OR partner
      // sponsorship still in effect). Edge/Eclipse/etc users never have a
      // Stripe sub so the legacy sub-only check would mistakenly suspend
      // them after the hibernate threshold. P0-3 helper covers both cases.
      if (vm.assigned_to) {
        const billing = await isUserBillableForVmAssignment(
          supabase,
          vm.assigned_to,
        );
        // Fail-closed (2026-06-11): skip the destructive-direction transition
        // on billable OR an unverifiable billing read — a blip must not advance
        // a protected VM toward reclaim.
        if (billing.billable || !billing.verified) {
          if (!billing.verified) {
            logger.warn("vm-lifecycle: hibernating→suspended SKIPPED — billing unverifiable (fail-closed)", {
              route: "cron/vm-lifecycle",
              vmId: vm.id,
              userId: vm.assigned_to,
              reason: billing.reason,
            });
          }
          continue;
        }
      }

      // Transition: hibernating → suspended
      await supabase
        .from("instaclaw_vms")
        .update({ health_status: "suspended" })
        .eq("id", vm.id)
        // Race guard: this Pass 0 runs in the same cron as Pass 1 (which
        // terminates), but a sibling cron could also flip the row. Atomic
        // skip if it became terminal.
        .not("status", "in", '("terminated","destroyed","failed")');

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
  // PASS 0.5: Stale frozen_image_id sweep
  //
  // Find rows where frozen_image_id references a Linode image that has been
  // deleted out of band (manual cleanup in dashboard, partial-failure during
  // a previous freeze, race recovery, etc.). Probe each image via Linode
  // API; if 404, clear frozen_image_id so the operator can investigate.
  //
  // Only sweep status='frozen' rows. status='assigned' + non-null
  // frozen_image_id is the legitimate thaw-pending state (post-thaw,
  // pre-SSH-verify in lib/vm-freeze-thaw.ts:638); clearing there would
  // remove the rollback path if SSH never comes up.
  //
  // Limit 50/tick keeps the Linode GET cost bounded. Each image probe is a
  // single API call; rate limit is 1500/hr per account so we're nowhere
  // near it. Non-404 errors (rate-limit, 5xx, network) leave the row alone
  // and we retry next tick.
  // ═══════════════════════════════════════════════════════════════════
  if (settings.vmLifecycleV2Enabled) {
    try {
      const { data: frozenWithImage } = await supabase
        .from("instaclaw_vms")
        .select("id, name, frozen_image_id, frozen_at, assigned_to")
        .eq("status", "frozen")
        .not("frozen_image_id", "is", null)
        .limit(50);

      for (const vm of frozenWithImage ?? []) {
        if (!vm.frozen_image_id) continue;
        let exists: boolean;
        try {
          exists = await imageExists(vm.frozen_image_id);
        } catch (err) {
          // Non-404 probe failure (rate limit, 5xx, network). Leave the row
          // untouched and retry on the next tick. Log so we can spot a
          // sustained probe-fail pattern.
          report.pass05_image_probe_failed++;
          logger.warn("vm-lifecycle: stale-image probe failed (will retry)", {
            route: "cron/vm-lifecycle", runId, vmId: vm.id, vmName: vm.name,
            imageId: vm.frozen_image_id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (exists) continue;

        // Image is gone. Clear the reference so the operator can decide what
        // to do (thaw is no longer possible — the user's data is lost). We
        // do NOT flip status to 'destroyed' automatically; that's a one-way
        // door and deserves human review.
        logger.warn("vm-lifecycle: stale frozen_image_id (Linode 404) — clearing reference", {
          route: "cron/vm-lifecycle", runId,
          vmId: vm.id, vmName: vm.name,
          staleImageId: vm.frozen_image_id,
          frozenAt: vm.frozen_at,
        });
        report.pass05_stale_image_cleared++;
        if (!dryRun) {
          await supabase
            .from("instaclaw_vms")
            .update({ frozen_image_id: null })
            .eq("id", vm.id)
            .eq("status", "frozen");  // race-guard against concurrent thaw
          await logLifecycleEvent(
            supabase, vm, vm.assigned_to ?? null, "(unknown)", null,
            "frozen_image_cleared_stale",
            `Linode image ${vm.frozen_image_id} returned 404 — reference cleared (user data is lost)`,
          );
        }
      }
    } catch (err) {
      report.errors.push(`Pass 0.5 (stale image sweep) failed: ${String(err)}`);
      logger.error("vm-lifecycle: Pass 0.5 fatal error", {
        route: "cron/vm-lifecycle", runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PASS 1 v2: FREEZE suspended/hibernating VMs past grace period
  //
  // Active only when vmLifecycleV2Enabled=true. Replaces legacy Pass 1's
  // hard-delete with snapshot-then-delete. Different grace per status:
  //   - suspended:    FREEZE_GRACE_SUSPENDED_DAYS days post-suspended_at
  //   - hibernating:  FREEZE_GRACE_HIBERNATING_DAYS days post-suspended_at
  // Cap MAX_FREEZE_PER_RUN per cycle (Linode image rate limit). v97
  // (2026-05-14): the cap now counts ONLY Linode-touching attempts, so
  // safety skips (SSH unreachable, lock held, etc.) no longer burn budget.
  // Candidates are ordered by (freeze_consecutive_failures ASC,
  // suspended_at ASC) so persistent failers move to the back of the queue.
  //
  // All safety checks live in lib/vm-freeze-thaw.ts:freezeVM(). The route
  // just gathers candidates and counts results.
  // ═══════════════════════════════════════════════════════════════════
  if (settings.vmLifecycleV2Enabled) {
    try {
      // Skip any VM with REAL user activity in the last 7 days. Rule 50:
      // last_user_activity_at is the only signal not contaminated by
      // platform-internal traffic (heartbeats, crons, reconcile writes).
      // The prior filter on last_proxy_call_at excluded 17/50 sleeping VMs
      // with phantom heartbeat fires from the freeze pool entirely — they
      // looked active to the cron but their owners had stopped using them
      // weeks before. Switching to last_user_activity_at brings them back
      // in. (Defense in depth: freezeVM also re-checks live via
      // `userHasRecentActivity` — fail-CLOSED on NULL — so a NULL row that
      // slips through the query is skipped at the gate, not frozen.)
      const userActivityCutoff = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { data: candidates } = await supabase
        .from("instaclaw_vms")
        .select(
          "id, name, ip_address, ssh_port, ssh_user, provider_server_id, assigned_to, credit_balance, bankr_token_address, suspended_at, status, health_status, region, lifecycle_locked_at, last_user_activity_at, frozen_image_id, freeze_consecutive_failures"
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
        // Rule 50: include NULL-activity VMs (freezeVM fails CLOSED on
        // NULL, so they don't get frozen — but including them in the
        // candidate set means the gate observes them, not the cron filter).
        .or(`last_user_activity_at.is.null,last_user_activity_at.lt.${userActivityCutoff}`)
        // v97 (2026-05-14): order by (failures ASC, suspended_at ASC) so
        // persistent failers move to the back of the queue. vm-866 + vm-873
        // sat at the head of the result set for 5+ days each because they
        // are SSH-unreachable — freezeVM's "verify silence" probe times out
        // and returns "failing closed", consuming the MAX_FREEZE_PER_RUN
        // budget every tick without making queue progress. The
        // freeze_consecutive_failures bump (see post-call update below)
        // moves them to the tail; the suspended_at tiebreaker keeps the
        // remaining queue FIFO so older suspensions free up Linode cost
        // first.
        .order("freeze_consecutive_failures", { ascending: true })
        .order("suspended_at", { ascending: true });

      logger.info("vm-lifecycle: Pass 1 v2 (freeze) — candidates queried", {
        route: "cron/vm-lifecycle", runId, count: candidates?.length ?? 0, dryRun,
      });

      let freezeAttempts = 0;
      for (const vm of candidates ?? []) {
        // v97: cap counts ONLY Linode-touching attempts. Safety skips (SSH
        // unreachable, lock held, etc.) bail before any Linode API call, so
        // they don't burn the budget. See the post-call increment below.
        // Linode's image-create rate limit (~50/hr) counts real API hits,
        // not freezeVM invocations.
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
          // Pure-observability log (2026-05-18): the 28-VM "silent skip" cohort
          // surfaced during the vm-748 incident investigation traced back to
          // this path — counter-only, no lifecycle event. Hibernating VMs sit
          // in the 90-day grace window producing zero audit trail, so a stuck
          // VM looked indistinguishable from "never reached" in the cron logs.
          if (!dryRun) {
            await logLifecycleEvent(
              supabase, vm, vm.assigned_to ?? null, "(grace)", null,
              "freeze_skipped_grace",
              `${Math.floor(daysSincePause)}d/${graceDays}d grace (${vm.health_status})`,
            );
          }
          continue;
        }

        // Protected user — never freeze (defense in depth; freezeVM also
        // re-checks Stripe live, but skip the call entirely for these).
        // Fail-closed: when the exempt list is unverifiable, treat EVERY
        // candidate as potentially protected and skip the freeze (the loud
        // one-time signal is logged at fetch time, :118).
        if (!exemptVerified || (vm.assigned_to && isProtectedUser(vm.assigned_to, exemptUserIds))) {
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
          last_user_activity_at: vm.last_user_activity_at ?? null,
        };

        // Per-VM try/catch — a single Linode API throw must NOT kill the rest
        // of the pass. Convert thrown errors into a freeze_failed result and
        // continue to the next candidate.
        //
        // v97 (2026-05-14): freezeAttempts++ moved to AFTER the call so we
        // can classify whether Linode was actually touched. See below.
        let result: Awaited<ReturnType<typeof freezeVM>>;
        let threwFromFreezeVM = false;
        try {
          result = await freezeVM(supabase, stripe, candidate, dryRun, runId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          threwFromFreezeVM = true;
          logger.error("vm-lifecycle: freezeVM threw — caught and continuing", {
            route: "cron/vm-lifecycle", runId,
            vmId: vm.id, vmName: vm.name, error: msg,
          });
          result = { success: false, reason: `freezeVM threw: ${msg.slice(0, 200)}` };
        }

        // ── SoT billing UNVERIFIABLE → skip ALL candidates this tick (Rule 14 + Lesson 2) ──
        // freezeVM returns this prefix when a Stripe sub existed but the live
        // retrieve failed, the comp-exempt read errored, or the VM row was
        // unreadable — the non-paying signal is untrustworthy. A billing-read
        // outage must NEVER cause a freeze spree on possibly-paying / possibly-
        // comp customers, so we halt the whole pass (not just this VM) and let
        // the next tick retry. Bail BEFORE the budget / freeze_consecutive_failures
        // accounting so an outage doesn't pollute queue fairness for an innocent VM.
        if (!result.success && result.reason?.startsWith(FREEZE_BILLING_UNVERIFIABLE_PREFIX)) {
          report.pass1_v2_skipped_safety++;
          logger.error(
            "vm-lifecycle: freeze billing UNVERIFIABLE — skipping ALL freeze candidates this tick",
            { route: "cron/vm-lifecycle", runId, vmId: vm.id, vmName: vm.name, reason: result.reason },
          );
          if (!dryRun) {
            await logLifecycleEvent(
              supabase, vm, vm.assigned_to ?? null, "(billing-unverifiable)", null,
              "freeze_skipped_safety", result.reason,
            );
            sendAdminAlertEmail(
              "Freeze pass halted — billing unverifiable (Stripe/exempt outage?)",
              `vm-lifecycle freeze pass skipped ALL candidates this tick because SoT billing could not be verified for ${vm.name ?? vm.id}.\nReason: ${result.reason}\nRun ID: ${runId}\n\nFail-closed (Lesson 2) — no VM frozen. If billing reads are healthy and this persists, investigate the verification path.`,
            ).catch(() => {});
          }
          break;
        }

        // v97: classify result and decide budget consumption.
        // - success → counts toward budget (real Linode op)
        // - threw from freezeVM → counts (assume Linode-side ops issued)
        // - safety-skip (SSH unreachable, lock held, credit balance, active sub,
        //   bankr token, wrong status, wrong health, no provider) → does NOT count;
        //   freezeVM bails before any Linode API call
        // - real failure (non-skip, e.g., "no ext4 disk", "image status=...")
        //   → counts (freezeVM reached Linode and got back an error)
        const isSafetySkip =
          !result.success &&
          !threwFromFreezeVM &&
          /refuse|paid credits|active|activity|failing closed|lock|wrong status|wrong health|no provider|unexpected activity-check/i.test(result.reason);
        const touchedLinode = result.success || threwFromFreezeVM || !isSafetySkip;
        if (touchedLinode) freezeAttempts++;

        // v97: freeze_consecutive_failures tracking for queue fairness.
        // - Success resets to 0 (well-behaved VM goes back to neutral)
        // - Any non-success (skip OR real failure) increments by 1 so the
        //   ORDER BY (failures ASC, suspended_at ASC) on the next tick puts
        //   persistent failers behind newer / better-behaved candidates.
        // SSH-unreachable VMs eventually exceed the queue's natural turnover
        // and get attempted last — still attempted, just deprioritized.
        if (!dryRun) {
          const currentFailures = vm.freeze_consecutive_failures ?? 0;
          const nextFailures = result.success ? 0 : currentFailures + 1;
          if (nextFailures !== currentFailures) {
            await supabase
              .from("instaclaw_vms")
              .update({ freeze_consecutive_failures: nextFailures })
              .eq("id", vm.id);
          }
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
          // Reuse isSafetySkip from above so reporting and budget accounting
          // stay consistent. isSafetySkip is already false when threwFromFreezeVM
          // is true, so genuine Linode-API exceptions correctly land in the
          // freeze_failed bucket (not freeze_skipped_safety).
          if (isSafetySkip) {
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
            action: isSafetySkip ? "SKIP" : "FAILED",
            image_id: null,
          });
          if (!dryRun) {
            await logLifecycleEvent(
              supabase, vm, vm.assigned_to ?? null, userEmail, null,
              isSafetySkip ? "freeze_skipped_safety" : "freeze_failed",
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
        // v97: budget consumption summary — should equal frozen + failed,
        // NOT include skippedSafety. If freezeAttempts equals MAX_FREEZE_PER_RUN
        // but skippedSafety > 0 and frozen+failed=0 there's a regression.
        budgetAttemptsUsed: freezeAttempts,
        budgetCap: MAX_FREEZE_PER_RUN,
        // v97: stale-image sweep counters (run before Pass 1 v2)
        pass05StaleImageCleared: report.pass05_stale_image_cleared,
        pass05ImageProbeFailed: report.pass05_image_probe_failed,
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
      .not("status", "in", '("terminated","destroyed","failed")')
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
        // Fail-closed: unverifiable exempt list → treat every candidate as
        // potentially protected, skip the (irreversible) reclaim this tick.
        if (!exemptVerified || (userId && isProtectedUser(userId, exemptUserIds))) {
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
          // Instance gone → clean up its <vm.id>.vm DNS record (best-effort,
          // never throws). dns-zone-gc is the backstop.
          await deleteVMDNSRecord(vm.id);
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

        // Step 3: Update DB. health_status MUST move atomically with status —
        // any candidate query that filters only on health_status will otherwise
        // keep selecting this row (e.g. wake-paid-hibernating, vm-lifecycle's
        // own suspended-cleanup pass below) and waste SSH budget on a Linode
        // that no longer exists.
        //
        // Clear assigned_to atomically with the status flip. The dangling-
        // assigned_to-on-terminate pattern was the root cause of the entire
        // ghost-row class fixed in 39d0e237/3914d05f/0d5499af/8ecf83d1.
        // Clearing it here makes every .eq("assigned_to", userId) lookup
        // naturally exclude terminated rows.
        //
        // The last_assigned_to stamp lives in a SEPARATE best-effort update
        // because the column has an FK to auth.users (NOT instaclaw_users) —
        // a user hard-deleted from Supabase auth will fail the FK and
        // atomically reject the whole compound update, leaving assigned_to
        // dangling. Splitting the writes guarantees the load-bearing clear
        // always succeeds; history is preserved when the user still exists.
        await supabase
          .from("instaclaw_vms")
          .update({
            status: "terminated",
            health_status: "unhealthy",
            assigned_to: null,
            assigned_at: null,
            // Per eec2cf95: null IP at terminal flip (the Linode was just
            // deleted in Step 2; nulling here also disqualifies the row from
            // any future recovery probe in case Linode reuses the IP).
            ip_address: null,
          })
          .eq("id", vm.id);
        if (vm.assigned_to) {
          const { error: stampErr } = await supabase
            .from("instaclaw_vms")
            .update({ last_assigned_to: vm.assigned_to })
            .eq("id", vm.id)
            .is("last_assigned_to", null);
          // FK violation on auth-deleted users is expected; ignore it.
          // Any OTHER error (network, RLS, etc.) is worth logging once.
          if (stampErr && !stampErr.message.includes("last_assigned_to_fkey")) {
            logger.warn("vm-lifecycle: last_assigned_to stamp failed (non-FK)", {
              route: "cron/vm-lifecycle",
              vmId: vm.id,
              error: stampErr.message,
            });
          }
        }

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
          // Pool-trim delete → clean up any <vm.id>.vm DNS record (best-effort,
          // idempotent; pool VMs may not have one, 404 is a success).
          await deleteVMDNSRecord(vm.id);
          await supabase
            .from("instaclaw_vms")
            .update({
              status: "terminated",
              health_status: "unhealthy",
              // Pool VMs typically have assigned_to=null already, but defensive
              // for the rare case where a half-assigned VM got trimmed.
              assigned_to: null,
              assigned_at: null,
              // Per eec2cf95: null IP at terminal flip (Linode was just
              // deleted; nulling disqualifies the row from recovery probes).
              ip_address: null,
            })
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
        `Skipped (user activity, Rule 50): ${orphanReport.skipped_safety}`,
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
