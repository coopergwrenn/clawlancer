/**
 * Telegram delivery helpers for recurring task results and notifications.
 *
 * Architecture note: The Telegram bot runs on the user's VM via OpenClaw
 * long-polling. For recurring task delivery, Vercel calls the Telegram API
 * directly using the bot_token stored in instaclaw_vms. The chat_id is
 * discovered lazily via getUpdates (one-time, brief polling interruption).
 */

import { sanitizeAgentResult } from "@/lib/sanitize-result";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MSG_LENGTH = 4000; // Telegram limit is 4096; leave buffer

/**
 * Send a formatted recurring task result to a Telegram chat.
 * Returns { success, error? }.
 */
export async function sendTelegramTaskResult(
  botToken: string,
  chatId: string,
  task: { title: string; frequency: string; streak: number; result: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    // Safety net: sanitize result before sending
    const cleanResult = sanitizeAgentResult(task.result);
    const header = `📋 ${task.title}\n${task.frequency} · Run #${task.streak}\n${"─".repeat(30)}\n\n`;
    const footer = `\n\n${"─".repeat(30)}\n🤖 Delivered by your InstaClaw agent`;
    const fullMessage = header + cleanResult + footer;

    const chunks: string[] = [];

    if (fullMessage.length <= MAX_MSG_LENGTH) {
      chunks.push(fullMessage);
    } else {
      // First chunk gets the header
      const firstContentLen = MAX_MSG_LENGTH - header.length - 20;
      chunks.push(
        header + cleanResult.slice(0, firstContentLen) + "\n\n⏬ (continued...)"
      );
      let remaining = cleanResult.slice(firstContentLen).trim();

      while (remaining.length > 0) {
        if (remaining.length <= MAX_MSG_LENGTH - footer.length - 20) {
          chunks.push(remaining + footer);
          break;
        }
        // Split on paragraph boundaries
        let splitPoint = remaining.lastIndexOf("\n\n", MAX_MSG_LENGTH - 20);
        if (splitPoint <= 0)
          splitPoint = remaining.lastIndexOf("\n", MAX_MSG_LENGTH - 20);
        if (splitPoint <= 0) splitPoint = MAX_MSG_LENGTH - 20;
        chunks.push(
          remaining.slice(0, splitPoint) + "\n\n⏬ (continued...)"
        );
        remaining = remaining.slice(splitPoint).trim();
      }
    }

    for (let i = 0; i < chunks.length; i++) {
      // Plain text mode — agent output contains markdown chars (* _ [ etc.)
      // that would break Telegram's Markdown parser with 400 errors.
      const response = await fetch(
        `${TELEGRAM_API}/bot${botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunks[i],
            disable_web_page_preview: true,
          }),
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(
          `Telegram send failed (chunk ${i + 1}/${chunks.length}):`,
          errorBody
        );
        return {
          success: false,
          error: `Telegram API error: ${response.status}`,
        };
      }

      // Delay between chunks to avoid Telegram rate limiting
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return { success: true };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("Telegram delivery error:", errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Send a simple notification message (errors, pauses, etc.).
 */
export async function sendTelegramNotification(
  botToken: string,
  chatId: string,
  message: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `${TELEGRAM_API}/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          disable_web_page_preview: true,
        }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Attempt to discover the chat_id for a bot by calling getUpdates.
 * This briefly interrupts the VM's long-polling (one missed cycle ~1s).
 * Returns the chat_id string or null if no chats found.
 */
export async function discoverTelegramChatId(
  botToken: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `${TELEGRAM_API}/bot${botToken}/getUpdates?timeout=0&limit=10`,
      { method: "GET" }
    );
    if (!response.ok) return null;

    const data = await response.json();
    if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) {
      return null;
    }

    // Find the most recent private chat (DM with the user)
    for (let i = data.result.length - 1; i >= 0; i--) {
      const update = data.result[i];
      const chat =
        update.message?.chat || update.edited_message?.chat;
      if (chat && chat.type === "private") {
        return String(chat.id);
      }
    }

    // Fallback: use any chat
    const firstChat =
      data.result[0]?.message?.chat || data.result[0]?.edited_message?.chat;
    return firstChat ? String(firstChat.id) : null;
  } catch (err) {
    console.error("Telegram chat_id discovery failed:", err);
    return null;
  }
}

