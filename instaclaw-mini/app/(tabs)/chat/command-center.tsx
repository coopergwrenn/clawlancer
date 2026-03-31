"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import ChatSidebar from "@/components/chat-sidebar";
import {
  Send,
  Globe,
  Zap,
  Repeat,
  Sparkles,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  RotateCw,
  Trash2,
  RefreshCw,
  Search,
  Play,
  Pause,
  Pencil,
  X,
  AlertCircle,
  Archive,
  PanelLeft,
  Bookmark,
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
  last_run_at: string | null;
  processing_started_at: string | null;
  tools_used: string[];
  error_message: string | null;
  result: string | null;
  consecutive_failures: number;
  last_delivery_status: string | null;
  archived_at: string | null;
  created_at: string;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

interface LibraryItem {
  id: string;
  content: string;
  created_at: string;
  run_number: number;
}

// ── Helpers ──

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch { return ""; }
}

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

function formatDate(iso: string | undefined | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch { return ""; }
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
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTitleDraft, setEditTitleDraft] = useState("");
  const [taskError, setTaskError] = useState<string | null>(null);
  const [pollingIds, setPollingIds] = useState<Set<string>>(new Set());
  const [failedCount, setFailedCount] = useState(0);
  const [showRefineId, setShowRefineId] = useState<string | null>(null);
  const [refineInput, setRefineInput] = useState("");
  const [isRefining, setIsRefining] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [runHistory, setRunHistory] = useState<LibraryItem[]>([]);
  const [runHistoryLoading, setRunHistoryLoading] = useState(false);
  const [currentRunIndex, setCurrentRunIndex] = useState(0);
  const refineRef = useRef<HTMLInputElement>(null);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
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
  const [savedMessageIds, setSavedMessageIds] = useState<Set<string>>(new Set());
  const [refreshingSuggestions, setRefreshingSuggestions] = useState(false);

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

  // Fetch failed task count for badge on "All" filter pill
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/tasks/list?status=failed&limit=1");
        if (res.ok) {
          const data = await res.json();
          setFailedCount(data.total || 0);
        }
      } catch {}
    })();
  }, [tasks]); // re-check when tasks change

  // Auto-dismiss toast after 3 seconds
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Background polling for in-progress tasks (matches web app: every 3s, 2min timeout)
  useEffect(() => {
    const inProgress = tasks.filter((t) => t.status === "in_progress" && !t.id.startsWith("temp-"));
    if (inProgress.length === 0) return;

    const interval = setInterval(async () => {
      for (const task of inProgress) {
        try {
          const res = await fetch(`/api/tasks/${task.id}`);
          if (res.ok) {
            const data = await res.json();
            if (data.task) {
              setTasks((prev) => prev.map((t) => t.id === task.id ? data.task : t));
              // Stop polling this task if it reached a terminal state
              if (data.task.status !== "in_progress") {
                setPollingIds((prev) => { const next = new Set(prev); next.delete(task.id); return next; });
              }
            }
          }
        } catch {}
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [tasks]);

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

  // Refresh suggestions on demand
  const refreshSuggestions = useCallback(async () => {
    setRefreshingSuggestions(true);
    try {
      const res = await fetch("/api/proxy/tasks/suggestions");
      if (res.ok) {
        const data = await res.json();
        if (data?.suggestions && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
          const labels = data.suggestions
            .map((s: { label?: string; prefill?: string }) => s.label || s.prefill)
            .filter(Boolean);
          if (labels.length > 0) {
            setSuggestions(labels);
            try { localStorage.setItem("instaclaw-suggestions", JSON.stringify(labels)); } catch {}
          }
        }
      }
    } catch {}
    setRefreshingSuggestions(false);
  }, []);

  // Load messages for active conversation
  useEffect(() => {
    if (!activeConvId) {
      // No active conversation — try loading from localStorage (legacy)
      try {
        const stored = localStorage.getItem(CHAT_KEY);
        if (stored) setChatMsgs(JSON.parse(stored));
      } catch {}
      return;
    }
    // Load from DB
    setLoadingChat(true);
    setChatMsgs([]);
    fetch(`/api/chat/conversations/${activeConvId}`)
      .then((r) => r.json())
      .then((data) => {
        setChatMsgs((data.messages || []).map((m: { role: string; content: string; created_at: string }) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          ts: new Date(m.created_at).getTime(),
        })));
      })
      .catch(() => {})
      .finally(() => setLoadingChat(false));
  }, [activeConvId]);

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
        streak: 0, next_run_at: null, last_run_at: null, processing_started_at: null,
        tools_used: [], error_message: null, result: null, consecutive_failures: 0,
        last_delivery_status: null, archived_at: null,
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
            // Replace placeholder with real task, remove any temp entries
            setTasks((prev) => [data.task, ...prev.filter((t) => !t.id.startsWith("temp-"))]);
          }
        } else {
          // Remove placeholder on error
          setTasks((prev) => prev.filter((t) => !t.id.startsWith("temp-")));
          setTaskError("Failed to create task. Please try again.");
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
          conversation_id: activeConvId,
          stream: true,
          toggles: { webSearch, deepResearch },
        }),
      });

      // Capture conversation_id from response header (auto-created)
      const returnedConvId = res.headers.get("X-Conversation-Id");
      if (returnedConvId && !activeConvId) {
        setActiveConvId(returnedConvId);
      }

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

        // Save assistant message to DB
        const saveConvId = returnedConvId || activeConvId;
        if (saveConvId) {
          fetch("/api/chat/save-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversation_id: saveConvId, content: accumulated }),
          }).catch(() => {});
        }
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
  }, [input, sending, tab, chatMsgs, activeConvId, webSearch, deepResearch]);

  // Tasks are already filtered by the API based on the filter param
  const filteredTasks = tasks;

  const emptyState = EMPTY_STATES[filter];
  const EmptyIcon = emptyState.icon;
  const tgUsername = telegramBotUsername?.replace(/^@/, "");

  return (
    <div className="relative flex h-full flex-col overflow-hidden" style={{ background: "transparent" }}>
      {/* ── Pinned header section (shrink-0, never scrolls) ── */}
      <div className="shrink-0">
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
            className="relative shrink-0 rounded-full px-3.5 py-1.5 text-[11px] font-medium capitalize transition-all active:scale-95"
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
            {f === "all" && failedCount > 0 && (
              <span
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white"
                style={{ background: "#ef4444" }}
              >
                {failedCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tabs — glass with sliding underline */}
      <div className="relative flex px-4 pb-0.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        {(["tasks", "chat", "library"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); scrollRef.current?.scrollTo({ top: 0 }); }}
            className="relative px-4 py-2.5 text-[13px] font-semibold capitalize transition-all duration-300"
            style={{ color: tab === t ? "#fff" : "#555" }}
          >
            {t}
            {tab === t && (
              <div
                className="absolute bottom-0 left-2 right-2 h-[2.5px] rounded-full"
                style={{
                  background: "linear-gradient(90deg, #da7756, #e0906a)",
                  boxShadow: "0 0 8px rgba(218,119,86,0.4)",
                }}
              />
            )}
          </button>
        ))}
      </div>

      </div>{/* end shrink-0 header */}

      {/* Content — scrollable area, extends behind the bottom glass toolbar */}
      <div ref={scrollRef} className="flex-1 flex flex-col overflow-y-auto" style={{ minHeight: 0, WebkitOverflowScrolling: "touch", paddingBottom: "180px" }}>
        {/* ── Tasks Tab ── */}
        {tab === "tasks" && (
          <div className="flex-1 flex flex-col px-4 py-3">
            {/* Error banner */}
            {taskError && (
              <div className="mb-2.5 rounded-xl p-3 flex items-center justify-between" style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.15)" }}>
                <p className="text-[12px]" style={{ color: "#f87171" }}>{taskError}</p>
                <button onClick={() => setTaskError(null)} className="text-xs" style={{ color: "#f87171" }}><X size={14} /></button>
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
                      border: isFailed ? "1px solid #fca5a5" : undefined,
                      background: isFailed ? "rgba(239,68,68,0.03)" : undefined,
                      opacity: isPaused ? 0.65 : undefined,
                    }}
                  >
                    <div
                      className="p-4 flex items-start gap-3.5 cursor-pointer active:bg-white/[0.02] transition-colors"
                      onClick={() => {
                        const opening = expandedTaskId !== task.id;
                        setExpandedTaskId(opening ? task.id : null);
                        setCurrentRunIndex(0);
                        if (opening && task.is_recurring && task.result) {
                          setRunHistoryLoading(true);
                          setRunHistory([]);
                          fetch(`/api/library/list?source_task_id=${task.id}&limit=100&sort=created_at&order=desc`)
                            .then((r) => r.json())
                            .then((d) => setRunHistory(d.items ?? []))
                            .catch(() => setRunHistory([]))
                            .finally(() => setRunHistoryLoading(false));
                        }
                      }}
                    >
                      {/* Left status icon — matches web app exactly */}
                      <div className="shrink-0 mt-0.5">
                        {isPaused ? (
                          <div className="w-6 h-6 rounded-full flex items-center justify-center" style={{ border: "2px solid #9ca3af" }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="#9ca3af"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                          </div>
                        ) : isActive ? (
                          <div className="w-7 h-7 rounded-full relative flex items-center justify-center" style={{ background: "radial-gradient(circle, rgba(34,197,94,0.12) 0%, rgba(34,197,94,0.04) 70%, transparent 100%)", boxShadow: "0 0 12px rgba(34,197,94,0.15), 0 0 4px rgba(34,197,94,0.08)" }}>
                            <div className="absolute inset-0 rounded-full" style={{ background: "conic-gradient(from 0deg, transparent 0%, rgba(34,197,94,0.45) 30%, transparent 55%)", animation: "spin 3s linear infinite" }} />
                            <div className="w-2.5 h-2.5 rounded-full relative z-10" style={{ background: "radial-gradient(circle at 35% 30%, #4ade80, #16a34a)", boxShadow: "0 0 6px rgba(34,197,94,0.35)" }} />
                          </div>
                        ) : isProcessing ? (
                          <div className="w-7 h-7 rounded-full relative flex items-center justify-center" style={{ background: "radial-gradient(circle, rgba(99,102,241,0.10) 0%, rgba(99,102,241,0.03) 70%, transparent 100%)" }}>
                            <div className="absolute inset-0 rounded-full" style={{ background: "conic-gradient(from 0deg, transparent 0%, rgba(99,102,241,0.5) 30%, transparent 55%)", animation: "spin 2s linear infinite" }} />
                            <div className="w-2 h-2 rounded-full relative z-10" style={{ background: "radial-gradient(circle at 35% 30%, #818cf8, #6366f1)", boxShadow: "0 0 6px rgba(99,102,241,0.35)" }} />
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
                          <p className="font-medium text-[15px] truncate" style={{ color: isProcessing ? "#6366f1" : isFailed ? "#ef4444" : "#fff" }}>
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
                        <p className="text-[12px] mt-0.5 truncate" style={{ color: isFailed && task.error_message ? "#fca5a5" : "#888" }}>
                          {isFailed && task.error_message ? task.error_message : task.description}
                        </p>
                        {/* Delivery status + consecutive failures */}
                        <div className="flex items-center gap-2 mt-1">
                          {task.last_delivery_status && (
                            <span className="text-[9px] font-medium" style={{ color: task.last_delivery_status === "delivered" ? "#22c55e" : task.last_delivery_status === "delivery_failed" ? "#ef4444" : "#888" }}>
                              {task.last_delivery_status === "delivered" ? "Delivered to Telegram" : task.last_delivery_status === "delivery_failed" ? "Delivery failed" : ""}
                            </span>
                          )}
                          {isFailed && task.consecutive_failures > 1 && (
                            <span className="text-[9px] font-medium" style={{ color: "#ef4444" }}>
                              {task.consecutive_failures} consecutive failures
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Tools + Recurring + Chevron */}
                      <div className="flex items-center gap-2 shrink-0">
                        {task.tools_used && task.tools_used.length > 0 && (
                          <div className="flex -space-x-1.5">
                            {task.tools_used.slice(0, 4).map((tool) => {
                              const t = tool.toLowerCase();
                              // Tool color + icon matching web app TOOL_CONFIGS exactly
                              const toolColor =
                                t.includes("search") || t.includes("brave") ? "#4285F4"
                                : t.includes("telegram") ? "#2AABEE"
                                : t.includes("discord") ? "#5865F2"
                                : t.includes("gmail") || t.includes("email") ? "#EA4335"
                                : t.includes("code") || t.includes("python") ? "#4285F4"
                                : t.includes("file") || t.includes("write") ? "#34a853"
                                : t.includes("database") ? "#8b5cf6"
                                : t.includes("calendar") ? "#4285F4"
                                : t.includes("image") ? "#ec4899"
                                : t.includes("cron") || t.includes("schedule") ? "#f59e0b"
                                : t.includes("competitive") || t.includes("monitor") ? "#64748b"
                                : "#71717a";

                              // SVG icon path per tool type
                              const iconPath =
                                t.includes("search") || t.includes("brave")
                                  ? <><circle cx="10.5" cy="10.5" r="5" stroke="#fff" strokeWidth="2.5" fill="none"/><line x1="14" y1="14" x2="18" y2="18" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"/></>
                                : t.includes("code") || t.includes("python")
                                  ? <><polyline points="8,6 4,10 8,14" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/><polyline points="14,6 18,10 14,14" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></>
                                : t.includes("file") || t.includes("write")
                                  ? <><path d="M13 2H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z" stroke="#fff" strokeWidth="2" fill="none"/><path d="M13 2v5h5" stroke="#fff" strokeWidth="2" fill="none"/></>
                                : t.includes("telegram")
                                  ? <path d="M18 4.5L3 10.5c-.5.2-.5.7.1.8l3.8 1.2 1.5 4.5c.2.4.5.5.9.3l2-1.7 4 3c.4.3.9.2 1-.4L19 5.5c.2-.7-.3-1.1-1-.8l0 0zM8.5 13l6.5-4.5c.2-.1.2.1.1.1L9.5 14l-.3 2.6-.9-3z" fill="#fff"/>
                                : t.includes("email") || t.includes("gmail")
                                  ? <><rect x="3" y="5" width="16" height="12" rx="2" stroke="#fff" strokeWidth="2" fill="none"/><path d="M3 7l8 5 8-5" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round"/></>
                                : t.includes("cron") || t.includes("schedule")
                                  ? <><circle cx="11" cy="11" r="8" stroke="#fff" strokeWidth="2" fill="none"/><path d="M11 7v4l3 3" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round"/></>
                                : t.includes("competitive") || t.includes("monitor")
                                  ? <><circle cx="11" cy="11" r="8" stroke="#fff" strokeWidth="2" fill="none"/><line x1="21" y1="21" x2="16.65" y2="16.65" stroke="#fff" strokeWidth="2" strokeLinecap="round"/><line x1="11" y1="8" x2="11" y2="14" stroke="#fff" strokeWidth="2" strokeLinecap="round"/><line x1="8" y1="11" x2="14" y2="11" stroke="#fff" strokeWidth="2" strokeLinecap="round"/></>
                                  // Default: wrench/tool icon
                                : <><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></>;

                              return (
                                <div key={tool} className="w-7 h-7 rounded-full flex items-center justify-center relative" style={{ background: `radial-gradient(circle at 35% 35%, ${toolColor}, ${toolColor}cc 60%, ${toolColor}88 100%)`, boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.2), inset 0 2px 3px rgba(255,255,255,0.35), 0 2px 6px rgba(0,0,0,0.18)" }}>
                                  <div className="absolute rounded-full pointer-events-none" style={{ top: "8%", left: "15%", width: "45%", height: "28%", background: "linear-gradient(180deg, rgba(255,255,255,0.55) 0%, transparent 100%)" }} />
                                  <svg width={12} height={12} viewBox="0 0 22 22" fill="none" className="relative z-10">{iconPath}</svg>
                                </div>
                              );
                            })}
                            {task.tools_used.length > 4 && (
                              <div className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-semibold" style={{ background: "radial-gradient(circle at 35% 35%, #555, #444cc 60%, #33388 100%)", boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.15), inset 0 2px 3px rgba(255,255,255,0.2), 0 2px 6px rgba(0,0,0,0.15)", color: "#aaa" }}>
                                +{task.tools_used.length - 4}
                              </div>
                            )}
                          </div>
                        )}
                        {task.is_recurring && <Repeat size={14} style={{ color: "#888" }} />}
                        {expandedTaskId === task.id
                          ? <ChevronDown size={16} style={{ color: "#888" }} />
                          : <ChevronRight size={16} style={{ color: "#555", transition: "transform 0.2s" }} />
                        }
                      </div>
                    </div>

                    {/* Recurring pills row — matches web app exactly */}
                    {task.is_recurring && (task.frequency || task.next_run_at || task.streak > 0) && (() => {
                      const isOverdue = task.next_run_at ? new Date(task.next_run_at).getTime() < Date.now() : false;
                      const isRunningNow = !!task.processing_started_at || isOverdue;
                      const frequencyLabel = task.frequency ? `Runs ${task.frequency}` : null;
                      const nextRunLabel = isRunningNow ? "Running now" : task.next_run_at ? formatNextRun(task.next_run_at) : null;

                      return (
                      <div className="px-4 pb-3 pt-0 flex flex-wrap gap-1.5" style={{ marginLeft: "44px" }}>
                        {/* Frequency pill */}
                        {frequencyLabel && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px]" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", color: "#999", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)" }}>
                            <Repeat size={9} /> {frequencyLabel}
                          </span>
                        )}

                        {/* Next run / Running now pill */}
                        {nextRunLabel && (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
                            style={isRunningNow ? {
                              background: "rgba(34,197,94,0.08)",
                              border: "1px solid rgba(34,197,94,0.12)",
                              boxShadow: "0 0 0 1px rgba(34,197,94,0.15), 0 1px 2px rgba(34,197,94,0.06)",
                              color: "#16a34a",
                            } : isPaused ? {
                              background: "rgba(156,163,175,0.08)",
                              border: "1px solid rgba(156,163,175,0.12)",
                              color: "#9ca3af",
                            } : {
                              background: "rgba(255,255,255,0.06)",
                              border: "1px solid rgba(255,255,255,0.08)",
                              color: "#999",
                              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
                            }}
                          >
                            {isRunningNow && (
                              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "#22c55e" }} />
                            )}
                            {nextRunLabel}
                          </span>
                        )}

                        {/* Streak pill */}
                        {!isPaused && task.streak > 0 && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium" style={{ background: "rgba(218,119,86,0.08)", boxShadow: "0 0 0 1px rgba(218,119,86,0.12), 0 1px 2px rgba(218,119,86,0.06)", color: "#da7756" }}>
                            <Zap size={9} style={{ fill: "#da7756" }} /> {task.streak} {task.streak === 1 ? "day" : "days"} streak
                          </span>
                        )}
                      </div>
                      );
                    })()}

                    {/* ── Expanded Result Section ── */}
                    <div
                      style={{
                        maxHeight: expandedTaskId === task.id ? "5000px" : "0",
                        opacity: expandedTaskId === task.id ? 1 : 0,
                        overflow: "hidden",
                        transition: "max-height 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.25s ease",
                      }}
                    >
                      <div className="px-4 pb-4 pt-0 space-y-3" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                        {/* Result with run history navigator */}
                        {task.result ? (() => {
                          const allRuns = runHistory;
                          const totalRuns = allRuns.length;
                          const hasHistory = task.is_recurring && totalRuns > 1;
                          const displayedContent = hasHistory && allRuns[currentRunIndex]
                            ? allRuns[currentRunIndex].content
                            : task.result;
                          const displayedDate = hasHistory && allRuns[currentRunIndex]
                            ? allRuns[currentRunIndex].created_at
                            : task.last_run_at;

                          return (
                          <div className="mt-3">
                            {/* Run history navigator header */}
                            <div className="flex items-center justify-between mb-1.5">
                              <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "#888", opacity: 0.6 }}>
                                Result
                              </p>
                              {task.is_recurring && runHistoryLoading ? (
                                <div className="h-5 w-36 rounded-full animate-pulse" style={{ background: "rgba(255,255,255,0.06)" }} />
                              ) : hasHistory ? (
                                <div
                                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full"
                                  style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)" }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    onClick={() => setCurrentRunIndex((i) => Math.min(i + 1, totalRuns - 1))}
                                    disabled={currentRunIndex >= totalRuns - 1}
                                    className="p-0.5 rounded transition-all disabled:opacity-25"
                                  >
                                    <ChevronLeft size={12} style={{ color: "#888" }} />
                                  </button>
                                  <span className="text-[10px] font-medium" style={{ color: "#999", fontVariantNumeric: "tabular-nums" }}>
                                    Run {totalRuns - currentRunIndex} of {totalRuns}
                                  </span>
                                  <button
                                    onClick={() => setCurrentRunIndex((i) => Math.max(i - 1, 0))}
                                    disabled={currentRunIndex <= 0}
                                    className="p-0.5 rounded transition-all disabled:opacity-25"
                                  >
                                    <ChevronRight size={12} style={{ color: "#888" }} />
                                  </button>
                                  <span className="text-[9px] ml-0.5" style={{ color: "#666" }}>
                                    {formatDate(displayedDate)}
                                  </span>
                                </div>
                              ) : task.is_recurring && task.last_run_at ? (
                                <span className="text-[9px]" style={{ color: "#666" }}>
                                  {formatDate(task.last_run_at)}
                                </span>
                              ) : null}
                            </div>

                            {/* Result text */}
                            <div
                              className="rounded-xl p-3.5 text-sm leading-relaxed relative"
                              style={{
                                background: "rgba(255,255,255,0.04)",
                                border: "1px solid rgba(255,255,255,0.06)",
                                boxShadow: "inset 0 1px 2px rgba(0,0,0,0.08)",
                                color: "#ccc",
                                maxHeight: "400px",
                                overflowY: "auto",
                                WebkitOverflowScrolling: "touch",
                                opacity: isRefining && showRefineId === task.id ? 0.4 : 1,
                                transition: "opacity 0.2s",
                              }}
                            >
                              {isRefining && showRefineId === task.id && (
                                <div className="absolute inset-0 flex items-center justify-center rounded-xl" style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(2px)" }}>
                                  <p className="text-xs font-medium animate-pulse" style={{ color: "#a78bfa" }}>Refining...</p>
                                </div>
                              )}
                              <div className="prose prose-sm prose-invert max-w-none [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_h2]:text-base [&_h2]:font-bold [&_h2]:mt-3 [&_h2]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2.5 [&_h3]:mb-1 [&_hr]:my-3 [&_hr]:border-white/10 [&_strong]:text-white [&_a]:text-[#da7756] [&_a]:no-underline [&_code]:text-xs [&_code]:bg-white/5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:my-2 [&_pre]:rounded-lg [&_pre]:bg-white/5 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_blockquote]:border-l-2 [&_blockquote]:border-white/15 [&_blockquote]:pl-3 [&_blockquote]:text-white/60">
                                <ReactMarkdown>{displayedContent || ""}</ReactMarkdown>
                              </div>
                            </div>
                          </div>
                          );
                        })() : task.status === "in_progress" ? (
                          <p className="text-xs mt-3" style={{ color: "#888" }}>Agent is working on this task...</p>
                        ) : task.error_message ? (
                          <div className="rounded-xl p-3.5 text-sm mt-3 flex items-start gap-2.5" style={{ background: "rgba(239,68,68,0.04)", border: "1px solid rgba(239,68,68,0.12)", boxShadow: "inset 0 1px 2px rgba(239,68,68,0.04)", color: "#fca5a5" }}>
                            <AlertCircle size={16} className="shrink-0 mt-0.5" style={{ color: "#ef4444" }} />
                            <span>{task.error_message}</span>
                          </div>
                        ) : (
                          <p className="text-xs mt-3" style={{ color: "#666" }}>No result yet.</p>
                        )}

                        {/* Action buttons — matches web app exactly */}
                        <div className="flex items-center gap-2 pt-2 flex-wrap" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
                          {/* Run now / Resume / Re-run — context-dependent */}
                          {task.is_recurring && isActive ? (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, processing_started_at: new Date().toISOString() } : t));
                                try {
                                  const res = await fetch(`/api/tasks/${task.id}/trigger`, { method: "POST" });
                                  if (res.ok) { const d = await res.json(); if (d.task) setTasks((prev) => prev.map((t) => t.id === task.id ? d.task : t)); }
                                } catch {}
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                              style={{ background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.12)", color: "#16a34a", boxShadow: "0 1px 3px rgba(34,197,94,0.08), inset 0 1px 0 rgba(255,255,255,0.1)" }}
                            >
                              <Play size={11} /> Run now
                            </button>
                          ) : isPaused ? (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  const res = await fetch(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "active" }) });
                                  if (res.ok) { const d = await res.json(); if (d.task) setTasks((prev) => prev.map((t) => t.id === task.id ? d.task : t)); }
                                } catch {}
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                              style={{ background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.12)", color: "#16a34a", boxShadow: "0 1px 3px rgba(34,197,94,0.08), inset 0 1px 0 rgba(255,255,255,0.1)" }}
                            >
                              <Play size={11} /> Resume
                            </button>
                          ) : (isCompleted || isFailed) ? (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, status: "in_progress", result: null, error_message: null } : t));
                                try {
                                  const res = await fetch(`/api/tasks/${task.id}/rerun`, { method: "POST" });
                                  if (res.ok) { const d = await res.json(); if (d.task) setTasks((prev) => prev.map((t) => t.id === task.id ? d.task : t)); }
                                } catch {}
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", color: "#ccc", boxShadow: "0 1px 3px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.06)" }}
                            >
                              <RotateCw size={11} /> Re-run
                            </button>
                          ) : null}

                          {/* Pause (active recurring only) */}
                          {isActive && task.is_recurring && (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  const res = await fetch(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "paused" }) });
                                  if (res.ok) { const d = await res.json(); if (d.task) setTasks((prev) => prev.map((t) => t.id === task.id ? d.task : t)); }
                                } catch {}
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                              style={{ background: "rgba(156,163,175,0.06)", border: "1px solid rgba(156,163,175,0.12)", color: "#9ca3af" }}
                            >
                              <Pause size={11} /> Pause
                            </button>
                          )}

                          {/* Toggle complete (for non-recurring) */}
                          {!task.is_recurring && (isCompleted || task.status === "queued") && (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                const newStatus = isCompleted ? "queued" : "completed";
                                try {
                                  const res = await fetch(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: newStatus }) });
                                  if (res.ok) { const d = await res.json(); if (d.task) setTasks((prev) => prev.map((t) => t.id === task.id ? d.task : t)); }
                                } catch {}
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", color: "#ccc", boxShadow: "0 1px 3px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.06)" }}
                            >
                              <Check size={11} /> {isCompleted ? "Mark undone" : "Mark done"}
                            </button>
                          )}

                          {/* Edit & re-run */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingTaskId(task.id);
                              setEditTitleDraft(task.description);
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", color: "#ccc", boxShadow: "0 1px 3px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.06)" }}
                          >
                            <Pencil size={11} /> Edit &amp; re-run
                          </button>

                          {/* Refine (only when result exists) */}
                          {task.result && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowRefineId(showRefineId === task.id ? null : task.id);
                                setRefineInput("");
                                setTimeout(() => refineRef.current?.focus(), 100);
                              }}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                              style={{ background: "rgba(139,92,246,0.06)", border: "1px solid rgba(139,92,246,0.12)", color: "#a78bfa" }}
                            >
                              <Sparkles size={11} /> Refine
                            </button>
                          )}

                          {/* Archive */}
                          <button
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                const res = await fetch(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archive: true }) });
                                if (res.ok) {
                                  setTasks((prev) => prev.filter((t) => t.id !== task.id));
                                  setExpandedTaskId(null);
                                  setToast({ msg: "Task archived", type: "success" });
                                }
                              } catch {}
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                            style={{ background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.12)", color: "#818cf8", boxShadow: "0 1px 3px rgba(99,102,241,0.08), inset 0 1px 0 rgba(255,255,255,0.06)" }}
                          >
                            <Archive size={12} /> Archive
                          </button>

                          {/* Delete with confirmation */}
                          {confirmDeleteId !== task.id ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(task.id); }}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
                              style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.12)", color: "#f87171" }}
                            >
                              <Trash2 size={11} /> Delete
                            </button>
                          ) : (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
                                  setTasks((prev) => prev.filter((t) => t.id !== task.id));
                                  setExpandedTaskId(null);
                                  setConfirmDeleteId(null);
                                  setToast({ msg: "Task deleted", type: "success" });
                                } catch {}
                              }}
                              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all active:scale-95"
                              style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.25)", color: "#ef4444" }}
                            >
                              Confirm delete
                            </button>
                          )}
                        </div>

                        {/* Refine input */}
                        {showRefineId === task.id && (
                          <div
                            className="flex gap-2 items-center"
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              maxHeight: showRefineId === task.id ? "60px" : "0",
                              opacity: showRefineId === task.id ? 1 : 0,
                              overflow: "hidden",
                              transition: "max-height 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease",
                            }}
                          >
                            <input
                              ref={refineRef}
                              type="text"
                              value={refineInput}
                              onChange={(e) => setRefineInput(e.target.value)}
                              placeholder="Tell your agent what to change..."
                              className="flex-1 rounded-lg px-3 py-2 text-sm bg-transparent outline-none"
                              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff" }}
                              onKeyDown={async (e) => {
                                if (e.key === "Enter" && refineInput.trim()) {
                                  setIsRefining(true);
                                  try {
                                    const res = await fetch(`/api/tasks/${task.id}/refine`, {
                                      method: "POST",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ instruction: refineInput }),
                                    });
                                    if (res.ok) {
                                      const d = await res.json();
                                      if (d.task) setTasks((prev) => prev.map((t) => t.id === task.id ? d.task : t));
                                      setToast({ msg: "Result refined", type: "success" });
                                    }
                                  } catch {}
                                  setIsRefining(false);
                                  setShowRefineId(null);
                                  setRefineInput("");
                                }
                                if (e.key === "Escape") { setShowRefineId(null); setRefineInput(""); }
                              }}
                            />
                            <button
                              onClick={async () => {
                                if (!refineInput.trim()) return;
                                setIsRefining(true);
                                try {
                                  const res = await fetch(`/api/tasks/${task.id}/refine`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ instruction: refineInput }),
                                  });
                                  if (res.ok) {
                                    const d = await res.json();
                                    if (d.task) setTasks((prev) => prev.map((t) => t.id === task.id ? d.task : t));
                                    setToast({ msg: "Result refined", type: "success" });
                                  }
                                } catch {}
                                setIsRefining(false);
                                setShowRefineId(null);
                                setRefineInput("");
                              }}
                              disabled={isRefining}
                              className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium"
                              style={{ background: "rgba(139,92,246,0.1)", color: "#a78bfa" }}
                            >
                              {isRefining ? "..." : <Send size={12} />}
                            </button>
                            <button onClick={() => { setShowRefineId(null); setRefineInput(""); }}>
                              <X size={14} style={{ color: "#888" }} />
                            </button>
                          </div>
                        )}

                        {/* Edit & re-run inline */}
                        {editingTaskId === task.id && (
                          <div className="flex gap-2 items-center" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="text"
                              value={editTitleDraft}
                              onChange={(e) => setEditTitleDraft(e.target.value)}
                              className="flex-1 rounded-lg px-3 py-2 text-sm bg-transparent outline-none"
                              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff" }}
                              placeholder="Edit prompt and re-run..."
                              autoFocus
                              onKeyDown={async (e) => {
                                if (e.key === "Enter" && editTitleDraft.trim()) {
                                  setEditingTaskId(null);
                                  // Update description + re-run with edited prompt
                                  setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, description: editTitleDraft, status: "in_progress", result: null, error_message: null } : t));
                                  try {
                                    await fetch(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: editTitleDraft.slice(0, 60) }) });
                                    const res = await fetch(`/api/tasks/${task.id}/rerun`, { method: "POST" });
                                    if (res.ok) { const d = await res.json(); if (d.task) setTasks((prev) => prev.map((t) => t.id === task.id ? d.task : t)); }
                                  } catch {}
                                }
                                if (e.key === "Escape") setEditingTaskId(null);
                              }}
                            />
                            <button
                              onClick={async () => {
                                if (!editTitleDraft.trim()) return;
                                setEditingTaskId(null);
                                setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, description: editTitleDraft, status: "in_progress", result: null, error_message: null } : t));
                                try {
                                  await fetch(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: editTitleDraft.slice(0, 60) }) });
                                  const res = await fetch(`/api/tasks/${task.id}/rerun`, { method: "POST" });
                                  if (res.ok) { const d = await res.json(); if (d.task) setTasks((prev) => prev.map((t) => t.id === task.id ? d.task : t)); }
                                } catch {}
                              }}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium"
                              style={{ background: "rgba(218,119,86,0.1)", border: "1px solid rgba(218,119,86,0.15)", color: "#da7756" }}
                            >
                              <RotateCw size={10} /> Re-run
                            </button>
                            <button onClick={() => setEditingTaskId(null)} className="text-[11px]" style={{ color: "#888" }}>
                              <X size={14} />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Chat Tab ── */}
        {tab === "chat" && (
          <div className="flex-1 flex flex-col relative">
            {/* Chat header with sidebar toggle + title — matching web app */}
            <div className="sticky top-0 z-20 flex items-center h-11 px-2 gap-1.5" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", background: "#0a0a0a", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)" }}>
              <button
                onClick={() => setShowSidebar((v) => !v)}
                className="w-8 h-8 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-white/[0.05] active:scale-95 shrink-0"
                title={showSidebar ? "Close sidebar" : "Open conversations"}
              >
                <PanelLeft size={18} style={{ color: "#999" }} />
              </button>
              <span className="text-[13px] font-medium truncate flex-1" style={{ color: "#eee" }}>
                {activeConvId ? "Chat" : "New Chat"}
              </span>
            </div>

            {/* Sidebar overlay */}
            <ChatSidebar
              open={showSidebar}
              onClose={() => setShowSidebar(false)}
              activeId={activeConvId}
              onSelect={(id) => setActiveConvId(id)}
              onNewChat={() => { setActiveConvId(null); setChatMsgs([]); }}
            />

            {/* Messages area */}
            <div className="flex-1 px-4 py-3">
            {loadingChat ? (
              <div className="flex-1 flex items-center justify-center py-16">
                <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "rgba(255,255,255,0.1)", borderTopColor: "transparent" }} />
              </div>
            ) : chatMsgs.length === 0 && !sending ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 2px 8px rgba(0,0,0,0.1)" }}>
                  <Zap size={24} style={{ color: "#777" }} />
                </div>
                <p className="text-sm font-medium text-white">Chat with your agent</p>
                <p className="mt-1 max-w-[240px] text-[12px]" style={{ color: "#777" }}>Same AI, same skills, same memory. Tap a suggestion below or type anything.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {chatMsgs.map((msg, i) => {
                  const isUser = msg.role === "user";
                  const msgKey = `${msg.ts}-${i}`;
                  const isSaved = savedMessageIds.has(msgKey);

                  return (
                    <div key={i} className={`flex gap-2.5 ${isUser ? "justify-end" : "justify-start"} group/bubble`} style={{ animation: "bubble-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}>
                      {/* Assistant avatar — glass orb with logo */}
                      {!isUser && (
                        <div
                          className="w-8 h-8 rounded-full shrink-0 relative flex items-center justify-center mt-1"
                          style={{
                            background: "radial-gradient(circle at 35% 30%, rgba(60,60,60,0.9), rgba(40,40,40,0.7) 50%, rgba(25,25,25,0.8) 100%)",
                            boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.3), inset 0 2px 4px rgba(255,255,255,0.15), 0 1px 4px rgba(0,0,0,0.2)",
                          }}
                        >
                          <div className="absolute top-[2px] left-[4px] w-[14px] h-[7px] rounded-full pointer-events-none z-10"
                            style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.35) 0%, transparent 100%)" }} />
                          <img src="/logo.png" alt="" className="w-5 h-5 relative z-[1]" style={{ filter: "invert(1) brightness(1.2)" }} />
                        </div>
                      )}

                      {/* Message bubble + timestamp */}
                      <div className={`max-w-[80%] relative ${isUser ? "items-end" : "items-start"}`}>
                        <div
                          className="relative rounded-2xl px-4 py-3 text-[13px] leading-relaxed"
                          style={isUser
                            ? {
                                background: "#da7756",
                                boxShadow: "0 2px 8px rgba(218,119,86,0.25), 0 1px 3px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.2)",
                                color: "#fff",
                                borderBottomRightRadius: "4px",
                              }
                            : {
                                background: "#1e1e1e",
                                boxShadow: "0 1px 6px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)",
                                color: "#ddd",
                                borderBottomLeftRadius: "4px",
                              }
                          }
                        >
                          {isUser ? msg.content : (
                            <div className="prose prose-sm prose-invert max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_h2]:text-sm [&_h2]:font-bold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_hr]:my-2 [&_hr]:border-white/10 [&_strong]:text-white [&_a]:text-[#da7756] [&_code]:text-xs [&_code]:bg-white/5 [&_code]:px-1 [&_code]:rounded [&_pre]:my-1.5 [&_pre]:rounded-lg [&_pre]:bg-white/5 [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0">
                              <ReactMarkdown>{msg.content}</ReactMarkdown>
                            </div>
                          )}

                          {/* SVG bubble tails — solid colors to match bubble backgrounds */}
                          {isUser ? (
                            <svg className="absolute bottom-0 -right-[8px] w-3 h-[18px]" viewBox="0 0 12 18" fill="none">
                              <path d="M0 0C1 8 8 14 12 18H0V0Z" fill="#da7756" />
                            </svg>
                          ) : (
                            <svg className="absolute bottom-0 -left-[8px] w-3 h-[18px]" viewBox="0 0 12 18" fill="none">
                              <path d="M12 0C11 8 4 14 0 18H12V0Z" fill="#1e1e1e" />
                            </svg>
                          )}
                        </div>

                        {/* Timestamp + save icon */}
                        <div className={`flex items-center gap-1 mt-1 ${isUser ? "justify-end" : "justify-start"}`}>
                          <p className="text-[11px]" style={{ color: "#666" }}>
                            {formatTime(msg.ts)}
                          </p>
                          {!isUser && msg.content.length > 0 && (
                            <button
                              onClick={() => {
                                setSavedMessageIds((prev) => new Set(prev).add(msgKey));
                              }}
                              className={`p-0.5 rounded transition-opacity ${isSaved ? "opacity-70" : "opacity-40"}`}
                              title={isSaved ? "Saved" : "Save to Library"}
                            >
                              <Bookmark size={12} style={{ color: "#666" }} fill={isSaved ? "currentColor" : "none"} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Typing indicator — with avatar and tail */}
                {sending && (
                  <div className="flex gap-2.5 justify-start" style={{ animation: "bubble-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}>
                    <div
                      className="w-8 h-8 rounded-full shrink-0 relative flex items-center justify-center mt-1"
                      style={{
                        background: "radial-gradient(circle at 35% 30%, rgba(60,60,60,0.9), rgba(40,40,40,0.7) 50%, rgba(25,25,25,0.8) 100%)",
                        boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.3), inset 0 2px 4px rgba(255,255,255,0.15), 0 1px 4px rgba(0,0,0,0.2)",
                      }}
                    >
                      <div className="absolute top-[2px] left-[4px] w-[14px] h-[7px] rounded-full pointer-events-none z-10"
                        style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.35) 0%, transparent 100%)" }} />
                      <img src="/logo.png" alt="" className="w-5 h-5 relative z-[1]" style={{ filter: "invert(1) brightness(1.2)" }} />
                    </div>
                    <div className="relative">
                      <div className="rounded-2xl px-4 py-3.5" style={{ background: "#1e1e1e", boxShadow: "0 1px 6px rgba(0,0,0,0.08)", borderBottomLeftRadius: "4px" }}>
                        <div className="flex gap-1.5">
                          <span className="h-2 w-2 rounded-full" style={{ background: "rgba(218,119,86,0.6)", animation: "dot 1.4s infinite 0s" }} />
                          <span className="h-2 w-2 rounded-full" style={{ background: "rgba(218,119,86,0.6)", animation: "dot 1.4s infinite 0.2s" }} />
                          <span className="h-2 w-2 rounded-full" style={{ background: "rgba(218,119,86,0.6)", animation: "dot 1.4s infinite 0.4s" }} />
                        </div>
                        <svg className="absolute bottom-0 -left-[8px] w-3 h-[18px]" viewBox="0 0 12 18" fill="none">
                          <path d="M12 0C11 8 4 14 0 18H12V0Z" fill="#1e1e1e" />
                        </svg>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            </div>{/* end messages area */}
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

      {/* ── Bottom toolbar — invisible container, pure blur fade ── */}
      <div
        className="absolute bottom-0 left-0 right-0 z-30 pointer-events-none"
      >
        {/* Blur layer — uses mask so blur itself fades in smoothly */}
        <div
          className="absolute inset-0 -top-12"
          style={{
            backdropFilter: "blur(40px) saturate(1.6)",
            WebkitBackdropFilter: "blur(40px) saturate(1.6)",
            maskImage: "linear-gradient(to bottom, transparent 0%, black 28%)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent 0%, black 28%)",
          }}
        />
        {/* All interactive content — re-enable pointer events */}
        <div className="relative pointer-events-auto">

      {/* Suggestion chips */}
      {(tab === "tasks" || tab === "chat") && (
        <div className="flex gap-2 overflow-x-auto px-4 py-2 no-scrollbar">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => handleSend(s)}
              className="shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium transition-all hover:scale-[1.02] active:scale-[0.98]"
              style={{
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.1)",
                color: "#ccc",
                boxShadow: "0 1px 3px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.06)",
              }}
            >
              {s}
            </button>
          ))}
          {/* Reload suggestions button — matching web app */}
          <button
            onClick={refreshSuggestions}
            disabled={refreshingSuggestions}
            className="shrink-0 flex items-center justify-center w-8 h-8 rounded-full transition-all active:scale-95"
            style={{
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.1)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.06)",
            }}
            title="Refresh suggestions"
          >
            <RefreshCw
              size={13}
              style={{
                color: "#999",
                animation: refreshingSuggestions ? "spin 1s linear infinite" : "none",
              }}
            />
          </button>
        </div>
      )}

      {/* Active toggle pills */}
      <div className="flex flex-wrap gap-1.5 px-4 py-1">
        {webSearch && (
          <button onClick={() => setWebSearch(false)} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#ccc", boxShadow: "0 1px 3px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.06)" }}>
            <Globe size={11} style={{ color: "#999" }} /> Web search <span style={{ color: "#666" }}>×</span>
          </button>
        )}
        {deepResearch && (
          <button onClick={() => setDeepResearch(false)} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#ccc", boxShadow: "0 1px 3px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.06)" }}>
            <Sparkles size={11} style={{ color: "#999" }} /> Deep research <span style={{ color: "#666" }}>×</span>
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
                style={{ color: selectedModel === m.id ? "#da7756" : "#aaa" }}
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
            style={{ background: plusMenuOpen ? "#da7756" : "rgba(255,255,255,0.08)", transform: plusMenuOpen ? "rotate(45deg)" : "none" }}
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
            style={{ color: modelMenuOpen ? "#da7756" : "#666" }}
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
              background: input.trim() ? "linear-gradient(135deg, #da7756, #c36441)" : "rgba(255,255,255,0.06)",
              boxShadow: input.trim() ? "0 2px 8px rgba(218,119,86,0.3), inset 0 1px 0 rgba(255,255,255,0.15)" : "none",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>
            </svg>
          </button>
        </div>
      </div>
      </div>{/* end interactive content */}
      </div>{/* end bottom toolbar */}

      <style>{`
        @keyframes dot { 0%,60%,100%{opacity:.3;transform:translateY(0)} 30%{opacity:1;transform:translateY(-4px)} }
        @keyframes bubble-in { from{opacity:0;transform:scale(0.95) translateY(8px)} to{opacity:1;transform:scale(1) translateY(0)} }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>

      {/* Toast notification */}
      {toast && (
        <div
          className="fixed top-16 left-1/2 -translate-x-1/2 z-[9999] rounded-xl px-4 py-2.5 text-[12px] font-medium"
          style={{
            background: toast.type === "success" ? "rgba(34,197,94,0.9)" : "rgba(239,68,68,0.9)",
            color: "#fff",
            backdropFilter: "blur(12px)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
            animation: "fade-in 0.2s ease-out",
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
