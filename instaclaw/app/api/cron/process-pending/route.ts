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

  return NextResponse.json({
    pending: pending?.length ?? 0,
    assigned,
    retried,
    autoConfigured,
    cleaned,
  });
}
