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
  async function handleWorldChat() {
    if (!xmtpAddress) return;
    try {
      MiniKit.commands.sendHapticFeedback({ hapticsType: "impact", style: "medium" });
      await MiniKit.commandsAsync.chat({
        message: "Hey! What's happening today?",
        to: [xmtpAddress],
      });
    } catch { /* chat cancelled */ }
  }

  function handleTelegram() {
    if (!telegramBotUsername) return;
    MiniKit.commands.sendHapticFeedback({ hapticsType: "impact", style: "light" });
    const username = telegramBotUsername.replace(/^@/, "");
    window.open(`https://t.me/${username}?start=world`, "_blank");
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Primary: World Chat */}
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
            {xmtpAddress
              ? "Opens World Chat with your agent"
              : "Coming soon — use Telegram for now"}
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
              : "Connect Telegram in Settings"}
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
            <span className="status-dot-healthy h-1.5 w-1.5 rounded-full" />
            <span className="text-[10px] text-muted">World Chat</span>
          </div>
          <span className="text-[10px] text-white/20">•</span>
          <div className="flex items-center gap-1.5">
            <MessageCircle size={10} className="text-muted" />
            <span className="text-[10px] text-muted">Telegram</span>
          </div>
        </div>
      </div>
    </div>
  );
}
