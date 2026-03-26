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

    // Write a small send script that uses the same wallet key as the running agent
    // This shares the SAME identity (same key, same DB) — no new installation
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

// Inspect available methods on agent and agent.conversations
console.log("Agent keys:", Object.getOwnPropertyNames(Object.getPrototypeOf(agent)).join(", "));
if (agent.conversations) {
  console.log("Conversations keys:", Object.getOwnPropertyNames(Object.getPrototypeOf(agent.conversations)).join(", "));
}
if (agent.client) {
  console.log("Client keys:", Object.getOwnPropertyNames(Object.getPrototypeOf(agent.client)).join(", "));
  if (agent.client.conversations) {
    console.log("Client.conversations keys:", Object.getOwnPropertyNames(Object.getPrototypeOf(agent.client.conversations)).join(", "));
  }
}

// Try multiple approaches to create a DM
console.log("\\nAttempting to message:", TARGET);

// Approach 1: agent.conversations.newDm (agent-sdk v2.x)
if (agent.conversations?.newDm) {
  try {
    console.log("Trying agent.conversations.newDm...");
    const dm = await agent.conversations.newDm(TARGET);
    console.log("DM created:", dm.id || dm);
    await dm.sendText(MSG);
    console.log("SUCCESS via newDm!");
    await new Promise(r => setTimeout(r, 3000));
    process.exit(0);
  } catch (e) { console.log("newDm failed:", e.message); }
}

// Approach 2: agent.client.conversations.createDm
if (agent.client?.conversations?.createDm) {
  try {
    console.log("Trying agent.client.conversations.createDm...");
    // First get inbox ID
    const inboxIds = await agent.client.findInboxIdByAddress(TARGET);
    console.log("Inbox IDs:", JSON.stringify(inboxIds));
    if (inboxIds) {
      const dm = await agent.client.conversations.createDm(inboxIds);
      console.log("DM created:", dm.id || dm);
      await dm.send(MSG);
      console.log("SUCCESS via client.conversations.createDm!");
      await new Promise(r => setTimeout(r, 3000));
      process.exit(0);
    }
  } catch (e) { console.log("createDm failed:", e.message); }
}

// Approach 3: newGroup with single member (creates a 1:1)
if (agent.conversations?.newGroup) {
  try {
    console.log("Trying agent.conversations.newGroup([TARGET])...");
    const group = await agent.conversations.newGroup([TARGET]);
    console.log("Group created:", group.id || group);
    await group.sendText(MSG);
    console.log("SUCCESS via newGroup!");
    await new Promise(r => setTimeout(r, 3000));
    process.exit(0);
  } catch (e) { console.log("newGroup failed:", e.message); }
}

// Approach 4: Direct client DM methods
if (agent.client?.conversations?.findOrCreateDmWithIdentity) {
  try {
    console.log("Trying findOrCreateDmWithIdentity...");
    const dm = await agent.client.conversations.findOrCreateDmWithIdentity({ identifier: TARGET, identifierKind: "Ethereum" });
    console.log("DM created:", dm.id || dm);
    await dm.send(MSG);
    console.log("SUCCESS via findOrCreateDmWithIdentity!");
    await new Promise(r => setTimeout(r, 3000));
    process.exit(0);
  } catch (e) { console.log("findOrCreateDmWithIdentity failed:", e.message); }
}

console.log("All approaches failed.");
await new Promise(r => setTimeout(r, 1000));
process.exit(1);
`;

    // Write the script to ~/scripts/ so it can find node_modules
    const result = await ssh.execCommand(
      `source ~/.nvm/nvm.sh && cat > ~/scripts/xmtp-send-tmp.mjs << 'SCRIPTEOF'\n${sendScript}\nSCRIPTEOF\ncd ~/scripts && node xmtp-send-tmp.mjs 2>&1; rm -f ~/scripts/xmtp-send-tmp.mjs`,
      { cwd: "/home/openclaw/scripts" }
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
