"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  Globe,
  Zap,
  Repeat,
  Sparkles,
  Check,
  ChevronRight,
  RefreshCw,
  Search,
} from "lucide-react";

// ── Types ──

type Tab = "tasks" | "chat" | "library";
type Filter = "all" | "recurring" | "scheduled" | "completed";

interface TaskItem {
  id: string;
  title: string;
  description: string;
  status: string;
  is_recurring: boolean;
  frequency: string | null;
  streak: number;
  next_run_at: string | null;
  tools_used: string[];
  created_at: string;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

// ── Helpers ──

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatNextRun(iso: string | null) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return "Running soon";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `Next in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `Next in ${hrs}h ${mins % 60}m`;
}

const CHAT_KEY = "instaclaw-chat-history";

const SUGGESTIONS = [
  "Research", "Draft email", "Market update", "Write a post",
  "Check bounties", "Today's schedule",
];

const EMPTY_STATES: Record<Filter, { icon: typeof Zap; title: string; desc: string; hint?: string }> = {
  all: { icon: Zap, title: "No tasks yet", desc: "Tell your agent what to do — just type below.", hint: 'Try: "Research the top AI agent frameworks"' },
  recurring: { icon: Repeat, title: "No recurring tasks", desc: "Set up tasks that run on autopilot.", hint: 'Try: "Send me a weekly newsletter digest"' },
  scheduled: { icon: Sparkles, title: "Nothing scheduled", desc: "Schedule tasks for a specific time." },
  completed: { icon: Check, title: "No completed tasks", desc: "Tasks your agent has finished will show up here." },
};

// ── Main Component ──

export default function CommandCenter({
  userId,
  telegramBotUsername,
  isOnline,
}: {
  userId: string;
  telegramBotUsername: string | null;
  isOnline: boolean;
}) {
  const [tab, setTab] = useState<Tab>("tasks");
  const [filter, setFilter] = useState<Filter>("all");
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [webSearch, setWebSearch] = useState(true);
  const [suggestions, setSuggestions] = useState<string[]>(SUGGESTIONS);
  const [infoDismissed, setInfoDismissed] = useState(false);

  // Check localStorage for dismissed state
  useEffect(() => {
    try { if (localStorage.getItem("instaclaw-info-dismissed")) setInfoDismissed(true); } catch {}
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load tasks
  useEffect(() => {
    async function loadTasks() {
      try {
        const res = await fetch("/api/proxy/tasks/list?limit=20&offset=0", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        if (res.ok) {
          const data = await res.json();
          setTasks(data.tasks || []);
        }
      } catch { /* proxy might not support this yet */ }
      setLoadingTasks(false);
    }
    loadTasks();
  }, []);

  // Load personalized suggestions
  useEffect(() => {
    // Show cached suggestions first
    try {
      const cached = localStorage.getItem("instaclaw-suggestions");
      if (cached) setSuggestions(JSON.parse(cached));
    } catch {}

    // Fetch fresh from API in background
    fetch("/api/proxy/tasks/suggestions", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.suggestions && Array.isArray(data.suggestions)) {
          const labels = data.suggestions.map((s: { label: string }) => s.label).filter(Boolean);
          if (labels.length > 0) {
            setSuggestions(labels);
            try { localStorage.setItem("instaclaw-suggestions", JSON.stringify(labels)); } catch {}
          }
        }
      })
      .catch(() => {});
  }, []);

  // Load chat history
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CHAT_KEY);
      if (stored) setChatMsgs(JSON.parse(stored));
    } catch {}
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    if (tab === "chat" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chatMsgs, sending, tab]);

  // Send message (chat tab) or create task (tasks tab)
  const handleSend = useCallback(async () => {
    const msg = input.trim();
    if (!msg || sending) return;
    setInput("");

    if (tab === "chat") {
      const userMsg: ChatMsg = { role: "user", content: msg, ts: Date.now() };
      const newMsgs = [...chatMsgs, userMsg];
      setChatMsgs(newMsgs);
      localStorage.setItem(CHAT_KEY, JSON.stringify(newMsgs.slice(-50)));
      setSending(true);

      try {
        const res = await fetch("/api/chat/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg }),
        });
        const data = await res.json();
        const reply: ChatMsg = { role: "assistant", content: data.response || data.error || "No response", ts: Date.now() };
        const updated = [...newMsgs, reply];
        setChatMsgs(updated);
        localStorage.setItem(CHAT_KEY, JSON.stringify(updated.slice(-50)));
      } catch {
        const updated = [...newMsgs, { role: "assistant" as const, content: "Connection error.", ts: Date.now() }];
        setChatMsgs(updated);
      }
      setSending(false);
    } else {
      // Tasks tab — create a task via chat/send (agent processes it)
      setSending(true);
      try {
        await fetch("/api/chat/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg }),
        });
        // Refresh tasks after a short delay
        setTimeout(async () => {
          try {
            const res = await fetch("/api/proxy/tasks/list?limit=20&offset=0", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
            if (res.ok) {
              const data = await res.json();
              setTasks(data.tasks || []);
            }
          } catch {}
        }, 3000);
      } catch {}
      setSending(false);
    }
    inputRef.current?.focus();
  }, [input, sending, tab, chatMsgs]);

  // Filter tasks
  const filteredTasks = tasks.filter((t) => {
    if (filter === "all") return true;
    if (filter === "recurring") return t.is_recurring;
    if (filter === "scheduled") return t.next_run_at && !t.is_recurring;
    if (filter === "completed") return t.status === "completed";
    return true;
  });

  const emptyState = EMPTY_STATES[filter];
  const EmptyIcon = emptyState.icon;
  const tgUsername = telegramBotUsername?.replace(/^@/, "");

  return (
    <div className="flex h-full flex-col" style={{ background: "#0a0a0a" }}>
      {/* Info banners — compact top section */}
      {!infoDismissed && (
        <div className="flex items-center gap-2 px-4 pt-3 pb-1">
          <div className="flex flex-1 items-center gap-2 rounded-xl px-3 py-2" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <Globe size={12} style={{ color: "#666", flexShrink: 0 }} />
            <p className="flex-1 text-[10px] leading-tight" style={{ color: "#777" }}>
              Also on <a href={tgUsername ? `https://t.me/${tgUsername}?start=world` : "#"} style={{ color: "#999" }}>Telegram</a> &amp; <a href="https://instaclaw.io" style={{ color: "#999" }}>instaclaw.io</a>, same email to sign in. World Chat coming soon
            </p>
            <button
              onClick={() => { setInfoDismissed(true); try { localStorage.setItem("instaclaw-info-dismissed", "1"); } catch {} }}
              className="shrink-0 text-[11px]"
              style={{ color: "#555" }}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="px-4 pt-2 pb-1">
        <h1 className="text-lg font-bold text-white">Command Center</h1>
        <p className="text-[11px]" style={{ color: "#666" }}>Your agent works around the clock.</p>
      </div>

