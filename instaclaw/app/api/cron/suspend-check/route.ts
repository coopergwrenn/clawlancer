import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { stopGateway } from "@/lib/ssh";
import { logger } from "@/lib/logger";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUSPENSION_GRACE_DAYS = 7;
const NO_SUB_GRACE_DAYS = 3;

/**
 * GET /api/cron/suspend-check
 *
 * Lightweight dedicated suspension cron — runs independently from health-check.
 * Only does DB queries + gateway stop. No SSH health probes, no config checks.
 *
 * Checks:
 * 1. Past-due users beyond 7-day grace → suspend
 * 2. Assigned VMs with no/canceled subscription beyond 3-day grace → suspend
 * 3. Logs all actions for audit
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = getSupabase();
  const results = { pastDueSuspended: 0, noSubSuspended: 0, errors: 0, skipped: 0 };

  // ── Pass 1: Past-due users beyond grace period ──
  try {
    const { data: pastDueSubs } = await supabase
      .from("instaclaw_subscriptions")
      .select("user_id, past_due_since")
      .eq("payment_status", "past_due")
      .not("past_due_since", "is", null);

    if (pastDueSubs?.length) {
      for (const sub of pastDueSubs) {
        const daysPastDue = Math.floor(
          (Date.now() - new Date(sub.past_due_since).getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysPastDue < SUSPENSION_GRACE_DAYS) {
          results.skipped++;
          continue;
        }

        const { data: vm } = await supabase
          .from("instaclaw_vms")
          .select("id, ip_address, ssh_port, ssh_user, health_status, name")
          .eq("assigned_to", sub.user_id)
          .single();

        if (!vm || vm.health_status === "suspended") {
          results.skipped++;
          continue;
        }

        try {
          await stopGateway(vm as VMRecord);
          await supabase
            .from("instaclaw_vms")
            .update({
              health_status: "suspended",
              suspended_at: new Date().toISOString(),
              last_health_check: new Date().toISOString(),
            })
            .eq("id", vm.id);

          logger.info("Suspended VM: past-due beyond grace", {
            route: "cron/suspend-check",
            vmId: vm.id,
            vmName: vm.name,
            daysPastDue,
          });
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
  } catch (err) {
    logger.error("Pass 1 (past-due) failed", { route: "cron/suspend-check", error: String(err) });
    results.errors++;
  }

  // ── Pass 2: Assigned VMs with no/canceled subscription ──
  try {
    const { data: assignedVms } = await supabase
      .from("instaclaw_vms")
      .select("id, assigned_to, assigned_at, health_status, ip_address, ssh_port, ssh_user, name")
      .eq("status", "assigned")
      .not("assigned_to", "is", null)
      .neq("health_status", "suspended");

    if (assignedVms?.length) {
      for (const vm of assignedVms) {
        // Skip VMs assigned less than 3 days ago
        if (vm.assigned_at) {
          const daysSinceAssign = (Date.now() - new Date(vm.assigned_at).getTime()) / (1000 * 60 * 60 * 24);
          if (daysSinceAssign < NO_SUB_GRACE_DAYS) {
            results.skipped++;
            continue;
          }
        }

        // Check subscription
        const { data: sub } = await supabase
          .from("instaclaw_subscriptions")
          .select("status")
          .eq("user_id", vm.assigned_to)
          .single();

        // Skip if user has active/trialing/past_due subscription
        // (past_due handled separately in Pass 1 with its own grace period)
        if (sub && sub.status !== "canceled") continue;

        // Also skip if user has WLD overflow credits (they paid, just no Stripe sub)
        const { data: vmCredits } = await supabase
          .from("instaclaw_vms")
          .select("credit_balance")
          .eq("id", vm.id)
          .single();

        if (vmCredits && vmCredits.credit_balance > 0) {
          results.skipped++;
          continue;
        }

        // No subscription, no credits, past grace → suspend
        try {
          await stopGateway(vm as VMRecord);
          await supabase
            .from("instaclaw_vms")
            .update({
              health_status: "suspended",
              suspended_at: new Date().toISOString(),
              last_health_check: new Date().toISOString(),
            })
            .eq("id", vm.id);

          logger.info("Suspended VM: no subscription or credits", {
            route: "cron/suspend-check",
            vmId: vm.id,
            vmName: vm.name,
            subStatus: sub?.status ?? "none",
          });
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
