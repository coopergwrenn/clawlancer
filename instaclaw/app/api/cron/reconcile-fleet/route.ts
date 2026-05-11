import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { auditVMConfig } from "@/lib/ssh";
import { VM_MANIFEST } from "@/lib/vm-manifest";
import { verifyManifestFreshness } from "@/lib/manifest-integrity";
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
// 2026-05-05: dropped 10 → 3 to fit under Vercel 300s maxDuration.
// Per-VM cost on stale cohort (cv=82) is ~150-300s after v87 added
// stepPrctlSubreaper (180s npm install + node-gyp) and v88 added
// build-essential to stepSystemPackages. Batch of 10 was hitting
// FUNCTION_INVOCATION_TIMEOUT and only the first VM was getting cv-bumped.
// 3 × ~300s worst case fits within budget. Throughput 60/hr (was nominally
// 200/hr but actual was ~20/hr due to timeouts).
//
// Cache-bust touch 2026-05-05 23:50 UTC: editing this file forces Vercel to
// re-run @vercel/nft on this route, which is the only way to pick up the
// outputFileTracingIncludes glob change in next.config.ts (commits 3f3443d2
// → cb4d20c3 → 48c98a93). Build cache key is per-route source file, not
// config — local builds picked up the change immediately, but every Vercel
// deploy was restoring the old route.js.nft.json. Touch comment is harmless
// and load-bearing; do not remove without re-deploying first.
//
// Cache-bust touch 2026-05-07 19:45 UTC: re-bust to force a fresh nft trace
// after the v90 four-layer reliability fix (commit 7ac0d370) added 7 new
// agents.defaults.compaction.* keys to lib/vm-manifest.ts:configSettings
// (mode, maxActiveTranscriptBytes, recentTurnsPreserve, qualityGuard.enabled,
// qualityGuard.maxRetries, notifyUser, truncateAfterCompaction). Verified on
// vm-648 (the first VM to reconcile to cv=91 post-deploy): strip-thinking.py
// had all 4 new Layer 1+3 sentinels (def compact_session_in_place_lines /
// SESSION COMPACTED: / def _extract_large_tool_results_to_cache /
// LAYER3_EXTRACTED:) but openclaw.json compaction block was the OLD shape
// (only reserveTokensFloor + memoryFlush). The reconciler bundle on Vercel
// was running pre-v90 vm-manifest.ts because Vercel's nft trace was cached
// from before the v90 deploy. Pre-flight test on vm-512 had already
// confirmed all 7 keys are schema-accepted (EXIT:0 each), so this is purely
// a build-cache problem, not a config-validity problem. Same precedent as
// the 2026-05-05 touch above. Once Vercel rebuilds with this comment, the
// next reconcile cycle will pick up the new keys for any VM at cv<91.
// Already-at-v91 VMs (vm-648, vm-043) won't auto-receive Layer 2 until the
// next manifest bump — Layer 1 (the critical nuke-prevention fix) is on
// them and protective regardless.
const CONFIG_AUDIT_BATCH_SIZE = 3;
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-11 20:02 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-11 19:46 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-05-11 19:24 UTC

// Per-VM hard timeout. A clean reconcile is 30-60s; a stale-cohort
// reconcile is 60-120s. Anything past 120s is almost certainly a slow
// SSH connection, hung command, or unrecoverable VM. Without this cap,
// a single hung VM at the head of the batch can eat the entire 300s
// Vercel budget, leaving the other 2 batch slots unprocessed.
//
// Implementation: Promise.race against a setTimeout reject. The
// in-flight SSH commands continue executing on the VM side after the
// timeout — they just stop being awaited by us. The reconciler is
// designed to be idempotent and the cv bump only happens on full
// success, so an aborted mid-flight reconcile leaves the VM at its
// prior cv and the next cron tick retries naturally.
const PER_VM_TIMEOUT_MS = 120_000;

