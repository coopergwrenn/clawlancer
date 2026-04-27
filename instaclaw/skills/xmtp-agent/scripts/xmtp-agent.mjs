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
 *   → Agent forwards to OpenClaw gateway HTTP API (with full conversation history)
 *   → Gateway processes via Claude
 *   → Agent sends response back via XMTP
 *   → User sees reply in World Chat
 *
 * Conversation history is persisted to disk at ~/.openclaw/xmtp/conversations.json
 * so it survives service restarts, gateway restarts, and VM reboots.
 */

import { Agent } from "@xmtp/agent-sdk";
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ── Config ──
const HOME = process.env.HOME || "/home/openclaw";
const XMTP_DIR = join(HOME, ".openclaw", "xmtp");
const LOG_DIR = join(HOME, ".openclaw", "logs");
const LOG_FILE = join(LOG_DIR, "xmtp-agent.log");
const HISTORY_FILE = join(XMTP_DIR, "conversations.json");
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:18789";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";
const MAX_HISTORY_MESSAGES = 100; // Per conversation cap

// Ensure directories exist
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(XMTP_DIR, { recursive: true });

function log(level, msg, data) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG_FILE, line); } catch {}
}

// ── Persistent Conversation History ──

/** In-memory cache, synced to disk after each write */
const conversationHistory = new Map();

/** Pending write — coalesces rapid saves into one disk write */
let saveTimeout = null;
const SAVE_DEBOUNCE_MS = 500;

/** Load history from disk on startup */
function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) {
      const raw = readFileSync(HISTORY_FILE, "utf-8");
      const data = JSON.parse(raw);
      let totalMessages = 0;
      for (const [convId, messages] of Object.entries(data)) {
        if (Array.isArray(messages)) {
          conversationHistory.set(convId, messages);
          totalMessages += messages.length;
        }
      }
      log("INFO", `Loaded ${conversationHistory.size} conversations (${totalMessages} messages) from disk`);
    } else {
      log("INFO", "No conversation history file found — starting fresh");
    }
  } catch (err) {
    log("WARN", "Failed to load conversation history from disk — starting fresh", { error: err.message });
  }
}

/** Save history to disk (debounced — coalesces rapid writes) */
function scheduleSave() {
  if (saveTimeout) return; // Already scheduled
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    saveToDisk();
  }, SAVE_DEBOUNCE_MS);
}

/** Write current history to disk */
function saveToDisk() {
  try {
    const obj = {};
    for (const [convId, messages] of conversationHistory) {
      obj[convId] = messages;
    }
    writeFileSync(HISTORY_FILE, JSON.stringify(obj));
  } catch (err) {
    log("ERROR", "Failed to save conversation history to disk", { error: err.message });
  }
}

function getHistory(conversationId) {
  if (!conversationHistory.has(conversationId)) {
    conversationHistory.set(conversationId, []);
  }
  return conversationHistory.get(conversationId);
}

function addMessage(conversationId, role, content) {
  const history = getHistory(conversationId);
  history.push({ role, content });
  // Trim oldest messages when cap exceeded
  if (history.length > MAX_HISTORY_MESSAGES) {
    const excess = history.length - MAX_HISTORY_MESSAGES;
    history.splice(0, excess);
  }
  scheduleSave();
}

// ── Gateway Bridge ──

/**
 * Send messages to the OpenClaw gateway and get the AI response.
 * Includes full conversation history for context continuity.
 */
async function sendToGateway(conversationId, userMessage) {
  const url = `${GATEWAY_URL}/v1/chat/completions`;

  // Add user message to history (persists to disk via debounce)
  addMessage(conversationId, "user", userMessage);
  const messages = getHistory(conversationId);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      log("ERROR", `Gateway returned ${res.status}`, { errText });
      return null;
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || null;

    // Add assistant response to history (persists to disk via debounce)
    if (reply) {
      addMessage(conversationId, "assistant", reply);
    }

    return reply;
  } catch (err) {
    log("ERROR", "Gateway request failed", { error: err.message });
    return null;
  }
}

// ── Proactive Greeting (auto first-message on provisioning) ──