// ── File delivery functions ──

interface TelegramFileResult {
  success: boolean;
  fileId?: string;
  error?: string;
}

/**
 * DRY wrapper for Telegram multipart file uploads.
 * All send*() functions delegate here.
 */
async function telegramMultipartPost(
  botToken: string,
  method: string,
  formData: FormData
): Promise<TelegramFileResult> {
  try {
    const response = await fetch(`${TELEGRAM_API}/bot${botToken}/${method}`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Telegram ${method} failed:`, errorBody);
      return { success: false, error: `Telegram API error: ${response.status}` };
    }

    const data = await response.json();
    // Extract file_id from the response (varies by type)
    const fileId =
      data.result?.document?.file_id ??
      data.result?.photo?.at(-1)?.file_id ??
      data.result?.video?.file_id ??
      undefined;

    return { success: true, fileId };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    console.error(`Telegram ${method} error:`, errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * Send a document (any file type) to a Telegram chat.
 * 50MB limit — caller must check size before calling.
 */
export async function sendTelegramDocument(
  botToken: string,
  chatId: string,
  fileBuffer: Buffer,
  filename: string,
  caption?: string
): Promise<TelegramFileResult> {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("document", new Blob([new Uint8Array(fileBuffer)]), filename);
  if (caption) formData.append("caption", caption.slice(0, 1024));
  return telegramMultipartPost(botToken, "sendDocument", formData);
}

/**
 * Send a photo to a Telegram chat.
 * 10MB limit, auto-compressed by Telegram.
 */
export async function sendTelegramPhoto(
  botToken: string,
  chatId: string,
  fileBuffer: Buffer,
  caption?: string
): Promise<TelegramFileResult> {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("photo", new Blob([new Uint8Array(fileBuffer)]), "photo");
  if (caption) formData.append("caption", caption.slice(0, 1024));
  return telegramMultipartPost(botToken, "sendPhoto", formData);
}

/**
 * Send a video to a Telegram chat.
 * 50MB limit.
 */
export async function sendTelegramVideo(
  botToken: string,
  chatId: string,
  fileBuffer: Buffer,
  filename: string,
  caption?: string
): Promise<TelegramFileResult> {
  const formData = new FormData();
  formData.append("chat_id", chatId);
  formData.append("video", new Blob([new Uint8Array(fileBuffer)]), filename);
  if (caption) formData.append("caption", caption.slice(0, 1024));
  return telegramMultipartPost(botToken, "sendVideo", formData);
}

const IMAGE_EXTS_TG = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const VIDEO_EXTS_TG = new Set([".mp4", ".webm", ".mov"]);

/**
 * Smart file dispatcher — detects MIME from extension and routes to the
 * appropriate Telegram send method (Photo, Video, or Document).
 *
 * This is the main entry point for file delivery.
 * Size guards: >50MB always rejected, >10MB photos sent as document instead.
 */
export async function sendTelegramFile(
  botToken: string,
  chatId: string,
  fileBuffer: Buffer,
  filename: string,
  caption?: string
): Promise<TelegramFileResult> {
  const sizeBytes = fileBuffer.length;
  const MAX_DOCUMENT = 50 * 1024 * 1024;
  const MAX_PHOTO = 10 * 1024 * 1024;

  if (sizeBytes > MAX_DOCUMENT) {
    return { success: false, error: `File too large (${(sizeBytes / 1024 / 1024).toFixed(1)}MB). Telegram limit is 50MB.` };
  }

  const ext = filename.lastIndexOf(".") >= 0
    ? filename.slice(filename.lastIndexOf(".")).toLowerCase()
    : "";

  if (IMAGE_EXTS_TG.has(ext) && sizeBytes <= MAX_PHOTO) {
    return sendTelegramPhoto(botToken, chatId, fileBuffer, caption);
  }

  if (VIDEO_EXTS_TG.has(ext)) {
    return sendTelegramVideo(botToken, chatId, fileBuffer, filename, caption);
  }

  return sendTelegramDocument(botToken, chatId, fileBuffer, filename, caption);
}
