"use client";

import { MiniKit } from "@worldcoin/minikit-js";
import { MessageCircle, Send, Globe, ArrowUpRight } from "lucide-react";

export default function ChatOptions({
  xmtpAddress,
  telegramBotUsername,
}: {
  xmtpAddress: string | null;
  telegramBotUsername: string | null;
}) {
  function handleTelegram() {
    if (!telegramBotUsername) return;
    MiniKit.commands.sendHapticFeedback({ hapticsType: "impact", style: "medium" });
    const username = telegramBotUsername.replace(/^@/, "");
    window.location.href = `https://t.me/${username}?start=world`;
  }

  function handleWorldChat() {
    if (!xmtpAddress) return;
    MiniKit.commands.sendHapticFeedback({ hapticsType: "impact", style: "medium" });
    // Use World App universal deep link to open a direct chat with the agent's address
    // Format from Leighton/World team: world.org/profile?address=0x...&action=chat
    window.location.href = `https://world.org/profile?address=${xmtpAddress}&action=chat`;
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Primary: World Chat (XMTP — works via deep link!) */}
      <button
        onClick={handleWorldChat}
        disabled={!xmtpAddress}
        className="animate-fade-in-up btn-primary flex items-center gap-4 rounded-2xl p-4 text-left disabled:opacity-40"
        style={{ opacity: 0 }}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/20">
          <Globe size={24} />
        </div>
        <div className="flex-1">
          <p className="font-bold">Chat via World App</p>
          <p className="mt-0.5 text-sm opacity-70">
            {xmtpAddress ? "Opens a direct chat with your agent" : "Coming soon"}
          </p>
        </div>
        <ArrowUpRight size={18} className="opacity-50" />
      </button>

      {/* Secondary: Telegram */}
      <button
        onClick={handleTelegram}
        disabled={!telegramBotUsername}
        className="animate-fade-in-up glass-card flex items-center gap-4 rounded-2xl p-4 text-left disabled:opacity-40 stagger-1"
        style={{ opacity: 0 }}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.04]">
          <Send size={22} className="text-muted" />
        </div>
        <div className="flex-1">
          <p className="font-semibold">Chat via Telegram</p>
          <p className="mt-0.5 text-sm text-muted">
            {telegramBotUsername
              ? `@${telegramBotUsername.replace(/^@/, "")}`
              : "Not connected yet"}
          </p>
        </div>
        <ArrowUpRight size={18} className="text-muted opacity-50" />
      </button>

      <div className="animate-fade-in mt-4 text-center stagger-2" style={{ opacity: 0 }}>
        <p className="text-xs leading-relaxed text-muted">
          Your agent responds on whichever channel you message from.
          <br />
          Both channels connect to the same AI.
        </p>
        <div className="mx-auto mt-3 flex items-center justify-center gap-3">
          <div className="flex items-center gap-1.5">
            <Send size={10} className="text-accent" />
            <span className="text-[10px] text-muted">Telegram</span>
          </div>
          <span className="text-[10px] text-white/20">•</span>
          <div className="flex items-center gap-1.5">
            <Globe size={10} className="text-muted" />
            <span className="text-[10px] text-muted">World Chat</span>
          </div>
        </div>
      </div>
    </div>
  );
}
