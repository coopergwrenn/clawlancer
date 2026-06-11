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
 * Parse an MP4's display dimensions + duration from the buffer (pure JS, no
 * ffmpeg — works on Vercel serverless). Walks moov→trak→tkhd (width/height are
 * 16.16 fixed-point at the tail of the tkhd payload) + moov→mvhd (duration via
 * timescale). Returns the VIDEO track's dims (the audio track's tkhd is 0x0).
 * Best-effort: returns null on any parse failure or non-MP4.
 *
 * WHY (2026-06-11): Telegram's sendVideo does NOT reliably probe dimensions
 * from the uploaded buffer, so the inline player renders a wrong (often square)
 * box even for a true 16:9 file. Passing explicit width/height/supports_streaming
 * fixes the presentation. This is the fleet's media surface — load-bearing.
 */
export function parseMp4Dimensions(
  buf: Buffer,
): { width: number; height: number; duration?: number } | null {
  const walk = (
    start: number,
    end: number,
    cb: (type: string, payloadStart: number, boxEnd: number) => void,
  ): void => {
    let off = start;
    while (off + 8 <= end) {
      const size = buf.readUInt32BE(off);
      const type = buf.toString("ascii", off + 4, off + 8);
      let hdr = 8;
      let boxSize = size;
      if (size === 1) {
        // 64-bit largesize
        boxSize = Number(buf.readBigUInt64BE(off + 8));
        hdr = 16;
      } else if (size === 0) {
        boxSize = end - off; // box extends to end
      }
      if (boxSize < hdr || off + boxSize > end) break;
      cb(type, off + hdr, off + boxSize);
      off += boxSize;
    }
  };

  try {
    let dims: { width: number; height: number } | null = null;
    let durationSec: number | undefined;
    walk(0, buf.length, (type, s, e) => {
      if (type !== "moov") return;
      walk(s, e, (t2, s2, e2) => {
        if (t2 === "mvhd") {
          const ver = buf[s2];
          if (ver === 1) {
            const ts = buf.readUInt32BE(s2 + 20);
            const du = Number(buf.readBigUInt64BE(s2 + 24));
            if (ts) durationSec = du / ts;
          } else {
            const ts = buf.readUInt32BE(s2 + 12);
            const du = buf.readUInt32BE(s2 + 16);
            if (ts) durationSec = du / ts;
          }
        } else if (t2 === "trak") {
          walk(s2, e2, (t3, _s3, e3) => {
            if (t3 !== "tkhd") return;
            // width/height: last 8 bytes of the tkhd payload, 16.16 fixed-point.
            const w = buf.readUInt32BE(e3 - 8) / 65536;
            const h = buf.readUInt32BE(e3 - 4) / 65536;
            if (w >= 1 && h >= 1) dims = { width: Math.round(w), height: Math.round(h) };
          });
        }
      });
    });
    if (!dims) return null;
    return {
      width: (dims as { width: number; height: number }).width,
      height: (dims as { width: number; height: number }).height,
      duration: durationSec && durationSec > 0 ? Math.round(durationSec) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Send a video to a Telegram chat.
 * 50MB limit. Passes explicit width/height/duration/supports_streaming so the
 * inline player renders at the true aspect (see parseMp4Dimensions). Falls back
 * to a bare send (still delivers) if dimensions can't be parsed.
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
  const dims = parseMp4Dimensions(fileBuffer);
  if (dims) {
    formData.append("width", String(dims.width));
    formData.append("height", String(dims.height));
    if (dims.duration) formData.append("duration", String(dims.duration));
  }
  formData.append("supports_streaming", "true");
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
