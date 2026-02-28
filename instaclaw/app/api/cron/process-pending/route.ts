import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { assignVMWithSSHCheck } from "@/lib/ssh";
import { sendVMReadyEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const MAX_CONFIGURE_ATTEMPTS = 3;

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  let assigned = 0;
  let retried = 0;

  // -----------------------------------------------------------------
  // Pass 1: Assign VMs to pending users who don't have one yet
  // -----------------------------------------------------------------
  const { data: pending } = await supabase
    .from("instaclaw_pending_users")
    .select("*, instaclaw_users!inner(email)")
    .is("consumed_at", null) // Skip already-consumed records
    .order("created_at", { ascending: true })
    .limit(10);

  if (pending?.length) {
    for (const p of pending) {
      // Skip if user already has a VM assigned (they're waiting on configure, not assignment)
      const { data: existingVm } = await supabase
        .from("instaclaw_vms")
        .select("id")
        .eq("assigned_to", p.user_id)
        .single();

      if (existingVm) continue;

      // BILLING CHECK: Never assign a VM without a valid subscription.
      // Without this, anyone who completes the onboarding wizard (creating a
      // pending_users row) but skips Stripe checkout gets a free VM.
      const { data: sub } = await supabase
        .from("instaclaw_subscriptions")
        .select("status")
        .eq("user_id", p.user_id)
        .single();

      if (!sub || !["active", "trialing"].includes(sub.status)) {
        logger.warn("Skipping VM assignment — no active subscription", {
          route: "cron/process-pending",
          userId: p.user_id,
          subscriptionStatus: sub?.status ?? "none",
        });
        continue;
      }

      // Try to assign a VM (with SSH pre-check to avoid dead VMs)
      const vm = await assignVMWithSSHCheck(p.user_id);

      if (!vm) break; // No more VMs available

      // Trigger VM configuration
      try {
        const configRes = await fetch(
          `${process.env.NEXTAUTH_URL}/api/vm/configure`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
            },
            body: JSON.stringify({ userId: p.user_id }),
          }
        );

        if (configRes.ok) {
          // Send notification email
          const userEmail = (p as Record<string, unknown>).instaclaw_users as {
            email: string;
          };
          if (userEmail?.email) {
            await sendVMReadyEmail(
              userEmail.email,
              `${process.env.NEXTAUTH_URL}/dashboard`
            );
          }
          assigned++;
        }
      } catch (err) {
        logger.error("Failed to configure VM for user", { error: String(err), route: "cron/process-pending", userId: p.user_id });
      }
    }
  }

  // -----------------------------------------------------------------
  // Pass 2: Retry failed configurations (max 3 attempts)
  // -----------------------------------------------------------------
  const { data: failedVms } = await supabase
    .from("instaclaw_vms")
    .select("assigned_to, configure_attempts")
    .eq("health_status", "configure_failed")
    .lt("configure_attempts", MAX_CONFIGURE_ATTEMPTS)
    .not("assigned_to", "is", null)
    .limit(10);

  if (failedVms?.length) {
    for (const vm of failedVms) {
      // Verify pending config still exists (needed by configure endpoint)
      const { data: hasPending } = await supabase
        .from("instaclaw_pending_users")
        .select("id")
        .eq("user_id", vm.assigned_to)
        .is("consumed_at", null)
        .single();

      if (!hasPending) continue;

      try {
        const configRes = await fetch(
          `${process.env.NEXTAUTH_URL}/api/vm/configure`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
            },
            body: JSON.stringify({ userId: vm.assigned_to }),
          }
        );

        if (configRes.ok) {
          retried++;

          // Send notification email
          const { data: user } = await supabase
            .from("instaclaw_users")
            .select("email")
            .eq("id", vm.assigned_to)
            .single();

          if (user?.email) {
            await sendVMReadyEmail(
              user.email,
              `${process.env.NEXTAUTH_URL}/dashboard`
            );
          }
        }
      } catch (err) {
        logger.error("Failed to retry configure for user", { error: String(err), route: "cron/process-pending", userId: vm.assigned_to });
      }
    }
  }

  // -----------------------------------------------------------------
  // Pass 2b: Retry VMs that were assigned + configured but gateway never
  // came up (gateway_url is null). This catches the case where configure
  // ran but the gateway didn't start — our new gateway verification logic
  // sets gateway_url to null in that case.
  // -----------------------------------------------------------------
  let gatewayRetried = 0;
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: noGatewayVms } = await supabase
    .from("instaclaw_vms")
    .select("id, assigned_to, configure_attempts")
    .not("assigned_to", "is", null)
    .is("gateway_url", null)
    .gt("configure_attempts", 0)
    .lt("configure_attempts", MAX_CONFIGURE_ATTEMPTS)
    .lt("last_health_check", fiveMinutesAgo)
    .limit(5);

  if (noGatewayVms?.length) {
    for (const vm of noGatewayVms) {
      try {
        const configRes = await fetch(
          `${process.env.NEXTAUTH_URL}/api/vm/configure`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
            },
            body: JSON.stringify({ userId: vm.assigned_to }),
          }
        );

        if (configRes.ok) {
          gatewayRetried++;
          logger.info("Retried configure for VM with no gateway_url", {
            route: "cron/process-pending",
            vmId: vm.id,
            userId: vm.assigned_to,
            attempt: vm.configure_attempts + 1,
          });
        }
      } catch (err) {
        logger.error("Failed to retry configure for no-gateway VM", {
          error: String(err),
          route: "cron/process-pending",
          vmId: vm.id,
        });
      }
    }
  }

  // -----------------------------------------------------------------
  // Pass 3: Auto-configure orphaned VMs (assigned but never configured)
  // Users who paid but never completed the onboarding wizard end up with
  // a VM assigned but configure_attempts = 0 and no pending config.
  // After 10 minutes, configure them with defaults so the gateway runs.
  // -----------------------------------------------------------------
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  let autoConfigured = 0;

  const { data: orphanedVms } = await supabase
    .from("instaclaw_vms")
    .select("id, assigned_to, assigned_at")
    .not("assigned_to", "is", null)
    .eq("configure_attempts", 0)
    .in("health_status", ["unknown", "unhealthy"])
    .lt("assigned_at", tenMinutesAgo)
    .limit(10);

  if (orphanedVms?.length) {
    for (const vm of orphanedVms) {
      // Skip if there's a pending config (standard retry logic will handle it)
      const { data: hasPending } = await supabase
        .from("instaclaw_pending_users")
        .select("id")
        .eq("user_id", vm.assigned_to)
        .is("consumed_at", null)
        .single();

      if (hasPending) continue;

      // Verify user has an active subscription (don't configure for cancelled users)
      const { data: sub } = await supabase
        .from("instaclaw_subscriptions")
        .select("status")
        .eq("user_id", vm.assigned_to)
        .single();

      if (sub?.status !== "active") continue;

      logger.info("Auto-configuring orphaned VM with defaults", {
        route: "cron/process-pending",
        userId: vm.assigned_to,
        vmId: vm.id,
        assignedAt: vm.assigned_at,
      });

      try {
        const configRes = await fetch(
          `${process.env.NEXTAUTH_URL}/api/vm/configure`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
            },
            body: JSON.stringify({ userId: vm.assigned_to }),
          }
        );

        if (configRes.ok) {
          autoConfigured++;

          const { data: user } = await supabase
            .from("instaclaw_users")
            .select("email")
            .eq("id", vm.assigned_to)
            .single();

          if (user?.email) {
            await sendVMReadyEmail(
              user.email,
              `${process.env.NEXTAUTH_URL}/dashboard`
            );
          }
        }
      } catch (err) {
        logger.error("Failed to auto-configure orphaned VM", {
          error: String(err),
          route: "cron/process-pending",
          userId: vm.assigned_to,
        });
      }
    }
  }

  // -----------------------------------------------------------------
  // Pass 4: Clean up stale pending_users (stuck for more than 10 minutes)
  // -----------------------------------------------------------------
  const { data: stalePending } = await supabase
    .from("instaclaw_pending_users")
    .select("user_id, created_at")
    .is("consumed_at", null) // Only clean up non-consumed stale records
    .lt("created_at", tenMinutesAgo)
    .limit(10);

  let cleaned = 0;
  if (stalePending?.length) {
    for (const p of stalePending) {
      // Check if they have a VM assigned (if so, don't clean up - they're just waiting for configure)
      const { data: hasVm } = await supabase
        .from("instaclaw_vms")
        .select("id")
        .eq("assigned_to", p.user_id)
        .single();

      if (hasVm) continue; // VM assigned, let retry logic handle it

      // No VM after 10 minutes - clean up and let them retry
      await supabase
        .from("instaclaw_pending_users")
        .delete()
        .eq("user_id", p.user_id);

      cleaned++;
      logger.info("Cleaned up stale pending user", {
        route: "cron/process-pending",
        userId: p.user_id,
        staleDuration: Math.floor((Date.now() - new Date(p.created_at).getTime()) / 1000 / 60),
      });
    }
  }

  // -----------------------------------------------------------------
  // Pass 5: Clean up consumed pending_users older than 24 hours.
  // Consumed records are kept as a safety net for re-configure scenarios
  // but serve no purpose after 24h.
  // -----------------------------------------------------------------
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error: consumedErr } = await supabase
    .from("instaclaw_pending_users")
    .delete()
    .not("consumed_at", "is", null)
    .lt("consumed_at", oneDayAgo);

  if (consumedErr) {
    logger.error("Failed to clean consumed pending records", {
      route: "cron/process-pending",
      error: String(consumedErr),
    });
  }

  return NextResponse.json({
    pending: pending?.length ?? 0,
    assigned,
    retried,
    gatewayRetried,
    autoConfigured,
    cleaned,
  });
}
