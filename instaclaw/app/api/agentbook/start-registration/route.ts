import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH, NVM_PREAMBLE } from "@/lib/ssh";
import { logger } from "@/lib/logger";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";

/**
 * POST /api/agentbook/start-registration
 *
 * SSH into the user's VM, kick off `agentkit-cli register` in a fully
 * detached process (setsid), and return immediately. The CLI writes its
 * output to /tmp/agentbook-register.log. The frontend polls
 * GET /api/agentbook/get-bridge-url to read the log and extract the URL.
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
      // Clean up any previous log and launcher script
      await ssh.execCommand("rm -f /tmp/agentbook-register.log /tmp/agentbook-start.sh");

      // Write a launcher script to the VM — avoids shell escaping issues
      const script = [
        "#!/bin/bash",
        NVM_PREAMBLE,
        `npx --yes @worldcoin/agentkit-cli register ${wallet} --network base --auto > /tmp/agentbook-register.log 2>&1`,
      ].join("\n");
      const b64 = Buffer.from(script, "utf-8").toString("base64");

      await ssh.execCommand(
        `echo '${b64}' | base64 -d > /tmp/agentbook-start.sh && chmod +x /tmp/agentbook-start.sh`
      );

      // Launch fully detached via setsid — returns immediately, process survives SSH disconnect
      await ssh.execCommand(
        "setsid /tmp/agentbook-start.sh < /dev/null > /dev/null 2>&1 &"
      );

      logger.info("AgentBook registration CLI launched via setsid", {
        vmId: vm.id,
        wallet,
        route: "agentbook/start-registration",
      });

      return NextResponse.json({ status: "starting" });
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
