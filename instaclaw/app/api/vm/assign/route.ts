import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { assignVMWithSSHCheck } from "@/lib/ssh";
import { logger } from "@/lib/logger";
import { logOnboardingEvent } from "@/lib/onboarding-events";

export async function POST(req: NextRequest) {
  try {
    // Dual auth: NextAuth session OR X-Mini-App-Token
    const session = await auth();
    let targetUserId = session?.user?.id;
    let isMiniApp = false;

    if (!targetUserId) {
      const { validateMiniAppToken } = await import("@/lib/security");
      targetUserId = await validateMiniAppToken(req) ?? undefined;
      isMiniApp = !!targetUserId;
    }

    if (!targetUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // If from mini app, also accept userId from body (with match enforcement)
    if (isMiniApp) {
      try {
        const body = await req.clone().json();
        if (body.userId && body.userId !== targetUserId) {
          return NextResponse.json({ error: "userId mismatch" }, { status: 403 });
        }
      } catch { /* no body — fine */ }
    }

    const supabase = getSupabase();

    // C9 FIX (revised): Detect trial abuse via World ID nullifier matching.
    // - First-time trial signups are ALWAYS allowed (zero friction).
    // - If user has World ID, check if another account with the same nullifier
    //   already had a trial/subscription → block (same human, second trial).
    // - If user has no World ID, allow (can't detect abuse, that's the tradeoff).
    if (!isMiniApp) {
      const { data: subscription } = await supabase
        .from("instaclaw_subscriptions")
        .select("status")
        .eq("user_id", targetUserId)
        .single();

      // Standard subscription check first
      if (!subscription || !["active", "trialing"].includes(subscription.status)) {
        return NextResponse.json(
          { error: "Active subscription required. Please subscribe to a plan first." },
          { status: 403 }
        );
      }

      // Trial abuse detection: only for trialing users with World ID
      if (subscription.status === "trialing") {
        const { data: user } = await supabase
          .from("instaclaw_users")
          .select("world_id_verified, world_id_nullifier_hash")
          .eq("id", targetUserId)
          .single();

        if (user?.world_id_verified && user?.world_id_nullifier_hash) {
          // Check if any OTHER account with this nullifier already had a subscription
          const { data: otherAccounts } = await supabase
            .from("instaclaw_users")
            .select("id")
            .eq("world_id_nullifier_hash", user.world_id_nullifier_hash)
            .neq("id", targetUserId);

          if (otherAccounts && otherAccounts.length > 0) {
            // Check if any of those other accounts ever had a subscription
            const otherIds = otherAccounts.map((a) => a.id);
            const { data: otherSubs } = await supabase
              .from("instaclaw_subscriptions")
              .select("user_id, status")
              .in("user_id", otherIds);

            if (otherSubs && otherSubs.length > 0) {
              logger.warn("Trial abuse detected: same World ID nullifier on multiple accounts", {
                route: "vm/assign",
                userId: targetUserId,
                nullifier: user.world_id_nullifier_hash.slice(0, 12) + "...",
                otherAccountCount: otherAccounts.length,
              });
              return NextResponse.json(
                { error: "A trial has already been used with this identity. Please subscribe to continue." },
                { status: 403 }
              );
            }
          }
        }
        // No World ID or no matching accounts → first-time trial, allow through
      }
    }

    // Mini app users skip subscription check (they pay with WLD)

    // Check if user already has a VM
    const { data: existing } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, gateway_url, control_ui_url, status")
      .eq("assigned_to", targetUserId)
      .single();

    if (existing) {
      return NextResponse.json({
        assigned: true,
        vm: existing,
      });
    }

    // Try to assign (with SSH pre-check to avoid dead VMs)
    const vm = await assignVMWithSSHCheck(targetUserId);

    if (!vm) {
      return NextResponse.json({
        assigned: false,
        message: "No VMs available. You've been added to the queue.",
      });
    }

    // Set initial credits if provided (from WLD delegation) — use RPC for audit trail
    try {
      const body = await req.clone().json().catch(() => ({}));
      if (body.initialCredits && typeof body.initialCredits === "number") {
        const { error: creditErr } = await supabase.rpc("instaclaw_add_credits", {
          p_vm_id: vm.id,
          p_credits: body.initialCredits,
          p_reference_id: `initial_wld_${targetUserId}`,
          p_source: "wld",
        });
        if (creditErr) {
          // Fallback if p_source not yet supported
          if (creditErr.message?.includes("p_source")) {
            await supabase.rpc("instaclaw_add_credits", {
              p_vm_id: vm.id,
              p_credits: body.initialCredits,
              p_reference_id: `initial_wld_${targetUserId}`,
            });
          } else {
            logger.error("Initial credits RPC failed, falling back to direct update", {
              error: String(creditErr), vmId: vm.id, route: "vm/assign",
            });
            await supabase.from("instaclaw_vms")
              .update({ credit_balance: body.initialCredits })
              .eq("id", vm.id);
          }
        }
        logger.info("Initial credits set on new VM", {
          vmId: vm.id,
          credits: body.initialCredits,
          route: "vm/assign",
        });
      }
    } catch { /* body parse failed — fine, no credits */ }

    // Onboarding journey event: a fresh VM has been bound to this user.
    // Only fires on NEW assignment (the existing-VM short-circuit above
    // returns early without reaching here).
    await logOnboardingEvent({
      userId: targetUserId,
      eventType: "vm_assigned",
      vmId: vm.id,
      metadata: {
        vm_name: (vm as { name?: string }).name ?? null,
        is_mini_app: isMiniApp,
      },
    });

    return NextResponse.json({ assigned: true, vm });
  } catch (err) {
    logger.error("VM assign error", { error: String(err), route: "vm/assign" });
    return NextResponse.json(
      { error: "Failed to assign VM" },
      { status: 500 }
    );
  }
}
