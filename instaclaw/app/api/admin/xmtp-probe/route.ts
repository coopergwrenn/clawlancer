import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/admin/xmtp-probe
 *
 * Probes the XMTP network to find Cooper's real XMTP identity.
 * SSHes into vm-313, stops the XMTP service (to release DB lock),
 * runs a probe script, then restarts the service.
 *
 * Body: { targetAddress?: "0x..." } (defaults to Cooper's address)
 * Requires X-Admin-Key header.
 */
export async function POST(req: NextRequest) {
  const adminKey = req.headers.get("x-admin-key");
  if (adminKey !== process.env.ADMIN_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const targetAddress =
    body.targetAddress || "0x52fc5c6307a19bae5d27dfbc35489cdae98863b4";

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
    const privateKey = Buffer.from(
      process.env.SSH_PRIVATE_KEY_B64!,
      "base64"
    ).toString("utf-8");

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

    // Probe script that explores XMTP identity for a target address
    const probeScript = `
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
const results = {};

console.log("=== XMTP IDENTITY PROBE ===");
console.log("Target address:", TARGET);
console.log("");

// Step 1: Create agent from env
console.log("[1] Creating agent from env...");
const agent = await Agent.createFromEnv();
console.log("Agent address:", agent.address);
console.log("Agent inboxId:", agent.client?.inboxId || "unknown");
results.agentAddress = agent.address;
results.agentInboxId = agent.client?.inboxId || null;
console.log("");

// Step 2: canMessage checks
console.log("[2] canMessage checks...");
const addressVariants = [
  TARGET,
  TARGET.toLowerCase(),
  TARGET.toUpperCase(),
  "eip155:1:" + TARGET.toLowerCase(),
  "eip155:8453:" + TARGET.toLowerCase(),
];

results.canMessage = {};
for (const addr of addressVariants) {
  try {
    const can = await agent.client.canMessage([addr]);
    console.log("  canMessage(" + addr + "):", JSON.stringify(can));
    results.canMessage[addr] = can;
  } catch (e) {
    console.log("  canMessage(" + addr + ") ERROR:", e.message);
    results.canMessage[addr] = { error: e.message };
  }
}
console.log("");

// Step 3: fetchInboxIdByIdentifier (try all available methods)
console.log("[3] fetchInboxIdByIdentifier...");
results.inboxIdLookup = {};

// Try fetchInboxIdByIdentifier (the documented API)
try {
  const inboxId = await agent.client.fetchInboxIdByIdentifier({
    identifier: TARGET.toLowerCase(),
    identifierKind: 0, // 0 = Ethereum (enum value, not string)
  });
  console.log("  fetchInboxIdByIdentifier (enum 0):", inboxId);
  results.inboxIdLookup.fetchByIdentifier = inboxId;
} catch (e) {
  console.log("  fetchInboxIdByIdentifier (enum 0) ERROR:", e.message);
  results.inboxIdLookup.fetchByIdentifier = { error: e.message };
}

// Try with string enum
try {
  const inboxId = await agent.client.fetchInboxIdByIdentifier({
    identifier: TARGET.toLowerCase(),
    identifierKind: "Ethereum",
  });
  console.log("  fetchInboxIdByIdentifier (string):", inboxId);
  results.inboxIdLookup.fetchByIdentifierStr = inboxId;
} catch (e) {
  console.log("  fetchInboxIdByIdentifier (string) ERROR:", e.message);
}

// Try canMessage with numeric enum
try {
  const can = await agent.client.canMessage([{
    identifier: TARGET.toLowerCase(),
    identifierKind: 0,
  }]);
  console.log("  canMessage (enum 0):", JSON.stringify(Object.fromEntries(can)));
  results.inboxIdLookup.canMessageEnum = Object.fromEntries(can);
} catch (e) {
  console.log("  canMessage (enum 0) ERROR:", e.message);
}
console.log("");

// Step 4: List all conversations
console.log("[4] Listing all conversations...");
results.conversations = [];
try {
  const convos = await agent.client.conversations.list();
  console.log("  Total conversations:", convos.length);
  for (const convo of convos) {
    const info = {
      id: convo.id,
      topic: convo.topic || null,
      createdAt: convo.createdAt || null,
      peerAddress: convo.peerAddress || convo.peerInboxId || null,
      type: convo.constructor?.name || "unknown",
    };
    console.log("  Convo:", JSON.stringify(info));
    results.conversations.push(info);
  }
} catch (e) {
  console.log("  conversations.list() ERROR:", e.message);
  results.conversations = { error: e.message };
}
console.log("");

// Step 5: List DMs specifically
console.log("[5] Listing DMs...");
results.dms = [];
try {
  const dms = await agent.client.conversations.listDms();
  console.log("  Total DMs:", dms.length);
  for (const dm of dms) {
    const dmInfo = {
      id: dm.id,
      topic: dm.topic || null,
      createdAt: dm.createdAt || null,
      peerInboxId: dm.peerInboxId || null,
    };

    // Try to get peer address from the DM members
    try {
      const members = await dm.members();
      dmInfo.members = members.map(m => ({
        inboxId: m.inboxId,
        addresses: m.addresses || m.accountAddresses || [],
        installationIds: m.installationIds || [],
      }));
      console.log("  DM:", JSON.stringify(dmInfo));
    } catch (me) {
      console.log("  DM (no members):", JSON.stringify(dmInfo), "members error:", me.message);
    }

    // Try to get recent messages
    try {
      const msgs = await dm.messages({ limit: 3 });
      dmInfo.recentMessages = msgs.map(m => ({
        id: m.id,
        senderInboxId: m.senderInboxId || m.senderAddress || null,
        content: typeof m.content === "string" ? m.content.slice(0, 100) : JSON.stringify(m.content).slice(0, 100),
        sentAt: m.sentAt || m.sentAtNs || null,
      }));
    } catch (msgErr) {
      dmInfo.recentMessagesError = msgErr.message;
    }

    results.dms.push(dmInfo);
  }
} catch (e) {
  console.log("  conversations.listDms() ERROR:", e.message);
  results.dms = { error: e.message };
}
console.log("");

// Step 6: Try to inspect the client object for useful methods
console.log("[6] Client introspection...");
try {
  const clientKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(agent.client)).filter(k => k !== "constructor");
  console.log("  Client methods:", clientKeys.join(", "));
  results.clientMethods = clientKeys;
} catch (e) {
  console.log("  Client introspection error:", e.message);
}

try {
  const convoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(agent.client.conversations)).filter(k => k !== "constructor");
  console.log("  Conversations methods:", convoKeys.join(", "));
  results.conversationsMethods = convoKeys;
} catch (e) {
  console.log("  Conversations introspection error:", e.message);
}
console.log("");

console.log("=== PROBE COMPLETE ===");
console.log("JSON_RESULTS:" + JSON.stringify(results));

await new Promise(r => setTimeout(r, 3000));
process.exit(0);
`;

    // Write and execute the probe script on vm-313
    const result = await ssh.execCommand(
      `source ~/.nvm/nvm.sh && cat > ~/scripts/xmtp-probe-tmp.mjs << 'SCRIPTEOF'\n${probeScript}\nSCRIPTEOF\ncd ~/scripts && node xmtp-probe-tmp.mjs 2>&1; EXIT_CODE=$?; rm -f ~/scripts/xmtp-probe-tmp.mjs; echo "EXIT:$EXIT_CODE"`,
      { cwd: "/home/openclaw/scripts" }
    );

    // Restart the XMTP service after probing
    await ssh.execCommand(
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user start instaclaw-xmtp 2>/dev/null; echo "service restarted"'
    );

    ssh.dispose();

    const output =
      result.stdout + (result.stderr ? "\nSTDERR: " + result.stderr : "");

    // Try to extract structured JSON results from the output
    let structuredResults = null;
    const jsonMatch = output.match(/JSON_RESULTS:(.+)/);
    if (jsonMatch) {
      try {
        structuredResults = JSON.parse(jsonMatch[1]);
      } catch {
        // ignore parse errors
      }
    }

    logger.info("XMTP probe complete", {
      target: targetAddress,
      output: output.slice(0, 500),
    });

    return NextResponse.json({
      success: true,
      target: targetAddress,
      results: structuredResults,
      rawOutput: output,
    });
  } catch (err) {
    logger.error("XMTP probe failed", { error: String(err) });
    return NextResponse.json(
      {
        error: "Probe failed",
        detail: String(err),
      },
      { status: 500 }
    );
  }
}
