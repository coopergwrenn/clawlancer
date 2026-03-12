import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import { logger } from "@/lib/logger";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";

/**
 * GET /api/agentbook/get-bridge-url
 *
 * SSH into the user's VM and read /tmp/agentbook-register.log to extract
 * the World ID bridge URL. Called by the frontend every 2s after
 * start-registration kicks off the CLI.
 *
 * Returns:
 *   { status: "waiting" }              — log empty or URL not yet present
 *   { status: "ready", bridgeUrl }     — bridge URL found
 *   { status: "error", error }         — CLI failed
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
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    const vmRecord: VMRecord = {
      id: vm.id,
      ip_address: vm.ip_address,
      ssh_port: vm.ssh_port,
      ssh_user: vm.ssh_user,
    };

    let ssh;
    try {
      ssh = await connectSSH(vmRecord);
    } catch (err) {
      logger.error("SSH connect failed for get-bridge-url", {
        error: String(err),
        vmId: vm.id,
        route: "agentbook/get-bridge-url",
      });
      return NextResponse.json(
        { error: "Failed to connect to VM" },
        { status: 502 }
      );
    }

    try {
      const { stdout } = await ssh.execCommand(
        "cat /tmp/agentbook-register.log 2>/dev/null || true"
      );

      if (!stdout || stdout.trim() === "") {
        return NextResponse.json({ status: "waiting" });
      }

      // Check for bridge URL
      const bridgeMatch = stdout.match(
        /https:\/\/bridge\.worldcoin\.org[^\s"')]+/
      );
      if (bridgeMatch) {
        return NextResponse.json({
          status: "ready",
          bridgeUrl: bridgeMatch[0],
        });
      }

      // Broader pattern fallback
      const broadMatch = stdout.match(
        /https:\/\/[^\s"')]*worldcoin[^\s"')]+/
      );
      if (broadMatch) {
        return NextResponse.json({
          status: "ready",
          bridgeUrl: broadMatch[0],
        });
      }

      // Check if CLI errored out
      if (
        stdout.includes("Error") ||
        stdout.includes("error:") ||
        stdout.includes("ENOENT")
      ) {
        logger.warn("agentkit-cli errored during registration", {
          vmId: vm.id,
          log: stdout.slice(0, 500),
          route: "agentbook/get-bridge-url",
        });
        return NextResponse.json({
          status: "error",
          error: "Registration CLI failed. Check VM logs.",
        });
      }

      // Log exists but no URL yet — still starting
      return NextResponse.json({ status: "waiting" });
    } finally {
      ssh.dispose();
    }
  } catch (err) {
    logger.error("get-bridge-url error", {
      error: String(err),
      route: "agentbook/get-bridge-url",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