      {/* Filter pills (tasks tab only) */}
      <div className="flex gap-1.5 overflow-x-auto px-4 py-2 no-scrollbar" style={{ opacity: tab === "tasks" ? 1 : 0.3, transition: "opacity 0.2s" }}>
        {(["all", "recurring", "scheduled", "completed"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium capitalize transition-all"
            style={{
              background: filter === f ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.04)",
              color: filter === f ? "#fff" : "#888",
              border: `1px solid ${filter === f ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.06)"}`,
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex border-b px-4" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
        {(["tasks", "chat", "library"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="relative px-4 py-2.5 text-[13px] font-medium capitalize transition-colors"
            style={{ color: tab === t ? "#fff" : "#666" }}
          >
            {t}
            {tab === t && (
              <div className="absolute bottom-0 left-0 right-0 h-[2px] rounded-full" style={{ background: "#DC6743" }} />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto" style={{ WebkitOverflowScrolling: "touch" }}>
        {/* ── Tasks Tab ── */}
        {tab === "tasks" && (
          <div className="px-4 py-3">
            {loadingTasks ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-20 animate-pulse rounded-xl" style={{ background: "rgba(255,255,255,0.04)" }} />
                ))}
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "rgba(255,255,255,0.06)" }}>
                  <EmptyIcon size={24} style={{ color: "#666" }} />
                </div>
                <p className="text-sm font-medium text-white">{emptyState.title}</p>
                <p className="mt-1 max-w-[240px] text-[12px]" style={{ color: "#666" }}>{emptyState.desc}</p>
                {emptyState.hint && (
                  <p className="mt-3 max-w-[260px] rounded-xl px-3 py-2 text-[11px]" style={{ background: "rgba(255,255,255,0.04)", color: "#888" }}>
                    {emptyState.hint}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {filteredTasks.map((task) => (
                  <div
                    key={task.id}
                    className="rounded-xl p-3.5"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}
                  >
                    <div className="flex items-start gap-3">
                      {/* Status dot */}
                      <div className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center">
                        <div
                          className="h-2.5 w-2.5 rounded-full"
                          style={{
                            background: task.status === "completed" ? "#22c55e"
                              : task.status === "active" ? "#22c55e"
                              : task.status === "in_progress" ? "#3b82f6"
                              : task.status === "failed" ? "#ef4444"
                              : "#888",
                            boxShadow: task.status === "active" ? "0 0 6px rgba(34,197,94,0.5)" : "none",
                          }}
                        />
                      </div>
                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-white truncate">{task.title}</p>
                        <p className="mt-0.5 text-[11px] truncate" style={{ color: "#888" }}>{task.description}</p>
                        {/* Pills */}
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {task.is_recurring && task.frequency && (
                            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]" style={{ background: "rgba(255,255,255,0.06)", color: "#888" }}>
                              <Repeat size={9} /> Runs {task.frequency}
                            </span>
                          )}
                          {task.next_run_at && (
                            <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: "rgba(255,255,255,0.06)", color: "#888" }}>
                              {formatNextRun(task.next_run_at)}
                            </span>
                          )}
                          {task.streak > 0 && (
                            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px]" style={{ background: "rgba(220,103,67,0.1)", color: "#DC6743" }}>
                              <Zap size={9} /> {task.streak} streak
                            </span>
                          )}
                        </div>
                      </div>
                      <ChevronRight size={16} style={{ color: "#444", marginTop: 4 }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Chat Tab ── */}
        {tab === "chat" && (
          <div className="px-4 py-3">
            {chatMsgs.length === 0 && !sending ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "rgba(255,255,255,0.06)" }}>
                  <Zap size={24} style={{ color: "#666" }} />
                </div>
                <p className="text-sm font-medium text-white">Chat with your agent</p>
                <p className="mt-1 max-w-[240px] text-[12px]" style={{ color: "#666" }}>Same AI, same skills, same memory.</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {chatMsgs.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${msg.role === "user" ? "rounded-br-sm" : "rounded-bl-sm"}`}
                      style={{ background: msg.role === "user" ? "linear-gradient(135deg, #DC6743, #c2553a)" : "rgba(255,255,255,0.08)", color: "#fff" }}
                    >
                      {msg.content}
                    </div>
                  </div>
                ))}
                {sending && (
                  <div className="flex justify-start">
                    <div className="flex gap-1.5 rounded-2xl rounded-bl-sm px-4 py-3" style={{ background: "rgba(255,255,255,0.08)" }}>
                      <span className="h-2 w-2 rounded-full" style={{ background: "rgba(255,255,255,0.4)", animation: "dot 1.4s infinite 0s" }} />
                      <span className="h-2 w-2 rounded-full" style={{ background: "rgba(255,255,255,0.4)", animation: "dot 1.4s infinite 0.2s" }} />
                      <span className="h-2 w-2 rounded-full" style={{ background: "rgba(255,255,255,0.4)", animation: "dot 1.4s infinite 0.4s" }} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Library Tab ── */}
        {tab === "library" && (
          <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "rgba(255,255,255,0.06)" }}>
              <Search size={24} style={{ color: "#666" }} />
            </div>
            <p className="text-sm font-medium text-white">Library</p>
            <p className="mt-1 max-w-[240px] text-[12px]" style={{ color: "#666" }}>
              Saved research, drafts, and reports from your agent will appear here.
            </p>
          </div>
        )}
      </div>

      {/* Suggestion chips */}
      {((tab === "tasks" && filteredTasks.length === 0) || (tab === "chat" && chatMsgs.length === 0)) && (
        <div className="flex gap-2 overflow-x-auto px-4 py-2 no-scrollbar">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => { setInput(s); inputRef.current?.focus(); }}
              className="shrink-0 rounded-full px-4 py-2 text-[12px] font-medium transition-all active:scale-95"
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "#aaa",
                boxShadow: "0 1px 3px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.04)",
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Web search toggle */}
      <div className="flex gap-2 px-4 py-1">
        <button
          onClick={() => setWebSearch(!webSearch)}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium transition-all"
          style={{
            background: webSearch ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)",
            border: `1px solid ${webSearch ? "rgba(66,133,244,0.3)" : "rgba(255,255,255,0.06)"}`,
            color: webSearch ? "#4285F4" : "#666",
          }}
        >
          <Globe size={12} />
          Web search
          {webSearch && <span style={{ marginLeft: 2, opacity: 0.5 }}>×</span>}
        </button>
      </div>


      {/* Input bar — clean glass UI */}
      <div className="px-4 py-2.5" style={{ paddingBottom: "max(env(safe-area-inset-bottom, 8px), 8px)" }}>
        <div
          className="flex items-center gap-2 rounded-2xl px-3 py-2.5"
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          {/* + button */}
          <button
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all active:scale-90"
            style={{ background: "rgba(255,255,255,0.08)" }}
          >
            <span className="text-lg font-light" style={{ color: "#888" }}>+</span>
          </button>

          {/* Input */}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder={tab === "chat" ? "Message your agent..." : "Tell your agent what to do next..."}
            autoComplete="off"
            className="flex-1 min-w-0 bg-transparent text-[13px] text-white placeholder:text-white/30 focus:outline-none"
          />

          {/* Model selector */}
          <button
            className="shrink-0 flex items-center gap-0.5 text-[11px] font-medium"
            style={{ color: "#666" }}
          >
            <span className="hidden sm:inline">Sonnet</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>

          {/* Mic button */}
          <button
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all active:scale-90"
            style={{ color: "#666" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>
            </svg>
          </button>

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all active:scale-90 disabled:opacity-20"
            style={{
              background: input.trim()
                ? "linear-gradient(135deg, #DC6743, #c2553a)"
                : "rgba(255,255,255,0.06)",
              boxShadow: input.trim()
                ? "0 2px 8px rgba(220,103,67,0.3), inset 0 1px 0 rgba(255,255,255,0.15)"
                : "none",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>
            </svg>
          </button>
        </div>
      </div>

      <style>{`
        @keyframes dot { 0%,60%,100%{opacity:.3;transform:translateY(0)} 30%{opacity:1;transform:translateY(-4px)} }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
}