// Auto-quarantine threshold: after K consecutive reconcile failures (cycles
// where pushFailed gate held the cv bump), set reconcile_quarantined_at and
// alert. The eligibility query above filters out quarantined VMs so they
// stop consuming cron cycles. K=10 mirrors the watchdog_consecutive_failures
// threshold (already proven). At /3min cron interval, K=10 means quarantine
// fires after ~30 min of consistent failure — fast enough to surface broken
// VMs, slow enough to absorb single transient errors. Operator manually
// clears reconcile_quarantined_at to re-enable a VM after fixing root cause.
const RECONCILE_QUARANTINE_THRESHOLD = 10;

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

  // 2b. Manifest integrity gate (D.2-A, 2026-05-09).
  //
  // Vercel's @vercel/nft trace cache has shipped stale `vm-manifest.ts`
  // to this route across multiple deploys (5e710334, 16aa97c9, e30c6a78).
  // The pre-v90 incident (20 VMs stuck at cv=91 with old configSettings
  // on disk) is the most expensive instance documented. Reactive
  // touch-route comments are not enough — a bundle that loads stale
  // VM_MANIFEST will sail through the per-step verify-after-set
  // because every key it checks was in the OLD shape too.
  //
  // Verify here, before any cv mutation: fetch the live vm-manifest.ts
  // from main on GitHub (outside the bundle, can't be cached by nft),
  // hash (version + configSettings), compare to runtime. Mismatch =
  // bundle is stale = REFUSE to bump cv this cycle. Release lock and
  // exit; next deploy will rebuild the bundle and the next cron tick
  // will pass the integrity check.
  //
  // GitHub outage / parse error / network timeout = degrade to old
  // behavior (allow cv bump). Better than halting the entire reconcile
  // pipeline on a transient GitHub blip.
  const integrity = await verifyManifestFreshness(
    VM_MANIFEST.version,
    VM_MANIFEST.configSettings,
  );
  if (integrity.ok && !integrity.fresh) {
    logger.error("reconcile-fleet: STALE BUNDLE — refusing to bump cv this cycle", {
      route: "cron/reconcile-fleet",
      runtime_version: integrity.runtime_version,
      remote_version: integrity.remote_version,
      runtime_sha: integrity.runtime_sha,
      remote_sha: integrity.remote_sha,
      action: "REFUSE_CV_BUMP_REASON_STALE_BUNDLE",
    });
    await releaseCronLock(CRON_NAME);
    return NextResponse.json({
      halted: "stale_bundle",
      runtime_version: integrity.runtime_version,
      remote_version: integrity.remote_version,
      runtime_sha: integrity.runtime_sha,
      remote_sha: integrity.remote_sha,
      action_required: "Vercel has cached a stale vm-manifest.ts. Force a redeploy (touch route.ts comment + push) and verify the next cron tick reports fresh: true.",
    }, { status: 503 });
  }
  if (!integrity.ok) {
    // Couldn't verify — degrade to old behavior (allow cv bump). Log
    // a warning so monitoring can flag prolonged github_unreachable
    // states (those would mask staleness silently).
    logger.warn("reconcile-fleet: manifest integrity check unverifiable — proceeding with caution", {
      route: "cron/reconcile-fleet",
      reason: integrity.reason,
      detail: integrity.detail,
    });
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
    //   - health_status='healthy' — see HISTORY note below.
    //   - gateway_url IS NOT NULL (skip VMs that never finished provisioning)
    //
    // Order: oldest config_version first so v55 VMs (most drifted) get
    // priority over v57 VMs (only 1 version behind).
    //
    // ── HISTORY: eligibility filter ──
    // 2026-04-28: widened from eq('healthy') → in('healthy','suspended','hibernating')
    //   so suspended/hibernating users would have current config when they
    //   came back. Each suspended VM ran with skipGatewayRestart=true so the
    //   reconcile didn't accidentally un-suspend them.
    //
    // 2026-05-09: REVERTED to eq('healthy'). The widened filter caused fleet
    //   throughput to collapse from nominal 60 VMs/hr to ~0.4 VMs/hr.
    //   Diagnosis: 45 long-dormant suspended/hibernating VMs at cv=74-80
    //   (last_health_check 2-28 days old, many SSH-degraded a la vm-726)
    //   were head-of-line blocking the 149 healthy stale VMs behind them.
    //   The cron's oldest-cv-first ordering re-picked the same broken cohort
    //   every tick, burned the full 300s Vercel budget, and made zero
    //   forward progress.
    //
    //   Why removing them is safe: suspended VMs serve no user traffic, so
    //   there's no time pressure to keep their config current. When the user
    //   pays again, wakeIfHibernating (lib/wake-vm.ts) flips health_status
    //   to 'healthy' and the VM re-enters eligibility on the next tick.
    //   Oldest-cv-first ordering puts the just-woken VM at the head of the
    //   queue (it's the most stale by definition), so reconcile happens
    //   within 1-2 ticks (3-6 min) of wake. Acceptable staleness window vs.
    //   making wake synchronous-reconcile (which would 30-90s the Stripe
    //   webhook and breach the 10s timeout).
    //
    //   skipGatewayRestart logic at the loop site is preserved (defensive —
    //   /api/admin/reconcile-vm can still be invoked manually against
    //   suspended VMs, which is the only remaining caller of that path).
    const { data: staleVms, error: queryErr } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, gateway_url, gateway_token, health_status, assigned_to, name, config_version, tier, api_mode, user_timezone, strict_hold_streak, partner, reconcile_consecutive_failures")
      .eq("status", "assigned")
      .eq("provider", "linode")
      .eq("health_status", "healthy")
      .lt("config_version", VM_MANIFEST.version)
      .not("gateway_url", "is", null)
      // Auto-quarantined VMs (K=10 consecutive reconcile failures) are
      // excluded so they stop wasting cron cycles. Operator clears the
      // quarantine flag manually after fixing the root cause. See
      // 20260511220000_reconcile_failure_tracking.sql + the
      // RECONCILE_QUARANTINE_THRESHOLD constant below.
      .is("reconcile_quarantined_at", null)
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
        // Suspended/hibernating VMs: do everything EXCEPT restart the gateway.
        // Their gateway is intentionally stopped/idle — restarting would
        // un-suspend them. Config + files land; gateway picks them up on next
        // start (reactivation flow runs auditVMConfig again, this time with
        // skipGatewayRestart=false, so the gateway gets the latest).
        const skipGatewayRestart = vm.health_status !== "healthy";
        // Per-VM hard timeout (PER_VM_TIMEOUT_MS, currently 120s). One slow
        // VM can otherwise eat the full 300s Vercel budget and starve the
        // other 2 batch slots. The thrown timeout error falls into the catch
        // block below → errored++, no cv bump, next cron cycle retries.
        const auditResult = await Promise.race([
          auditVMConfig(vm, { strict, canary: canaryEnabled, skipGatewayRestart }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `per-VM reconcile timeout after ${PER_VM_TIMEOUT_MS / 1000}s`,
                  ),
                ),
              PER_VM_TIMEOUT_MS,
            ),
          ),
        ]);
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
        const strictFailed = strict && auditResult.strictErrors.length > 0;

        // Bump-without-push gate — added 2026-04-28. Until now, any
        // result.errors from reconcileVM (file SCP failures, config-set
        // failures, npm install errors, etc.) were silently swallowed in
        // non-strict mode and the cron bumped config_version regardless.
        // That meant a VM could be marked v63 while pushes had failed.
        // Now: if auditResult.errors is non-empty, hold config_version
        // back. Logged + counted as 'errored' so it shows in the response.
        // Distinct from strictFailed: no streak/alert bookkeeping, just a
        // soft hold so next cron cycle retries naturally.
        const pushFailed = auditResult.errors.length > 0;

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
        } else if (pushFailed) {
          // Push errors → hold config_version back. Surfaces as 'errored' in
          // the response so the cron summary catches it. Next cycle
          // re-evaluates; if errors clear, we'll bump.
          //
          // 2026-05-11 P1: persist failure history per VM. The pre-fix path
          // logged warnings into Vercel cron logs that disappeared the
          // moment the function returned. 53 paying customers hit this
          // failure path for 33-86 days each with zero alerting because
          // no DB record persisted across cycles. Now: increment a
          // counter, capture the most recent error string, auto-quarantine
          // at K=10 so persistent failures stop wasting cron cycles AND
          // surface to operators via the alert + reconcile_quarantined_at
          // dashboard column.
          errored++;
          errorDetails.push({
            vmId: vm.id,
            vmName: vm.name,
            error: `push: ${auditResult.errors.slice(0, 3).join("; ")}`,
          });
          const newCounter = (vm.reconcile_consecutive_failures ?? 0) + 1;
          const errSnippet = auditResult.errors.join("; ").slice(0, 500);
          const nowIso = new Date().toISOString();
          const shouldQuarantine = newCounter >= RECONCILE_QUARANTINE_THRESHOLD;
          const update: Record<string, unknown> = {
            reconcile_consecutive_failures: newCounter,
            reconcile_last_failure_at: nowIso,
            reconcile_last_error: errSnippet,
          };
          if ((vm.reconcile_consecutive_failures ?? 0) === 0) {
            update.reconcile_first_failure_at = nowIso;
          }
          if (shouldQuarantine) {
            update.reconcile_quarantined_at = nowIso;
          }
          await supabase.from("instaclaw_vms").update(update).eq("id", vm.id);

          logger.warn("reconcile-fleet: push errors — holding config_version", {
            route: "cron/reconcile-fleet",
            vmId: vm.id,
            vmName: vm.name,
            atVersion: vm.config_version ?? 0,
            manifestVersion: VM_MANIFEST.version,
            errors: auditResult.errors,
            healthStatus: vm.health_status,
            reconcileConsecutiveFailures: newCounter,
            quarantined: shouldQuarantine,
          });

          // Alert dispatch — fire-and-forget. Two trigger points:
          //   1. First fire (counter==1): "VM started failing" — early
          //      warning so operators can investigate before quarantine
          //   2. Quarantine fire (counter>=K): "VM auto-quarantined" — the
          //      automatic "this VM needs hands-on attention" signal
          // Dedup via instaclaw_admin_alert_log (existing table).
          if (newCounter === 1 || shouldQuarantine) {
            sendReconcileFailureAlert(supabase, vm, newCounter, shouldQuarantine, auditResult.errors).catch((e) =>
              logger.error("reconcile-fleet: failure alert dispatch failed", {
                route: "cron/reconcile-fleet", vmId: vm.id, error: String(e),
              }),
            );
          }
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

          // Reset reconcile-failure history on success. If the VM was
          // quarantined, it stays quarantined until an operator manually
          // clears reconcile_quarantined_at — successful reconcile alone
          // doesn't auto-unquarantine because we want operators to
          // explicitly acknowledge the recovery (and ensure they understood
          // what was originally broken).
          if ((vm.reconcile_consecutive_failures ?? 0) > 0) {
            await supabase
              .from("instaclaw_vms")
              .update({
                reconcile_consecutive_failures: 0,
                reconcile_first_failure_at: null,
                reconcile_last_error: null,
                // NOTE: reconcile_quarantined_at NOT cleared here — operator
                // action required after they understand what was failing.
              })
              .eq("id", vm.id);
            logger.info("reconcile-fleet: reconcile_consecutive_failures reset to 0", {
              route: "cron/reconcile-fleet",
              vmId: vm.id,
              vmName: vm.name,
              priorCounter: vm.reconcile_consecutive_failures,
            });
          }

          // Bump config_version when the check passed (nothing failed strictly
          // AND no push errors). Default (non-strict, no errors) = bump.
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

/**
 * Per-VM reconcile-failure alert. Two trigger points:
 *   - first fire (counter==1): early warning that a VM started failing
 *   - quarantine fire (counter>=K): VM auto-quarantined, needs operator
 *
 * Dedup via instaclaw_admin_alert_log. Alert key includes the trigger
 * type so the two alert types deduplicate independently — a VM that
 * already triggered the "first fire" alert can still trigger a
 * "quarantine" alert when it crosses K.
 *
 * Never throws (caller fires-and-forgets) — alert delivery failures
 * must NEVER interrupt the cron.
 */
async function sendReconcileFailureAlert(
  supabase: SupabaseClient,
  vm: { id: string; name: string | null; config_version: number | null; assigned_to?: string | null },
  counter: number,
  quarantined: boolean,
  errors: string[],
): Promise<void> {
  const alertType = quarantined ? "quarantined" : "first-fire";
  const alertKey = `reconcile_failure_${alertType}:${vm.id}`;

  // Suppress if we've already sent this exact alert in the last 24h.
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id", { count: "exact", head: true })
    .eq("alert_key", alertKey)
    .gte("sent_at", oneDayAgo);
  if ((count ?? 0) > 0) {
    logger.info("reconcile-fleet: failure alert suppressed (24h dedup)", {
      route: "cron/reconcile-fleet", vmId: vm.id, alertKey,
    });
    return;
  }

  const subject = quarantined
    ? `[InstaClaw] reconcile QUARANTINED — ${vm.name ?? vm.id.slice(0, 8)} (${counter} consecutive failures)`
    : `[InstaClaw] reconcile failing — ${vm.name ?? vm.id.slice(0, 8)} (first fire)`;

  const body = [
    quarantined
      ? `VM ${vm.name ?? vm.id} (${vm.id}) has been auto-quarantined from the reconcile-fleet cron after ${counter} consecutive failures.`
      : `VM ${vm.name ?? vm.id} (${vm.id}) just started failing reconcile. Tracking for ${RECONCILE_QUARANTINE_THRESHOLD - counter} more failures before auto-quarantine.`,
    "",
    `cv:                  ${vm.config_version ?? 0}`,
    `manifest:            v${VM_MANIFEST.version}`,
    `consecutive failures: ${counter}`,
    `assigned_to:         ${vm.assigned_to ?? "(none)"}`,
    "",
    `Recent errors (most recent reconcile cycle):`,
    ...errors.slice(0, 5).map((e) => `  ${e.slice(0, 200)}`),
    "",
    quarantined ? "Operator action required:" : "If failures continue, this VM will auto-quarantine within ~30 min.",
    quarantined ? "  1. Investigate root cause via reconcile_last_error column" : "  Watch reconcile_last_error column for the specific failing step.",
    quarantined ? "  2. Fix the issue (often a step* function bug)" : "",
    quarantined ? "  3. Manually clear: UPDATE instaclaw_vms SET reconcile_quarantined_at = NULL, reconcile_consecutive_failures = 0 WHERE id = '" + vm.id + "';" : "",
    "",
    "Dashboards:",
    `  SELECT name, config_version, reconcile_consecutive_failures, reconcile_last_error FROM instaclaw_vms WHERE reconcile_consecutive_failures > 0 OR reconcile_quarantined_at IS NOT NULL ORDER BY reconcile_consecutive_failures DESC;`,
  ].join("\n");

  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: alertKey,
    vm_count: 1,
    details: `sent: ${subject}`,
  });

  await sendAdminAlertEmail(subject, body);
  logger.info("reconcile-fleet: failure alert dispatched", {
    route: "cron/reconcile-fleet",
    vmId: vm.id,
    alertKey,
    counter,
    quarantined,
  });
}
