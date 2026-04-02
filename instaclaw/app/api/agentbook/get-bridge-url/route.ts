import { NextRequest, NextResponse } from "next/server";
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
 * the World ID bridge URL. Supports mini app proxy token.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    let userId = session?.user?.id;
    if (!userId) {
      const { validateMiniAppToken } = await import("@/lib/security");
      userId = await validateMiniAppToken(req) ?? undefined;
    }
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user")
      .eq("assigned_to", userId)
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

      // Check for World ID verify URL
      // idkit-core generates: https://worldcoin.org/verify?t=wld&i=...&k=...
      // Also check world.org/verify and bridge.worldcoin.org as fallbacks
      const urlMatch = stdout.match(
        /https:\/\/(?:worldcoin\.org\/verify|world\.org\/verify|bridge\.worldcoin\.org)[^\s"')]+/
      );
      if (urlMatch) {
        return NextResponse.json({
          status: "ready",
          bridgeUrl: urlMatch[0],
        });
      }

      // Broader fallback — any worldcoin/world.org URL with verify
      const broadMatch = stdout.match(
        /https:\/\/[^\s"')]*(?:worldcoin|world\.org)[^\s"')]*verify[^\s"')]+/
      );
      if (broadMatch) {
        return NextResponse.json({
          status: "ready",
          bridgeUrl: broadMatch[0],
        });
      }

      // Check if CLI errored out — comprehensive patterns
      const errorPatterns = [
        "Error", "error:", "ENOENT", "ETIMEDOUT", "ECONNREFUSED",
        "command not found", "Cannot find module", "MODULE_NOT_FOUND",
        "VERIFICATION_FAILED", "REGISTRATION_FAILED", "INVALID_PROOF",
        "MISSING_API_URL", "fetch failed", "timed out",
      ];
      const hasError = errorPatterns.some(p => stdout.includes(p));
      if (hasError) {
        logger.warn("agentkit-cli errored during registration", {
          vmId: vm.id,
          log: stdout.slice(0, 500),
          route: "agentbook/get-bridge-url",
        });
        return NextResponse.json({
          status: "error",
          error: "Registration CLI failed",
          detail: stdout.slice(-300),
        });
      }

      // Log exists but no URL yet — still starting. Include log tail for debugging.
      return NextResponse.json({
        status: "waiting",
        logTail: stdout.slice(-200),
      });
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
