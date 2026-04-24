import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { auditVMConfig } from "@/lib/ssh";
import { VM_MANIFEST } from "@/lib/vm-manifest";
import { sendAdminAlertEmail } from "@/lib/email";
import * as crypto from "crypto";

// ─── Vercel cron config ────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
// 5-min ceiling. A clean reconcile is ~30-60s per VM, so a batch of 10
// fits in ~5 min worst case. Lock TTL must EXCEED this so the next cron
// can never start a concurrent batch.
export const maxDuration = 300;

// ─── Constants ─────────────────────────────────────────────────────────────

const CRON_NAME = "reconcile-fleet";
const LOCK_TTL_SECONDS = 360; // > maxDuration with 60s headroom
const CONFIG_AUDIT_BATCH_SIZE = 10;

/**
 * Strict-mode allowlist. Comma-separated VM UUIDs. Any VM whose id is in
 * this set is reconciled in strict mode for this cron cycle:
 *   - config set failures are captured (not swallowed by `|| true`)
 *   - a canary round-trip probe runs after writes
 *   - config_version is NOT advanced unless strictErrors=[] and canary passes
 *
 * Empty (default) = zero VMs in strict mode = behavior identical to pre-2c.
 * This is the rollout surface for stages 1/2/3 of the strict-mode migration:
 *   - stage 1: 3 canary VMs
 *   - stage 2: 20 mixed-version VMs
 *   - stage 3: full fleet
 */
