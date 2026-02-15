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
