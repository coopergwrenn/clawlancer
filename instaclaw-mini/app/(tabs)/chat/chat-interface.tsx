"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Bot, Globe, ArrowUpRight } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

const STORAGE_KEY = "instaclaw-chat-history";

function loadHistory(): Message[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

function saveHistory(msgs: Message[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(msgs.slice(-50))); } catch {}
}

export default function ChatInterface({
  telegramBotUsername,
  xmtpAddress,
  isOnline,
}: {
  telegramBotUsername: string | null;
  xmtpAddress: string | null;
  isOnline: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setMessages(loadHistory()); }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  async function handleSend() {
    const msg = input.trim();
    if (!msg || loading) return;
    setInput("");
    const userMsg: Message = { role: "user", content: msg, ts: Date.now() };
    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    saveHistory(newMsgs);
    setLoading(true);

    try {
      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      const data = await res.json();
      const reply: Message = { role: "assistant", content: data.response || data.error || "No response", ts: Date.now() };
      const updated = [...newMsgs, reply];
      setMessages(updated);
      saveHistory(updated);
    } catch {
      const updated = [...newMsgs, { role: "assistant" as const, content: "Connection error. Please try again.", ts: Date.now() }];
      setMessages(updated);
      saveHistory(updated);
    }
    setLoading(false);
    inputRef.current?.focus();
  }

  const tgUsername = telegramBotUsername?.replace(/^@/, "");

  return (
    <div className="flex h-full flex-col" style={{ background: "#0a0a0a" }}>
      {/* World Chat — primary but disabled (coming soon) */}
      <div className="px-4 pt-4 pb-2">
        <button
          disabled
          className="flex w-full items-center gap-3 rounded-2xl p-3.5 opacity-40"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "rgba(218,119,86,0.15)" }}>
            <Globe size={20} className="text-accent" />
          </div>
          <div className="flex-1 text-left">
            <p className="text-sm font-semibold text-white">Chat via World Chat</p>
            <p className="text-[11px]" style={{ color: "#666" }}>Coming soon</p>
          </div>
          <ArrowUpRight size={16} style={{ color: "#444" }} />
        </button>
      </div>

      {/* Agent header */}
      <div className="flex items-center gap-3 px-4 py-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: "linear-gradient(145deg, rgba(218,119,86,0.3), rgba(218,119,86,0.1))" }}>
          <Bot size={18} className="text-accent" />
        </div>
        <div className="flex-1">
          <p className="text-xs font-semibold text-white">Your Agent</p>
          <div className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: isOnline ? "#22c55e" : "#888", boxShadow: isOnline ? "0 0 4px rgba(34,197,94,0.5)" : "none" }} />
            <span className="text-[10px]" style={{ color: isOnline ? "#22c55e" : "#888" }}>{isOnline ? "Online" : "Offline"}</span>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3" style={{ WebkitOverflowScrolling: "touch" }}>
        {messages.length === 0 && !loading && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full" style={{ background: "rgba(218,119,86,0.1)" }}>
              <Bot size={24} className="text-accent" />
            </div>
            <p className="text-sm font-medium text-white">Chat with your agent</p>
            <p className="mt-1 max-w-[220px] text-[11px]" style={{ color: "#666" }}>
              Same AI, same skills, same memory as Telegram.
            </p>
          </div>
        )}

        <div className="space-y-2.5">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`} style={{ animation: "msg-in 0.2s ease" }}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed ${msg.role === "user" ? "rounded-br-sm" : "rounded-bl-sm"}`}
                style={{ background: msg.role === "user" ? "linear-gradient(135deg, #da7756, #c36441)" : "rgba(255,255,255,0.08)", color: "#fff" }}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="flex gap-1.5 rounded-2xl rounded-bl-sm px-4 py-3" style={{ background: "rgba(255,255,255,0.08)" }}>
                <span className="h-2 w-2 rounded-full" style={{ background: "rgba(255,255,255,0.4)", animation: "dot 1.4s infinite 0s" }} />
                <span className="h-2 w-2 rounded-full" style={{ background: "rgba(255,255,255,0.4)", animation: "dot 1.4s infinite 0.2s" }} />
                <span className="h-2 w-2 rounded-full" style={{ background: "rgba(255,255,255,0.4)", animation: "dot 1.4s infinite 0.4s" }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Telegram secondary */}
      {tgUsername && (
        <div className="px-4 py-1 text-center">
          <a href={`https://t.me/${tgUsername}?start=world`} className="text-[11px]" style={{ color: "#555" }}>
            Also available via Telegram @{tgUsername}
          </a>
        </div>
      )}

      {/* Input */}
      <div className="px-3 py-3" style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingBottom: "max(env(safe-area-inset-bottom, 12px), 12px)" }}>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder="Message your agent..."
            autoComplete="off"
            className="flex-1 rounded-2xl px-4 py-3 text-sm text-white placeholder:text-white/25 focus:outline-none"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)" }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-2xl disabled:opacity-30"
            style={{ background: "linear-gradient(135deg, #da7756, #c36441)" }}
          >
            <Send size={18} color="#fff" />
          </button>
        </div>
      </div>

      <style>{`
        @keyframes dot { 0%,60%,100%{opacity:.3;transform:translateY(0)} 30%{opacity:1;transform:translateY(-4px)} }
        @keyframes msg-in { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
      `}</style>
    </div>
  );
}