/**
 * If USER_WALLET_ADDRESS is set in the agent env, send the user a proactive
 * greeting so the World Chat DM is established without requiring the user
 * to message first. Fire-and-forget — the start handler does not await this.
 *
 * Idempotent via a marker file so service restarts (Restart=on-failure) do
 * not re-greet. The marker lives in XMTP_DIR which setupXMTP wipes on fresh
 * provisioning, so a re-provisioned VM correctly sends a fresh greeting.
 *
 * Failures do not crash the agent. If the send fails, the marker is NOT
 * written — the next agent restart will retry once.
 */
async function sendProactiveGreeting(agent) {
  const userAddr = process.env.USER_WALLET_ADDRESS;
  if (!userAddr) {
    log("INFO", "USER_WALLET_ADDRESS not set — skipping proactive greeting (reactive mode)");
    return;
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(userAddr)) {
    log("WARN", "USER_WALLET_ADDRESS has invalid format — skipping proactive greeting", { prefix: userAddr.slice(0, 10) });
    return;
  }

  const markerFile = join(XMTP_DIR, ".greeting-sent");
  if (existsSync(markerFile)) {
    log("INFO", "Proactive greeting already sent (marker present) — skipping");
    return;
  }

  const greeting = "Hey! I'm your InstaClaw agent. You can chat with me right here in World Chat — same AI, same skills, same memory as Telegram and the mini app.";

  try {
    const dm = await agent.createDmWithAddress(userAddr);
    await dm.sendText(greeting);
    log("INFO", "Proactive greeting sent", { target: userAddr.slice(0, 10) + "..." });
    try {
      writeFileSync(markerFile, new Date().toISOString());
    } catch (e) {
      log("WARN", `Failed to write greeting marker: ${e}`);
    }
  } catch (err) {
    log("ERROR", "Failed to send proactive greeting", { error: err?.message || String(err) });
    // Do NOT write marker — next agent restart will retry
  }
}

// ── Main ──

async function main() {
  log("INFO", "Starting XMTP agent service...");
  log("INFO", `GATEWAY_URL: ${GATEWAY_URL}`);
  log("INFO", `GATEWAY_TOKEN: ${GATEWAY_TOKEN ? GATEWAY_TOKEN.slice(0, 8) + "..." : "MISSING"}`);
  log("INFO", `MAX_HISTORY: ${MAX_HISTORY_MESSAGES} messages per conversation`);
  log("INFO", `HISTORY_FILE: ${HISTORY_FILE}`);

  // Load env from ~/.openclaw/xmtp/.env if it exists
  const xmtpEnvFile = join(XMTP_DIR, ".env");
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

  // Load conversation history from disk
  loadHistory();

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
    const convId = ctx.conversation.id;

    log("INFO", `Message from ${sender} in ${convId}: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`);

    // Forward to gateway with full conversation history
    const response = await sendToGateway(convId, text);

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
    // When sendProactiveGreeting created the DM itself, this dm event also
    // fires (the agent is one party of a new conversation). Suppress the
    // reactive greeting in that case — otherwise the user receives two
    // greetings back-to-back. The proactive marker is the authoritative
    // signal that the canonical greeting has already been delivered.
    if (existsSync(join(XMTP_DIR, ".greeting-sent"))) {
      log("INFO", "DM event with proactive marker present — skipping reactive greeting");
      return;
    }
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
    const addrFile = join(XMTP_DIR, "address");
    try {
      writeFileSync(addrFile, agent.address);
      log("INFO", `Address written to ${addrFile}`);
    } catch (e) {
      log("WARN", `Failed to write address file: ${e}`);
    }

    // Fire proactive first-message in background. Non-blocking so this handler
    // returns fast and setupXMTP's address-file poller is not delayed.
    sendProactiveGreeting(agent).catch((err) => {
      log("WARN", `sendProactiveGreeting threw: ${err?.message || err}`);
    });
  });

  agent.on("unhandledError", (error) => {
    log("ERROR", "Unhandled XMTP error", { error: String(error) });
  });

  // Flush history to disk before exit
  process.on("SIGTERM", () => {
    log("INFO", "SIGTERM received — flushing history to disk");
    saveToDisk();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    log("INFO", "SIGINT received — flushing history to disk");
    saveToDisk();
    process.exit(0);
  });

  // Start listening
  await agent.start();

  log("INFO", "Agent is now listening for messages. Keeping process alive...");
  setInterval(() => {}, 60000);
}

main().catch((err) => {
  log("FATAL", "Agent crashed", { error: err.message, stack: err.stack });
  saveToDisk(); // Best-effort save before crash exit
  process.exit(1);
});