function getStrictVmIds(): Set<string> {
  const raw = (process.env.STRICT_RECONCILE_VM_IDS ?? "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

// ─── Route handler ─────────────────────────────────────────────────────────

/**
 * Dedicated fleet reconciler.
 *
 * Purpose: push VM_MANIFEST drift to assigned VMs whose config_version is
 * behind the current manifest version. Previously this lived inside
 * /api/cron/health-check as "Pass 4" but it was starved by the ~10 earlier
 * passes consuming most of the 600s health-check budget — observed throughput
 * was ~1-2 VMs per cron run instead of the configured 10, so backlog clearing
 * took 4-8 hours.
 *
 * This route runs ONLY the audit pass with its own dedicated 300s budget.
 * Same batch size (10), same per-VM logic (auditVMConfig → reconcileVM),
 * same DB update (bump config_version after success). Just isolated.
 *
 * Schedule: every 3 minutes (see vercel.json)
 * Throughput: 10 VMs × 20 cron runs/hour = 200 audits/hour
 * Backlog clear time at 86 stale VMs: ~26 minutes
 */
export async function GET(req: NextRequest) {
  // 1. Auth — same Bearer pattern as all other crons
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Distributed lock — race-safe via instaclaw_cron_locks PK constraint.
  // Without this, two overlapping cron runs (e.g., previous run took 5+ min
  // and a new tick fires) could double-process the same batch.
  const lockAcquired = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("reconcile-fleet: lock held, skipping", {
      route: "cron/reconcile-fleet",
    });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startMs = Date.now();
  let candidates = 0;
  let audited = 0;
  let fixed = 0;
  let errored = 0;
  const errorDetails: { vmId: string; vmName: string | null; error: string }[] = [];
  // Max strict_hold_streak observed across this batch. Surfaced in response
  // so we see the worst case without a follow-up DB query.
  let response_strict_hold_streak_max = 0;

  try {
    const supabase = getSupabase();

    // 3. Pull stale assigned VMs.
    //
    // Filters:
    //   - status="assigned" (the only VMs that benefit from reconciliation;
    //     ready pool VMs are handled by the snapshot itself)
    //   - config_version < VM_MANIFEST.version (the staleness signal)
    //   - health_status="healthy" (proxy for SSH-reachable; the main
    //     health-check cron maintains this. Skipping unhealthy/unknown
    //     avoids hammering broken VMs that would just throw inside
    //     auditVMConfig and waste the budget)
    //   - gateway_url IS NOT NULL (skip VMs that never finished provisioning)
    //
    // Order: oldest config_version first so v55 VMs (most drifted) get
    // priority over v57 VMs (only 1 version behind).
    const { data: staleVms, error: queryErr } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, gateway_url, gateway_token, health_status, assigned_to, name, config_version, tier, api_mode, user_timezone, strict_hold_streak")
      .eq("status", "assigned")
      .eq("provider", "linode")
      .eq("health_status", "healthy")
      .lt("config_version", VM_MANIFEST.version)
      .not("gateway_url", "is", null)
      .order("config_version", { ascending: true, nullsFirst: true })
      .limit(CONFIG_AUDIT_BATCH_SIZE);

    if (queryErr) {
      logger.error("reconcile-fleet: stale-VM query failed", {
        route: "cron/reconcile-fleet",
        error: queryErr.message,
      });
      return NextResponse.json(
        { error: "DB query failed", detail: queryErr.message },
        { status: 500 }
      );
    }

    candidates = staleVms?.length ?? 0;

    if (candidates === 0) {
      logger.info("reconcile-fleet: no stale VMs", {
        route: "cron/reconcile-fleet",
        manifestVersion: VM_MANIFEST.version,
      });
      return NextResponse.json({
        candidates: 0,
        audited: 0,
        fixed: 0,
        errored: 0,
        manifestVersion: VM_MANIFEST.version,
        durationMs: Date.now() - startMs,
      });
    }

    logger.info("reconcile-fleet: starting batch", {
      route: "cron/reconcile-fleet",
      candidates,
      manifestVersion: VM_MANIFEST.version,
      vmIds: staleVms!.map((v) => v.id),
    });

    // 4. Process each stale VM sequentially. Sequential (not Promise.all)
    // matches the previous health-check Pass 4 behavior and avoids
    // 10 concurrent SSH connections + 10 concurrent openclaw config-set
    // chains, which could trip rate limits or DB pool exhaustion. If the
    // throughput becomes a problem we can revisit (Fix B in the audit doc).
    const strictVmIds = getStrictVmIds();

    // ── Phase 2c runtime kill switches ──
    // DB-backed flags in instaclaw_admin_settings. Read once per cron
    // invocation (not per VM) so we have a consistent view for this batch.
    // Flipping either row in Supabase UI takes effect on the NEXT cron
    // fire (≤3 min). This beats env-var rollback which requires a redeploy.
    const { strictModeEnabled, canaryEnabled } = await readStrictKillSwitches(supabase);

    // If strict_mode_enabled=false, every VM runs legacy mode regardless of
    // the STRICT_RECONCILE_VM_IDS env allowlist. This is the "stop everything
    // strict" kill. Bypasses the strict gate entirely — config_version bumps
    // like pre-2c.
    const strictEnabledForBatch = strictModeEnabled && strictVmIds.size > 0;

    if (!strictModeEnabled && strictVmIds.size > 0) {
      logger.warn("reconcile-fleet: strict_mode_enabled=false in DB — ignoring STRICT_RECONCILE_VM_IDS", {
        route: "cron/reconcile-fleet",
        envAllowlistSize: strictVmIds.size,
      });
    }

    let strictHeld = 0; // Count of VMs held back from config_version bump in this batch
    let strictProbes = 0;
    let strictClean = 0;
    let canariesSkippedBudget = 0;
    const batchHolds: Array<{ vmId: string; vmName: string | null; streak: number; errors: string[] }> = [];

    for (const vm of staleVms!) {
      try {
        const strict = strictEnabledForBatch && strictVmIds.has(vm.id);
        const auditResult = await auditVMConfig(vm, {
          strict,
          canary: canaryEnabled,
        });
        audited++;
        if (strict) {
          strictProbes++;
          if (auditResult.canarySkippedBudget) canariesSkippedBudget++;
        }

        if (auditResult.fixed.length > 0) {
          fixed++;
          logger.info("reconcile-fleet: drift fixed", {
            route: "cron/reconcile-fleet",
            vmId: vm.id,
            vmName: vm.name,
            fromVersion: vm.config_version ?? 0,
            toVersion: VM_MANIFEST.version,
            fixed: auditResult.fixed,
            alreadyCorrect: auditResult.alreadyCorrect.length,
            strict,
          });
        }

        // Strict gate — hold config_version back ONLY when strictErrors is
        // non-empty. Canary failure already pushes a "canary: ..." entry
        // into strictErrors (see stepCanaryProbe), so no separate canary
        // branch is needed here. Unit-tested for equivalence across all
        // cases — see lib/__tests__/vm-reconcile-strict.test.ts.
        // Default (non-strict) path behaves EXACTLY as before: strictErrors=[]
        // from reconcileVM, so this block is a no-op.
        const strictFailed = strict && auditResult.strictErrors.length > 0;

        if (strictFailed) {
          strictHeld++;

          // ── Persist the hold event + advance streak (atomic-ish) ──
          // 1. Bump streak on the VM and capture the new value.
          const { data: streakRow } = await supabase
            .from("instaclaw_vms")
            .update({ strict_hold_streak: (vm.strict_hold_streak ?? 0) + 1 })
            .eq("id", vm.id)
            .select("strict_hold_streak")
            .single();
          const newStreak = streakRow?.strict_hold_streak ?? ((vm.strict_hold_streak ?? 0) + 1);

          // 2. Append to the event log.
          await supabase.from("instaclaw_strict_holds").insert({
            vm_id: vm.id,
            strict_errors: auditResult.strictErrors,
            canary_healthy: auditResult.canaryHealthy,
            at_version: vm.config_version ?? 0,
            manifest_version: VM_MANIFEST.version,
            strict_hold_streak: newStreak,
          });

          batchHolds.push({
            vmId: vm.id,
            vmName: vm.name,
            streak: newStreak,
            errors: auditResult.strictErrors,
          });

          logger.error("reconcile-fleet: strict-mode failure — holding config_version", {
            route: "cron/reconcile-fleet",
            vmId: vm.id,
            vmName: vm.name,
            strictErrors: auditResult.strictErrors,
            canaryHealthy: auditResult.canaryHealthy,
            atVersion: vm.config_version ?? 0,
            manifestVersion: VM_MANIFEST.version,
            streak: newStreak,
          });
          errorDetails.push({
            vmId: vm.id,
            vmName: vm.name,
            error: `strict: ${auditResult.strictErrors.slice(0, 3).join("; ")}`,
          });

          // 3. Per-VM alerting with fire-first-then-escalate dedup.
          //    Fire-and-forget — never block the cron on email delivery.
          sendPerVmHoldAlert(supabase, vm, auditResult, newStreak).catch((e) =>
            logger.error("reconcile-fleet: per-VM alert dispatch failed", {
              route: "cron/reconcile-fleet", vmId: vm.id, error: String(e),
            }),
          );
        } else {
          if (strict) strictClean++;

          // Reset streak if this VM was previously holding.
          if ((vm.strict_hold_streak ?? 0) > 0) {
            await supabase
              .from("instaclaw_vms")
              .update({ strict_hold_streak: 0 })
              .eq("id", vm.id);
            logger.info("reconcile-fleet: strict_hold_streak reset to 0", {
              route: "cron/reconcile-fleet",
              vmId: vm.id,
              vmName: vm.name,
              priorStreak: vm.strict_hold_streak,
            });
          }

          // Bump config_version when the check passed (nothing failed strictly,
          // or we're in non-strict mode where strictErrors is always empty).
          const { error: updateErr } = await supabase
            .from("instaclaw_vms")
            .update({ config_version: VM_MANIFEST.version })
            .eq("id", vm.id);

          if (updateErr) {
            logger.error("reconcile-fleet: config_version bump failed", {
              route: "cron/reconcile-fleet",
              vmId: vm.id,
              vmName: vm.name,
              error: updateErr.message,
            });
          }
        }
      } catch (err) {
        errored++;
        const msg = err instanceof Error ? err.message : String(err);
        errorDetails.push({ vmId: vm.id, vmName: vm.name, error: msg });
        logger.error("reconcile-fleet: audit failed", {
          route: "cron/reconcile-fleet",
          vmId: vm.id,
          vmName: vm.name,
          error: msg,
        });
        // Continue to next VM rather than aborting the batch.
      }
    }

    if (strictHeld > 0) {
      logger.warn("reconcile-fleet: strict holds in batch", {
        route: "cron/reconcile-fleet",
        strictHeld,
        strictAllowlistSize: strictVmIds.size,
      });

      // Batch summary email — one per cron invocation, regardless of hold count.
      // Intentionally separate from per-VM emails (Cooper's spec: "20 emails
      // if 20 VMs hold, AND a batch summary"). Fire-and-forget.
      sendBatchSummaryAlert(supabase, batchHolds, strictHeld, audited, strictVmIds.size).catch((e) =>
        logger.error("reconcile-fleet: batch summary alert failed", {
          route: "cron/reconcile-fleet", error: String(e),
        }),
      );
    }

    // ── Daily stats upsert — fire-and-forget aggregate ──
    // One UPSERT per cron invocation into instaclaw_strict_daily_stats.
    // Lets ops answer "is strict mode still running?" with a single-row
    // lookup instead of counting strict_hold events.
    if (strictProbes > 0 || strictHeld > 0) {
      const now = new Date();
      const statDate = now.toISOString().split("T")[0];
      const streakMaxThisBatch = batchHolds.reduce((m, h) => Math.max(m, h.streak), 0);
      upsertDailyStats(supabase, statDate, {
        probesRun: strictProbes,
        probesClean: strictClean,
        probesHeld: strictHeld,
        probesErrored: errored,
        canariesSkippedBudget,
        now,
      }).catch((e) =>
        logger.error("reconcile-fleet: daily stats upsert failed", {
          route: "cron/reconcile-fleet", error: String(e),
        }),
      );
      // Surface max streak in the response so callers see the worst case
      // without needing a follow-up DB query.
      response_strict_hold_streak_max = streakMaxThisBatch;
    }

    const durationMs = Date.now() - startMs;
    logger.info("reconcile-fleet: batch complete", {
      route: "cron/reconcile-fleet",
      candidates,
      audited,
      fixed,
      errored,
      durationMs,
      manifestVersion: VM_MANIFEST.version,
    });

    return NextResponse.json({
      candidates,
      audited,
      fixed,
      errored,
      strictHeld,
      strictAllowlistSize: strictVmIds.size,
      strict_hold_streak_max: response_strict_hold_streak_max,
      errorDetails: errorDetails.slice(0, 10), // Cap response size
      manifestVersion: VM_MANIFEST.version,
      durationMs,
    });
  } catch (err) {
    logger.error("reconcile-fleet: unhandled error", {
      route: "cron/reconcile-fleet",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  } finally {
    // 5. Always release the lock — finally block guarantees cleanup even
    // on uncaught throws so the next cron run isn't blocked.
    await releaseCronLock(CRON_NAME);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

type SupabaseClient = ReturnType<typeof getSupabase>;

/**
 * Read the DB-backed runtime kill switches. Fail-safe: if the settings table
 * is unreachable or missing rows, default to {strict_mode_enabled: true,
 * canary_enabled: true} so a partial outage of the settings row doesn't
 * secretly disable strict mode.
 */
async function readStrictKillSwitches(supabase: SupabaseClient): Promise<{
  strictModeEnabled: boolean;
  canaryEnabled: boolean;
}> {
  try {
    const { data } = await supabase
      .from("instaclaw_admin_settings")
      .select("setting_key, bool_value")
      .in("setting_key", ["strict_mode_enabled", "canary_enabled"]);
    const map = new Map<string, boolean | null | undefined>();
    for (const row of data ?? []) map.set(row.setting_key, row.bool_value);
    return {
      // Missing row or null = default-on. Explicit false = off.
      strictModeEnabled: map.get("strict_mode_enabled") !== false,
      canaryEnabled: map.get("canary_enabled") !== false,
    };
  } catch (err) {
    logger.warn("reconcile-fleet: readStrictKillSwitches failed, defaulting ON", {
      route: "cron/reconcile-fleet",
      error: String(err),
    });
    return { strictModeEnabled: true, canaryEnabled: true };
  }
}

/**
 * Error-set dedup key. Same VM + same set of strict errors → same alert key.
 * A sorted + joined + sha1-truncated digest keeps the key short and stable
 * across "same errors in different order" variations.
 */
function strictHoldAlertKey(vmId: string, strictErrors: string[]): string {
  const sorted = [...strictErrors].sort().join("|");
  const hash = crypto.createHash("sha1").update(sorted).digest("hex").slice(0, 16);
  return `strict_hold:${vmId}:${hash}`;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const PERSISTENT_HOLD_THRESHOLD = 5;

/**
 * Per-VM strict-hold alerting with fire-first-then-escalate dedup.
 *
 *   1st occurrence of (vm, error_set) in the last hour → send "Strict hold fired" email.
 *   2nd–4th → suppressed (event still logged to instaclaw_strict_holds — this is
 *             about ALERT volume, not about losing data).
 *   5th → send "PERSISTENT strict hold" email ("this one's stuck, stop ignoring").
 *   6th+ → suppressed until the hourly window resets.
 *
 * Dedup tracked via instaclaw_admin_alert_log rows keyed by
 * `strict_hold:{vmId}:{error_hash}`.
 *
 * All DB writes wrapped in try/catch — alert dispatch MUST NOT interrupt
 * the main reconcile path.
 */
async function sendPerVmHoldAlert(
  supabase: SupabaseClient,
  vm: { id: string; name: string | null; config_version: number | null },
  audit: {
    strictErrors: string[];
    canaryHealthy: boolean | null;
  },
  newStreak: number,
): Promise<void> {
  const alertKey = strictHoldAlertKey(vm.id, audit.strictErrors);
  const oneHourAgo = new Date(Date.now() - ONE_HOUR_MS).toISOString();

  // Count how many times this (vm, error_set) fired in the last hour.
  const { count } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id", { count: "exact", head: true })
    .eq("alert_key", alertKey)
    .gte("sent_at", oneHourAgo);

  const occurrencesInHour = (count ?? 0) + 1; // +1 for the current event

  // Policy:
  //   occurrencesInHour === 1          → send "Strict hold fired" (first-fire email)
  //   occurrencesInHour === THRESHOLD  → send "PERSISTENT hold" (escalation email)
  //   other                            → suppress
  let subject: string | null = null;
  let body: string | null = null;
  const canaryStr =
    audit.canaryHealthy === true ? "healthy" : audit.canaryHealthy === false ? "failed" : "skipped";

  if (occurrencesInHour === 1) {
    subject = `[InstaClaw] Strict reconcile held — ${vm.name ?? vm.id.slice(0, 8)}`;
    body = [
      `VM ${vm.name ?? vm.id} (${vm.id}) was held at config_version ${vm.config_version ?? 0} during reconcile.`,
      "",
      `Manifest version: v${VM_MANIFEST.version} (gap: ${VM_MANIFEST.version - (vm.config_version ?? 0)})`,
      `Canary: ${canaryStr}`,
      `Strict hold streak: ${newStreak} consecutive cycles`,
      "",
      `Strict errors (${audit.strictErrors.length}):`,
      ...audit.strictErrors.map((e) => `  ${e}`),
      "",
      "Next action:",
      "  - Full history: GET /api/admin/strict-holds?vmId=" + vm.id,
      "  - If manifest-wide issue: revert the manifest bump",
      "  - If VM-specific: remove from STRICT_RECONCILE_VM_IDS + inspect manually",
      "",
      `Event log: SELECT * FROM instaclaw_strict_holds WHERE vm_id = '${vm.id}' ORDER BY event_time DESC LIMIT 10`,
    ].join("\n");
  } else if (occurrencesInHour === PERSISTENT_HOLD_THRESHOLD) {
    subject = `[InstaClaw] PERSISTENT strict hold — ${vm.name ?? vm.id.slice(0, 8)} (${PERSISTENT_HOLD_THRESHOLD}× in last hour)`;
    body = [
      `VM ${vm.name ?? vm.id} has hit strict reconcile ${PERSISTENT_HOLD_THRESHOLD} consecutive times`,
      `in the last hour with the SAME errors. Further identical holds this hour`,
      "will be suppressed (still recorded in DB).",
      "",
      "Most recent error set:",
      ...audit.strictErrors.map((e) => `  ${e}`),
      "",
      `Canary: ${canaryStr}`,
      `Total hold streak: ${newStreak}`,
      `This hour: ${occurrencesInHour} fires`,
      "",
      "This is NOT a transient issue. The manifest or the VM has a real",
      "problem that the reconciler cannot self-heal. Manual investigation",
      "required.",
      "",
      `Event log: SELECT * FROM instaclaw_strict_holds WHERE vm_id = '${vm.id}' ORDER BY event_time DESC LIMIT 10`,
    ].join("\n");
  }

  // Always record the event in the alert log (even when suppressed) so the
  // count query above reflects all fires.
  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: alertKey,
    vm_count: 1,
    details: subject ? `sent: ${subject}` : `suppressed: occurrence ${occurrencesInHour}`,
  });

  if (subject && body) {
    await sendAdminAlertEmail(subject, body);
    logger.info("reconcile-fleet: per-VM alert dispatched", {
      route: "cron/reconcile-fleet",
      vmId: vm.id,
      alertKey,
      occurrencesInHour,
      type: occurrencesInHour === 1 ? "first-fire" : "persistent",
    });
  } else {
    logger.info("reconcile-fleet: per-VM alert suppressed (dedup)", {
      route: "cron/reconcile-fleet",
      vmId: vm.id,
      alertKey,
      occurrencesInHour,
    });
  }
}

/**
 * Batch summary email — one per cron invocation if any VMs held strict.
 * Not deduplicated; Cooper's spec is intentional: one email per batch, always.
 */
async function sendBatchSummaryAlert(
  _supabase: SupabaseClient,
  batchHolds: Array<{ vmId: string; vmName: string | null; streak: number; errors: string[] }>,
  strictHeld: number,
  audited: number,
  strictAllowlistSize: number,
): Promise<void> {
  // Top 5 by streak (persistent ones most worth surfacing).
  const top5 = [...batchHolds].sort((a, b) => b.streak - a.streak).slice(0, 5);

  const subject = `[InstaClaw] reconcile-fleet batch: ${strictHeld} VMs held`;
  const body = [
    `Cron run at ${new Date().toISOString()} held ${strictHeld} / ${audited} VMs at their current config_version.`,
    "",
    `Manifest version:      v${VM_MANIFEST.version}`,
    `Strict allowlist size: ${strictAllowlistSize}`,
    "",
    "Top 5 offenders (by strict_hold_streak):",
    ...top5.map(
      (h, i) =>
        `  ${i + 1}. ${h.vmName ?? h.vmId.slice(0, 8)} streak=${h.streak} errors: [${h.errors.slice(0, 2).join("; ")}]`,
    ),
    "",
    "Full list of held VMs in this batch:",
    ...batchHolds.map((h) => `  ${h.vmId}  ${h.vmName ?? "(no name)"}  streak=${h.streak}`),
    "",
    "Dashboards:",
    "  GET https://instaclaw.io/api/admin/strict-holds",
    "  Supabase: SELECT * FROM instaclaw_strict_daily_stats ORDER BY stat_date DESC LIMIT 7;",
  ].join("\n");

  await sendAdminAlertEmail(subject, body);
}

/**
 * UPSERT one row per day into instaclaw_strict_daily_stats. Additive on
 * existing counters when called multiple times (e.g., multiple cron runs in
 * the same day). The "is strict mode still running?" query looks up
 * yesterday's row: if probes_run = 0 despite a non-empty allowlist, strict
 * mode stopped firing and needs investigation.
 */
async function upsertDailyStats(
  supabase: SupabaseClient,
  statDate: string,
  delta: {
    probesRun: number;
    probesClean: number;
    probesHeld: number;
    probesErrored: number;
    canariesSkippedBudget: number;
    now: Date;
  },
): Promise<void> {
  const { probesRun, probesClean, probesHeld, probesErrored, canariesSkippedBudget, now } = delta;

  // Do NOT rely on upsert() here — Supabase's PostgREST upsert can't do
  // "incremental counter" semantics. Read-modify-write is the portable path,
  // and per-cron serialization via cron lock means no race with itself.
  const { data: existing } = await supabase
    .from("instaclaw_strict_daily_stats")
    .select("*")
    .eq("stat_date", statDate)
    .maybeSingle();

  if (existing) {
    await supabase
      .from("instaclaw_strict_daily_stats")
      .update({
        probes_run: (existing.probes_run ?? 0) + probesRun,
        probes_clean: (existing.probes_clean ?? 0) + probesClean,
        probes_held: (existing.probes_held ?? 0) + probesHeld,
        probes_errored: (existing.probes_errored ?? 0) + probesErrored,
        canaries_skipped_budget:
          (existing.canaries_skipped_budget ?? 0) + canariesSkippedBudget,
        last_probe_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("stat_date", statDate);
  } else {
    await supabase.from("instaclaw_strict_daily_stats").insert({
      stat_date: statDate,
      probes_run: probesRun,
      probes_clean: probesClean,
      probes_held: probesHeld,
      probes_errored: probesErrored,
      canaries_skipped_budget: canariesSkippedBudget,
      first_probe_at: now.toISOString(),
      last_probe_at: now.toISOString(),
    });
  }
}
