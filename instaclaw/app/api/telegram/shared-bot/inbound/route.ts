/**
 * POST /api/telegram/shared-bot/inbound
 *
 * Telegram webhook for the InstaClaw shared bot (@myinstaclaw_bot).
 * Mirrors /api/imessage/inbound's logic — same classification chain
 * (known / in_flight / new), same welcome burst with variable gaps,
 * same race-safety via lib/onboarding-signup.
 *
 * The DIFFERENCES from iMessage:
 *   - Transport: Telegram Bot API instead of Sendblue
 *   - Auth: Telegram's "secret_token" header model (set via setWebhook
 *     during bootstrap). Static shared secret in
 *     X-Telegram-Bot-Api-Secret-Token, compared in constant time.
 *   - Identity: chat_id (decimal integer, stored as string) instead
 *     of E.164 phone.
 *   - Payload shape: { update_id, message: { chat: { id, type }, text, ... } }
 *
 * Auth model (CLAUDE.md Rule 13):
 *   Route is in middleware selfAuthAPIs allow-list. Auth is the
 *   shared signing secret in X-Telegram-Bot-Api-Secret-Token,
 *   verified against TELEGRAM_SHARED_BOT_WEBHOOK_SECRET via
 *   constant-time sha256-hashed compare (same primitive as Sendblue).
 *
 * Per spec §6.5.3, welcome burst uses variable gaps (2s + 0.5s).
 * Per spec §6.5.7 invariant: returns 200 fast; burst plays via after().
 *
 * Edge cases handled here:
 *   - Malformed JSON              → 200 skipped (don't make Telegram retry)
 *   - Update is not a message     → 200 skipped (callback_query, edits, etc.)
 *   - Group chat (non-private)    → 200 skipped (we don't onboard groups)
 *   - Empty text + no media       → 200 skipped
 *   - Missing signing secret env  → 500 (we don't ship without it)
 *   - Bad signing secret          → 401
 *   - DB unreachable              → 500 (Telegram retries)
 */

import { NextRequest, NextResponse, after } from "next/server";
import { logger } from "@/lib/logger";
import { resolveInbound, detectPartnerFromText, type SignupChannel } from "@/lib/onboarding-signup";
import { verifySigningSecret } from "@/lib/sendblue-webhook";
import {
  sendTelegramSharedBot,
  isValidTelegramChatId,
} from "@/lib/telegram-shared-bot";
import {
  WELCOME_1,
  WELCOME_2,
  welcome3,
  WELCOME_GAP_1_TO_2_MS,
  WELCOME_GAP_2_TO_3_MS,
} from "@/lib/welcome-messages";
import { forwardInboundToVm } from "@/lib/channel-routing";

export const maxDuration = 300;

const CHANNEL: SignupChannel = "telegram";

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    from?: {
      id?: number;
      first_name?: string;
      username?: string;
      is_bot?: boolean;
    };
    chat?: {
      id?: number;
      type?: string; // "private" | "group" | "supergroup" | "channel"
    };
    text?: string;
  };
  // Other update types we don't handle (callback_query, edited_message,
  // channel_post, etc.) are gracefully ignored at the "no message" gate.
}

