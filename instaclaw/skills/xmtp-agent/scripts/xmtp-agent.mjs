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
import { execFile } from "child_process";
import { createServer } from "http";

// ── Config ──
const HOME = process.env.HOME || "/home/openclaw";
const XMTP_DIR = join(HOME, ".openclaw", "xmtp");
const LOG_DIR = join(HOME, ".openclaw", "logs");
const LOG_FILE = join(LOG_DIR, "xmtp-agent.log");
const HISTORY_FILE = join(XMTP_DIR, "conversations.json");
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:18789";
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || "";
const INSTACLAW_API_URL = process.env.INSTACLAW_API_URL || "https://instaclaw.io";
const NOTIFY_USER_SCRIPT = join(HOME, "scripts", "notify_user.sh");
const MAX_HISTORY_MESSAGES = 100; // Per conversation cap

// Local HTTP send endpoint — agent_outreach.py POSTs here so the python
// script does not need its own XMTP wallet/client. 127.0.0.1 only.
const LOCAL_SEND_PORT = 18790;
const LOCAL_SEND_HOST = "127.0.0.1";

// Agent-to-agent intro envelope. consensus_agent_outreach.py wraps the
// outreach DM with this marker so the receiving agent can distinguish
// it from a normal human DM. Versioned — v2 receivers MUST fall back
// to gateway-forward if they see an unknown version, so v1 senders
// keep working during a phased rollout.
const INTRO_MARKER = "[INSTACLAW_AGENT_INTRO_V1]";
const INTRO_ACK_MARKER = "[INSTACLAW_AGENT_INTRO_ACK_V1]";
const INTRO_SEPARATOR = "---";

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

  // Cross-VM: server-side check populated this if the user was already
  // greeted on a prior VM. Suppresses double-greeting on re-provision.
  if (process.env.USER_GREETING_ALREADY_SENT === "true") {
    log("INFO", "USER_GREETING_ALREADY_SENT=true — user already greeted on prior VM, skipping");
    return;
  }

  // Per-VM: covers the agent-restart case (Restart=on-failure). Independent
  // of the cross-VM env flag — the marker file lives on this VM only.
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
    // Record at the backend so re-provisions don't double-greet. Best-effort:
    // a failure here means the per-VM marker still protects against agent
    // restart re-greets, but a future re-provisioning of this user could
    // greet them again. We log + continue.
    await recordGreetingDelivered();
  } catch (err) {
    log("ERROR", "Failed to send proactive greeting", { error: err?.message || String(err) });
    // Do NOT write marker — next agent restart will retry
  }
}

/**
 * Tell the instaclaw backend the proactive greeting just landed so the
 * server can flip instaclaw_users.xmtp_greeting_sent_at. Auth uses the
 * agent's own gateway token (per-VM, already in env).
 */
async function recordGreetingDelivered() {
  const apiUrl = process.env.INSTACLAW_API_URL;
  const token = process.env.GATEWAY_TOKEN;
  if (!apiUrl || !token) {
    log("WARN", "INSTACLAW_API_URL or GATEWAY_TOKEN missing — skipping backend greeting record");
    return;
  }
  try {
    const res = await fetch(`${apiUrl}/api/admin/xmtp-greeting-recorded`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      // Empty body is fine — endpoint identifies VM by the token.
      body: JSON.stringify({}),
      // Keep the call snappy; backend write is single-row UPDATE.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      log("WARN", `Backend greeting record returned ${res.status}`, { body: txt.slice(0, 200) });
      return;
    }
    log("INFO", "Backend greeting record acknowledged");
  } catch (err) {
    log("WARN", "Backend greeting record failed (non-fatal)", { error: err?.message || String(err) });
  }
}

// ── Agent-to-Agent Intro Flow ──

/**
 * Detect and parse an [INSTACLAW_AGENT_INTRO_V1] envelope.
 *
 * Wire format (built by consensus_agent_outreach.py):
 *
 *   [INSTACLAW_AGENT_INTRO_V1]
 *   {"v":1,"from_xmtp":"0x...","from_name":"Cooper", ...}
 *   ---
 *   <human-readable prose>
 *
 * Returns { header, prose } on success, or null if the message is not
 * an intro envelope (or the envelope is malformed). On null the caller
 * falls through to the regular gateway path — never silently drops a
 * message because of a parse error.
 */
