import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { checkAcpStatus, type VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, agdp_enabled")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ enabled: false, error: "No VM assigned" });
    }

    if (!vm.agdp_enabled) {
      return NextResponse.json({
        enabled: false,
        vmId: vm.id,
      });
    }

    // SSH to VM and check ACP status
    try {
      const status = await checkAcpStatus(vm as VMRecord);

      return NextResponse.json({
        enabled: true,
        vmId: vm.id,
        authenticated: status.authenticated,
        serving: status.serving,
        agentId: status.agentId,
        authUrl: status.authUrl,
        jobsCompleted: status.jobsCompleted,
      });
    } catch (sshErr) {
      logger.warn("Virtuals status: SSH failed", {
        vmId: vm.id,
        error: String(sshErr),
      });
      return NextResponse.json({
        enabled: true,
        vmId: vm.id,
        authenticated: false,
        serving: false,
        error: "Could not connect to your agent instance. Try again in a moment.",
      });
    }
  } catch (err) {
    logger.error("Virtuals status error", {
      error: String(err),
      route: "virtuals/status",
    });
    return NextResponse.json(
      { error: "Failed to fetch Virtuals Protocol status" },
      { status: 500 }
    );
  }
}
