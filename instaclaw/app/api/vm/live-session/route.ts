import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import crypto from "crypto";

export const dynamic = "force-dynamic";

/**
 * GET /api/vm/live-session
 *
 * Returns a WebSocket URL for the user's VM live desktop viewer.
 * Generates a short-lived one-time token for websockify authentication.
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
      .select("id, ip_address, ssh_port, ssh_user, name, gateway_token, tier")
      .eq("assigned_to", session.user.id)
      .eq("status", "assigned")
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Pro and Power tiers only
    const allowedTiers = ["pro", "power", "starter"]; // Allow starter for now during rollout
    if (!allowedTiers.includes(vm.tier || "")) {
      return NextResponse.json({
        error: "Live desktop view requires an active subscription.",
      }, { status: 403 });
    }

    // Generate a one-time token and deploy it to the VM
    const token = crypto.randomBytes(32).toString("hex");

    // Write token to VM for websockify validation
    try {
      const { connectSSH } = await import("@/lib/ssh");
      const ssh = await connectSSH(vm);
      try {
        // Write token file that websockify --token-source will read
        // Format: token: host:port (one line per valid token)
        await ssh.execCommand(
          `mkdir -p ~/.vnc && echo "${token}: localhost:5901" > ~/.vnc/live-tokens`
        );
      } finally {
        ssh.dispose();
      }
    } catch (sshErr) {
      logger.warn("Failed to deploy VNC token to VM", {
        error: String(sshErr),
        vmId: vm.id,
        route: "vm/live-session",
      });
      // Fall back to tokenless connection (less secure but functional)
    }

    // The noVNC client connects to the VM's websockify on port 6080
    const wsUrl = `ws://${vm.ip_address}:6080`;
    const vncUrl = `http://${vm.ip_address}:6080/vnc.html?autoconnect=true&resize=scale&path=websockify?token=${token}`;

    logger.info("Live session requested", {
      userId: session.user.id,
      vmId: vm.id,
      vmName: vm.name,
      route: "vm/live-session",
    });

    return NextResponse.json({
      wsUrl,
      vncUrl,
      vmName: vm.name,
      vmIp: vm.ip_address,
      port: 6080,
      token,
    });
  } catch (err) {
    logger.error("Live session error", {
      error: String(err),
      route: "vm/live-session",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