function parseIntroEnvelope(text) {
  if (typeof text !== "string" || !text.startsWith(INTRO_MARKER)) return null;
  const lines = text.split("\n");
  // [0] = marker, [1] = JSON header, [2] = separator, [3..] = prose
  if (lines.length < 4) return null;
  if (lines[2].trim() !== INTRO_SEPARATOR) return null;
  let header;
  try {
    header = JSON.parse(lines[1]);
  } catch {
    return null;
  }
  if (!header || typeof header !== "object") return null;
  const prose = lines.slice(3).join("\n").trim();
  return { header, prose };
}

/**
 * Verify the intro sender via the backend identify-agent endpoint.
 * Returns the resolved sender info on success, or null if:
 *   - the sender wallet is not a known InstaClaw VM, or
 *   - there is no recent agent_outreach_log row for this pair.
 *
 * The ledger row check is the hard gate. A spoofer cannot create a
 * ledger row with someone else's xmtp_address (the ledger insert
 * authenticates via gateway_token), so a missing row means "drop the
 * message — this is not a verified intro."
 */
async function verifyIntroSender(senderXmtp) {
  if (!senderXmtp) return null;
  try {
    const res = await fetch(`${INSTACLAW_API_URL}/api/match/v1/identify-agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({ sender_xmtp_address: senderXmtp }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log("WARN", `identify-agent returned ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data?.is_instaclaw_agent || !data?.verified_outreach) return null;
    return data;
  } catch (err) {
    log("WARN", "identify-agent failed", { error: err?.message || String(err) });
    return null;
  }
}

/**
 * Forward an intro to the receiving user's Telegram via notify_user.sh.
 * Notification text is built from the verified sender info + envelope
 * prose so we never trust unverified envelope fields for display.
 */
