import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/admin/xmtp-send-to-user
 *
 * Sends a message from a specific VM's XMTP agent to a target address.
 * Used to initiate World Chat conversations (agent messages user first).
 *
 * Auth: X-Mini-App-Token (from proxy) or X-Admin-Key
 */
export async function POST(req: NextRequest) {
  // Auth: accept mini app proxy token OR admin key
  const adminKey = req.headers.get("x-admin-key");
  const miniAppToken = req.headers.get("x-mini-app-token");

  let authorized = false;
  if (adminKey === process.env.ADMIN_API_KEY) authorized = true;
  if (miniAppToken) {
    try {
      const { validateMiniAppToken } = await import("@/lib/security");
      const userId = await validateMiniAppToken(req);
      if (userId) authorized = true;
    } catch {}
  }

  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { vmId, targetAddress, message } = body;

  if (!vmId || !targetAddress || !message) {
    return NextResponse.json({ error: "vmId, targetAddress, and message required" }, { status: 400 });
  }

  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, xmtp_address")
    .eq("id", vmId)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "VM not found" }, { status: 404 });
  }

  if (!vm.xmtp_address) {
    return NextResponse.json({ error: "VM has no XMTP agent configured" }, { status: 404 });
  }

  try {
    const { NodeSSH } = await import("node-ssh");
    const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

    const ssh = new NodeSSH();
    await ssh.connect({
      host: vm.ip_address,
      port: vm.ssh_port,
      username: vm.ssh_user,
      privateKey,
    });

    // Stop the running service to release DB lock, send message, restart
    await ssh.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user stop instaclaw-xmtp 2>/dev/null; sleep 1'
    );

    const sendScript = `
import { Agent } from "@xmtp/agent-sdk";
import { readFileSync } from "fs";

const envContent = readFileSync("/home/openclaw/.openclaw/xmtp/.env", "utf-8");
for (const line of envContent.split("\\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx > 0) {
    process.env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
}

const agent = await Agent.createFromEnv();
console.log("Agent address:", agent.address);

try {
  const dm = await agent.createDmWithAddress("${targetAddress}");
  console.log("DM created:", dm.id);
  await dm.sendText(${JSON.stringify(message)});
  console.log("MESSAGE SENT");
} catch (e) {
  console.log("Send error:", e.message);
}

process.exit(0);
`;

    // Write script INTO ~/scripts/ so ESM import resolution finds node_modules there
    const scriptPath = "~/scripts/xmtp-send-init.mjs";
    await ssh.execCommand(`cat > ${scriptPath} << 'SCRIPTEOF'\n${sendScript}\nSCRIPTEOF`);

    // Ensure @xmtp/agent-sdk is installed, then run
    const result = await ssh.execCommand(
      `source ~/.nvm/nvm.sh && cd ~/scripts && (node -e "require.resolve('@xmtp/agent-sdk')" 2>/dev/null || npm install @xmtp/agent-sdk@latest --save 2>&1 | tail -3) && node xmtp-send-init.mjs 2>&1; rm -f xmtp-send-init.mjs`,
      { execOptions: { timeout: 45000 } }
    );

    // Restart the XMTP service
    await ssh.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user start instaclaw-xmtp'
    );

    ssh.dispose();

    const sent = result.stdout.includes("MESSAGE SENT");
    logger.info("XMTP init-chat", {
      route: "admin/xmtp-send-to-user",
      vmId,
      targetAddress: targetAddress.slice(0, 10) + "...",
      sent,
    });

    return NextResponse.json({ success: sent, output: result.stdout });
  } catch (err) {
    logger.error("XMTP send-to-user failed", { error: String(err), vmId });
    return NextResponse.json({ error: "Failed", detail: String(err) }, { status: 500 });
  }
}
