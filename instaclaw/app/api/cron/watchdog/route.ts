/**
 * GET /api/cron/watchdog
 *
 * Watchdog v2 — server-side, every 5 minutes. Replaces the implicit
 * restart logic in cron/health-check (which fires every ~3-6 cycles
 * with no time-based threshold and was the source of the "restart
 * healthy agents every 6 minutes" bug).
 *
 * Design goals (per docs/watchdog-v2-and-wake-reconciler-design.md):
 *   - CONSERVATIVE — false negatives (miss broken VM 15 more min) are
 *     vastly cheaper than false positives (restart healthy VM mid-convo).
 *   - DETERMINISTIC state machine in lib/watchdog.ts. No bag of if/else.
 *   - Restart only when ALL gates pass:
 *       1. Derived state == UNHEALTHY (counter≥3 AND elapsed≥15min)
 *       2. (NOW − last_restart) ≥ 20 min (cooldown)
 *       3. <3 restart attempts in last 24h (rolling quarantine)
 *       4. (NOW − last_user_activity_at) ≥ 5 min (active-user protect)
 *       5. Direct-HTTP re-probe right before restart still failing
 *       6. <50% of VMs failing this cycle (network anomaly guard)
 *       7. Customer is paying (lib/billing-status verified vs Stripe)
 *   - Privacy mode (instaclaw_users.privacy_mode_until > NOW) is checked
 *     for inspection-grade SSH operations. NOT a restart blocker — restart
 *     is infrastructure, not user data (per Cooper's clarification).
 *   - SHADOW MODE by default. Env var WATCHDOG_V2_MODE=shadow (default) |
 *     active. Shadow does everything except actual restart — full audit
 *     log so we can see what v2 WOULD do before flipping it on.
 *   - Health probe is HTTPS to public gateway URL. NOT SSH. Privacy-safe
 *     and faster.
 *
 * Spec: docs/watchdog-v2-and-wake-reconciler-design.md
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { restartGateway, type VMRecord } from "@/lib/ssh";
import { getBillingStatusVerified } from "@/lib/billing-status";
import {
  WATCHDOG_ACTIVE_USER_PROTECT_MS,
  WATCHDOG_COOLDOWN_MS,
  WATCHDOG_GLOBAL_ANOMALY_RATIO,
  WATCHDOG_QUARANTINE_RESTARTS_24H,
  WATCHDOG_TIME_THRESHOLD_MS,
  WATCHDOG_CONSECUTIVE_FAILURE_THRESHOLD,
  deriveState,
  isPrivacyModeActive,
  probeGatewayHealth,
  shouldResetRestartWindow,
  writeAudit,
  type DerivedState,
} from "@/lib/watchdog";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const CRON_NAME = "watchdog";
const CRON_LOCK_TTL_SECONDS = 360;

type WatchdogMode = "shadow" | "active";

function getMode(): WatchdogMode {
  return process.env.WATCHDOG_V2_MODE === "active" ? "active" : "shadow";
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("watchdog: lock held, skipping", { route: `cron/${CRON_NAME}` });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const mode = getMode();
  const startedAt = Date.now();
  const counts = {
    mode,
    probed: 0,
    healthy: 0,
    degraded: 0,
    unhealthy: 0,
    sleeping: 0,
    quarantined: 0,
    cooldown: 0,
    restart_attempted: 0,
    restart_succeeded: 0,
    restart_failed: 0,
    restart_skipped_active_user: 0,
    restart_skipped_unowned: 0,
    restart_skipped_billing_unverified: 0,
    restart_skipped_global_anomaly: 0,
    restart_skipped_shadow_mode: 0,
    new_quarantines: 0,
  };

  try {
    const supabase = getSupabase();
    const stripe = getStripe();

    // Lesson 7: select * for safety-critical reads.
    // Only consider VMs that are SUPPOSED to be serving (not legitimately
    // asleep). QA fix #2: exclude sleeping states at the SQL layer so we
    // don't waste 10s probe budgets per cycle on ~30 sleeping VMs that
    // would always fail the probe (gateway is intentionally stopped).
    // PostgREST `not.in` syntax: comma-separated, parens.
    const { data: vms, error } = await supabase
      .from("instaclaw_vms")
      .select("*")
      .eq("status", "assigned")
      .not("assigned_to", "is", null)
      .not("gateway_url", "is", null)
      .not("health_status", "in", "(hibernating,suspended,frozen)");

    if (error) {
      logger.error("watchdog: query failed", { route: `cron/${CRON_NAME}`, error: error.message });
      return NextResponse.json({ error: "query_failed" }, { status: 500 });
    }

    counts.probed = vms?.length ?? 0;
    if (!counts.probed) return NextResponse.json({ ok: true, ...counts, elapsedMs: Date.now() - startedAt });

    // ─── Phase 1: probe all VMs in parallel; classify state ─────────────
    // Probes are HTTPS-only. No SSH yet. This is privacy-safe and fast.
    type ProbeResult = {
      vm: typeof vms[0];
      derivedState: DerivedState;
      probeOk: boolean;
      probeReason?: string;
      probeLatencyMs: number;
    };

    // QA fix #3: bounded concurrency. Promise.all on N VMs would fan out
    // to N concurrent fetches — at fleet size 200+ this hits Vercel egress
    // and downstream connection limits. Manual semaphore at 20 concurrent.
    const PROBE_CONCURRENCY = 20;
    const queue = vms ?? [];
    const probeResults: ProbeResult[] = new Array(queue.length);
    let cursor = 0;
    async function probeWorker() {
      while (true) {
        const idx = cursor++;
        if (idx >= queue.length) return;
        const vm = queue[idx];
        if (!vm.id || !vm.gateway_url) {
          probeResults[idx] = {
            vm,
            derivedState: deriveState(vm) as DerivedState,
            probeOk: false,
            probeReason: "row_shape_invalid",
            probeLatencyMs: 0,
          };
          continue;
        }
        const probe = await probeGatewayHealth(vm.gateway_url);
        probeResults[idx] = {
          vm,
          derivedState: deriveState(vm) as DerivedState,
          probeOk: probe.ok,
          probeReason: probe.reason,
          probeLatencyMs: probe.latencyMs,
        };
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, () => probeWorker())
    );

    // Count derived states for telemetry
    for (const r of probeResults) {
      if (r.derivedState === "SLEEPING") counts.sleeping++;
      else if (r.derivedState === "QUARANTINED") counts.quarantined++;
      else if (r.derivedState === "RESTART_COOLDOWN") counts.cooldown++;
      else if (r.derivedState === "HEALTHY") counts.healthy++;
      else if (r.derivedState === "DEGRADED") counts.degraded++;
      else if (r.derivedState === "UNHEALTHY") counts.unhealthy++;
    }

    // ─── Global anomaly guard ───────────────────────────────────────────
    // If >50% of probes fail in a single cycle, assume network anomaly
    // (Vercel egress issue, DNS hiccup) and refuse to restart anyone.
    const probedConsidered = probeResults.filter(r => r.derivedState !== "SLEEPING" && r.derivedState !== "QUARANTINED");
    const failedConsidered = probedConsidered.filter(r => !r.probeOk);
    const failureRatio = probedConsidered.length > 0
      ? failedConsidered.length / probedConsidered.length
      : 0;
    const globalAnomaly = failureRatio > WATCHDOG_GLOBAL_ANOMALY_RATIO;
    if (globalAnomaly) {
      logger.error("watchdog: global anomaly suspected — halting all destructive actions this cycle", {
        route: `cron/${CRON_NAME}`,
        failureRatio,
        considered: probedConsidered.length,
        failed: failedConsidered.length,
      });
    }

    const now = Date.now();

    // ─── Phase 2: per-VM state transitions + audit + (in active mode) action ─
    for (const r of probeResults) {
      const { vm, probeOk, probeReason, derivedState, probeLatencyMs } = r;

      if (derivedState === "SLEEPING") {
        // Not watchdog's responsibility. Don't even probe-classify.
        continue;
      }

      // ──────────── HEALTHY-PATH: probe succeeded ────────────
      if (probeOk) {
        // probe_healthy audit row INTENTIONALLY NOT WRITTEN.
        //
        // 2026-05-05 audit: instaclaw_watchdog_audit had 129K rows growing
        // 1.8K/hour — 96.4% were probe_healthy no-op rows with zero
        // forensic value (no action taken; no state transition). The
        // table was the largest in the DB by 25× and Supabase flagged
        // resource exhaustion the day before Consensus launch.
        //
        // What's still written (Rule 17 forensic invariants preserved):
        //   - probe_failed: every failed probe (~1% of cycles)
        //   - reset_after_recovery: when a previously-failing VM probes
        //     healthy (rare, forensically valuable — captures recovery
        //     moments)
        //   - All restart_skipped_* (every gate that blocked a restart)
        //   - restart_attempted / restart_succeeded / restart_failed
        //   - inspection_skipped_privacy_mode, quarantined, wake_*
        //
        // The fleet-failure-ratio guard (line ~186) computes from the
        // in-memory probeResults of THIS cycle — it does NOT read the
        // audit table — so suppressing healthy rows does not affect the
        // restart gate. The watchdog state machine reads
        // watchdog_consecutive_failures from instaclaw_vms, not the
        // audit table — also unaffected. There are zero readers of the
        // audit table in the production codebase (verified via grep);
        // it is forensic-only per Rule 17.
        //
        // Reset detection (below) still runs for the rare healthy-probe-
        // after-failure case, and we still write a reset_after_recovery
        // row when it fires — that IS the moment worth recording.
        if ((vm.watchdog_consecutive_failures ?? 0) > 0 || vm.watchdog_first_failure_at) {
          await supabase
            .from("instaclaw_vms")
            .update({
              watchdog_consecutive_failures: 0,
              watchdog_first_failure_at: null,
            })
            .eq("id", vm.id);
          await writeAudit(supabase, {
            vm_id: vm.id,
            user_id: vm.assigned_to,
            action: "reset_after_recovery",
            prior_state: derivedState,
            new_state: "HEALTHY",
            consecutive_failures: 0,
            meta: { mode },
          });
        }
        continue;
      }

      // ──────────── FAILURE-PATH: probe failed ────────────
      // Increment counter, set first_failure_at if not set.
      const newFailureCount = (vm.watchdog_consecutive_failures ?? 0) + 1;
      const firstFailureAt = vm.watchdog_first_failure_at ?? new Date().toISOString();

      await supabase
        .from("instaclaw_vms")
        .update({
          watchdog_consecutive_failures: newFailureCount,
          watchdog_first_failure_at: firstFailureAt,
        })
        .eq("id", vm.id);

      // Re-derive state with the incremented counter
      const newDerivedState = deriveState({
        ...vm,
        watchdog_consecutive_failures: newFailureCount,
        watchdog_first_failure_at: firstFailureAt,
      }, now);

      await writeAudit(supabase, {
        vm_id: vm.id,
        user_id: vm.assigned_to,
        action: "probe_failed",
        prior_state: derivedState,
        new_state: newDerivedState,
        reason: probeReason,
        consecutive_failures: newFailureCount,
        meta: { mode, probeLatencyMs, gatewayUrl: vm.gateway_url },
      });

      // Only consider restart if newly UNHEALTHY
      if (newDerivedState !== "UNHEALTHY") continue;

      // ──────────── RESTART GATING ────────────
      // Each gate is its own audit row so we can see WHY a restart didn't happen.

      if (globalAnomaly) {
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "restart_skipped_global_anomaly",
          prior_state: newDerivedState,
          new_state: newDerivedState,
          reason: `${failedConsidered.length}/${probedConsidered.length} VMs failing — likely network`,
          consecutive_failures: newFailureCount,
          meta: { mode, failureRatio },
        });
        counts.restart_skipped_global_anomaly++;
        continue;
      }

      // Active-user protection (Lesson 6 — should use last_user_activity_at,
      // not last_proxy_call_at).
      // QA fix #4: proxy doesn't yet write last_user_activity_at — column
      // was backfilled at migration time and is otherwise frozen. Until the
      // proxy update lands, fall back to last_proxy_call_at as the activity
      // signal. Tradeoff: heartbeats fire every 3h and update last_proxy_call_at,
      // so a heartbeat 4 min ago will protect the VM for 1 more min — over-
      // protective by design (matches our conservative-bias spec).
      // TODO(proxy): once the proxy classifies user vs heartbeat and writes
      // last_user_activity_at on real user requests, drop the fallback.
      const lastActivityRaw = vm.last_user_activity_at ?? vm.last_proxy_call_at ?? null;
      const lastActivity = lastActivityRaw ? new Date(lastActivityRaw).getTime() : 0;
      if (now - lastActivity < WATCHDOG_ACTIVE_USER_PROTECT_MS) {
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "restart_skipped_active_user",
          prior_state: newDerivedState,
          new_state: newDerivedState,
          reason: `last_user_activity_at=${vm.last_user_activity_at} (within ${WATCHDOG_ACTIVE_USER_PROTECT_MS / 60_000} min)`,
          consecutive_failures: newFailureCount,
          meta: { mode },
        });
        counts.restart_skipped_active_user++;
        continue;
      }

      // Cooldown
      const lastRestart = vm.watchdog_last_restart_at ? new Date(vm.watchdog_last_restart_at).getTime() : 0;
      if (lastRestart && now - lastRestart < WATCHDOG_COOLDOWN_MS) {
        // shouldn't happen — derived state would be RESTART_COOLDOWN — but defensive
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "restart_skipped_cooldown",
          prior_state: newDerivedState,
          new_state: newDerivedState,
          reason: `last_restart=${vm.watchdog_last_restart_at}, < ${WATCHDOG_COOLDOWN_MS / 60_000} min ago`,
          consecutive_failures: newFailureCount,
          meta: { mode },
        });
        continue;
      }

      // Quarantine — too many restart attempts in 24h
      const windowStart = vm.watchdog_restart_attempts_24h_window_start;
      const windowReset = shouldResetRestartWindow(windowStart, now);
      const attemptsInWindow = windowReset ? 0 : (vm.watchdog_restart_attempts_24h ?? 0);
      if (attemptsInWindow >= WATCHDOG_QUARANTINE_RESTARTS_24H) {
        // Move to QUARANTINED state
        await supabase
          .from("instaclaw_vms")
          .update({ watchdog_quarantined_at: new Date().toISOString() })
          .eq("id", vm.id);
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "quarantined",
          prior_state: newDerivedState,
          new_state: "QUARANTINED",
          reason: `${attemptsInWindow} restart attempts in 24h — manual reset required`,
          consecutive_failures: newFailureCount,
          meta: { mode },
        });
        counts.new_quarantines++;
        continue;
      }

      // Billing verification — Lesson 2
      const billing = await getBillingStatusVerified(supabase, stripe, vm.id);
      if (!billing) {
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "restart_skipped_unowned",
          prior_state: newDerivedState,
          new_state: newDerivedState,
          reason: "billing lookup returned null",
          consecutive_failures: newFailureCount,
          meta: { mode },
        });
        counts.restart_skipped_unowned++;
        continue;
      }
      if (!billing.isPaying) {
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "restart_skipped_unowned",
          prior_state: newDerivedState,
          new_state: newDerivedState,
          reason: `not paying: ${billing.reasons.join(",")}`,
          consecutive_failures: newFailureCount,
          meta: { mode, billing },
        });
        counts.restart_skipped_unowned++;
        continue;
      }
      if (!billing.details.stripeSubVerified && billing.details.stripeSubStatus) {
        // Had a sub_id but Stripe call failed — defer (Lesson 2)
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "restart_skipped_billing_unverified",
          prior_state: newDerivedState,
          new_state: newDerivedState,
          reason: "Stripe API verification unavailable — deferring",
          consecutive_failures: newFailureCount,
          meta: { mode, billing },
        });
        counts.restart_skipped_billing_unverified++;
        continue;
      }

      // Privacy-mode awareness — for forward compat. Restart itself is
      // infrastructure (not reading user data) so it proceeds regardless.
      // This audit row makes it visible that the user was in privacy mode
      // when the watchdog acted.
      const privacy = await isPrivacyModeActive(supabase, vm.assigned_to, now);
      if (privacy.active) {
        // Per Cooper: privacy mode does NOT block restart (gateway restart is
        // infrastructure, not user data). It would block any deeper SSH
        // investigation. The watchdog v2 doesn't do SSH investigation, so
        // this is purely informational.
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "inspection_skipped_privacy_mode",
          prior_state: newDerivedState,
          new_state: newDerivedState,
          reason: `user in privacy mode until ${privacy.until} — restart still proceeds (infrastructure)`,
          consecutive_failures: newFailureCount,
          meta: { mode, privacy_mode_until: privacy.until },
        });
        // continue to restart — privacy mode does NOT block restart
      }

      // Re-probe right before restart — keeps the v1 false-positive guard.
      // If it now succeeds, we caught a transient and can skip the restart.
      const reprobe = await probeGatewayHealth(vm.gateway_url);
      if (reprobe.ok) {
        await supabase
          .from("instaclaw_vms")
          .update({
            watchdog_consecutive_failures: 0,
            watchdog_first_failure_at: null,
          })
          .eq("id", vm.id);
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "reset_after_recovery",
          prior_state: newDerivedState,
          new_state: "HEALTHY",
          reason: "re-probe succeeded — was a transient failure",
          consecutive_failures: 0,
          meta: { mode, reprobe_latency_ms: reprobe.latencyMs },
        });
        continue;
      }

      // ──────────── ACTUAL RESTART (or shadow log) ────────────
      counts.restart_attempted++;

      if (mode === "shadow") {
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "restart_skipped_shadow_mode",
          prior_state: newDerivedState,
          new_state: newDerivedState,
          reason: "shadow mode — would restart but env WATCHDOG_V2_MODE != active",
          consecutive_failures: newFailureCount,
          meta: { mode, billing, privacy_active: privacy.active },
        });
        counts.restart_skipped_shadow_mode++;
        continue;
      }

      // ACTIVE mode — perform the restart
      await writeAudit(supabase, {
        vm_id: vm.id,
        user_id: vm.assigned_to,
        action: "restart_attempted",
        prior_state: newDerivedState,
        new_state: "restarting",
        reason: `${WATCHDOG_CONSECUTIVE_FAILURE_THRESHOLD}+ failures over ${WATCHDOG_TIME_THRESHOLD_MS / 60_000}+ min, all gates passed`,
        consecutive_failures: newFailureCount,
        meta: { mode, billing, privacy_active: privacy.active },
      });

      let restarted = false;
      try {
        const vmRecord: VMRecord = {
          id: vm.id,
          ip_address: vm.ip_address,
          ssh_port: vm.ssh_port,
          ssh_user: vm.ssh_user,
          assigned_to: vm.assigned_to,
          region: vm.region ?? undefined,
        };
        restarted = await restartGateway(vmRecord);
      } catch (err) {
        logger.error("watchdog: restartGateway threw", {
          route: `cron/${CRON_NAME}`,
          vmId: vm.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Update restart accounting (regardless of success)
      const newAttempts = attemptsInWindow + 1;
      const newWindowStart = windowReset ? new Date().toISOString() : (windowStart ?? new Date().toISOString());
      await supabase
        .from("instaclaw_vms")
        .update({
          watchdog_last_restart_at: new Date().toISOString(),
          watchdog_restart_attempts_24h: newAttempts,
          watchdog_restart_attempts_24h_window_start: newWindowStart,
        })
        .eq("id", vm.id);

      if (restarted) {
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "restart_succeeded",
          prior_state: "restarting",
          new_state: "RESTART_COOLDOWN",
          consecutive_failures: newFailureCount,
          meta: { mode, attemptsInWindow: newAttempts, billing },
        });
        counts.restart_succeeded++;
      } else {
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "restart_failed",
          prior_state: "restarting",
          new_state: newDerivedState,
          reason: "restartGateway returned false or threw",
          consecutive_failures: newFailureCount,
          meta: { mode, attemptsInWindow: newAttempts, billing },
        });
        counts.restart_failed++;
      }
    }
  } finally {
    await releaseCronLock(CRON_NAME);
  }

  logger.info("watchdog: cycle complete", { route: `cron/${CRON_NAME}`, ...counts, elapsedMs: Date.now() - startedAt });
  return NextResponse.json({ ok: true, ...counts, elapsedMs: Date.now() - startedAt });
}
