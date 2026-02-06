import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { restartGateway } from "@/lib/ssh";

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("*")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    const success = await restartGateway(vm);

    if (success) {
      await supabase
        .from("instaclaw_vms")
        .update({
          health_status: "unknown",
          last_health_check: new Date().toISOString(),
        })
        .eq("id", vm.id);
    }

    return NextResponse.json({ restarted: success });
  } catch (err) {
    console.error("VM restart error:", err);
    return NextResponse.json(
      { error: "Failed to restart VM" },
      { status: 500 }
    );
  }
}