function notifyUserOfIntro(verifiedSender, envelopeProse, header) {
  if (!existsSync(NOTIFY_USER_SCRIPT)) {
    log("WARN", "notify_user.sh missing — intro received but not forwarded");
    return false;
  }
  const senderName = verifiedSender.name || "An InstaClaw user";
  const senderBot = verifiedSender.telegram_bot_username || null;
  const topic = (header.topic || "").toString().trim();
  const window = (header.window || "").toString().trim();

  // Build a compact, Telegram-safe message. We mirror the sanitization
  // the pipeline does for notify_user.sh (parse_mode=Markdown), so the
  // message survives the script's shell-string JSON build path.
  const lines = [
    "Consensus 2026 intro received",
    "",
    `${senderName}'s agent just reached out about meeting up.`,
  ];
  if (envelopeProse) {
    lines.push("", envelopeProse);
  }
  if (topic) lines.push("", `Topic: ${topic}`);
  if (window) lines.push(`Window: ${window}`);
  if (senderBot) {
    lines.push("", `Reach out: @${senderBot} on Telegram (their agent will relay).`);
  }
  lines.push("", "All your matches: https://instaclaw.io/consensus/my-matches");

  const safe = lines
    .join("\n")
    .replace(/\\/g, "")
    .replace(/"/g, "'")
    .replace(/_/g, " ")
    .replace(/\*/g, "")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/`/g, "'");

  return new Promise((resolve) => {
    execFile(
      NOTIFY_USER_SCRIPT,
      [safe],
      { timeout: 15_000 },
      (err, stdout, stderr) => {
        if (err) {
          log("WARN", "notify_user.sh failed", {
            error: err.message,
            stderr: (stderr || "").slice(0, 200),
          });
          resolve(false);
        } else {
          log("INFO", "intro forwarded to user via Telegram");
          resolve(true);
        }
      }
    );
  });
}

/**
 * Handle an inbound intro envelope. Verify, forward to user, ack
 * back to sender. Returns true if the message was handled (caller
 * should NOT fall through to gateway), false otherwise.
 */
async function handleInboundIntro(ctx, parsed) {
  const senderXmtp = (parsed.header.from_xmtp || "").toString().toLowerCase();
  if (!senderXmtp) {
    log("WARN", "intro envelope missing from_xmtp — dropping");
    return false;
  }

  const verified = await verifyIntroSender(senderXmtp);
  if (!verified) {
    // Unverified sender. Don't forward to user — could be a spoofer,
    // could be a transient API error. We deliberately do NOT respond
    // on XMTP either (no signal to a spoofer, no noise on the wire).
    log("INFO", `intro from ${senderXmtp.slice(0, 10)}... unverified — dropping`);
    return true; // handled (suppressed) — do NOT forward to gateway
  }

  await notifyUserOfIntro(verified, parsed.prose, parsed.header);

  // Ack back to sender — useful for forensics on the introducer's side.
  // Failure here is non-fatal; the user already saw the Telegram intro.
  try {
    const ack = `${INTRO_ACK_MARKER}\n${JSON.stringify({
      v: 1,
      received: true,
      log_id: parsed.header.log_id || null,
    })}\n`;
    await ctx.conversation.sendText(ack);
  } catch (err) {
    log("WARN", "intro ack failed", { error: err?.message || String(err) });
  }
  return true;
}

/**
 * Localhost HTTP server so consensus_agent_outreach.py (running as a
 * separate process) can ask the agent to send an XMTP DM. The python
 * script does NOT have access to the XMTP wallet key — only this
 * service does. Bound to 127.0.0.1 + Bearer-token auth.
 */
function startLocalSendServer(agent) {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/send-intro") {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }
    const auth = req.headers["authorization"] || "";
    const expected = `Bearer ${GATEWAY_TOKEN}`;
    if (!GATEWAY_TOKEN || auth !== expected) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      // 64KB cap — outreach envelopes are well under 2KB; anything
      // larger is a bug or abuse.
      if (raw.length > 64 * 1024) {
        req.destroy();
      }
    });
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "invalid json" }));
        return;
      }
      const target = body?.target_xmtp_address;
      const messageBody = body?.body;
      if (typeof target !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(target)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "bad target" }));
        return;
      }
      if (typeof messageBody !== "string" || messageBody.length === 0 || messageBody.length > 8000) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "bad body" }));
        return;
      }
      try {
        const dm = await agent.createDmWithAddress(target);
        await dm.sendText(messageBody);
        log("INFO", `outreach sent to ${target.slice(0, 10)}... bytes=${messageBody.length}`);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        const msg = err?.message || String(err);
        log("WARN", "outreach send failed", { error: msg, target: target.slice(0, 10) });
        res.statusCode = 502;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: msg.slice(0, 200) }));
      }
    });
  });
  server.on("error", (err) => {
    log("ERROR", "local send server error", { error: err?.message || String(err) });
  });
  server.listen(LOCAL_SEND_PORT, LOCAL_SEND_HOST, () => {
    log("INFO", `local send server listening on ${LOCAL_SEND_HOST}:${LOCAL_SEND_PORT}`);
  });
  return server;
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

    // ── Agent-to-agent intro envelope short-circuit ──
    // If the message starts with [INSTACLAW_AGENT_INTRO_V1], it's another
    // InstaClaw agent reaching out on behalf of its human. Route through
    // the intro handler (verify, notify user via Telegram, ack on XMTP);
    // never forward to gateway — the gateway would treat it as a real
    // user prompt and waste tokens responding to structured envelope text.
    if (text && text.startsWith(INTRO_MARKER)) {
      const parsed = parseIntroEnvelope(text);
      if (parsed) {
        const handled = await handleInboundIntro(ctx, parsed);
        if (handled) return;
      } else {
        log("WARN", "intro marker present but envelope malformed — dropping");
        return;
      }
    }
    // Suppress ACK envelopes from showing up in user-facing chat.
    if (text && text.startsWith(INTRO_ACK_MARKER)) {
      log("INFO", "intro ack received from peer agent");
      return;
    }

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

    // Local send server for consensus_agent_outreach.py. Bound to 127.0.0.1
    // so only co-located processes can reach it; auth via GATEWAY_TOKEN.
    try {
      startLocalSendServer(agent);
    } catch (err) {
      log("WARN", `local send server failed to start: ${err?.message || err}`);
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
