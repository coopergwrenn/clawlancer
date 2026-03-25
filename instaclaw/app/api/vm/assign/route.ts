import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { assignVMWithSSHCheck } from "@/lib/ssh";
import { logger } from "@/lib/logger";

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

    // For web users: verify active subscription
    // For mini app users: skip subscription check (they pay with WLD)
    if (!isMiniApp) {
      const { data: subscription } = await supabase
        .from("instaclaw_subscriptions")
        .select("status")
        .eq("user_id", targetUserId)
        .single();

      if (!subscription || !["active", "trialing"].includes(subscription.status)) {
        return NextResponse.json(
          { error: "Active subscription required. Please subscribe to a plan first." },
          { status: 403 }
        );
      }
    }

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

    // Set initial credits if provided (from WLD delegation)
    try {
      const body = await req.clone().json().catch(() => ({}));
      if (body.initialCredits && typeof body.initialCredits === "number") {
        await supabase
          .from("instaclaw_vms")
          .update({ credit_balance: body.initialCredits })
          .eq("id", vm.id);
        logger.info("Initial credits set on new VM", {
          vmId: vm.id,
          credits: body.initialCredits,
          route: "vm/assign",
        });
      }
    } catch { /* body parse failed — fine, no credits */ }

    return NextResponse.json({ assigned: true, vm });
  } catch (err) {
    logger.error("VM assign error", { error: String(err), route: "vm/assign" });
    return NextResponse.json(
      { error: "Failed to assign VM" },
      { status: 500 }
    );
  }
}
