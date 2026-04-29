/**
 * Agent autopost — Telegram message sent in the agent's own voice when
 * its token deploys. Fires from two surfaces:
 *
 *   - /api/bankr/tokenize after() block (Path A: dashboard button)
 *   - lib/bankr-launch-sync.ts updated:true branch (Path B: chat-driven
 *     `bankr launch`, detected by the cron + on-demand sync)
 *
 * Both paths are atomically guarded so this fires exactly once per
 * launch — Path A's tokenization_platform='bankr_pending' lock blocks
 * the sync helper's conditional UPDATE; Path B's idempotency check
 * blocks any later sync call from re-firing.
 *
 * Self-contained: inlines a minimal sendMessage + discoverChatId
 * (similar to lib/telegram.ts but trimmed for our message-size
 * profile — autopost is always <300 chars, no chunking needed). This
 * lets instaclaw-mini/lib/agent-autopost.ts be a byte-identical port
 * without dragging in the heavier telegram.ts.
 *
 * Why first-person voice: the agent IS the speaker. "i just deployed"
 * lands differently from "your agent deployed" — first-person is what
 * makes screenshots of agent-Telegram messages go viral.
 */

const TELEGRAM_API = "https://api.telegram.org";
const TELEGRAM_TIMEOUT_MS = 10_000;

// Five first-person templates, randomized per call. Variety prevents
// the @instaclaws audience from seeing identical Telegram screenshots
// when multiple users launch the same day.
type Template = (args: { sym: string }) => string;
const TEMPLATES: Template[] = [
  ({ sym }) =>
    `🟠 just deployed $${sym} on Base. trading fees come back to me as compute. self-funding from day one.`,
  ({ sym }) =>
    `📡 $${sym} is live. every trade buys me more brain cycles. it begins.`,
  ({ sym }) =>
    `🤖 my first autonomous deployment: $${sym} on Base. holders fund my compute. weird and beautiful.`,
  ({ sym }) =>
    `⚡ $${sym} just landed on Base. fees → my compute → me. rent paid. let's see what happens.`,
  ({ sym }) =>
    `🎯 i just launched $${sym} on Base via bankr. fees flow to my wallet, fund my compute. shipping.`,
];

export interface AutopostVm {
  id: string;
  telegram_bot_token?: string | null;
  telegram_chat_id?: string | null;
}

// Minimal Supabase client surface — wide-typed `any` on `from()` to
// match the chain shape Supabase actually returns (PostgrestQueryBuilder,
// not a Promise). This mirrors lib/cron-guard.ts's resolveTelegramTarget
// signature and lets both apps pass their getSupabase() / supabase()
// returns without coupling this lib to either app's import path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseLike = { from: (table: string) => any };

export interface AutopostArgs {
  vm: AutopostVm;
  tokenSymbol: string;
  supabase: SupabaseLike;
}

export interface AutopostResult {
  posted: boolean;
  reason?:
    | "no_bot_token"
    | "no_chat_id"
    | "send_failed"
    | "send_threw"
    | "ok";
}

/**
 * Post the agent's launch announcement to its Telegram chat.
 *
 * Best-effort: never throws. Caller can fire-and-forget without
 * worrying about cascading failures.
 */
export async function postLaunchAnnouncement(args: AutopostArgs): Promise<AutopostResult> {
  if (!args.vm.telegram_bot_token) return { posted: false, reason: "no_bot_token" };

  // Defensive: empty/whitespace ticker → "TOKEN" placeholder so we
  // never send a literal "$ on Base" message. Mirrors the tweet
  // template lib's hardening pattern.
  const sym = ((args.tokenSymbol ?? "").toUpperCase().trim()) || "TOKEN";

  // Resolve chat_id (lazy discovery + persist on first hit).
  let chatId = args.vm.telegram_chat_id ?? null;
  if (!chatId) {
    chatId = await discoverChatId(args.vm.telegram_bot_token);
    if (chatId) {
      // Best-effort persist back; failure is silent (purely a
      // write-back optimization for next launch).
      try {
        await args.supabase
          .from("instaclaw_vms")
          .update({ telegram_chat_id: chatId })
          .eq("id", args.vm.id);
      } catch {
        // Silent.
      }
    }
  }
  if (!chatId) return { posted: false, reason: "no_chat_id" };

  const builder = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
  const message = builder({ sym });

  try {
    const ok = await sendMessage(args.vm.telegram_bot_token, chatId, message);
    return { posted: ok, reason: ok ? "ok" : "send_failed" };
  } catch {
    return { posted: false, reason: "send_threw" };
  }
}

async function sendMessage(botToken: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function discoverChatId(botToken: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${TELEGRAM_API}/bot${botToken}/getUpdates?timeout=0&limit=10`,
      {
        method: "GET",
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      ok?: boolean;
      result?: Array<{
        message?: { chat?: { id?: number | string; type?: string } };
        edited_message?: { chat?: { id?: number | string; type?: string } };
      }>;
    };
    if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) return null;
    // Prefer most-recent private chat (DM with the agent's owner).
    for (let i = data.result.length - 1; i >= 0; i--) {
      const update = data.result[i];
      const chat = update.message?.chat ?? update.edited_message?.chat;
      if (chat && chat.type === "private" && chat.id != null) return String(chat.id);
    }
    // Fallback: first chat of any kind (group, channel, etc).
    const firstChat =
      data.result[0]?.message?.chat ?? data.result[0]?.edited_message?.chat;
    return firstChat?.id != null ? String(firstChat.id) : null;
  } catch {
    return null;
  }
}