async function fireTelegramWelcomeBurst(
  chatId: string,
  shortCode: string,
  partner: string | null,
): Promise<void> {
  const chatIdRedacted = chatId.slice(0, 4) + "***";
  try {
    await sendTelegramSharedBot(chatId, WELCOME_1);
    await new Promise((r) => setTimeout(r, WELCOME_GAP_1_TO_2_MS));
    await sendTelegramSharedBot(chatId, WELCOME_2);
    await new Promise((r) => setTimeout(r, WELCOME_GAP_2_TO_3_MS));
    // Welcome 3 carries partner via ?p=<slug> — /go handler sets cookie
    // before redirecting to /auth (P1-A fix). For Telegram, the "/start"
    // deep-link pattern (t.me/myinstaclaw_bot?start=edge) lands here as
    // text="/start edge" so detectPartnerFromText picks it up naturally.
    await sendTelegramSharedBot(chatId, welcome3(shortCode, partner));
    logger.info("[/api/telegram/shared-bot/inbound] welcome burst complete", {
      route: "telegram/shared-bot/inbound",
      chatIdPrefix: chatIdRedacted,
      shortCode,
      partner: partner ?? null,
    });
  } catch (err) {
    logger.error("[/api/telegram/shared-bot/inbound] welcome burst failed", {
      route: "telegram/shared-bot/inbound",
      chatIdPrefix: chatIdRedacted,
      shortCode,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function POST(req: NextRequest) {
  // ─── Signing-secret verification (Rule 13: self-auth) ──
  const expectedSecret = process.env.TELEGRAM_SHARED_BOT_WEBHOOK_SECRET;
  if (!expectedSecret) {
    logger.error(
      "[/api/telegram/shared-bot/inbound] TELEGRAM_SHARED_BOT_WEBHOOK_SECRET not configured",
      { route: "telegram/shared-bot/inbound" },
    );
    return NextResponse.json(
      { error: "Webhook not configured" },
      { status: 500 },
    );
  }

  const providedSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (!providedSecret) {
    logger.warn(
      "[/api/telegram/shared-bot/inbound] missing secret-token header",
      { route: "telegram/shared-bot/inbound" },
    );
    return NextResponse.json({ error: "Missing secret token" }, { status: 401 });
  }

  if (!verifySigningSecret(providedSecret, expectedSecret)) {
    logger.warn("[/api/telegram/shared-bot/inbound] secret-token mismatch", {
      route: "telegram/shared-bot/inbound",
      providedPrefix: providedSecret.slice(0, 4) + "***",
    });
    return NextResponse.json({ error: "Invalid secret token" }, { status: 401 });
  }

  // ─── Parse payload ──
  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    logger.warn(
      "[/api/telegram/shared-bot/inbound] malformed JSON; returning 200 to halt retry",
      { route: "telegram/shared-bot/inbound" },
    );
    return NextResponse.json({ ok: true, skipped: "malformed-json" });
  }

  // We only handle `message` updates. Edited messages, callback
  // queries, channel posts, etc. are ignored gracefully.
  const message = update.message;
  if (!message) {
    return NextResponse.json({ ok: true, skipped: "non-message-update" });
  }

  // Skip bot-to-bot (defensive — shouldn't happen but protects against
  // a loop if some webhook tooling re-broadcasts to us).
  if (message.from?.is_bot === true) {
    return NextResponse.json({ ok: true, skipped: "from-bot" });
  }

  // Skip non-private chats. Onboarding is strictly 1-on-1; if our bot
  // gets added to a group, we ignore those messages.
  if (message.chat?.type !== "private") {
    logger.info("[/api/telegram/shared-bot/inbound] non-private chat; ignoring", {
      route: "telegram/shared-bot/inbound",
      chatType: message.chat?.type,
    });
    return NextResponse.json({ ok: true, skipped: "non-private-chat" });
  }

  // Validate chat_id shape.
  const chatIdNum = message.chat?.id;
  if (typeof chatIdNum !== "number" || !Number.isFinite(chatIdNum)) {
    return NextResponse.json({ ok: true, skipped: "no-chat-id" });
  }
  const chatId = String(chatIdNum);
  if (!isValidTelegramChatId(chatId)) {
    return NextResponse.json({ ok: true, skipped: "invalid-chat-id-shape" });
  }

  // Text content. /start is the canonical first message; we treat any
  // non-empty text as the "this user wants to engage" signal.
  const text = message.text?.trim() ?? "";
  if (text.length === 0) {
    return NextResponse.json({ ok: true, skipped: "empty-text" });
  }

  // ─── Classify sender via shared resolver ──
  const resolution = await resolveInbound(CHANNEL, chatId);
  const chatIdRedacted = chatId.slice(0, 4) + "***";

  switch (resolution.kind) {
    case "error":
      logger.error("[/api/telegram/shared-bot/inbound] resolveInbound error", {
        route: "telegram/shared-bot/inbound",
        chatIdPrefix: chatIdRedacted,
        error: resolution.error,
      });
      // 500 → Telegram retries. They retry up to 3 times with backoff.
      return NextResponse.json({ error: "Internal error" }, { status: 500 });

    case "known": {
      // Returning user. Forward to their VM gateway via lib/channel-routing
      // — POST /v1/chat/completions, agent runs with full memory/tools,
      // response comes back via sendTelegramSharedBot. Fire in after() so
      // Telegram's webhook gets a 200 within budget.
      logger.info(
        "[/api/telegram/shared-bot/inbound] known user — scheduling gateway relay",
        {
          route: "telegram/shared-bot/inbound",
          chatIdPrefix: chatIdRedacted,
          userId: resolution.userId,
          vmId: resolution.vmId,
          textLength: text.length,
        },
      );
      after(async () => {
        await forwardInboundToVm({
          userId: resolution.userId,
          channel: "telegram",
          channelIdentity: chatId,
          text,
          // Telegram's update_id is a stable per-update identifier; carry
          // it through so a future de-dup table can use it. v1 has no
          // dedup store; this is logged-only for now.
          inboundMessageId:
            typeof update.update_id === "number"
              ? String(update.update_id)
              : undefined,
        });
      });
      return NextResponse.json({ ok: true, kind: "known" });
    }

    case "in_flight":
      logger.info(
        "[/api/telegram/shared-bot/inbound] in-flight; not re-firing welcome",
        {
          route: "telegram/shared-bot/inbound",
          chatIdPrefix: chatIdRedacted,
          pendingId: resolution.pendingId,
          shortCode: resolution.shortCode,
        },
      );
      return NextResponse.json({ ok: true, kind: "in_flight" });

    case "new": {
      // P1-A: detect partner via text content. Telegram deep-links of the
      // form t.me/myinstaclaw_bot?start=edge arrive here as text="/start
      // edge" — detectPartnerFromText finds "edge" naturally.
      const detectedPartner = detectPartnerFromText(text);
      logger.info(
        "[/api/telegram/shared-bot/inbound] new user — scheduling welcome burst",
        {
          route: "telegram/shared-bot/inbound",
          chatIdPrefix: chatIdRedacted,
          pendingId: resolution.pendingId,
          shortCode: resolution.shortCode,
          detectedPartner,
        },
      );
      after(async () => {
        await fireTelegramWelcomeBurst(chatId, resolution.shortCode, detectedPartner);
      });
      return NextResponse.json({ ok: true, kind: "new" });
    }

    default: {
      const exhaustive: never = resolution;
      logger.error("[/api/telegram/shared-bot/inbound] unreachable kind", {
        route: "telegram/shared-bot/inbound",
        resolution: exhaustive,
      });
      return NextResponse.json({ error: "Unreachable" }, { status: 500 });
    }
  }
}
