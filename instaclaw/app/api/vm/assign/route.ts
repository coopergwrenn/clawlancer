import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { assignVMWithSSHCheck } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Always use the authenticated user's ID — never accept userId from the body
    const targetUserId = session.user.id;

    const supabase = getSupabase();

    // Verify user has an active subscription before assigning a VM
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

    return NextResponse.json({ assigned: true, vm });
  } catch (err) {
    logger.error("VM assign error", { error: String(err), route: "vm/assign" });
    return NextResponse.json(
      { error: "Failed to assign VM" },
      { status: 500 }
    );
  }
}
