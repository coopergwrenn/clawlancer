import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.GATEWAY_PORT || "8080", 10);
const BIND = process.env.GATEWAY_BIND || "0.0.0.0";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5-20250929";
const PROXY_URL = process.env.ANTHROPIC_PROXY_URL;

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
if (!API_KEY && !PROXY_URL) throw new Error("ANTHROPIC_API_KEY or ANTHROPIC_PROXY_URL is required");

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------
const anthropicOpts = { apiKey: API_KEY || "proxy-mode" };
if (PROXY_URL) {
  anthropicOpts.baseURL = PROXY_URL.replace(/\/+$/, "");
  anthropicOpts.defaultHeaders = { "x-gateway-token": GATEWAY_TOKEN || "" };
}
const anthropic = new Anthropic(anthropicOpts);

// Per-chat conversation history (last N messages, keyed by chat_id)
const MAX_HISTORY = 20;
const conversations = new Map();

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tgSend(chatId, text) {
  await fetch(`${TG}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });
}

async function tgSendTyping(chatId) {
  await fetch(`${TG}/sendChatAction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

async function tgSetWebhook() {
  // Get our external IP for the webhook URL (Caddy handles HTTPS)
  let ip;
  try {
    const res = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(5000) });
    ip = (await res.text()).trim();
  } catch {
    console.warn("[gateway] Could not resolve external IP for webhook");
    return;
  }

  const webhookUrl = `https://${ip}/webhook`;
  const res = await fetch(`${TG}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: webhookUrl }),
  });
  const data = await res.json();
  console.log(`[gateway] Webhook set: ${webhookUrl} =>`, data.ok ? "OK" : data.description);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
async function handleMessage(chatId, userText) {
  await tgSendTyping(chatId);

  // Get or create conversation history
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }
  const history = conversations.get(chatId);

  // Add user message
  history.push({ role: "user", content: userText });

  // Trim to max history
  while (history.length > MAX_HISTORY) {
    history.shift();
  }

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: "You are a helpful AI assistant running on Telegram via OpenClaw. Be concise and helpful. Use Markdown formatting where appropriate.",
      messages: history,
    });

    const assistantText =
      response.content?.[0]?.type === "text"
        ? response.content[0].text
        : "I couldn't generate a response.";

    // Add assistant response to history
    history.push({ role: "assistant", content: assistantText });

    // Telegram has a 4096 char limit per message
    if (assistantText.length <= 4096) {
      await tgSend(chatId, assistantText);
    } else {
      // Split into chunks
      for (let i = 0; i < assistantText.length; i += 4096) {
        await tgSend(chatId, assistantText.slice(i, i + 4096));
      }
    }
  } catch (err) {
    console.error("[gateway] Anthropic error:", err.message);

    // Check for rate limit from proxy
    if (err.status === 429) {
      await tgSend(chatId, "You've reached your daily message limit. It resets at midnight UTC.");
    } else {
      await tgSend(chatId, "Sorry, I encountered an error. Please try again.");
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${BIND}:${PORT}`);

  // Health check
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", model: MODEL }));
    return;
  }

  // Telegram webhook
  if (url.pathname === "/webhook" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    try {
      const update = JSON.parse(body);
      const msg = update.message;
      if (msg?.text && msg.chat?.id) {
        // Handle /start command
        if (msg.text === "/start") {
          await tgSend(msg.chat.id, `Hello! I'm your AI assistant powered by ${MODEL}. Send me any message to get started.`);
        } else {
          handleMessage(msg.chat.id, msg.text).catch((err) =>
            console.error("[gateway] Handler error:", err.message)
          );
        }
      }
    } catch (err) {
      console.error("[gateway] Webhook parse error:", err.message);
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, BIND, async () => {
  console.log(`[gateway] OpenClaw gateway listening on ${BIND}:${PORT}`);
  console.log(`[gateway] Model: ${MODEL}`);
  console.log(`[gateway] Proxy: ${PROXY_URL || "direct"}`);
  await tgSetWebhook();
});
