import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/status
 *
 * Granular status endpoint for provisioning UI — matches web app's /api/vm/status.
 * Returns distinct states so the UI can show real progress, not fake timed steps.
 *
 * States:
 *   "no_vm"       — VM not assigned yet (still in assignment)
 *   "configuring"  — VM assigned, gateway not yet running
 *   "starting"     — Gateway URL set, waiting for health check to pass
 *   "ready"        — Fully operational, gateway healthy
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ status: "unauthorized" }, { status: 401 });
    }

    const { data: vm } = await supabase()
      .from("instaclaw_vms")
      .select("id, health_status, gateway_url, credit_balance, agent_name, assigned_at")
      .eq("assigned_to", session.userId)
      .single();

    if (!vm) {
      return NextResponse.json({ status: "no_vm" });
    }

    if (!vm.gateway_url) {
      return NextResponse.json({
        status: "configuring",
        vmId: vm.id,
        assignedAt: vm.assigned_at,
      });
    }

    if (vm.health_status !== "healthy") {
      return NextResponse.json({
        status: "starting",
        vmId: vm.id,
        healthStatus: vm.health_status,
      });
    }

    return NextResponse.json({
      status: "ready",
      vmId: vm.id,
      credits: vm.credit_balance,
      agentName: vm.agent_name,
    });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
