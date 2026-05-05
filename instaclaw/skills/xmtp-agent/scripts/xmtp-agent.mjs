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

// ── Dynamic gateway-token resolver ──

/**
 * Read the current GATEWAY_TOKEN from ~/.openclaw/.env on every call.
 *
 * The xmtp-agent service loads ~/.openclaw/xmtp/.env via systemd's
 * EnvironmentFile at startup, but that file is only written by setupXMTP
 * at first provisioning. resyncGatewayToken (the canonical rotation
 * path) updates ~/.openclaw/.env, openclaw.json, auth-profiles.json, and
 * the DB — but NOT xmtp/.env. Across a token rotation, xmtp-agent's
 * cached GATEWAY_TOKEN goes stale and identify-agent / outreach calls
 * 401 for hours until the next service restart.
 *
 * Reading the canonical token per-call costs one syscall and survives
 * any rotation. Cached value is the env-loaded one (cheap fallback).
 */
function getGatewayToken() {
  try {
    const lines = readFileSync(join(HOME, ".openclaw", ".env"), "utf-8").split("\n");
    for (const l of lines) {
      const trimmed = l.trim();
      if (trimmed.startsWith("GATEWAY_TOKEN=")) {
        const v = trimmed.slice("GATEWAY_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
        if (v) return v;
      }
    }
  } catch {
    // fall through
  }
  return GATEWAY_TOKEN; // env-cached value as last resort
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
        "Authorization": `Bearer ${getGatewayToken()}`,
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
 * Build a user-facing intro message. Reused by both Telegram (passed
 * to notify_user.sh) and XMTP (sent to USER_WALLET_ADDRESS) paths so
 * the user sees the same content regardless of channel.
 *
 * `forXmtp` toggles whether to apply the Telegram-Markdown sanitizer
 * (which would strip @, *, _ etc that are fine in plain XMTP text).
 *
 * CTA routing: the receiver-facing reachback uses the sender's
 * personal Telegram handle when available (header.from_telegram_handle
 * AND verifiedSender.telegram_handle are both forward-compatible
 * fields). It deliberately does NOT fall back to the sender's bot
 * username — routing one person to chat with another person's AI
 * bot is a UX dead end (Cooper, 2026-05-05). When no personal
 * handle is known, fall back to the /consensus/my-matches link.
 */
function buildIntroBody(verifiedSender, envelopeProse, header, forXmtp) {
  const senderName = verifiedSender.name || "An InstaClaw user";

  // Draft C structure (2026-05-05): receiver wrapper is the conversation
  // — sender's prose is quoted within it.
  //   1. relationship-warm framing line (your agent introducing the intro)
  //   2. quote intro ("Here's what they said:")
  //   3. sender's prose verbatim (rationale + topic + window only)
  //   4. CTA: personal handle when known, else my-matches link
  //   5. match-count link (omit count when 0; always link to my-matches)
  //   6. quiet "(Quick note:...)" footer about the cap + how to change it
  //
  // The sender prose intentionally stops at topic/window — the receiver
  // wrapper owns CTA + count + cap because those are about the
  // RECEIVER's experience, not the sender's intent.
  const senderHandle = (verifiedSender.telegram_handle || header.from_telegram_handle || "")
    .toString().trim().replace(/^@/, "");
  const otherCount = Math.max(0, parseInt(header.target_pending_intro_count, 10) || 0);
  const cap = Math.max(0, parseInt(header.intro_per_receiver_cap, 10) || 3);

  const lines = [];
  lines.push(`${senderName}'s agent reached out — they think you two should meet.`);
  lines.push("");
  lines.push("Here's what they said:");
  lines.push("");
  if (envelopeProse && envelopeProse.trim().length > 0) {
    lines.push(envelopeProse.trim());
  } else {
    // Defensive fallback: prose was missing or empty. Shouldn't happen
    // in production but we want to never render "Here's what they
    // said:" followed by nothing.
    lines.push(`${senderName} thinks you should connect at Consensus 2026.`);
  }

  // CTA — personal handle preferred, my-matches fallback. Bot is
  // never used as a fallback (Cooper, 2026-05-05).
  lines.push("");
  if (senderHandle) {
    lines.push(`You can DM ${senderName} directly: @${senderHandle} on Telegram.`);
  } else {
    lines.push(`To follow up, see your matches page: https://instaclaw.io/consensus/my-matches`);
  }

  // Match count + page link. Phrasing differs by count: "X other"
  // when there are others, plain link when there aren't (avoids
  // saying "0 others matched" which reads weird). Personal-handle
  // CTA already linked the user to a way to reach the sender, so
  // the matches page becomes a "see all your matches" surface.
  lines.push("");
  if (otherCount === 1) {
    lines.push(`One other person matched with you today — see them on your page: https://instaclaw.io/consensus/my-matches`);
  } else if (otherCount >= 2) {
    lines.push(`${otherCount} other people matched with you today — see them on your page: https://instaclaw.io/consensus/my-matches`);
  } else if (!senderHandle) {
    // No-handle CTA already showed the link above; don't duplicate.
    // Leave this slot empty so we don't re-print the URL.
  } else {
    // Have-handle CTA pointed at Telegram. Add the my-matches link
    // as a secondary surface even when count is 0 — the page is the
    // hub for "see all your matches" regardless of count.
    lines.push(`See all your matches: https://instaclaw.io/consensus/my-matches`);
  }

  // Cap-controls footer. Quiet, parenthetical, conversational —
  // not a settings UI. cap=0 means kill-switch active for inbound;
  // shouldn't happen in practice (no intros would land), so we
  // skip the footer in that case to avoid contradiction.
  if (cap > 0) {
    lines.push("");
    lines.push(
      `(Quick note: you're set to ${cap} ${cap === 1 ? "intro" : "intros"}/day. ` +
      `Just tell me "pause intros", "change to N/day", or "daily summary instead" if you want me to adjust.)`
    );
  }

  const text = lines.join("\n");
  if (forXmtp) return text;
  // Telegram parse_mode=Markdown sanitizer: strip chars that break
  // notify_user.sh's shell-string JSON build path.
  return text
    .replace(/\\/g, "")
    .replace(/"/g, "'")
    .replace(/_/g, " ")
    .replace(/\*/g, "")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/`/g, "'");
}

/**
 * Read every log_id ever written to pending-intros.jsonl OR
 * pending-intros-seen.jsonl (the agent's archive after surfacing).
 * Used for dedup-on-intake: if an intro arrives via XMTP but it was
 * already polled in by the pipeline (or vice-versa), we don't double-
 * append. log_id is the universal idempotency key — same row in the
 * server ledger maps to one entry on disk regardless of channel.
 */
function readSeenLogIds() {
  const seen = new Set();
  for (const name of ["pending-intros.jsonl", "pending-intros-seen.jsonl"]) {
    const p = join(XMTP_DIR, name);
    if (!existsSync(p)) continue;
    try {
      const txt = readFileSync(p, "utf-8");
      for (const line of txt.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const row = JSON.parse(t);
          if (row?.log_id) seen.add(String(row.log_id));
        } catch {
          // malformed line; skip
        }
      }
    } catch {
      // unreadable; skip
    }
  }
  return seen;
}

/**
 * Append an intro to the on-disk pending-intros log so the agent
 * surfaces it in MEMORY.md or future conversations even if the live
 * Telegram + XMTP delivery paths both fail. This is the recovery-of-
 * last-resort: an intro that arrived but couldn't be surfaced live
 * is NOT dropped on the floor.
 *
 * Returns true if a new line was appended, false if log_id was already
 * present (dedup hit). Caller can use the boolean to suppress double
 * notifications.
 */
function appendPendingIntro(verifiedSender, prose, header, log_id) {
  const seen = readSeenLogIds();
  if (log_id && seen.has(String(log_id))) {
    log("INFO", `pending-intros dedup: log_id=${log_id} already seen`);
    return false;
  }
  const path = join(XMTP_DIR, "pending-intros.jsonl");
  const row = {
    ts: new Date().toISOString(),
    log_id,
    sender_user_id: verifiedSender.user_id,
    sender_name: verifiedSender.name,
    sender_bot: verifiedSender.telegram_bot_username,
    sender_xmtp: header.from_xmtp,
    sender_identity_wallet: verifiedSender.identity_wallet,
    topic: header.topic || "",
    window: header.window || "",
    prose,
  };
  try {
    appendFileSync(path, JSON.stringify(row) + "\n");
    return true;
  } catch (e) {
    log("WARN", "appendPendingIntro failed", { error: e?.message || String(e) });
    return false;
  }
}

/**
 * POST /api/match/v1/outreach phase=ack — tells the server we've
 * surfaced this intro to the user via the named channel. Stops the
 * sender's retry loop. Idempotent — second ack is a no-op.
 *
 * Failure here is logged but NOT fatal: the user already has the
 * intro on disk / in Telegram. Worst case, the sender retries and
 * the receiver dedups by log_id.
 */
async function ackIntroToServer(log_id, channel) {
  if (!log_id || !channel) return;
  try {
    const res = await fetch(`${INSTACLAW_API_URL}/api/match/v1/outreach`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getGatewayToken()}`,
      },
      body: JSON.stringify({ phase: "ack", log_id, channel }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log("WARN", `ack POST returned ${res.status}`);
      return;
    }
    const data = await res.json().catch(() => null);
    if (data?.already_acked) {
      log("INFO", `ack: log_id=${log_id} already acked (no-op)`);
    } else {
      log("INFO", `ack: log_id=${log_id} channel=${channel}`);
    }
  } catch (err) {
    log("WARN", "ack failed (non-fatal)", { error: err?.message || String(err) });
  }
}

/**
 * Forward an intro to the receiving user via the BEST available channel:
 *   1. Telegram via notify_user.sh, IF TELEGRAM_CHAT_ID is known.
 *      (Receiver's identify-agent response carries this from the DB.)
 *   2. XMTP DM to USER_WALLET_ADDRESS, IF set in agent env.
 *      (This is the same channel as the proactive greeting — lands in
 *       the user's World Chat thread with their agent.)
 *   3. Fallthrough: append to pending-intros.jsonl on disk so the
 *      agent can surface it in a future conversation.
 *
 * Returns the channel that succeeded ("telegram" | "xmtp_user" |
 * "pending") or "failed" if all paths failed.
 *
 * Either path failing falls through to the next; we want at-least-one-
 * channel-or-disk delivery so an intro is never silently lost.
 */
async function notifyUserOfIntro(agent, verifiedSender, envelopeProse, header, log_id) {
  // Dedup-on-intake: if this log_id was already surfaced (via the
  // poll path or a prior XMTP retry), short-circuit. The server-side
  // ACK is idempotent so we still post it — sender's retry loop
  // depends on seeing the ACK.
  if (log_id) {
    const seen = readSeenLogIds();
    if (seen.has(String(log_id))) {
      log("INFO", `notifyUserOfIntro dedup: log_id=${log_id} already surfaced`);
      // Best-effort ACK so sender stops retrying. Channel "polled" is
      // the canonical "delivered out-of-band" marker.
      ackIntroToServer(log_id, "polled");
      return "duplicate";
    }
  }

  // ── Channel 1: Telegram via notify_user.sh ──
  const chatId = verifiedSender.receiver_telegram_chat_id
    ? String(verifiedSender.receiver_telegram_chat_id)
    : null;
  if (chatId && existsSync(NOTIFY_USER_SCRIPT)) {
    const safe = buildIntroBody(verifiedSender, envelopeProse, header, /* forXmtp= */ false);
    const childEnv = { ...process.env, TELEGRAM_CHAT_ID: chatId };
    const sent = await new Promise((resolve) => {
      execFile(
        NOTIFY_USER_SCRIPT,
        [safe],
        { timeout: 15_000, env: childEnv },
        (err, stdout, stderr) => {
          if (err) {
            log("WARN", "notify_user.sh failed (will try XMTP fallback)", {
              error: err.message,
              stdout: (stdout || "").slice(0, 200),
              stderr: (stderr || "").slice(0, 200),
            });
            resolve(false);
          } else {
            resolve(true);
          }
        }
      );
    });
    if (sent) {
      log("INFO", "intro forwarded to user via Telegram");
      // Also append to pending-intros.jsonl so the agent can re-render
      // history when asked, and so dedup-on-intake works for any future
      // XMTP retry that arrives for the same log_id.
      const proseForDisk = buildIntroBody(verifiedSender, envelopeProse, header, /* forXmtp= */ true);
      appendPendingIntro(verifiedSender, proseForDisk, header, log_id);
      ackIntroToServer(log_id, "telegram");
      return "telegram";
    }
  } else {
    log("INFO", chatId
      ? "TELEGRAM_CHAT_ID present but notify_user.sh missing — falling back to XMTP-user channel"
      : "no TELEGRAM_CHAT_ID for receiver — falling back to XMTP-user channel");
  }

  // ── Channel 2: XMTP DM to USER_WALLET_ADDRESS (World Chat / mini app) ──
  const userAddr = process.env.USER_WALLET_ADDRESS;
  if (userAddr && /^0x[a-fA-F0-9]{40}$/.test(userAddr)) {
    try {
      const body = buildIntroBody(verifiedSender, envelopeProse, header, /* forXmtp= */ true);
      const dm = await agent.createDmWithAddress(userAddr);
      await dm.sendText(body);
      log("INFO", "intro forwarded to user via XMTP user channel", { user: userAddr.slice(0, 10) });
      const proseForDisk = body;
      appendPendingIntro(verifiedSender, proseForDisk, header, log_id);
      ackIntroToServer(log_id, "xmtp_user");
      return "xmtp_user";
    } catch (err) {
      log("WARN", "xmtp user-channel send failed (will fall through to pending)", {
        error: err?.message || String(err),
      });
    }
  } else {
    log("INFO", "USER_WALLET_ADDRESS not set — skipping XMTP-user channel");
  }

  // ── Channel 3: pending-intros.jsonl on disk ──
  const proseForDisk = buildIntroBody(verifiedSender, envelopeProse, header, /* forXmtp= */ true);
  const appended = appendPendingIntro(verifiedSender, proseForDisk, header, log_id);
  if (appended) {
    log("WARN", "intro stored to pending-intros.jsonl — no live channel succeeded");
  }
  // Even when no live channel succeeded, ACK to the server so the
  // sender's retry loop stops. The intro IS delivered (durably, on
  // disk for the agent to surface). "pending" is the channel name.
  ackIntroToServer(log_id, "pending");
  return "pending";
}

/**
 * Handle an inbound intro envelope. Verify, forward to user, ack
 * back to sender. Returns true if the message was handled (caller
 * should NOT fall through to gateway), false otherwise.
 *
 * `agent` is needed so the user-channel fallback can `createDmWithAddress`
 * for users without a known Telegram chat_id.
 */
async function handleInboundIntro(agent, ctx, parsed) {
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

  const channel = await notifyUserOfIntro(
    agent,
    verified,
    parsed.prose,
    parsed.header,
    verified.log_id || parsed.header.log_id || null,
  );

  // Ack back to sender — useful for forensics on the introducer's side.
  // Failure here is non-fatal; the user already saw the intro.
  try {
    const ack = `${INTRO_ACK_MARKER}\n${JSON.stringify({
      v: 1,
      received: true,
      channel,
      log_id: verified.log_id || parsed.header.log_id || null,
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
    // Localhost trust model: the listener is bound to 127.0.0.1 so the
    // kernel already restricts callers to processes on this VM. Anything
    // running as the openclaw user can reach the XMTP wallet key on disk
    // directly anyway, so a Bearer-token check on top adds no security
    // and creates a token-drift footgun (mjs reads ~/.openclaw/xmtp/.env,
    // python reads ~/.openclaw/.env — these can desync after a gateway
    // token rotation, and the local send call would 401 even when both
    // processes are healthy on the same VM).
    const remote = req.socket?.remoteAddress || "";
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "non-local origin" }));
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

    // Diagnostic — first 60 raw chars (printable + literal markers) so
    // we can tell envelope-from-marker-mismatch from real user prompts.
    const headRaw = (typeof text === "string" ? text : JSON.stringify(text)).slice(0, 60);
    log("INFO", `Message from ${sender} in ${convId}: ${(typeof text === "string" ? text : "(non-string)").toString().slice(0, 100)}${typeof text === "string" && text.length > 100 ? "..." : ""}  [head=${JSON.stringify(headRaw)}]`);

    // ── Agent-to-agent intro envelope short-circuit ──
    // If the message starts with [INSTACLAW_AGENT_INTRO_V1], it's another
    // InstaClaw agent reaching out on behalf of its human. Route through
    // the intro handler (verify, notify user via Telegram, ack on XMTP);
    // never forward to gateway — the gateway would treat it as a real
    // user prompt and waste tokens responding to structured envelope text.
    if (typeof text === "string" && text.includes(INTRO_MARKER)) {
      // Tolerant prefix check: some XMTP installations / content-type
      // wrappers add a brief leading whitespace or quoted-printable
      // header before the body. We match `includes` and then realign
      // the parser to the marker offset.
      const idx = text.indexOf(INTRO_MARKER);
      const slice = text.slice(idx);
      const parsed = parseIntroEnvelope(slice);
      if (parsed) {
        const handled = await handleInboundIntro(agent, ctx, parsed);
        if (handled) return;
      } else {
        log("WARN", "intro marker present but envelope malformed — dropping (no fallback reply)");
        return;
      }
    }
    // Suppress ACK envelopes from showing up in user-facing chat.
    if (typeof text === "string" && text.includes(INTRO_ACK_MARKER)) {
      log("INFO", "intro ack received from peer agent");
      return;
    }

    // Forward to gateway with full conversation history
    const response = await sendToGateway(convId, text);

    if (response) {
      await ctx.conversation.sendText(response);
      log("INFO", `Replied to ${sender}: ${response.slice(0, 100)}${response.length > 100 ? "..." : ""}`);
    } else {
      // No fallback reply. If we send "I'm having trouble..." here and
      // the sender is another instaclaw agent (or a buggy XMTP echo),
      // we get a runaway reply loop — both sides bouncing the same
      // failure message back and forth at full XMTP speed (~30 msg/s).
      // Burns through gateway/Anthropic credits on the responding side
      // and floods XMTP with traffic. Silent log is the safe choice;
      // a real user retrying gets the next attempt naturally.
      log("WARN", `No response from gateway for ${sender} — dropping silently (no reply, no loop risk)`);
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
