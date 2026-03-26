import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/admin/xmtp-send
 *
 * Sends an XMTP message from the agent on vm-313 to a target address.
 * Uses a small inline Node script executed via SSH on the VM.
 *
 * Body: { targetAddress: "0x...", message: "Hello!" }
 * Requires X-Admin-Key header.
 */
export async function POST(req: NextRequest) {
  const adminKey = req.headers.get("x-admin-key");
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { targetAddress, message } = await req.json();
  if (!targetAddress || !message) {
    return NextResponse.json({ error: "targetAddress and message required" }, { status: 400 });
  }

  const vmId = "1eac973f-1691-4700-a0ba-420f1956120c"; // vm-313
  const supabase = getSupabase();

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user")
    .eq("id", vmId)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "VM not found" }, { status: 404 });
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

    // Stop the running XMTP service to release the DB lock
    await ssh.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user stop instaclaw-xmtp 2>/dev/null; sleep 2; echo "service stopped"'
    );

    // Write a send script that uses the agent's wallet key
    const sendScript = `
import { Agent } from "@xmtp/agent-sdk";
import { readFileSync } from "fs";

// Load env from the agent's .env file
const envContent = readFileSync("/home/openclaw/.openclaw/xmtp/.env", "utf-8");
for (const line of envContent.split("\\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx > 0) {
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    process.env[key] = val;
  }
}

const TARGET = "${targetAddress}";
const MSG = ${JSON.stringify(message)};

console.log("Creating agent from env...");
const agent = await Agent.createFromEnv();
console.log("Agent address:", agent.address);

// Use agent.createDmWithAddress — the correct API method
console.log("Sending DM to:", TARGET);

// First resolve the inbox ID
let targetInboxId = null;
try {
  targetInboxId = await agent.client.fetchInboxIdByIdentifier({
    identifier: TARGET.toLowerCase(),
    identifierKind: 0, // 0 = Ethereum
  });
  console.log("Resolved inbox ID:", targetInboxId);
} catch (e) {
  console.log("fetchInboxIdByIdentifier failed:", e.message);
}

// Try createDmWithIdentifier (proper API with numeric enum)
try {
  console.log("Creating DM via createDmWithIdentifier...");
  const dm = await agent.client.conversations.createDmWithIdentifier({
    identifier: TARGET.toLowerCase(),
    identifierKind: 0,
  });
  console.log("DM created:", dm.id);
  await dm.send(MSG);
  console.log("MESSAGE SENT SUCCESSFULLY via createDmWithIdentifier!");
} catch (e) {
  console.error("createDmWithIdentifier failed:", e.message);

  // Fallback: try createDm with inbox ID
  if (targetInboxId) {
    try {
      console.log("Trying createDm with inbox ID...");
      const dm = await agent.client.conversations.createDm(targetInboxId);
      console.log("DM created via inbox ID:", dm.id);
      await dm.send(MSG);
      console.log("MESSAGE SENT via createDm(inboxId)!");
    } catch (e2) {
      console.error("createDm(inboxId) failed:", e2.message);
    }
  }

  // Last resort: try createDmWithAddress again
  try {
    console.log("Trying agent.createDmWithAddress...");
    const dm = await agent.createDmWithAddress(TARGET);
    console.log("DM created:", dm.id);
    await dm.sendText(MSG);
    console.log("MESSAGE SENT via createDmWithAddress!");
  } catch (e3) {
    console.error("createDmWithAddress failed:", e3.message);
  }
}

await new Promise(r => setTimeout(r, 3000));
process.exit(0);
`;

    // Write the script to ~/scripts/ so it can find node_modules
    const result = await ssh.execCommand(
      `source ~/.nvm/nvm.sh && cat > ~/scripts/xmtp-send-tmp.mjs << 'SCRIPTEOF'\n${sendScript}\nSCRIPTEOF\ncd ~/scripts && node xmtp-send-tmp.mjs 2>&1; EXIT_CODE=$?; rm -f ~/scripts/xmtp-send-tmp.mjs; echo "EXIT:$EXIT_CODE"`,
      { cwd: "/home/openclaw/scripts" }
    );

    // Restart the XMTP service after sending
    await ssh.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user start instaclaw-xmtp 2>/dev/null; echo "service restarted"'
    );

    ssh.dispose();

    const output = result.stdout + (result.stderr ? "\nSTDERR: " + result.stderr : "");

    logger.info("XMTP send attempt", {
      target: targetAddress,
      output: output.slice(0, 500),
    });

    return NextResponse.json({
      success: !output.includes("Failed:"),
      output,
    });
  } catch (err) {
    logger.error("XMTP send failed", { error: String(err) });
    return NextResponse.json({
      error: "Send failed",
      detail: String(err),
    }, { status: 500 });
  }
}
