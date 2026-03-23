"use client";

import { MiniKit } from "@worldcoin/minikit-js";
import { MessageCircle, Send } from "lucide-react";

export default function ChatOptions({
  xmtpAddress,
  botToken,
}: {
  xmtpAddress: string | null;
  botToken: string | null;
}) {
  async function handleWorldChat() {
    if (!xmtpAddress) return;
    try {
      await MiniKit.commandsAsync.chat({
        message: "Hey! What's happening today?",
        to: [xmtpAddress],
      });
    } catch {
      // Chat cancelled or failed
    }
  }

  function handleTelegram() {
    if (!botToken) return;
    // Bot token format: 123456:ABC-DEF — we need the bot username
    // For now, open a generic link. The actual username comes from the DB.
    window.open(`https://t.me/`, "_blank");
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Primary: World Chat */}
      <button
        onClick={handleWorldChat}
        disabled={!xmtpAddress}
        className="flex items-center gap-4 rounded-2xl bg-accent p-4 text-left text-black active:scale-[0.98] transition-transform disabled:opacity-50"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-black/10">
          <MessageCircle size={24} />
        </div>
        <div>
          <p className="font-bold">Chat via World App</p>
          <p className="text-sm opacity-70">
            {xmtpAddress
              ? "Opens World Chat with your agent"
              : "Agent is still deploying..."}
          </p>
        </div>
      </button>

      {/* Secondary: Telegram */}
      <button
        onClick={handleTelegram}
        disabled={!botToken}
        className="flex items-center gap-4 rounded-2xl border border-border bg-card p-4 text-left active:scale-[0.98] transition-transform disabled:opacity-50"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-card-hover">
          <Send size={24} className="text-muted" />
        </div>
        <div>
          <p className="font-semibold">Chat via Telegram</p>
          <p className="text-sm text-muted">
            {botToken
              ? "Opens Telegram with your agent"
              : "Connect Telegram in Settings"}
          </p>
        </div>
      </button>

      <p className="mt-2 text-center text-xs text-muted">
        Your agent responds on whichever channel you message from.
        <br />
        Both channels connect to the same AI.
      </p>
    </div>
  );
}
