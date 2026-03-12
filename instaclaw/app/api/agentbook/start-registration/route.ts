import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH, NVM_PREAMBLE } from "@/lib/ssh";
import { logger } from "@/lib/logger";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/agentbook/start-registration
 *
 * SSH into the user's VM, run `agentkit-cli register` in the background,
 * capture the bridge URL from the log, and return it to the frontend
 * so the user can scan the QR code in World App.
 */
export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    // Check World ID verification
    const { data: user } = await supabase
      .from("instaclaw_users")
      .select("world_id_verified")
      .eq("id", session.user.id)
      .single();

    if (!user?.world_id_verified) {
      return NextResponse.json(
        { error: "World ID verification required first" },
        { status: 400 }
      );
    }

    // Fetch VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, agentbook_wallet_address, agentbook_registered")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    if (vm.agentbook_registered) {
      return NextResponse.json(
        { error: "Already registered in AgentBook" },
        { status: 400 }
      );
    }

    if (!vm.agentbook_wallet_address) {
      return NextResponse.json(
        { error: "No wallet address found on VM" },
        { status: 400 }
      );
    }

    const wallet = vm.agentbook_wallet_address;
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
      logger.error("SSH connect failed for AgentBook registration", {
        error: String(err),
        vmId: vm.id,
        route: "agentbook/start-registration",
      });
      return NextResponse.json(
        { error: "Failed to connect to VM" },
        { status: 502 }
      );
    }

    try {
      // Clean up any previous log
      await ssh.execCommand("rm -f /tmp/agentbook-register.log");

      // Run agentkit-cli register in background
      const cmd = [
        NVM_PREAMBLE,
        `nohup npx --yes @worldcoin/agentkit-cli register ${wallet} --network base --auto > /tmp/agentbook-register.log 2>&1 &`,
      ].join(" && ");

      await ssh.execCommand(cmd);

      // Poll the log file for the bridge URL (up to 15s)
      const bridgeUrlPattern = /https:\/\/bridge\.worldcoin\.org[^\s"')]+/;
      let bridgeUrl: string | null = null;

      for (let attempt = 0; attempt < 6; attempt++) {
        // Wait 2.5s between reads
        await new Promise((resolve) => setTimeout(resolve, 2500));

        const { stdout } = await ssh.execCommand("cat /tmp/agentbook-register.log 2>/dev/null || true");

        if (stdout) {
          const match = stdout.match(bridgeUrlPattern);
          if (match) {
            bridgeUrl = match[0];
            break;
          }

          // Also try a broader pattern
          const broadMatch = stdout.match(/https:\/\/[^\s"')]*worldcoin[^\s"')]+/);
          if (broadMatch) {
            bridgeUrl = broadMatch[0];
            break;
          }

          // Check if CLI errored out
          if (stdout.includes("Error") || stdout.includes("error:") || stdout.includes("ENOENT")) {
            logger.warn("agentkit-cli errored during registration", {
              vmId: vm.id,
              log: stdout.slice(0, 500),
              route: "agentbook/start-registration",
            });
            return NextResponse.json(
              { error: "Registration CLI failed — check VM logs" },
              { status: 500 }
            );
          }
        }
      }

      if (!bridgeUrl) {
        // Grab whatever is in the log for debugging
        const { stdout: finalLog } = await ssh.execCommand(
          "cat /tmp/agentbook-register.log 2>/dev/null || echo '(empty)'"
        );
        logger.warn("Bridge URL not found in agentkit-cli output", {
          vmId: vm.id,
          log: finalLog?.slice(0, 1000),
          route: "agentbook/start-registration",
        });
        return NextResponse.json(
          { error: "Could not capture bridge URL from CLI. Try again." },
          { status: 504 }
        );
      }

      logger.info("AgentBook registration started — bridge URL captured", {
        vmId: vm.id,
        wallet,
        bridgeUrl: bridgeUrl.slice(0, 80) + "...",
        route: "agentbook/start-registration",
      });

      return NextResponse.json({ bridgeUrl });
    } finally {
      ssh.dispose();
    }
  } catch (err) {
    logger.error("start-registration error", {
      error: String(err),
      route: "agentbook/start-registration",
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
