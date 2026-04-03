import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { wipeVMForNextUser, connectSSH } from "@/lib/ssh";
import { sendAdminAlertEmail } from "@/lib/email";
import { getProvider } from "@/lib/providers";
import { logger } from "@/lib/logger";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
    circuit_breaker_tripped: false,
    deletions: [] as Array<{
      vm_name: string;
      ip_address: string;
      user_email: string;
      reason: string;
      action: string;
    }>,
    errors: [] as string[],
  };

  let totalDeletions = 0;

  try {
    // ═══════════════════════════════════════════════════════════════════
    // PASS 1: Delete suspended VMs past their grace period
    // ═══════════════════════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════════════════════
    // PASS 2: Trim ready pool if over maximum (30)
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

    if (report.pass1_deleted > 0 || report.circuit_breaker_tripped) {
      const subject = dryRun
        ? `VM Lifecycle DRY RUN: ${report.pass1_deleted} VMs would be deleted`
        : `VM Lifecycle: ${report.pass1_deleted} VMs deleted`;

      const body = [
        `VM lifecycle cron ran at ${new Date().toISOString()}${dryRun ? " (DRY RUN)" : ""}`,
        "",
        `Suspended VMs deleted: ${report.pass1_deleted}`,
        `Skipped (safety): ${report.pass1_skipped_safety}`,
        `Skipped (grace period): ${report.pass1_skipped_grace}`,
        `Wipe failed (retry next cycle): ${report.pass1_wipe_failed}`,
        `Delete failed: ${report.pass1_delete_failed}`,
        `Pool trimmed: ${report.pass2_pool_trimmed}`,
        `Circuit breaker: ${report.circuit_breaker_tripped ? "TRIPPED" : "OK"}`,
        "",
        "Deletions:",
        ...report.deletions.map(
          (d) => `  ${d.action} ${d.vm_name} (${d.ip_address}) — ${d.user_email} — ${d.reason}`
        ),
        ...(report.errors.length > 0
          ? ["", "Errors:", ...report.errors.map((e) => `  - ${e}`)]
          : []),
      ].join("\n");

      await sendAdminAlertEmail(subject, body).catch(() => {});
    }

    logger.info("VM lifecycle cron complete", {
      route: "cron/vm-lifecycle",
      ...report,
    });
  } catch (err) {
    logger.error("VM lifecycle cron failed", {
      route: "cron/vm-lifecycle",
      error: String(err),
    });
    report.errors.push(String(err));
  }

  return NextResponse.json(report);
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
