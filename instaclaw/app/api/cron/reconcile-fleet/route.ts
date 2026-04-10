import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { auditVMConfig } from "@/lib/ssh";
import { VM_MANIFEST } from "@/lib/vm-manifest";

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
      .select("id, ip_address, ssh_port, ssh_user, gateway_url, gateway_token, health_status, assigned_to, name, config_version, tier, api_mode")
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
    for (const vm of staleVms!) {
      try {
        const auditResult = await auditVMConfig(vm);
        audited++;

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
          });
        }

        // Bump config_version even when nothing was fixed — the check passed,
        // so this VM is verified at the current manifest version.
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
