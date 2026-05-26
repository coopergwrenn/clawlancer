/**
 * Telegram shared bot outbound client.
 *
 * Used by:
 *   - app/api/telegram/shared-bot/inbound/route.ts (welcome burst)
 *   - lib/m-return-dispatch.ts (agent's first message)
 *
 * The "shared bot" is one Telegram bot account (@myinstaclaw_bot)
 * that ALL channel-onboarding Telegram users interact with. This is
 * distinct from the legacy BYOB Telegram flow where each user creates
 * their own bot via BotFather — that path remains intact for advanced
 * users via /signup → /connect.
 *
 * Env: TELEGRAM_SHARED_BOT_TOKEN (set in Vercel production via
 * `printf 'TOKEN' | npx vercel env add ...` per CLAUDE.md Rule 6).
 *
 * Rate-limit awareness: Telegram's Bot API allows 30 messages/sec per
 * bot globally, with stricter per-chat limits. Our welcome burst is
 * 3 messages over ~2.5s to the same chat — well within limits. The
 * sendMessage call is non-retrying; rely on the caller (welcome
 * burst handler, M_RETURN dispatcher) to handle any failure.
 */

import { logger } from "@/lib/logger";

const TELEGRAM_API_BASE = "https://api.telegram.org";

const CHAT_ID_REGEX = /^-?\d+$/;

export class TelegramSendError extends Error {
  public readonly status: number;
  public readonly description: string | null;

  constructor(message: string, status: number, description: string | null) {
    super(message);
    this.name = "TelegramSendError";
    this.status = status;
    this.description = description;
  }
}

export function isTelegramConfigured(): boolean {
  return !!process.env.TELEGRAM_SHARED_BOT_TOKEN;
}

export function isValidTelegramChatId(chatId: unknown): chatId is string {
  return typeof chatId === "string" && CHAT_ID_REGEX.test(chatId);
}

/**
 * Send a plain-text message via the Telegram shared bot.
 *
 * @param chatId Telegram chat_id as decimal string (positive for
 *               private chats, negative for groups — but we only
 *               send to private chats in this flow).
 * @param text   Message body.
 *
 * Throws TelegramSendError on non-2xx response. Does NOT retry — the
 * caller decides whether retrying makes sense (welcome burst should
 * not retry to avoid duplicates; M_RETURN does its own CAS+rollback).
 */
export async function sendTelegramSharedBot(
  chatId: string,
  text: string,
): Promise<{ message_id?: number }> {
  const token = process.env.TELEGRAM_SHARED_BOT_TOKEN;
  if (!token) {
    throw new TelegramSendError(
      "TELEGRAM_SHARED_BOT_TOKEN not configured",
      0,
      null,
    );
  }

  // Note: signature already types chatId as string, so we only need to
  // validate the regex format here (not the typeof). The
  // isValidTelegramChatId type guard is for callers that have `unknown`.
  if (!CHAT_ID_REGEX.test(chatId)) {
    throw new TelegramSendError(
      `Invalid Telegram chat_id format (length ${chatId.length})`,
      400,
      null,
    );
  }

  if (typeof text !== "string" || text.length === 0) {
    throw new TelegramSendError("Telegram text must be a non-empty string", 400, null);
  }

  // Telegram's documented per-message limit is 4096 chars. We cap at
  // 4000 defensively (room for any future Telegram quirks).
  if (text.length > 4000) {
    throw new TelegramSendError(
      `Telegram text exceeds 4000 char limit (got ${text.length})`,
      400,
      null,
    );
  }

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        // Telegram supports parse_mode for markdown/HTML. We send
        // plain text — safer (no escaping bugs) and matches the
        // iMessage parity of the welcome burst.
      }),
    });
  } catch (err) {
    throw new TelegramSendError(
      `Telegram network error: ${err instanceof Error ? err.message : String(err)}`,
      0,
      null,
    );
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // ignore
  }

  if (!response.ok) {
    const description =
      body && typeof body === "object" && "description" in body
        ? String((body as { description: unknown }).description)
        : null;
    logger.warn("[telegram-shared-bot] sendMessage non-2xx", {
      route: "lib/telegram-shared-bot",
      chatIdPrefix: chatId.slice(0, 4) + "***",
      status: response.status,
      description,
    });
    throw new TelegramSendError(
      `Telegram sendMessage failed (${response.status}): ${description ?? response.statusText}`,
      response.status,
      description,
    );
  }

  // Telegram response shape: { ok: true, result: { message_id, ... } }
  const result =
    body && typeof body === "object" && "result" in body
      ? (body as { result?: { message_id?: number } }).result
      : undefined;

  logger.info("[telegram-shared-bot] sent", {
    route: "lib/telegram-shared-bot",
    chatIdPrefix: chatId.slice(0, 4) + "***",
    messageId: result?.message_id,
    textLength: text.length,
  });

  return { message_id: result?.message_id };
}

/**
 * Best-effort version. Catches all errors and returns a result type
 * so webhook handlers can return 2xx to Telegram even when a
 * downstream send failed.
 */
export async function safeSendTelegramSharedBot(
  chatId: string,
  text: string,
): Promise<
  | { ok: true; messageId?: number }
  | { ok: false; status: number; error: string }
> {
  try {
    const r = await sendTelegramSharedBot(chatId, text);
    return { ok: true, messageId: r.message_id };
  } catch (err) {
    if (err instanceof TelegramSendError) {
      return { ok: false, status: err.status, error: err.message };
    }
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
