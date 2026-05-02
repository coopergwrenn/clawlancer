/**
 * GET /api/cron/wake-paid-hibernating
 *
 * Defensive net for the wake-from-hibernation bug class. Runs every 15 min.
 *
 * The primary wake paths are:
 *   Fix A — billing/webhook customer.subscription.updated (calls wakeIfHibernating)
 *   Fix B — billing/webhook invoice.payment_succeeded (restartGateway)
 *   Fix C — billing/webhook credit_pack handler + mini-app pay/confirm (calls wakeIfHibernating)
 *
 * If any of those fail (Stripe webhook delivery hiccup, code regression, new
 * code path that hibernates without a corresponding wake), THIS cron catches it.
 * 15-min interval = 15-min max-customer-downtime SLA from any future bug.
 *
 * Spec: docs/watchdog-v2-and-wake-reconciler-design.md §5
 *
 * Lessons internalized:
 *   - Lesson 2: Stripe ground-truth verification BEFORE any destructive action.
 *               This cron only WAKES (not destructive in the "delete data" sense)
 *               but we still verify before acting on a stale local DB sub status.
 *   - Lesson 3: check ALL revenue sources via lib/billing-status.ts.
 *   - Lesson 5: handle BOTH 'hibernating' AND 'suspended' states (frozen VMs
 *               have their own thawVM path elsewhere).
 *   - Lesson 7: select * to avoid silent column-grant empty rows.
 *
 * Per Cooper's spec:
 *   - Batch 10 VMs per run max
 *   - Sequential, not parallel
 *   - Halt on first SSH failure (audit log, alert, exit)
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { startGateway, checkSSHConnectivity, type VMRecord } from "@/lib/ssh";
import { getBillingStatusVerified } from "@/lib/billing-status";
import { writeAudit } from "@/lib/watchdog";
import { clearStaleAuthCache } from "@/lib/auth-cache";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — conservative; 10 VMs × 10s SSH ≈ 100s
const CRON_NAME = "wake-paid-hibernating";
const CRON_LOCK_TTL_SECONDS = 360;
const BATCH_SIZE = 10;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("wake-paid-hibernating: lock held, skipping", { route: `cron/${CRON_NAME}` });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();
  const counts = {
    candidates: 0,
    verified_paying: 0,
    not_paying: 0,
    woke: 0,
    failed: 0,
    halted_ssh: false,
    skipped_unverified: 0,
  };

  try {
    const supabase = getSupabase();
    const stripe = getStripe();

    // Lesson 5: BOTH hibernating AND suspended (frozen has its own thawVM)
    // Lesson 7: select * — never trust an explicit column list for safety-critical reads
    const { data: candidates, error } = await supabase
      .from("instaclaw_vms")
      .select("*")
      .in("health_status", ["hibernating", "suspended"])
      .not("assigned_to", "is", null)
      .order("suspended_at", { ascending: true }) // wake longest-asleep first
      .limit(BATCH_SIZE);

    if (error) {
      logger.error("wake-paid-hibernating: query failed", { route: `cron/${CRON_NAME}`, error: error.message });
      return NextResponse.json({ error: "query_failed" }, { status: 500 });
    }

    counts.candidates = candidates?.length ?? 0;
    if (!counts.candidates) {
      return NextResponse.json({ ...counts, elapsedMs: Date.now() - startedAt });
    }

    logger.info("wake-paid-hibernating: starting batch", {
      route: `cron/${CRON_NAME}`,
      batchSize: counts.candidates,
    });

    for (const vm of candidates ?? []) {
      // Validate row shape (lesson 7)
      if (!vm.id || !vm.ip_address || !vm.ssh_port || !vm.ssh_user) {
        logger.error("wake-paid-hibernating: row missing SSH fields — skipping", {
          route: `cron/${CRON_NAME}`,
          vmId: vm.id,
        });
        counts.failed++;
        continue;
      }

      // Verify against Stripe (Lesson 2): never destructively act based on
      // local DB status alone. Note: WAKING isn't strictly destructive, but
      // we don't want to wake a VM whose owner truly canceled — that's our
      // signal the VM SHOULD stay asleep.
      const billing = await getBillingStatusVerified(supabase, stripe, vm.id);

      if (!billing) {
        logger.warn("wake-paid-hibernating: billing lookup returned null — skipping", {
          route: `cron/${CRON_NAME}`,
          vmId: vm.id,
        });
        counts.failed++;
        continue;
      }

      // If verified=false (Stripe API was unreachable) AND local DB says
      // not paying, we don't wake. Better to leave a stale-DB-canceled-but-
      // really-paying customer asleep for 15 more min than to wake someone
      // who actually canceled. The defensive net cycles again next run.
      if (!billing.isPaying) {
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "wake_reconciler_skipped_not_paying",
          prior_state: vm.health_status ?? "unknown",
          new_state: vm.health_status ?? "unknown",
          reason: billing.reasons.join(","),
          meta: { stripe_verified: billing.details.stripeSubVerified, drift: billing.details.stripeDriftDetected, billing },
        });
        counts.not_paying++;
        continue;
      }

      // If we couldn't verify Stripe (transient API issue), still skip.
      // Lesson 2: don't act on unverified billing.
      if (!billing.details.stripeSubVerified && billing.details.stripeSubStatus) {
        // We had a stripe_subscription_id but couldn't verify. Skip this cycle.
        logger.warn("wake-paid-hibernating: Stripe verification unavailable — deferring", {
          route: `cron/${CRON_NAME}`,
          vmId: vm.id,
          userId: vm.assigned_to,
        });
        counts.skipped_unverified++;
        continue;
      }

      counts.verified_paying++;

      // Sequential SSH wake. HALT on first SSH failure (Cooper's spec).
      const vmRecord: VMRecord = {
        id: vm.id,
        ip_address: vm.ip_address,
        ssh_port: vm.ssh_port,
        ssh_user: vm.ssh_user,
        assigned_to: vm.assigned_to,
        region: vm.region ?? undefined,
      };

      const sshOk = await checkSSHConnectivity(vmRecord);
      if (!sshOk) {
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "wake_reconciler_halted_ssh_failure",
          prior_state: vm.health_status ?? "unknown",
          new_state: vm.health_status ?? "unknown",
          reason: "SSH unreachable — halting batch (likely network/key issue, don't compound across VMs)",
          meta: { billing },
        });
        counts.halted_ssh = true;
        counts.failed++;
        logger.error("wake-paid-hibernating: SSH unreachable — HALTING batch", {
          route: `cron/${CRON_NAME}`,
          vmId: vm.id,
          ip: vm.ip_address,
        });
        break; // halt on first SSH failure per spec
      }

      await writeAudit(supabase, {
        vm_id: vm.id,
        user_id: vm.assigned_to,
        action: "wake_reconciler_attempted",
        prior_state: vm.health_status ?? "unknown",
        new_state: "starting",
        reason: `paying customer with sleeping VM: ${billing.reasons.join(",")}`,
        meta: { billing },
      });

      let started = false;
      try {
        started = await startGateway(vmRecord);
      } catch (err) {
        logger.error("wake-paid-hibernating: startGateway threw", {
          route: `cron/${CRON_NAME}`,
          vmId: vm.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (!started) {
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "wake_reconciler_failed",
          prior_state: vm.health_status ?? "unknown",
          new_state: vm.health_status ?? "unknown",
          reason: "startGateway returned false or threw",
        });
        counts.failed++;
        continue;
      }

      // Successful start. Update DB to healthy and clear suspended_at.
      const { error: updErr } = await supabase
        .from("instaclaw_vms")
        .update({
          health_status: "healthy",
          last_health_check: new Date().toISOString(),
          // Clear suspended_at — VM is being resurrected, not asleep
          suspended_at: null,
        })
        .eq("id", vm.id);

      if (updErr) {
        await writeAudit(supabase, {
          vm_id: vm.id,
          user_id: vm.assigned_to,
          action: "wake_reconciler_failed",
          prior_state: vm.health_status ?? "unknown",
          new_state: "healthy",
          reason: `DB update failed: ${updErr.message}`,
        });
        counts.failed++;
        continue;
      }

      await writeAudit(supabase, {
        vm_id: vm.id,
        user_id: vm.assigned_to,
        action: "wake_reconciler_succeeded",
        prior_state: vm.health_status ?? "unknown",
        new_state: "healthy",
        reason: `paying customer's VM woken: ${billing.reasons.join(",")}`,
        meta: { billing },
      });

      // Defense layer 1: clear stale auth-profiles cache so the
      // health-check cleaner doesn't fire its restart-loop killer
      // on the freshly-woken VM. Best-effort.
      const cacheClear = await clearStaleAuthCache(vmRecord, "cron/wake-paid-hibernating");
      if (cacheClear.cleared > 0) {
        logger.info("wake-paid-hibernating: cleared stale auth cache", {
          route: `cron/${CRON_NAME}`,
          vmId: vm.id,
          cleared: cacheClear.cleared,
        });
      }

      logger.info("wake-paid-hibernating: woke VM", {
        route: `cron/${CRON_NAME}`,
        vmId: vm.id,
        userId: vm.assigned_to,
        priorState: vm.health_status,
        billingReasons: billing.reasons,
      });
      counts.woke++;
    }
  } finally {
    await releaseCronLock(CRON_NAME);
  }

  return NextResponse.json({
    ok: true,
    ...counts,
    elapsedMs: Date.now() - startedAt,
  });
}

