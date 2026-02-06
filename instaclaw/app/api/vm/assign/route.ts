import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { userId } = await req.json();
    const targetUserId = userId ?? session.user.id;

    const supabase = getSupabase();

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

    // Try to assign
    const { data: vm, error } = await supabase.rpc("instaclaw_assign_vm", {
      p_user_id: targetUserId,
    });

    if (error || !vm) {
      return NextResponse.json({
        assigned: false,
        message: "No VMs available. You've been added to the queue.",
      });
    }

    return NextResponse.json({ assigned: true, vm });
  } catch (err) {
    console.error("VM assign error:", err);
    return NextResponse.json(
      { error: "Failed to assign VM" },
      { status: 500 }
    );
  }
}
