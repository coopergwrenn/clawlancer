import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * GET /api/vm/dispatch-status
 *
 * Returns the status of the dispatch relay (user's computer connection).
 * Checks the dispatch-server Unix socket on the user's VM.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, tier")
      .eq("assigned_to", session.user.id)
      .eq("status", "assigned")
      .single();

    if (!vm) {
      return NextResponse.json({ connected: false, dispatchServer: false, error: "No VM assigned" });
    }

    // Remote dispatch requires Pro or Power tier
    const allowedTiers = ["pro", "power"];
    if (!allowedTiers.includes(vm.tier || "")) {
      return NextResponse.json({
        dispatchServer: false,
        relayConnected: false,
        allowed: false,
        tier: vm.tier,
        error: "Remote dispatch requires Pro or Power tier. Upgrade at instaclaw.io/billing.",
      });
    }

    // SSH into VM and check dispatch status via Unix socket
    let ssh;
    try {
      ssh = await connectSSH(vm);
      const result = await ssh.execCommand(
        'echo \'{"type":"status"}\' | nc -U -w 3 /tmp/dispatch.sock 2>/dev/null || echo \'{"connected":false,"error":"dispatch server not running"}\''
      );

      const status = JSON.parse(result.stdout.trim() || '{"connected":false}');

      return NextResponse.json({
        dispatchServer: true,
        relayConnected: status.connected ?? false,
        pendingCommands: status.pendingCommands ?? 0,
        uptime: status.uptime ?? 0,
      });
    } catch (err) {
      logger.warn("Dispatch status check failed", {
        error: String(err),
        vmId: vm.id,
        route: "vm/dispatch-status",
      });
      return NextResponse.json({ connected: false, dispatchServer: false, error: "VM unreachable" });
    } finally {
      ssh?.dispose();
    }
  } catch (err) {
    logger.error("Dispatch status error", {
      error: String(err),
      route: "vm/dispatch-status",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
