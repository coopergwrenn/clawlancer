import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { stopGateway } from "@/lib/ssh";
import { logger } from "@/lib/logger";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SUSPENSION_GRACE_DAYS = 7;
const NO_SUB_GRACE_DAYS = 3;

/**
 * GET /api/cron/suspend-check
 *
 * Lightweight dedicated suspension cron — runs independently from health-check.
 * Batch-fetches data to avoid N+1 queries, then suspends VMs that are past grace.
 *
 * Checks:
 * 1. Past-due users beyond 7-day grace → suspend
 * 2. Assigned VMs with no/canceled subscription beyond 3-day grace → suspend
 * 3. Logs all actions for audit
 *
 * Gateway stop is best-effort — if SSH fails, we still mark the VM as suspended.
 * The gateway will die on its own without credits, and the health cron skips
 * suspended VMs, so there's no harm in leaving the process running briefly.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = getSupabase();
  const results = { wldExpired: 0, pastDueSuspended: 0, noSubSuspended: 0, errors: 0, skipped: 0, gatewayStopFailed: 0 };

  // ── Pre-pass: expire WLD subscriptions past their period end ──
  // WLD users get subscription records with stripe_subscription_id starting
  // with "wld_". Unlike Stripe, there's no webhook to auto-cancel these.
  // This pre-pass marks expired WLD subscriptions as "canceled" so
  // Pass 2 can suspend them normally.
  try {
    const now = new Date().toISOString();
    const { data: expiredWld } = await supabase
      .from("instaclaw_subscriptions")
      .select("user_id")
      .like("stripe_subscription_id", "wld_%")
      .eq("status", "active")
      .lt("current_period_end", now);

    if (expiredWld?.length) {
      await supabase
        .from("instaclaw_subscriptions")
        .update({ status: "canceled", payment_status: "current" })
        .like("stripe_subscription_id", "wld_%")
        .eq("status", "active")
        .lt("current_period_end", now);

      results.wldExpired = expiredWld.length;
      logger.info("Expired WLD subscriptions canceled", {
        route: "cron/suspend-check",
        count: expiredWld.length,
      });
    }
  } catch (err) {
    logger.error("WLD expiry pre-pass failed", { route: "cron/suspend-check", error: String(err) });
    results.errors++;
  }

  // Helper: suspend a VM (DB update first, then best-effort SSH stop)
  async function suspendVM(vm: { id: string; ip_address: string; ssh_port: number; ssh_user: string; name: string | null }, reason: string, extra: Record<string, unknown> = {}) {
    // DB update FIRST — even if SSH fails, the VM is marked suspended
    await supabase
      .from("instaclaw_vms")
      .update({
        health_status: "suspended",
        suspended_at: new Date().toISOString(),
        last_health_check: new Date().toISOString(),
      })
      .eq("id", vm.id);

    // Best-effort gateway stop — don't block on SSH failures
    try {
      await stopGateway(vm as VMRecord);
    } catch {
      results.gatewayStopFailed++;
    }

    logger.info(`Suspended VM: ${reason}`, {
      route: "cron/suspend-check",
      vmId: vm.id,
      vmName: vm.name,
      ...extra,
    });
  }

  // ── Pass 1: Past-due users beyond grace period ──
  try {
    const { data: pastDueSubs } = await supabase
      .from("instaclaw_subscriptions")
      .select("user_id, past_due_since")
      .eq("payment_status", "past_due")
      .not("past_due_since", "is", null);

    if (pastDueSubs?.length) {
      // Filter to those past grace period
      const expiredUserIds = pastDueSubs
        .filter(sub => {
          const daysPastDue = (Date.now() - new Date(sub.past_due_since).getTime()) / (1000 * 60 * 60 * 24);
          return daysPastDue >= SUSPENSION_GRACE_DAYS;
        })
        .map(sub => sub.user_id);

      results.skipped += pastDueSubs.length - expiredUserIds.length;

      if (expiredUserIds.length > 0) {
        // Batch-fetch VMs for all expired users
        const { data: vms } = await supabase
          .from("instaclaw_vms")
          .select("id, ip_address, ssh_port, ssh_user, health_status, name, assigned_to")
          .in("assigned_to", expiredUserIds)
          .eq("status", "assigned")
          .neq("health_status", "suspended");

        for (const vm of vms ?? []) {
          try {
            const sub = pastDueSubs.find(s => s.user_id === vm.assigned_to);
            const daysPastDue = sub
              ? Math.floor((Date.now() - new Date(sub.past_due_since).getTime()) / (1000 * 60 * 60 * 24))
              : 0;
            await suspendVM(vm, "past-due beyond grace", { daysPastDue });
            results.pastDueSuspended++;
          } catch (err) {
            logger.error("Failed to suspend past-due VM", {
              route: "cron/suspend-check",
              vmId: vm.id,
              error: String(err),
            });
            results.errors++;
          }
        }
      }
    }
  } catch (err) {
    logger.error("Pass 1 (past-due) failed", { route: "cron/suspend-check", error: String(err) });
    results.errors++;
  }

  // ── Pass 2: Assigned VMs with no/canceled subscription ──
  try {
    const { data: assignedVms } = await supabase
      .from("instaclaw_vms")
      .select("id, assigned_to, assigned_at, health_status, ip_address, ssh_port, ssh_user, name, credit_balance")
      .eq("status", "assigned")
      .not("assigned_to", "is", null)
      .neq("health_status", "suspended");

    if (assignedVms?.length) {
      // Batch-fetch all subscriptions for assigned VMs
      const userIds = assignedVms.map(v => v.assigned_to!).filter(Boolean);
      const { data: allSubs } = await supabase
        .from("instaclaw_subscriptions")
        .select("user_id, status")
        .in("user_id", userIds);

      const subMap: Record<string, string> = {};
      for (const s of allSubs ?? []) {
        subMap[s.user_id] = s.status;
      }

      for (const vm of assignedVms) {
        // Skip VMs assigned less than 3 days ago
        if (vm.assigned_at) {
          const daysSinceAssign = (Date.now() - new Date(vm.assigned_at).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceAssign < NO_SUB_GRACE_DAYS) {
            results.skipped++;
            continue;
          }
        }

        const subStatus = subMap[vm.assigned_to!];

        // Skip if user has active/trialing/past_due subscription
        // (past_due handled separately in Pass 1 with its own grace period)
        if (subStatus && subStatus !== "canceled") continue;

        // Also skip if user has credits (they paid via WLD, just no Stripe sub)
        if ((vm.credit_balance ?? 0) > 0) {
          results.skipped++;
          continue;
        }

        // No subscription (or canceled), no credits, past grace → suspend
        try {
          await suspendVM(vm, "no subscription or credits", { subStatus: subStatus ?? "none" });
          results.noSubSuspended++;
        } catch (err) {
          logger.error("Failed to suspend no-sub VM", {
            route: "cron/suspend-check",
            vmId: vm.id,
            error: String(err),
          });
          results.errors++;
        }
      }
    }
  } catch (err) {
    logger.error("Pass 2 (no-sub) failed", { route: "cron/suspend-check", error: String(err) });
    results.errors++;
  }

  logger.info("Suspend-check cron complete", { route: "cron/suspend-check", ...results });

  return NextResponse.json({
    ok: true,
    ...results,
    total: results.pastDueSuspended + results.noSubSuspended,
  });
}
