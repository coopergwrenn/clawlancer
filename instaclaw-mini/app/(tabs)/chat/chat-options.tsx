"use client";

import { MiniKit } from "@worldcoin/minikit-js";
import { useState, useRef, useEffect } from "react";
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

  async function handleWorldChat() {
    if (!xmtpAddress) return;
    MiniKit.commands.sendHapticFeedback({ hapticsType: "impact", style: "medium" });
    try {
      const result = await MiniKit.commandsAsync.chat({
        message: "Hey! What's happening today?",
        to: [xmtpAddress],
      });
      console.log("[Chat] MiniKit.chat result:", JSON.stringify(result.finalPayload));
    } catch (e) {
      console.error("[Chat] MiniKit.chat error:", e);
    }
  }

  // In-app chat — bypass World Chat entirely, talk to agent via our API
  const [chatMessage, setChatMessage] = useState("");
  const [chatHistory, setChatHistory] = useState<{role: string; content: string}[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [showInAppChat, setShowInAppChat] = useState(false);

  async function handleSendMessage() {
    if (!chatMessage.trim() || chatLoading) return;
    const msg = chatMessage.trim();
    setChatMessage("");
    setChatHistory(prev => [...prev, { role: "user", content: msg }]);
    setChatLoading(true);

    try {
      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json();
      if (data.response) {
        setChatHistory(prev => [...prev, { role: "assistant", content: data.response }]);
      } else {
        setChatHistory(prev => [...prev, { role: "assistant", content: "Sorry, I couldn't process that right now." }]);
      }
    } catch {
      setChatHistory(prev => [...prev, { role: "assistant", content: "Connection error. Please try again." }]);
    }
    setChatLoading(false);
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

      {/* In-app chat — direct messaging without leaving the app */}
      {!showInAppChat ? (
        <button
          onClick={() => setShowInAppChat(true)}
          className="animate-fade-in-up mt-2 w-full rounded-2xl py-3 text-center text-sm font-medium stagger-2"
          style={{ opacity: 0, color: "#da7756" }}
        >
          Or chat right here
        </button>
      ) : (
        <div className="animate-fade-in mt-3 rounded-2xl" style={{ opacity: 0, background: "rgba(0,0,0,0.03)", border: "1px solid rgba(0,0,0,0.08)" }}>
          {/* Messages */}
          <div className="max-h-[300px] overflow-y-auto p-4 space-y-3">
            {chatHistory.length === 0 && (
              <p className="text-center text-xs text-muted py-4">Send a message to your agent</p>
            )}
            {chatHistory.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "rounded-br-md"
                      : "rounded-bl-md"
                  }`}
                  style={{
                    background: msg.role === "user" ? "#da7756" : "rgba(0,0,0,0.05)",
                    color: msg.role === "user" ? "#fff" : "#333",
                  }}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="rounded-2xl rounded-bl-md px-4 py-3 text-sm" style={{ background: "rgba(0,0,0,0.05)", color: "#999" }}>
                  Thinking...
                </div>
              </div>
            )}
          </div>
          {/* Input */}
          <div className="flex gap-2 border-t p-3" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
            <input
              type="text"
              value={chatMessage}
              onChange={(e) => setChatMessage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
              placeholder="Message your agent..."
              className="flex-1 rounded-xl px-3 py-2.5 text-sm focus:outline-none"
              style={{ background: "rgba(0,0,0,0.03)", color: "#333" }}
            />
            <button
              onClick={handleSendMessage}
              disabled={!chatMessage.trim() || chatLoading}
              className="btn-primary rounded-xl px-4 py-2.5 disabled:opacity-40"
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
