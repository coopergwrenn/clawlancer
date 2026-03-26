#!/usr/bin/env node
/**
 * InstaClaw XMTP Agent Service
 *
 * Bridges World Chat (XMTP) messages to the OpenClaw gateway.
 * Runs as a systemd service alongside the OpenClaw gateway.
 *
 * Flow:
 *   User sends message in World Chat
 *   → XMTP network delivers to this agent
 *   → Agent forwards to OpenClaw gateway HTTP API
 *   → Gateway processes via Claude
 *   → Agent sends response back via XMTP
 *   → User sees reply in World Chat
 */

import { Agent } from "@xmtp/agent-sdk";
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ── Config ──
const HOME = process.env.HOME || "/home/openclaw";
const LOG_DIR = join(HOME, ".openclaw", "logs");
const LOG_FILE = join(LOG_DIR, "xmtp-agent.log");
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:3000";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";

// Ensure log directory exists
mkdirSync(LOG_DIR, { recursive: true });

function log(level, msg, data) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

// ── Gateway Bridge ──

/**
 * Send a message to the OpenClaw gateway and get the AI response.
 * Uses the gateway's v1 chat API, same format as the Telegram bot.
 */
async function sendToGateway(userMessage, senderAddress) {
  const url = `${GATEWAY_URL}/v1/chat/completions`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      log("ERROR", `Gateway returned ${res.status}`, { errText });
      return null;
    }

    const data = await res.json();
    // OpenAI chat completions format
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    log("ERROR", "Gateway request failed", { error: err.message });
    return null;
  }
}

// ── Main ──

async function main() {
  log("INFO", "Starting XMTP agent service...");
  log("INFO", `XMTP_ENV: ${process.env.XMTP_ENV}`);
  log("INFO", `GATEWAY_URL: ${GATEWAY_URL}`);
  log("INFO", `GATEWAY_TOKEN: ${GATEWAY_TOKEN ? GATEWAY_TOKEN.slice(0, 8) + "..." : "MISSING"}`);

  // Load env from ~/.openclaw/xmtp/.env if it exists
  const xmtpEnvFile = join(HOME, ".openclaw", "xmtp", ".env");
  if (existsSync(xmtpEnvFile)) {
    const envContent = readFileSync(xmtpEnvFile, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
    log("INFO", "Loaded XMTP env from " + xmtpEnvFile);
  }

  // Verify required env vars
  if (!process.env.XMTP_WALLET_KEY) {
    log("ERROR", "XMTP_WALLET_KEY not set. Cannot start.");
    process.exit(1);
  }

  const agent = await Agent.createFromEnv();

  // ── Handle incoming text messages ──
  agent.on("text", async (ctx) => {
    if (!ctx.isDm()) return; // Only handle DMs, not group messages

    const sender = ctx.message?.senderInboxId || ctx.message?.senderAddress || "unknown";
    const text = ctx.message.content;

    log("INFO", `Message from ${sender}: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

    // Forward to gateway
    const response = await sendToGateway(text, sender);

    if (response) {
      await ctx.conversation.sendText(response);
      log("INFO", `Replied to ${sender}: ${response.slice(0, 100)}${response.length > 100 ? "..." : ""}`);
    } else {
      await ctx.conversation.sendText(
        "I'm having trouble processing your message right now. Please try again in a moment."
      );
      log("WARN", `No response from gateway for ${sender}`);
    }
  });

  // ── Handle new DM conversations ──
  agent.on("dm", async (ctx) => {
    const sender = ctx.message?.senderInboxId || ctx.message?.senderAddress || "unknown";
    log("INFO", `New DM conversation from ${sender}`);
    await ctx.conversation.sendText(
      "Hey! I'm your InstaClaw agent. Ask me anything — I'm here to help."
    );
  });

  // ── Lifecycle events ──
  agent.on("start", () => {
    log("INFO", `XMTP agent started. Address: ${agent.address}`);
    log("INFO", `Users can message me at: ${agent.address}`);

    // Write address to a file so other scripts can read it
    const addrFile = join(HOME, ".openclaw", "xmtp", "address");
    try {
      writeFileSync(addrFile, agent.address);
      log("INFO", `Address written to ${addrFile}`);
    } catch (e) {
      log("WARN", `Failed to write address file: ${e}`);
    }
  });

  agent.on("unhandledError", (error) => {
    log("ERROR", "Unhandled XMTP error", { error: String(error) });
  });

  // Start listening
  await agent.start();

  // Keep the process alive — agent.start() sets up streams but
  // the Node.js event loop needs a reference to stay running
  log("INFO", "Agent is now listening for messages. Keeping process alive...");
  setInterval(() => {}, 60000);
}

main().catch((err) => {
  log("FATAL", "Agent crashed", { error: err.message, stack: err.stack });
  process.exit(1);
});
