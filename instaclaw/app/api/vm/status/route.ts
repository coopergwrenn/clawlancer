import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Check if user has an assigned VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select(
        "id, ip_address, gateway_url, control_ui_url, status, health_status, last_health_check, assigned_at"
      )
      .eq("assigned_to", session.user.id)
      .single();

    if (vm) {
      return NextResponse.json({
        status: "assigned",
        vm: {
          id: vm.id,
          gatewayUrl: vm.gateway_url,
          controlUiUrl: vm.control_ui_url,
          healthStatus: vm.health_status,
          lastHealthCheck: vm.last_health_check,
          assignedAt: vm.assigned_at,
        },
      });
    }

    // Check if user is pending
    const { data: pending } = await supabase
      .from("instaclaw_pending_users")
      .select("created_at")
      .eq("user_id", session.user.id)
      .single();

    if (pending) {
      return NextResponse.json({
        status: "pending",
        since: pending.created_at,
      });
    }

    // Check subscription status
    const { data: sub } = await supabase
      .from("instaclaw_subscriptions")
      .select("status, tier")
      .eq("user_id", session.user.id)
      .single();

    if (sub?.status === "active") {
      return NextResponse.json({
        status: "awaiting_config",
        tier: sub.tier,
      });
    }

    return NextResponse.json({ status: "no_subscription" });
  } catch (err) {
    console.error("VM status error:", err);
    return NextResponse.json(
      { error: "Failed to check VM status" },
      { status: 500 }
    );
  }
}
