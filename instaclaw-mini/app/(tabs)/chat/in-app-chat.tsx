"use client";

import { useState, useRef, useEffect } from "react";
import { Send, Bot } from "lucide-react";

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
  } catch {
    return [];
  }
}

function saveHistory(msgs: Message[]) {
  try {
    // Keep last 50 messages
    localStorage.setItem(STORAGE_KEY, JSON.stringify(msgs.slice(-50)));
  } catch { /* storage full */ }
}

export default function InAppChat({
  telegramBotUsername,
  agentName,
  isOnline,
}: {
  telegramBotUsername: string | null;
  agentName: string;
  isOnline: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load history on mount
  useEffect(() => {
    setMessages(loadHistory());
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
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
      const reply: Message = {
        role: "assistant",
        content: data.response || data.error || "No response",
        ts: Date.now(),
      };
      const updated = [...newMsgs, reply];
      setMessages(updated);
      saveHistory(updated);
    } catch {
      const errMsg: Message = {
        role: "assistant",
        content: "Connection error. Please try again.",
        ts: Date.now(),
      };
      const updated = [...newMsgs, errMsg];
      setMessages(updated);
      saveHistory(updated);
    }
    setLoading(false);
    inputRef.current?.focus();
  }

  const tgUsername = telegramBotUsername?.replace(/^@/, "");

  return (
    <div className="flex h-full flex-col" style={{ background: "#0a0a0a" }}>
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
        <div className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "linear-gradient(145deg, rgba(218,119,86,0.3), rgba(218,119,86,0.1))" }}>
          <Bot size={20} className="text-accent" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-white">{agentName}</p>
          <div className="flex items-center gap-1.5">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: isOnline ? "#22c55e" : "#888",
                boxShadow: isOnline ? "0 0 4px rgba(34,197,94,0.5)" : "none",
              }}
            />
            <span className="text-[11px]" style={{ color: isOnline ? "#22c55e" : "#888" }}>
              {isOnline ? "Online" : "Offline"}
            </span>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4" style={{ WebkitOverflowScrolling: "touch" }}>
        {messages.length === 0 && !loading && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full" style={{ background: "rgba(218,119,86,0.1)" }}>
              <Bot size={28} className="text-accent" />
            </div>
            <p className="text-sm font-medium text-white">Chat with your agent</p>
            <p className="mt-1 max-w-[240px] text-xs" style={{ color: "#888" }}>
              Ask anything — your agent has the same skills and memory as on Telegram.
            </p>
          </div>
        )}

        <div className="space-y-3">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              style={{ animation: "fade-in-up 0.2s ease forwards" }}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed ${
                  msg.role === "user" ? "rounded-br-md" : "rounded-bl-md"
                }`}
                style={{
                  background: msg.role === "user"
                    ? "linear-gradient(135deg, #da7756, #c36441)"
                    : "rgba(255,255,255,0.08)",
                  color: "#fff",
                }}
              >
                {msg.content}
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {loading && (
            <div className="flex justify-start">
              <div
                className="flex gap-1 rounded-2xl rounded-bl-md px-4 py-3"
                style={{ background: "rgba(255,255,255,0.08)" }}
              >
                <span className="h-2 w-2 rounded-full bg-white/40" style={{ animation: "typing-dot 1.4s infinite 0s" }} />
                <span className="h-2 w-2 rounded-full bg-white/40" style={{ animation: "typing-dot 1.4s infinite 0.2s" }} />
                <span className="h-2 w-2 rounded-full bg-white/40" style={{ animation: "typing-dot 1.4s infinite 0.4s" }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Telegram link */}
      {tgUsername && (
        <div className="px-4 py-1.5 text-center">
          <a
            href={`https://t.me/${tgUsername}?start=world`}
            className="text-[11px]"
            style={{ color: "#666" }}
          >
            Also available via Telegram @{tgUsername}
          </a>
        </div>
      )}

      {/* Input */}
      <div className="border-t px-3 py-3" style={{ borderColor: "rgba(255,255,255,0.08)", paddingBottom: "max(env(safe-area-inset-bottom, 12px), 12px)" }}>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder="Message your agent..."
            autoComplete="off"
            className="flex-1 rounded-2xl px-4 py-3 text-sm text-white placeholder:text-white/30 focus:outline-none"
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)" }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="flex h-[46px] w-[46px] items-center justify-center rounded-2xl disabled:opacity-30"
            style={{ background: "linear-gradient(135deg, #da7756, #c36441)" }}
          >
            <Send size={18} color="#fff" />
          </button>
        </div>
      </div>

      <style>{`
        @keyframes typing-dot {
          0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-4px); }
        }
        @keyframes fade-in-up {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
