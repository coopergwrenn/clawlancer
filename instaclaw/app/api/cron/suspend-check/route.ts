import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { stopGateway } from "@/lib/ssh";
import { logger } from "@/lib/logger";
import { fetchBillingExempt } from "@/lib/billing-status";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SUSPENSION_GRACE_DAYS = 7;
const HIBERNATE_GRACE_HOURS = 24; // 24 hours after credits + sub expire → hibernate
const WORLD_APP_ID = process.env.NEXT_PUBLIC_APP_ID || "app_a4e2de774b1bda0426e78cda2ddb8cfd";

/**
 * GET /api/cron/suspend-check
 *
 * Hibernation-aware suspension cron.
 *
 * Lifecycle:
 *   healthy → hibernating (gateway stopped, warm UX, 14 days)
 *           → suspended (VM deallocated by vm-lifecycle cron)
 *           → deleted (data wiped after 30 more days)
 *
 * Checks:
 * 0. Pre-pass: expire WLD subscriptions past their period end
 * 1. Past-due Stripe users beyond 7-day grace → hibernate
 * 2. Assigned VMs with no/canceled subscription, 0 credits, past 24h grace → hibernate
 * 3. Send push notifications on hibernate
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = getSupabase();
  const results = {
    pastDueHibernated: 0,
    noSubHibernated: 0,
    remindersSent: 0,
    errors: 0,
    skipped: 0,
    gatewayStopFailed: 0,
  };

  // NOTE: WLD users no longer get subscription records. They run on credits only.
  // The hibernate check below skips VMs with credits > 0, which protects WLD users.

  // Helper: hibernate a VM (gateway stop + warm "sleeping" status)
  async function hibernateVM(
    vm: { id: string; ip_address: string; ssh_port: number; ssh_user: string; name: string | null; assigned_to?: string | null },
    reason: string,
    extra: Record<string, unknown> = {}
  ) {
    // DB update FIRST — mark as hibernating
    await supabase
      .from("instaclaw_vms")
      .update({
        health_status: "hibernating",
        suspended_at: new Date().toISOString(),
        last_health_check: new Date().toISOString(),
      })
      .eq("id", vm.id)
      // Defensive: refuse to hibernate a row already in a terminal state.
      // All current callers select with status='assigned', but the guard
      // protects any future caller from accidentally resurrecting a ghost.
      .not("status", "in", '("terminated","destroyed","failed")');

    // Best-effort gateway stop — saves API costs immediately
    try {
      await stopGateway(vm as VMRecord);
    } catch {
      results.gatewayStopFailed++;
    }

    // Send "your agent fell asleep" push notification
    if (vm.assigned_to) {
      try {
        await sendHibernationNotification(vm.assigned_to, "start");
      } catch {
        // Non-fatal — notification failure shouldn't block hibernation
      }
    }

    logger.info(`Hibernated VM: ${reason}`, {
      route: "cron/suspend-check",
      vmId: vm.id,
      vmName: vm.name,
      ...extra,
    });
  }

  // ── Pass 1: Past-due Stripe users beyond grace → hibernate ──
  try {
    const { data: pastDueSubs } = await supabase
      .from("instaclaw_subscriptions")
      .select("user_id, past_due_since")
      .eq("payment_status", "past_due")
      .not("past_due_since", "is", null);

    if (pastDueSubs?.length) {
      const expiredUserIds = pastDueSubs
        .filter(sub => {
          const daysPastDue = (Date.now() - new Date(sub.past_due_since).getTime()) / (1000 * 60 * 60 * 24);
          return daysPastDue >= SUSPENSION_GRACE_DAYS;
        })
        .map(sub => sub.user_id);

      results.skipped += pastDueSubs.length - expiredUserIds.length;

      if (expiredUserIds.length > 0) {
        const { data: vms } = await supabase
          .from("instaclaw_vms")
          .select("id, ip_address, ssh_port, ssh_user, health_status, name, assigned_to, credit_balance, partner")
          .in("assigned_to", expiredUserIds)
          .eq("status", "assigned")
          .neq("health_status", "suspended")
          .neq("health_status", "hibernating");

        for (const vm of vms ?? []) {
          try {
            // Rule 14 credit guard (INC-2026-06-12): a past_due Stripe sub is
            // NOT grounds to hibernate a user paying by WLD credits or partner.
            // Pass 2 below already skips credit_balance > 0; Pass 1 didn't, so
            // WLD-credit users with a lapsed Stripe sub were wrongly hibernated
            // here. (Full getBillingStatusVerified SoT-ification is a tracked
            // follow-up.)
            if ((vm.credit_balance ?? 0) > 0 || vm.partner) {
              results.skipped++;
              logger.info("suspend-check Pass 1: hibernate SKIPPED — paying by credits/partner", {
                route: "cron/suspend-check", vmId: vm.id, userId: vm.assigned_to,
              });
              continue;
            }
            const sub = pastDueSubs.find(s => s.user_id === vm.assigned_to);
            const daysPastDue = sub
              ? Math.floor((Date.now() - new Date(sub.past_due_since).getTime()) / (1000 * 60 * 60 * 24))
              : 0;
            await hibernateVM(vm, "past-due beyond grace", { daysPastDue });
            results.pastDueHibernated++;
          } catch (err) {
            logger.error("Failed to hibernate past-due VM", {
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

  // ── Pass 2: No/canceled subscription + 0 credits + 24h grace → hibernate ──
  try {
    const { data: assignedVms } = await supabase
      .from("instaclaw_vms")
      .select("id, assigned_to, assigned_at, health_status, ip_address, ssh_port, ssh_user, name, credit_balance")
      .eq("status", "assigned")
      .not("assigned_to", "is", null)
      .neq("health_status", "suspended")
      .neq("health_status", "hibernating");

    if (assignedVms?.length) {
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
        // 24-hour grace period (not 3 days — WLD users may recharge quickly)
        if (vm.assigned_at) {
          const hoursSinceAssign = (Date.now() - new Date(vm.assigned_at).getTime()) / (1000 * 60 * 60);
          if (hoursSinceAssign < HIBERNATE_GRACE_HOURS) {
            results.skipped++;
            continue;
          }
        }

        const subStatus = subMap[vm.assigned_to!];

        // Skip if user has active/trialing/past_due subscription
        if (subStatus && subStatus !== "canceled") continue;

        // Skip if user has credits
        if ((vm.credit_balance ?? 0) > 0) {
          results.skipped++;
          continue;
        }

        // billing_exempt guard (Rule 67 / vm-1075 2026-06-10): comp-exempt
        // users (founder / family / partner-comp) keep their VM running even
        // with no sub + 0 credits. The exemption lives in billing-status; this
        // is the second inline suspend path (alongside the webhook
        // subscription.deleted handler) that must consult it directly.
        // Only the small set of VMs that survive the grace/sub/credit gates
        // reach this point, so the per-VM query is cheap.
        const { exempt: passExempt, exemptReason: passExemptReason, verified: passVerified } =
          await fetchBillingExempt(supabase, vm.assigned_to!);
        // F1 fail-closed: skip hibernate on exempt OR unverifiable read.
        if (passExempt || !passVerified) {
          logger.info("Pass 2: hibernate SKIPPED — billing_exempt/unverifiable", {
            route: "cron/suspend-check",
            vmId: vm.id,
            userId: vm.assigned_to,
            exempt: passExempt,
            verified: passVerified,
            exemptReason: passExemptReason,
          });
          results.skipped++;
          continue;
        }

        // No subscription (or canceled), no credits, past 24h grace → hibernate
        try {
          await hibernateVM(vm, "no subscription or credits", { subStatus: subStatus ?? "none" });
          results.noSubHibernated++;
        } catch (err) {
          logger.error("Failed to hibernate no-sub VM", {
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

  // ── Pass 3: Send 3-day reminder notifications to hibernating VMs ──
  try {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();

    // Find VMs hibernating for 3-4 days (send reminder once in that window)
    const { data: reminderVms } = await supabase
      .from("instaclaw_vms")
      .select("assigned_to")
      .eq("health_status", "hibernating")
      .not("status", "in", '("terminated","destroyed","failed")')
      .lt("suspended_at", threeDaysAgo)
      .gt("suspended_at", fourDaysAgo);

    for (const vm of reminderVms ?? []) {
      if (vm.assigned_to) {
        try {
          await sendHibernationNotification(vm.assigned_to, "reminder");
          results.remindersSent++;
        } catch {
          // Non-fatal
        }
      }
    }
  } catch {
    // Non-fatal — reminder pass failure shouldn't affect main results
  }

  logger.info("Suspend-check cron complete", { route: "cron/suspend-check", ...results });

  return NextResponse.json({
    ok: true,
    ...results,
    total: results.pastDueHibernated + results.noSubHibernated,
  });
}

// ── Push notification helper ──

async function sendHibernationNotification(userId: string, type: "start" | "reminder") {
  const apiKey = process.env.DEV_PORTAL_API_KEY;
  if (!apiKey) return;

  const supabase = getSupabase();
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("world_wallet_address")
    .eq("id", userId)
    .single();

  if (!user?.world_wallet_address) return;

  const messages = {
    start: {
      title: "Your agent fell asleep",
      message: "Add credits anytime to wake it up. Your data is safe.",
    },
    reminder: {
      title: "Your agent misses you",
      message: "It's still sleeping. Wake it up and get back to work.",
    },
  };

  const { title, message } = messages[type];

  await fetch("https://developer.worldcoin.org/api/v2/minikit/send-notification", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      app_id: WORLD_APP_ID,
      wallet_addresses: [user.world_wallet_address],
      title,
      message,
      mini_app_path: `worldapp://mini-app?app_id=${WORLD_APP_ID}`,
    }),
  });
}
