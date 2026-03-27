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
  error_message: string | null;
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
  "Research a topic", "Draft an email", "Summarize the news",
  "Write a social post", "Plan my week", "Track crypto prices",
];

const EMPTY_STATES: Record<Filter, { icon: typeof Zap; title: string; desc: string; hint?: string }> = {
  all: { icon: Zap, title: "No tasks yet", desc: "Tell your agent what to do. Just type below.", hint: 'Try: "Research the top AI agent frameworks"' },
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
  const [deepResearch, setDeepResearch] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>(SUGGESTIONS);
  const [infoDismissed, setInfoDismissed] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState("Sonnet 4.6");
  const [isListening, setIsListening] = useState(false);

  // Check localStorage for dismissed state
  useEffect(() => {
    try { if (localStorage.getItem("instaclaw-info-dismissed")) setInfoDismissed(true); } catch {}
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load tasks — re-fetch when filter changes
  useEffect(() => {
    async function loadTasks() {
      setLoadingTasks(true);
      try {
        const params = new URLSearchParams({ limit: "50", offset: "0" });
        if (filter === "recurring") params.set("recurring", "true");
        else if (filter === "scheduled") params.set("status", "queued");
        else if (filter === "completed") params.set("status", "completed");
        const res = await fetch(`/api/tasks/list?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          setTasks(data.tasks || []);
        }
      } catch { /* proxy error */ }
      setLoadingTasks(false);
    }
    loadTasks();
  }, [filter]);

  // Load personalized suggestions — cached first, then refresh from API
  useEffect(() => {
    // 1. Show cached suggestions instantly (no flash of defaults)
    try {
      const cached = localStorage.getItem("instaclaw-suggestions");
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) setSuggestions(parsed);
      }
    } catch {}

    // 2. Fetch personalized from API (runs in background, updates when ready)
    fetch("/api/proxy/tasks/suggestions")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data) => {
        // API returns { suggestions: [{ label, prefill }, ...] } or { suggestions: null }
        if (data?.suggestions && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
          const labels = data.suggestions
            .map((s: { label?: string; prefill?: string }) => s.label || s.prefill)
            .filter(Boolean);
          if (labels.length > 0) {
            setSuggestions(labels);
            try { localStorage.setItem("instaclaw-suggestions", JSON.stringify(labels)); } catch {}
          }
        }
        // If suggestions is null (no Gmail), keep current suggestions (defaults or cached)
      })
      .catch(() => {
        // API failed — keep defaults, don't clear anything
      });
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
  const handleSend = useCallback(async (directMsg?: string) => {
    const msg = (directMsg || input).trim();
    if (!msg || sending) return;
    setInput("");

    // ── Tasks tab: create a task ──
    if (tab === "tasks") {
      setSending(true);

      // Show optimistic placeholder immediately
      const tempId = `temp-${Date.now()}`;
      const placeholder: TaskItem = {
        id: tempId, title: "Working on it...", description: msg.slice(0, 500),
        status: "in_progress", is_recurring: false, frequency: null,
        streak: 0, next_run_at: null, tools_used: [], error_message: null,
        created_at: new Date().toISOString(),
      };
      setTasks((prev) => [placeholder, ...prev]);

      try {
        // This awaits full gateway execution and returns the completed task
        const res = await fetch("/api/tasks/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.task) {
            // Replace placeholder with real task
            setTasks((prev) => prev.map((t) => t.id === tempId ? data.task : t));
          }
        } else {
          // Remove placeholder on error
          setTasks((prev) => prev.filter((t) => t.id !== tempId));
        }
      } catch {}
      setSending(false);
      inputRef.current?.focus();
      return;
    }

    // ── Chat tab: send a chat message ──
    if (tab === "library") setTab("chat");

    const userMsg: ChatMsg = { role: "user", content: msg, ts: Date.now() };
    const newMsgs = [...chatMsgs, userMsg];
    setChatMsgs(newMsgs);
    localStorage.setItem(CHAT_KEY, JSON.stringify(newMsgs.slice(-50)));
    setSending(true);

    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }), 50);

    try {
      const res = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          stream: true,
          toggles: { webSearch, deepResearch },
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Error ${res.status}`);
      }

      // Handle SSE streaming
      if (res.headers.get("content-type")?.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";

        // Add placeholder assistant message that we'll update
        const streamMsg: ChatMsg = { role: "assistant", content: "", ts: Date.now() };
        let currentMsgs = [...newMsgs, streamMsg];
        setChatMsgs(currentMsgs);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (jsonStr === "[DONE]") continue;

            try {
              const chunk = JSON.parse(jsonStr);
              // OpenAI format
              const delta = chunk.choices?.[0]?.delta?.content;
              // Anthropic format
              const anthDelta = chunk.type === "content_block_delta" ? chunk.delta?.text : null;
              const text = delta || anthDelta || "";

              if (text) {
                accumulated += text;
                streamMsg.content = accumulated;
                currentMsgs = [...newMsgs, { ...streamMsg }];
                setChatMsgs(currentMsgs);
                scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
              }
            } catch { /* skip malformed chunks */ }
          }
        }

        // Finalize
        if (!accumulated) accumulated = "No response";
        const finalMsgs = [...newMsgs, { role: "assistant" as const, content: accumulated, ts: Date.now() }];
        setChatMsgs(finalMsgs);
        localStorage.setItem(CHAT_KEY, JSON.stringify(finalMsgs.slice(-50)));
      } else {
        // Non-streaming fallback
        const data = await res.json();
        const reply: ChatMsg = { role: "assistant", content: data.response || data.error || "No response", ts: Date.now() };
        const updated = [...newMsgs, reply];
        setChatMsgs(updated);
        localStorage.setItem(CHAT_KEY, JSON.stringify(updated.slice(-50)));
      }

      // Refresh tasks in background
      setTimeout(async () => {
        try {
          const taskRes = await fetch("/api/tasks/list?limit=20&offset=0");
          if (taskRes.ok) {
            const taskData = await taskRes.json();
            setTasks(taskData.tasks || []);
          }
        } catch {}
      }, 1000);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Connection error";
      const updated = [...newMsgs, { role: "assistant" as const, content: errMsg, ts: Date.now() }];
      setChatMsgs(updated);
      localStorage.setItem(CHAT_KEY, JSON.stringify(updated.slice(-50)));
    }
    setSending(false);
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }), 100);
    inputRef.current?.focus();
  }, [input, sending, tab, chatMsgs]);

  // Tasks are already filtered by the API based on the filter param
  const filteredTasks = tasks;

  const emptyState = EMPTY_STATES[filter];
  const EmptyIcon = emptyState.icon;
  const tgUsername = telegramBotUsername?.replace(/^@/, "");

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: "transparent" }}>
      {/* Info banner */}
      {!infoDismissed && (
        <div className="flex items-center gap-2 px-4 pt-3 pb-1">
          <div className="glass-card flex flex-1 items-center gap-2 rounded-xl px-3 py-2.5">
            <Globe size={12} style={{ color: "#777", flexShrink: 0 }} />
            <p className="flex-1 text-[10px] leading-tight" style={{ color: "#888" }}>
              Also on <a href={tgUsername ? `https://t.me/${tgUsername}?start=world` : "#"} style={{ color: "#aaa" }}>Telegram</a> &amp; <a href="https://instaclaw.io" style={{ color: "#aaa" }}>instaclaw.io</a>, same email to sign in. World Chat coming soon
            </p>
            <button
              onClick={() => { setInfoDismissed(true); try { localStorage.setItem("instaclaw-info-dismissed", "1"); } catch {} }}
              className="shrink-0 text-[11px]"
              style={{ color: "#666" }}
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
            className="shrink-0 rounded-full px-3.5 py-1.5 text-[11px] font-medium capitalize transition-all active:scale-95"
            style={{
              background: filter === f
                ? "rgba(255,255,255,0.85)"
                : "rgba(255,255,255,0.06)",
              color: filter === f ? "#111" : "#888",
              border: `1px solid ${filter === f ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.08)"}`,
              boxShadow: filter === f
                ? "0 2px 8px rgba(255,255,255,0.1), inset 0 1px 0 rgba(255,255,255,0.3)"
                : "inset 0 1px 0 rgba(255,255,255,0.04)",
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Tabs — glass with sliding underline */}
      <div className="relative flex px-4 pb-0.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        {(["tasks", "chat", "library"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="relative px-4 py-2.5 text-[13px] font-semibold capitalize transition-all duration-300"
            style={{ color: tab === t ? "#fff" : "#555" }}
          >
            {t}
            {tab === t && (
              <div
                className="absolute bottom-0 left-2 right-2 h-[2.5px] rounded-full"
                style={{
                  background: "linear-gradient(90deg, #DC6743, #e8845e)",
                  boxShadow: "0 0 8px rgba(220,103,67,0.4)",
                }}
              />
            )}
          </button>
        ))}
      </div>

      {/* Content — ONLY scrollable area */}
      <div ref={scrollRef} className="flex-1 flex flex-col overflow-y-auto" style={{ minHeight: 0, WebkitOverflowScrolling: "touch" }}>
        {/* ── Tasks Tab ── */}
        {tab === "tasks" && (
          <div className="flex-1 flex flex-col px-4 py-3">
            {/* Creating task indicator — matches web app "Working on it..." */}
            {sending && tab === "tasks" && (
              <div className="glass-card rounded-xl p-4 mb-2.5 flex items-start gap-3.5">
                <div className="w-7 h-7 rounded-full shrink-0 relative flex items-center justify-center" style={{ background: "radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)" }}>
                  <div className="absolute inset-0 rounded-full" style={{ background: "conic-gradient(from 0deg, transparent 0%, rgba(99,102,241,0.5) 30%, transparent 55%)", animation: "spin 2s linear infinite" }} />
                  <div className="w-2 h-2 rounded-full relative z-10" style={{ background: "radial-gradient(circle, #818cf8, #6366f1)" }} />
                </div>
                <div>
                  <p className="text-sm font-medium" style={{ color: "#818cf8" }}>Working on it...</p>
                  <p className="text-xs mt-0.5" style={{ color: "#888" }}>Your agent is processing this task</p>
                </div>
              </div>
            )}
            {loadingTasks ? (
              <div className="space-y-2.5">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-20 animate-pulse glass-card rounded-xl" />
                ))}
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.1)" }}>
                  <EmptyIcon size={24} style={{ color: "#777" }} />
                </div>
                <p className="text-sm font-medium text-white">{emptyState.title}</p>
                <p className="mt-1 max-w-[240px] text-[12px]" style={{ color: "#777" }}>{emptyState.desc}</p>
                {emptyState.hint && (
                  <p className="mt-3 max-w-[260px] glass-inner px-3 py-2 text-[11px]" style={{ color: "#999" }}>
                    {emptyState.hint}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2.5">
                {filteredTasks.map((task) => {
                  const isProcessing = task.status === "in_progress";
                  const isCompleted = task.status === "completed";
                  const isActive = task.status === "active";
                  const isFailed = task.status === "failed";
                  const isPaused = task.status === "paused";

                  return (
                  <div
                    key={task.id}
                    className="glass-card rounded-xl overflow-hidden"
                    style={{
                      border: isFailed ? "1px solid rgba(252,165,165,0.3)" : undefined,
                      opacity: isPaused ? 0.65 : undefined,
                    }}
                  >
                    <div className="p-4 flex items-start gap-3.5">
                      {/* Left status icon — matches web app exactly */}
                      <div className="shrink-0 mt-0.5">
                        {isPaused ? (
                          <div className="w-6 h-6 rounded-full flex items-center justify-center" style={{ border: "2px solid #9ca3af" }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="#9ca3af"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                          </div>
                        ) : isActive ? (
                          <div className="w-7 h-7 rounded-full relative flex items-center justify-center" style={{ background: "radial-gradient(circle, rgba(34,197,94,0.12) 0%, transparent 70%)", boxShadow: "0 0 12px rgba(34,197,94,0.15)" }}>
                            <div className="absolute inset-0 rounded-full" style={{ background: "conic-gradient(from 0deg, transparent 0%, rgba(34,197,94,0.45) 30%, transparent 55%)", animation: "spin 3s linear infinite" }} />
                            <div className="w-2.5 h-2.5 rounded-full relative z-10" style={{ background: "radial-gradient(circle, #4ade80, #16a34a)" }} />
                          </div>
                        ) : isProcessing ? (
                          <div className="w-7 h-7 rounded-full relative flex items-center justify-center" style={{ background: "radial-gradient(circle, rgba(99,102,241,0.10) 0%, transparent 70%)" }}>
                            <div className="absolute inset-0 rounded-full" style={{ background: "conic-gradient(from 0deg, transparent 0%, rgba(99,102,241,0.5) 30%, transparent 55%)", animation: "spin 2s linear infinite" }} />
                            <div className="w-2 h-2 rounded-full relative z-10" style={{ background: "radial-gradient(circle, #818cf8, #6366f1)" }} />
                          </div>
                        ) : isCompleted ? (
                          <div className="w-7 h-7 rounded-full flex items-center justify-center relative" style={{ background: "radial-gradient(circle at 35% 35%, #4a4a4a, #2a2a2acc 60%, #1a1a1a88 100%)", boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.25), inset 0 2px 3px rgba(255,255,255,0.3), 0 2px 6px rgba(0,0,0,0.2)" }}>
                            <div className="absolute rounded-full pointer-events-none" style={{ top: "8%", left: "15%", width: "45%", height: "28%", background: "linear-gradient(180deg, rgba(255,255,255,0.45) 0%, transparent 100%)" }} />
                            <Check size={14} strokeWidth={3} className="relative z-10" style={{ color: "#fff" }} />
                          </div>
                        ) : (
                          <div className="w-6 h-6 rounded-full" style={{ border: "2px solid rgba(255,255,255,0.15)" }} />
                        )}
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-[14px] truncate" style={{ color: isProcessing ? "#818cf8" : isFailed ? "#ef4444" : "#fff" }}>
                            {isProcessing && task.title === "Processing..." ? "Working on it..." : task.title}
                          </p>
                          {/* Status dot for non-active/completed */}
                          {!isCompleted && !isActive && !isProcessing && !isPaused && task.status === "queued" && (
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "#eab308" }} />
                          )}
                          {isFailed && (
                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "#ef4444" }} />
                          )}
                        </div>
                        <p className="text-[12px] mt-0.5 truncate" style={{ color: isFailed && task.error_message ? "#f87171" : "#888" }}>
                          {isFailed && task.error_message ? task.error_message : task.description}
                        </p>
                      </div>

                      {/* Tools + Recurring + Chevron */}
                      <div className="flex items-center gap-2 shrink-0">
                        {task.tools_used && task.tools_used.length > 0 && (
                          <div className="flex -space-x-1.5">
                            {task.tools_used.slice(0, 3).map((tool) => {
                              const toolColor = tool.includes("search") ? "#4285F4" : tool.includes("code") ? "#4285F4" : tool.includes("file") ? "#34a853" : "#71717a";
                              return (
                                <div key={tool} className="w-6 h-6 rounded-full flex items-center justify-center relative" style={{ background: `radial-gradient(circle at 35% 35%, ${toolColor}, ${toolColor}cc 60%, ${toolColor}88 100%)`, boxShadow: "inset 0 -1px 3px rgba(0,0,0,0.2), inset 0 1px 2px rgba(255,255,255,0.3), 0 1px 4px rgba(0,0,0,0.15)" }}>
                                  <div className="absolute rounded-full pointer-events-none" style={{ top: "8%", left: "15%", width: "45%", height: "28%", background: "linear-gradient(180deg, rgba(255,255,255,0.5) 0%, transparent 100%)" }} />
                                  <Search size={10} className="relative z-10" style={{ color: "#fff" }} />
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {task.is_recurring && <Repeat size={14} style={{ color: "#888" }} />}
                        <ChevronRight size={16} style={{ color: "#555" }} />
                      </div>
                    </div>

                    {/* Recurring pills row */}
                    {task.is_recurring && (task.frequency || task.next_run_at || task.streak > 0) && (
                      <div className="px-4 pb-3 pt-0 flex flex-wrap gap-1.5" style={{ marginLeft: "44px" }}>
                        {task.frequency && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px]" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", color: "#999", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)" }}>
                            <Repeat size={9} /> Runs {task.frequency}
                          </span>
                        )}
                        {task.next_run_at && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px]" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", color: "#999", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)" }}>
                            {formatNextRun(task.next_run_at)}
                          </span>
                        )}
                        {task.streak > 0 && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px]" style={{ background: "rgba(220,103,67,0.08)", boxShadow: "0 0 0 1px rgba(220,103,67,0.12)", color: "#DC6743" }}>
                            <Zap size={9} style={{ fill: "#DC6743" }} /> {task.streak} {task.streak === 1 ? "day" : "days"} streak
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Chat Tab ── */}
        {tab === "chat" && (
          <div className="flex-1 flex flex-col px-4 py-3">
            {chatMsgs.length === 0 && !sending ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.1)" }}>
                  <Zap size={24} style={{ color: "#777" }} />
                </div>
                <p className="text-sm font-medium text-white">Chat with your agent</p>
                <p className="mt-1 max-w-[240px] text-[12px]" style={{ color: "#777" }}>Same AI, same skills, same memory. Tap a suggestion below or type anything.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {chatMsgs.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} animate-fade-in`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-3 text-[13px] leading-relaxed ${msg.role === "user" ? "rounded-br-md" : "rounded-bl-md"}`}
                      style={msg.role === "user"
                        ? {
                            background: "linear-gradient(135deg, rgba(220,103,67,0.8), rgba(194,85,58,0.85))",
                            backdropFilter: "blur(8px)",
                            border: "1px solid rgba(255,255,255,0.1)",
                            boxShadow: "0 2px 8px rgba(220,103,67,0.2), inset 0 1px 0 rgba(255,255,255,0.15)",
                            color: "#fff",
                          }
                        : {
                            background: "linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))",
                            backdropFilter: "blur(12px)",
                            border: "1px solid rgba(255,255,255,0.08)",
                            boxShadow: "0 1px 4px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.06)",
                            color: "#ddd",
                          }
                      }
                    >
                      {msg.content}
                    </div>
                  </div>
                ))}
                {sending && (
                  <div className="flex justify-start animate-fade-in">
                    <div className="flex gap-1.5 rounded-2xl rounded-bl-md px-4 py-3.5" style={{ background: "linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 1px 4px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.06)" }}>
                      <span className="h-2 w-2 rounded-full" style={{ background: "rgba(220,103,67,0.6)", animation: "dot 1.4s infinite 0s" }} />
                      <span className="h-2 w-2 rounded-full" style={{ background: "rgba(220,103,67,0.6)", animation: "dot 1.4s infinite 0.2s" }} />
                      <span className="h-2 w-2 rounded-full" style={{ background: "rgba(220,103,67,0.6)", animation: "dot 1.4s infinite 0.4s" }} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Library Tab ── */}
        {tab === "library" && (
          <div className="flex-1 flex flex-col items-center justify-center px-4 text-center">
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
      {(tab === "tasks" || (tab === "chat" && chatMsgs.length === 0)) && (
        <div className="flex gap-2 overflow-x-auto px-4 py-2 no-scrollbar">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => handleSend(s)}
              className="shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.08)",
                color: "#ccc",
                boxShadow: "0 1px 3px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.06)",
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Active toggle pills */}
      <div className="flex flex-wrap gap-1.5 px-4 py-1">
        {webSearch && (
          <button onClick={() => setWebSearch(false)} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium" style={{ background: "rgba(66,133,244,0.1)", border: "1px solid rgba(66,133,244,0.25)", color: "#4285F4" }}>
            <Globe size={11} /> Web search <span style={{ opacity: 0.5 }}>×</span>
          </button>
        )}
        {deepResearch && (
          <button onClick={() => setDeepResearch(false)} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium" style={{ background: "rgba(139,92,246,0.1)", border: "1px solid rgba(139,92,246,0.25)", color: "#8b5cf6" }}>
            <Sparkles size={11} /> Deep research <span style={{ opacity: 0.5 }}>×</span>
          </button>
        )}
      </div>

      {/* Input bar */}
      <div className="relative px-4 py-2.5" style={{ paddingBottom: "max(env(safe-area-inset-bottom, 8px), 8px)" }}>
        {/* + menu overlay */}
        {plusMenuOpen && (
          <div className="absolute bottom-full left-4 right-4 mb-2 rounded-xl p-2" style={{ background: "linear-gradient(145deg, rgba(30,30,30,0.9), rgba(20,20,20,0.95))", border: "1px solid rgba(255,255,255,0.12)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", boxShadow: "0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.06)", zIndex: 50 }}>
            <button onClick={() => { setWebSearch(!webSearch); setPlusMenuOpen(false); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] transition-colors active:bg-white/5" style={{ color: webSearch ? "#4285F4" : "#aaa" }}>
              <Globe size={16} /> Web search {webSearch && <span className="ml-auto text-[10px]" style={{ color: "#4285F4" }}>ON</span>}
            </button>
            <button onClick={() => { setDeepResearch(!deepResearch); setPlusMenuOpen(false); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] transition-colors active:bg-white/5" style={{ color: deepResearch ? "#8b5cf6" : "#aaa" }}>
              <Sparkles size={16} /> Deep research {deepResearch && <span className="ml-auto text-[10px]" style={{ color: "#8b5cf6" }}>ON</span>}
            </button>
            <div className="my-1 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }} />
            <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px]" style={{ color: "#666" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
              Add files <span className="ml-auto text-[10px]" style={{ color: "#555" }}>soon</span>
            </button>
          </div>
        )}

        {/* Model dropdown */}
        {modelMenuOpen && (
          <div className="absolute bottom-full right-4 mb-2 w-40 rounded-xl p-1.5" style={{ background: "linear-gradient(145deg, rgba(30,30,30,0.9), rgba(20,20,20,0.95))", border: "1px solid rgba(255,255,255,0.12)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", boxShadow: "0 8px 32px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.06)", zIndex: 50 }}>
            {[
              { id: "Haiku 4.5", label: "Haiku 4.5" },
              { id: "Sonnet 4.6", label: "Sonnet 4.6" },
              { id: "Opus 4.6", label: "Opus 4.6" },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => { setSelectedModel(m.id); setModelMenuOpen(false); }}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-[12px] transition-colors active:bg-white/5"
                style={{ color: selectedModel === m.id ? "#DC6743" : "#aaa" }}
              >
                {m.label}
                {selectedModel === m.id && <Check size={14} />}
              </button>
            ))}
          </div>
        )}

        {/* Close menus on tap outside */}
        {(plusMenuOpen || modelMenuOpen) && (
          <div className="fixed inset-0 z-40" onClick={() => { setPlusMenuOpen(false); setModelMenuOpen(false); }} />
        )}

        <div className="relative z-50 flex items-center gap-2 rounded-2xl px-3 py-2.5" style={{ background: "linear-gradient(145deg, rgba(255,255,255,0.07), rgba(255,255,255,0.03))", border: "1px solid rgba(255,255,255,0.1)", backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)", boxShadow: "0 2px 8px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.06)" }}>
          {/* + button */}
          <button
            onClick={() => { setPlusMenuOpen(!plusMenuOpen); setModelMenuOpen(false); }}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all active:scale-90"
            style={{ background: plusMenuOpen ? "#DC6743" : "rgba(255,255,255,0.08)", transform: plusMenuOpen ? "rotate(45deg)" : "none" }}
          >
            <span className="text-lg font-light" style={{ color: plusMenuOpen ? "#fff" : "#888" }}>+</span>
          </button>

          {/* Input */}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            placeholder={tab === "tasks" ? "Create a new task..." : tab === "chat" ? "Message your agent..." : "Search library..."}
            autoComplete="off"
            className="flex-1 min-w-0 bg-transparent text-[13px] text-white placeholder:text-white/30 focus:outline-none"
          />

          {/* Model selector */}
          <button
            onClick={() => { setModelMenuOpen(!modelMenuOpen); setPlusMenuOpen(false); }}
            className="shrink-0 flex items-center gap-0.5 text-[11px] font-medium transition-colors"
            style={{ color: modelMenuOpen ? "#DC6743" : "#666" }}
          >
            <span>{selectedModel.split(" ")[0]}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
          </button>

          {/* Mic button */}
          <button
            onClick={() => {
              if (!("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) return;
              const SR = (window as unknown as Record<string, unknown>).SpeechRecognition || (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
              if (!SR) return;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const recognition = new (SR as any)();
              recognition.continuous = false;
              recognition.interimResults = false;
              recognition.lang = "en-US";
              setIsListening(true);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              recognition.onresult = (e: any) => {
                const transcript = e.results[0][0].transcript;
                setInput((prev: string) => prev + (prev ? " " : "") + transcript);
                setIsListening(false);
              };
              recognition.onerror = () => setIsListening(false);
              recognition.onend = () => setIsListening(false);
              recognition.start();
            }}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all active:scale-90"
            style={{ color: isListening ? "#ef4444" : "#666" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>
            </svg>
          </button>

          {/* Send button */}
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || sending}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-all active:scale-90 disabled:opacity-20"
            style={{
              background: input.trim() ? "linear-gradient(135deg, #DC6743, #c2553a)" : "rgba(255,255,255,0.06)",
              boxShadow: input.trim() ? "0 2px 8px rgba(220,103,67,0.3), inset 0 1px 0 rgba(255,255,255,0.15)" : "none",
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
