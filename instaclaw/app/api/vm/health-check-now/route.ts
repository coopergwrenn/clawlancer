import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { checkHealth } from "@/lib/ssh";

export const maxDuration = 30;

/**
 * On-demand health check for the deploy page.
 * Runs a single SSH health check and updates the DB immediately,
 * so the deploy page doesn't have to wait for the 1-minute cron.
 */
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
      // Don't operate on a terminated row that still has assigned_to set
      // (vm-lifecycle's main delete doesn't clear assigned_to). Otherwise the
      // health="healthy" update below would resurrect a dead VM.
      .not("status", "in", '("terminated","destroyed","failed")')
      .single();

    if (!vm || !vm.gateway_token) {
      return NextResponse.json({ healthy: false });
    }

    // Already healthy — no need to SSH
    if (vm.health_status === "healthy") {
      return NextResponse.json({ healthy: true });
    }

    const healthy = await checkHealth(vm, vm.gateway_token);

    if (healthy) {
      await supabase
        .from("instaclaw_vms")
        .update({
          health_status: "healthy",
          last_health_check: new Date().toISOString(),
        })
        .eq("id", vm.id);
    }

    return NextResponse.json({ healthy });
  } catch {
    return NextResponse.json({ healthy: false });
  }
}
