"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ChevronRight,
  ChevronDown,
  Check,
  Send,
  ArrowUp,
  Repeat,
  RotateCw,
  Trash2,
  AlertCircle,
  Pencil,
  Sparkles,
  X,
  Search,
  Pin,
  Copy,
  Download,
  Bookmark,
  Pause,
  Play,
  Zap,
} from "lucide-react";
import ReactMarkdown from "react-markdown";

/* ─── Tool Brand Logos ────────────────────────────────────── */

const TOOL_LOGOS: Record<string, { logo: string; label: string; color: string }> = {
  web_search:   { logo: "/tool-icons/web-search.svg", label: "Web Search",    color: "#4285F4" },
  brave_search: { logo: "/tool-icons/brave.svg",      label: "Brave Search",  color: "#FB542B" },
  search:       { logo: "/tool-icons/web-search.svg", label: "Search",        color: "#4285F4" },
  telegram:     { logo: "/tool-icons/telegram.svg",   label: "Telegram",      color: "#2AABEE" },
  discord:      { logo: "/tool-icons/discord.svg",    label: "Discord",       color: "#5865F2" },
  email:        { logo: "/tool-icons/gmail.svg",      label: "Email",         color: "#EA4335" },
  gmail:        { logo: "/tool-icons/gmail.svg",      label: "Gmail",         color: "#EA4335" },
  clawlancer:   { logo: "/tool-icons/instaclaw.svg",  label: "Instaclaw",     color: "#DC6743" },
  marketplace:  { logo: "/tool-icons/instaclaw.svg",  label: "Marketplace",   color: "#DC6743" },
  file:         { logo: "/tool-icons/file.svg",       label: "Files",         color: "#34A853" },
  code:         { logo: "/tool-icons/code.svg",       label: "Code",          color: "#1e1e1e" },
  database:     { logo: "/tool-icons/database.svg",   label: "Database",      color: "#8b5cf6" },
  calendar:     { logo: "/tool-icons/calendar.svg",   label: "Calendar",      color: "#4285F4" },
  image:        { logo: "/tool-icons/image.svg",      label: "Image",         color: "#ec4899" },
};

function getToolLogo(tool: string): { logo: string; label: string; color: string } {
  const key = tool.toLowerCase().replace(/[\s_-]+/g, "_");
  if (TOOL_LOGOS[key]) return TOOL_LOGOS[key];
  for (const [k, v] of Object.entries(TOOL_LOGOS)) {
    if (key.includes(k)) return v;
  }
  return { logo: "/tool-icons/web-search.svg", label: tool, color: "#71717a" };
}

/* ─── Model Options ──────────────────────────────────────── */

const MODEL_OPTIONS = [
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5" },
  { id: "claude-opus-4-5-20250820", label: "Opus 4.5" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
];

/* ─── Types ───────────────────────────────────────────────── */

type Tab = "tasks" | "chat" | "library";

type TaskStatus = "completed" | "in_progress" | "queued" | "failed" | "active" | "paused";

type FilterOption = "all" | "active" | "scheduled" | "completed";

interface TaskItem {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  is_recurring: boolean;
  frequency: string | null;
  streak: number;
  last_run_at: string | null;
  next_run_at: string | null;
  result: string | null;
  error_message: string | null;
  tools_used: string[];
  consecutive_failures: number;
  processing_started_at: string | null;
  last_delivery_status: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatMsg {
  id?: string;
  role: "user" | "assistant";
  content: string;
  created_at?: string;
  isStreaming?: boolean;
}

interface LibraryItem {
  id: string;
  user_id: string;
  title: string;
  type: string;
  content: string;
  preview: string;
  source_task_id: string | null;
  source_chat_message_id: string | null;
  run_number: number;
  tags: string[];
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

const LIBRARY_TYPE_CONFIG: Record<string, { icon: string; bg: string; label: string }> = {
  research: { icon: "\u{1F50D}", bg: "#bfdbfe", label: "Research" },
  draft: { icon: "\u2709\uFE0F", bg: "#bbf7d0", label: "Draft" },
  report: { icon: "\u{1F4CA}", bg: "#fed7aa", label: "Report" },
  analysis: { icon: "\u{1F4C8}", bg: "#e9d5ff", label: "Analysis" },
  code: { icon: "\u{1F4BB}", bg: "#e5e7eb", label: "Code" },
  post: { icon: "\u{1F4DD}", bg: "#fecdd3", label: "Post" },
  other: { icon: "\u{1F4C4}", bg: "#f3f4f6", label: "Other" },
};

const libraryTypeFilters = [
  { key: "all", label: "All" },
  { key: "research", label: "Research" },
  { key: "draft", label: "Drafts" },
  { key: "report", label: "Reports" },
  { key: "analysis", label: "Analysis" },
  { key: "code", label: "Code" },
  { key: "post", label: "Posts" },
];

/* ─── Quick Actions (with pre-fill text) ─────────────────── */

const quickActions = [
  { icon: "\u{1F50D}", label: "Research", prefill: "Research " },
  { icon: "\u2709\uFE0F", label: "Draft email", prefill: "Draft an email about " },
  { icon: "\u{1F4CA}", label: "Market update", prefill: "Give me a market update on the latest crypto and AI news" },
  { icon: "\u{1F4DD}", label: "Write a post", prefill: "Write a post about " },
  { icon: "\u{1F99E}", label: "Check bounties", prefill: "Check the Clawlancer marketplace for available bounties and recommend the best ones for me" },
  { icon: "\u{1F4C5}", label: "Today\u2019s schedule", prefill: "Summarize what I should focus on today based on my priorities and pending work" },
];

const filterOptions: { key: FilterOption; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "scheduled", label: "Scheduled" },
  { key: "completed", label: "Completed" },
];

/* ─── Helpers ────────────────────────────────────────────── */

function formatTime(iso: string | undefined | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
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
  } catch {
    return "";
  }
}

function timeAgo(iso: string | undefined | null): string {
  if (!iso) return "";
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return "";
  }
}

/** Smart next run formatting */
function formatNextRun(iso: string | null | undefined, isPaused: boolean): string {
  if (isPaused) return "Paused";
  if (!iso) return "";
  try {
    const next = new Date(iso).getTime();
    const diff = next - Date.now();
    if (diff <= 0) return "Running soon...";
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    if (hours < 24) return remMins > 0 ? `in ${hours}h ${remMins}m` : `in ${hours}h`;
    const nextDate = new Date(iso);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (nextDate.toDateString() === tomorrow.toDateString()) {
      return `Tomorrow ${nextDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    }
    return nextDate.toLocaleDateString([], { weekday: "short" }) +
      " " +
      nextDate.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Map filter option to status query param */
function filterToStatus(filter: FilterOption): string | undefined {
  switch (filter) {
    case "active":
      return "in_progress,active,paused";
    case "scheduled":
      return "queued";
    case "completed":
      return "completed";
    default:
      return undefined;
  }
}

/* ─── SSE Stream Parser ──────────────────────────────────── */

async function readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onDelta: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void
) {
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const event = JSON.parse(data);
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "text_delta"
          ) {
            onDelta(event.delta.text);
          }
        } catch {
          // Not valid JSON — skip
        }
      }
    }
    onDone();
  } catch (err) {
    onError(String(err));
  }
}

/* ─── Status Dot ─────────────────────────────────────────── */

function StatusDot({ status }: { status: TaskStatus }) {
  const base = "w-2 h-2 rounded-full shrink-0";
  switch (status) {
    case "completed":
      return null;
    case "active":
      return (
        <span
          className={base}
          style={{ background: "#16a34a", boxShadow: "0 0 6px rgba(34,197,94,0.5)" }}
        />
      );
    case "in_progress":
      return (
        <span
          className={`${base} animate-pulse`}
          style={{ background: "#3b82f6" }}
        />
      );
    case "queued":
      return <span className={base} style={{ background: "#eab308" }} />;
    case "failed":
      return <span className={base} style={{ background: "#ef4444" }} />;
    case "paused":
      return <span className={base} style={{ background: "#9ca3af" }} />;
  }
}

/* ─── Filter Pills ───────────────────────────────────────── */

function FilterPills({
  active,
  onChange,
  visible,
  failedCount,
}: {
  active: FilterOption;
  onChange: (f: FilterOption) => void;
  visible: boolean;
  failedCount: number;
}) {
  return (
    <div
      className={`flex gap-2 transition-opacity duration-200 ${
        visible ? "opacity-100" : "opacity-30 pointer-events-none"
      }`}
    >
      {filterOptions.map((f) => (
        <motion.button
          key={f.key}
          onClick={() => onChange(f.key)}
          className="relative px-3.5 py-1.5 rounded-full text-xs font-medium cursor-pointer backdrop-blur-md"
          animate={{
            background:
              active === f.key
                ? "rgba(30, 30, 30, 0.75)"
                : "rgba(255, 255, 255, 0.45)",
            color: active === f.key ? "#ffffff" : "#6b7280",
            borderColor:
              active === f.key
                ? "rgba(255, 255, 255, 0.2)"
                : "rgba(0, 0, 0, 0.08)",
            boxShadow:
              active === f.key
                ? "0 2px 8px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.1)"
                : "0 1px 3px rgba(0, 0, 0, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.6)",
          }}
          whileHover={{
            background:
              active === f.key
                ? "rgba(30, 30, 30, 0.85)"
                : "rgba(255, 255, 255, 0.65)",
            boxShadow:
              active === f.key
                ? "0 4px 12px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.15)"
                : "0 2px 6px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.7)",
          }}
          whileTap={{ scale: 0.96 }}
          transition={{ duration: 0.15 }}
          style={{ border: "1px solid rgba(0, 0, 0, 0.08)" }}
        >
          {f.label}
          {f.key === "all" && failedCount > 0 && (
            <span
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
              style={{ background: "#ef4444" }}
            >
              {failedCount}
            </span>
          )}
        </motion.button>
      ))}
    </div>
  );
}

/* ─── Typing Indicator ───────────────────────────────────── */

function TypingIndicator() {
  return (
    <div className="flex gap-3 justify-start">
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm"
        style={{ background: "var(--card)", border: "1px solid var(--border)" }}
      >
        {"\u{1F99E}"}
      </div>
      <div
        className="rounded-2xl px-4 py-3 flex items-center gap-1"
        style={{ background: "var(--card)", border: "1px solid var(--border)" }}
      >
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="w-2 h-2 rounded-full"
            style={{ background: "var(--muted)" }}
            animate={{ y: [0, -4, 0] }}
            transition={{
              duration: 0.6,
              repeat: Infinity,
              delay: i * 0.15,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/* ─── Chat Bubble ────────────────────────────────────────── */

function ChatBubble({
  msg,
  isSaved,
  onSave,
}: {
  msg: ChatMsg;
  isSaved?: boolean;
  onSave?: () => void;
}) {
  const isUser = msg.role === "user";
  const showBookmark = !isUser && !msg.isStreaming && msg.content.length > 0 && onSave;

  return (
    <div
      className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"} group/bubble`}
    >
      {!isUser && (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          {"\u{1F99E}"}
        </div>
      )}

      <div className="max-w-[80%] sm:max-w-[70%] relative">
        <div
          className="rounded-2xl px-4 py-3 text-sm leading-relaxed"
          style={
            isUser
              ? { background: "var(--accent)", color: "#ffffff" }
              : {
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
                }
          }
        >
          {isUser ? (
            msg.content
          ) : (
            <div className="prose prose-sm max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_pre]:my-2 [&_pre]:rounded-lg [&_pre]:bg-black/5 [&_pre]:p-3 [&_code]:text-xs [&_code]:bg-black/5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre_code]:bg-transparent [&_pre_code]:p-0">
              <ReactMarkdown>{msg.content}</ReactMarkdown>
            </div>
          )}
          {msg.isStreaming && (
            <span className="inline-block w-1.5 h-4 ml-0.5 bg-current animate-pulse" />
          )}
        </div>
        <div className="flex items-center gap-1 mt-1.5">
          {msg.created_at && (
            <p
              className={`text-[11px] ${isUser ? "text-right flex-1" : "text-left"}`}
              style={{ color: "var(--muted)" }}
            >
              {formatTime(msg.created_at)}
            </p>
          )}
          {showBookmark && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onSave();
              }}
              className={`p-0.5 rounded transition-opacity cursor-pointer ${
                isSaved
                  ? "opacity-70"
                  : "opacity-0 group-hover/bubble:opacity-60 sm:opacity-0 max-sm:opacity-40"
              } hover:opacity-100`}
              title={isSaved ? "Saved to Library" : "Save to Library"}
            >
              <Bookmark
                className="w-3.5 h-3.5"
                style={{ color: "var(--muted)" }}
                fill={isSaved ? "currentColor" : "none"}
              />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Chat Empty State ───────────────────────────────────── */

function ChatEmptyState({
  onChipClick,
}: {
  onChipClick: (text: string) => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center text-2xl mb-4"
        style={{ background: "var(--card)", border: "1px solid var(--border)" }}
      >
        {"\u{1F99E}"}
      </div>
      <h3
        className="text-lg font-normal mb-1"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        Hey! I&apos;m your InstaClaw agent.
      </h3>
      <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
        Ask me anything &mdash; I&apos;m ready to work.
      </p>
      <div className="flex flex-wrap gap-2 justify-center">
        {quickActions.map((a) => (
          <button
            key={a.label}
            onClick={() => onChipClick(a.prefill)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer transition-all hover:scale-[1.02]"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          >
            <span>{a.icon}</span>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── Skeleton Loading ───────────────────────────────────── */

function ChatSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[false, true, false].map((isUser, i) => (
        <div
          key={i}
          className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}
        >
          {!isUser && (
            <div
              className="w-8 h-8 rounded-full shrink-0"
              style={{ background: "var(--border)" }}
            />
          )}
          <div
            className="rounded-2xl h-12"
            style={{
              background: "var(--border)",
              width: isUser ? "50%" : "65%",
              opacity: 0.5,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function TasksSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-xl p-5 flex items-start gap-4"
          style={{ border: "1px solid var(--border)", opacity: 0.5 }}
        >
          <div
            className="w-6 h-6 rounded-full shrink-0"
            style={{ background: "var(--border)" }}
          />
          <div className="flex-1 space-y-2">
            <div
              className="h-4 rounded"
              style={{ background: "var(--border)", width: "60%" }}
            />
            <div
              className="h-3 rounded"
              style={{ background: "var(--border)", width: "80%" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Tasks Empty State ──────────────────────────────────── */

function TasksEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center text-2xl mb-4"
        style={{ background: "var(--card)", border: "1px solid var(--border)" }}
      >
        {"\u{1F4CB}"}
      </div>
      <h3
        className="text-lg font-normal mb-1"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        No tasks yet
      </h3>
      <p className="text-sm mb-2" style={{ color: "var(--muted)" }}>
        Tell your agent what to do &mdash; just type below.
      </p>
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Try something like: &ldquo;Research the top AI agent frameworks&rdquo;
        or &ldquo;Draft a weekly investor update&rdquo;
      </p>
    </div>
  );
}

/* ─── Task Card ──────────────────────────────────────────── */

function TaskCard({
  task,
  isExpanded,
  onToggleExpand,
  onToggleComplete,
  onDelete,
  onRerun,
  onTrigger,
  onPause,
  onResume,
  onTaskUpdated,
}: {
  task: TaskItem;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onToggleComplete: () => void;
  onDelete: () => void;
  onRerun: () => void;
  onTrigger: () => void;
  onPause: () => void;
  onResume: () => void;
  onTaskUpdated: (updated: TaskItem) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Edit mode
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  // Refine mode
  const [showRefine, setShowRefine] = useState(false);
  const [refineInput, setRefineInput] = useState("");
  const [isRefining, setIsRefining] = useState(false);
  // Toast
  const [toast, setToast] = useState<string | null>(null);
  const refineRef = useRef<HTMLInputElement>(null);

  const isFailed = task.status === "failed";
  const isProcessing = task.status === "in_progress";
  const isCompleted = task.status === "completed";
  const isActive = task.status === "active";
  const isPaused = task.status === "paused";

  const streakText =
    task.streak === 0
      ? "New"
      : task.streak > 1
        ? task.frequency?.includes("week")
          ? `${task.streak} weeks`
          : `${task.streak} days`
        : `${task.streak} day`;

  const timingParts: string[] = [];
  if (task.frequency) timingParts.push(task.frequency);
  if (isPaused) {
    timingParts.push("Paused");
  } else if (task.is_recurring && task.next_run_at) {
    const nextLabel = formatNextRun(task.next_run_at, false);
    timingParts.push(`Next: ${nextLabel}`);
  } else if (task.last_run_at) {
    timingParts.push(`Last: ${timeAgo(task.last_run_at)} ${isFailed ? "\u274C" : "\u2705"}`);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }

  function startEdit() {
    setEditDraft(task.result ?? "");
    setIsEditing(true);
    setShowRefine(false);
  }

  async function saveEdit() {
    setIsSavingEdit(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ result: editDraft }),
      });
      if (res.ok) {
        const data = await res.json();
        onTaskUpdated(data.task);
        setIsEditing(false);
        showToast("Saved");
      }
    } catch {
      // Keep in edit mode on failure
    } finally {
      setIsSavingEdit(false);
    }
  }

  function cancelEdit() {
    setIsEditing(false);
    setEditDraft("");
  }

  function openRefine() {
    setShowRefine(true);
    setIsEditing(false);
    setRefineInput("");
    requestAnimationFrame(() => refineRef.current?.focus());
  }

  async function submitRefine() {
    if (!refineInput.trim() || isRefining) return;
    setIsRefining(true);
    try {
      const res = await fetch(`/api/tasks/${task.id}/refine`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: refineInput.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        onTaskUpdated(data.task);
        setShowRefine(false);
        setRefineInput("");
        showToast("Result updated");
      }
    } catch {
      // Keep refine open on failure
    } finally {
      setIsRefining(false);
    }
  }

  return (
    <div
      className="glass rounded-xl overflow-hidden relative"
      style={{
        border: isFailed
          ? "1px solid #fca5a5"
          : "1px solid var(--border)",
        background: isFailed ? "rgba(239,68,68,0.03)" : undefined,
        opacity: isPaused ? 0.65 : undefined,
      }}
    >
      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="absolute top-2 right-2 z-10 px-3 py-1.5 rounded-lg text-xs font-medium"
            style={{ background: "var(--foreground)", color: "var(--background)" }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main row */}
      <div
        className="p-4 sm:p-5 flex items-start gap-4 cursor-pointer group"
        onClick={onToggleExpand}
      >
        {/* Checkbox / status indicator */}
        <div
          className="shrink-0 mt-0.5"
          onClick={(e) => {
            e.stopPropagation();
            if (!isProcessing && !isActive && !isPaused) onToggleComplete();
          }}
        >
          {isPaused ? (
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center"
              style={{ border: "2px solid #9ca3af" }}
            >
              <Pause className="w-3 h-3" style={{ color: "#9ca3af" }} />
            </div>
          ) : isActive ? (
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center relative"
              style={{
                background: "radial-gradient(circle, rgba(34,197,94,0.12) 0%, rgba(34,197,94,0.04) 70%, transparent 100%)",
                boxShadow: "0 0 12px rgba(34,197,94,0.15), 0 0 4px rgba(34,197,94,0.08)",
              }}
            >
              <motion.div
                className="absolute inset-0 rounded-full"
                style={{
                  background: "conic-gradient(from 0deg, transparent 0%, rgba(34,197,94,0.45) 30%, transparent 55%)",
                  mask: "radial-gradient(circle, transparent 58%, black 62%, black 100%)",
                  WebkitMask: "radial-gradient(circle, transparent 58%, black 62%, black 100%)",
                }}
                animate={{ rotate: 360 }}
                transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
              />
              <span
                className="w-2.5 h-2.5 rounded-full relative z-10"
                style={{
                  background: "radial-gradient(circle at 35% 30%, #4ade80, #16a34a)",
                  boxShadow: "0 0 6px rgba(34,197,94,0.35)",
                }}
              />
            </div>
          ) : isCompleted ? (
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center cursor-pointer transition-opacity hover:opacity-70"
              style={{ background: "var(--foreground)" }}
            >
              <Check
                className="w-3.5 h-3.5"
                style={{ color: "var(--background)" }}
              />
            </div>
          ) : (
            <div
              className="w-6 h-6 rounded-full border-2 transition-colors cursor-pointer hover:border-gray-400"
              style={{ borderColor: isProcessing ? "#3b82f6" : "rgba(0,0,0,0.15)" }}
            />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot status={task.status} />
            <p
              className={`font-medium text-base truncate ${
                isProcessing && task.title === "Processing..."
                  ? "animate-pulse"
                  : ""
              }`}
              style={{ color: "var(--foreground)" }}
            >
              {task.title}
            </p>
          </div>
          <p
            className="text-sm mt-0.5 truncate pl-4"
            style={{ color: isFailed ? "#b91c1c" : "var(--muted)" }}
          >
            {isFailed && task.error_message
              ? task.error_message
              : task.description}
          </p>
          {task.is_recurring && (timingParts.length > 0 || !isPaused) && (
            <div
              className={`flex items-center gap-1.5 text-xs mt-1 pl-4 ${
                !isPaused && task.next_run_at && new Date(task.next_run_at).getTime() < Date.now()
                  ? "animate-pulse"
                  : ""
              }`}
              style={{ color: isPaused ? "#9ca3af" : "var(--muted)" }}
            >
              <span>{timingParts.join(" \u00b7 ")}</span>
              {task.is_recurring && !isPaused && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                  style={{
                    background: "rgba(220,103,67,0.08)",
                    boxShadow: "0 0 0 1px rgba(220,103,67,0.12), 0 1px 2px rgba(220,103,67,0.06)",
                    color: "#DC6743",
                  }}
                >
                  <Zap className="w-2.5 h-2.5" style={{ fill: "#DC6743" }} />
                  {streakText} streak
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0 mt-1">
          {isFailed && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRerun();
              }}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-red-50"
              style={{ color: "#ef4444", border: "1px solid #fca5a5" }}
            >
              <RotateCw className="w-3 h-3" />
              Retry
            </button>
          )}
          {task.is_recurring && (
            <Repeat className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
          )}
          {task.tools_used.length > 0 && (
            <div className="flex items-center -space-x-1.5">
              {task.tools_used.slice(0, 4).map((tool) => {
                const { logo, label, color } = getToolLogo(tool);
                return (
                  <div
                    key={tool}
                    className="w-7 h-7 rounded-full relative shrink-0 flex items-center justify-center"
                    title={label}
                    style={{
                      background: `radial-gradient(circle at 35% 35%, ${color}dd, ${color}88 40%, rgba(0,0,0,0.3) 100%)`,
                      boxShadow: `
                        inset 0 -3px 6px rgba(0,0,0,0.25),
                        inset 0 3px 6px rgba(255,255,255,0.4),
                        inset 0 0 4px rgba(0,0,0,0.15),
                        0 2px 8px rgba(0,0,0,0.2),
                        0 1px 3px rgba(0,0,0,0.15)
                      `,
                    }}
                  >
                    <img src={logo} alt={label} className="w-4 h-4" style={{ position: "relative", zIndex: 1 }} />
                    <div
                      className="absolute top-[2px] left-[4px] w-[14px] h-[7px] rounded-full pointer-events-none"
                      style={{
                        background: "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 100%)",
                        zIndex: 2,
                      }}
                    />
                  </div>
                );
              })}
              {task.tools_used.length > 4 && (
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-semibold"
                  style={{
                    background: "radial-gradient(circle at 35% 35%, #e5e5e5dd, #d4d4d488 40%, rgba(0,0,0,0.15) 100%)",
                    boxShadow: "inset 0 -3px 6px rgba(0,0,0,0.15), inset 0 3px 6px rgba(255,255,255,0.5), 0 2px 8px rgba(0,0,0,0.15)",
                    color: "var(--muted)",
                  }}
                >
                  +{task.tools_used.length - 4}
                </div>
              )}
            </div>
          )}
        </div>

        {isExpanded ? (
          <ChevronDown
            className="w-4 h-4 shrink-0 mt-1"
            style={{ color: "var(--muted)" }}
          />
        ) : (
          <ChevronRight
            className="w-4 h-4 shrink-0 transition-transform group-hover:translate-x-0.5 mt-1"
            style={{ color: "var(--muted)" }}
          />
        )}
      </div>

      {/* Expanded detail section */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div
              className="px-4 sm:px-5 pb-4 sm:pb-5 pt-0 space-y-3"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              {/* Original request */}
              <div className="pt-3">
                <p className="text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>
                  You asked:
                </p>
                <p className="text-sm" style={{ color: "var(--muted)" }}>
                  &ldquo;{task.description}&rdquo;
                </p>
              </div>

              {/* Result — with edit mode */}
              {task.result && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs font-medium" style={{ color: "var(--muted)" }}>
                      Result:
                    </p>
                    {!isEditing && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit();
                        }}
                        className="p-1 rounded transition-opacity opacity-40 hover:opacity-100 cursor-pointer"
                        title="Edit result"
                      >
                        <Pencil className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
                      </button>
                    )}
                  </div>

                  {isEditing ? (
                    /* Edit mode: textarea */
                    <div className="space-y-2">
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        className="w-full rounded-lg p-3 text-sm font-mono outline-none resize-y"
                        style={{
                          background: "var(--card)",
                          border: "1px solid var(--border)",
                          color: "var(--foreground)",
                          minHeight: "200px",
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            saveEdit();
                          }}
                          disabled={isSavingEdit}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors disabled:opacity-50"
                          style={{ background: "var(--foreground)", color: "var(--background)" }}
                        >
                          {isSavingEdit ? "Saving..." : "Save"}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelEdit();
                          }}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-black/5"
                          style={{ color: "var(--muted)" }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Rendered markdown view */
                    <div
                      className="rounded-lg p-3 text-sm relative"
                      style={{
                        background: "rgba(0,0,0,0.02)",
                        border: "1px solid var(--border)",
                        ...(isRefining ? { opacity: 0.5 } : {}),
                      }}
                    >
                      {isRefining && (
                        <div className="absolute inset-0 flex items-center justify-center rounded-lg" style={{ background: "rgba(248,247,244,0.6)" }}>
                          <p className="text-xs font-medium animate-pulse" style={{ color: "var(--muted)" }}>Refining...</p>
                        </div>
                      )}
                      <div className="prose prose-sm max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_pre]:my-2 [&_pre]:rounded-lg [&_pre]:bg-black/5 [&_pre]:p-3 [&_code]:text-xs [&_code]:bg-black/5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre_code]:bg-transparent [&_pre_code]:p-0">
                        <ReactMarkdown>{task.result}</ReactMarkdown>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Error message */}
              {isFailed && task.error_message && (
                <div
                  className="rounded-lg p-3 text-sm flex items-start gap-2"
                  style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c" }}
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  {task.error_message}
                </div>
              )}

              {/* Tools used */}
              {task.tools_used.length > 0 && (
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    Tools:
                  </span>
                  {task.tools_used.map((tool) => {
                    const { logo, label, color } = getToolLogo(tool);
                    return (
                      <span
                        key={tool}
                        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] font-medium"
                        style={{
                          background: "rgba(0,0,0,0.04)",
                          boxShadow: "0 0 0 1px rgba(0,0,0,0.06)",
                          color: "var(--foreground)",
                        }}
                      >
                        <span
                          className="w-5 h-5 rounded-full relative shrink-0 flex items-center justify-center"
                          style={{
                            background: `radial-gradient(circle at 35% 35%, ${color}dd, ${color}88 40%, rgba(0,0,0,0.3) 100%)`,
                            boxShadow: `
                              inset 0 -2px 4px rgba(0,0,0,0.25),
                              inset 0 2px 4px rgba(255,255,255,0.4),
                              0 1px 4px rgba(0,0,0,0.15)
                            `,
                          }}
                        >
                          <img src={logo} alt={label} className="w-3 h-3" style={{ position: "relative", zIndex: 1 }} />
                        </span>
                        {label}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* Timestamps + recurring info + delivery status */}
              <div className="text-xs space-y-0.5" style={{ color: "var(--muted)" }}>
                <p>Created: {formatDate(task.created_at)}</p>
                {isCompleted && <p>Completed: {formatDate(task.updated_at)}</p>}
                {task.is_recurring && task.frequency && (
                  <p>
                    Recurring: {task.frequency}
                    {task.streak > 0 && ` \u00B7 ${task.streak} streak`}
                  </p>
                )}
                {task.is_recurring && task.last_delivery_status && (
                  <p>
                    Telegram:{" "}
                    {task.last_delivery_status === "delivered" ? (
                      <span style={{ color: "#16a34a" }}>Delivered</span>
                    ) : task.last_delivery_status === "delivery_failed" ? (
                      <span style={{ color: "#ef4444" }}>Delivery failed</span>
                    ) : (
                      <span>Not connected</span>
                    )}
                  </p>
                )}
              </div>

              {/* Action buttons — hidden during edit mode */}
              {!isEditing && (
                <div className="flex items-center gap-3 pt-1">
                  {/* Run now (recurring) or Re-run (non-recurring) */}
                  {task.is_recurring && (isActive || isFailed) ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onTrigger();
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-black/5"
                      style={{ border: "1px solid var(--border)", color: "var(--foreground)" }}
                    >
                      <Play className="w-3 h-3" />
                      Run now
                    </button>
                  ) : isPaused ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onResume();
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-green-50"
                      style={{ border: "1px solid var(--border)", color: "#16a34a" }}
                    >
                      <Play className="w-3 h-3" />
                      Resume
                    </button>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRerun();
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-black/5"
                      style={{ border: "1px solid var(--border)", color: "var(--foreground)" }}
                    >
                      <RotateCw className="w-3 h-3" />
                      Re-run
                    </button>
                  )}
                  {/* Pause button for active recurring tasks */}
                  {isActive && task.is_recurring && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPause();
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-black/5"
                      style={{ border: "1px solid var(--border)", color: "var(--muted)" }}
                    >
                      <Pause className="w-3 h-3" />
                      Pause
                    </button>
                  )}
                  {task.result && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openRefine();
                      }}
                      disabled={isRefining}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-black/5 disabled:opacity-50"
                      style={{ border: "1px solid var(--border)", color: "var(--foreground)" }}
                    >
                      <Sparkles className="w-3 h-3" />
                      Refine
                    </button>
                  )}
                  {!confirmDelete ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(true);
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-red-50 ml-auto"
                      style={{ color: "#ef4444" }}
                    >
                      <Trash2 className="w-3 h-3" />
                      Delete
                    </button>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete();
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer ml-auto"
                      style={{ background: "#ef4444", color: "#ffffff" }}
                    >
                      Confirm delete
                    </button>
                  )}
                </div>
              )}

              {/* Refine input — slides open below action buttons */}
              <AnimatePresence>
                {showRefine && !isEditing && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="overflow-hidden"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="space-y-2">
                      <div
                        className="rounded-lg p-2 flex items-center gap-2"
                        style={{ background: "var(--card)", border: "1px solid var(--border)" }}
                      >
                        <input
                          ref={refineRef}
                          type="text"
                          value={refineInput}
                          onChange={(e) => setRefineInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              submitRefine();
                            }
                            if (e.key === "Escape") {
                              setShowRefine(false);
                              setRefineInput("");
                            }
                          }}
                          placeholder="Tell your agent what to change..."
                          className="flex-1 bg-transparent text-sm outline-none"
                          style={{ color: "var(--foreground)" }}
                          disabled={isRefining}
                        />
                        <button
                          onClick={submitRefine}
                          disabled={isRefining || !refineInput.trim()}
                          className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-opacity hover:opacity-80 disabled:opacity-40"
                          style={{ background: "var(--accent)" }}
                        >
                          <Send className="w-3.5 h-3.5" style={{ color: "#ffffff" }} />
                        </button>
                        <button
                          onClick={() => {
                            setShowRefine(false);
                            setRefineInput("");
                          }}
                          className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-opacity hover:opacity-80"
                          style={{ color: "var(--muted)" }}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <p className="text-[11px]" style={{ color: "var(--muted)" }}>
                        e.g., &ldquo;Add a Solana section&rdquo; or &ldquo;Make it shorter&rdquo; or &ldquo;Focus more on DeFi&rdquo;
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── useTaskPolling Hook ────────────────────────────────── */

function useTaskPolling(
  taskIds: string[],
  onUpdate: (task: TaskItem) => void
) {
  const intervalRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const startTimesRef = useRef<Record<string, number>>({});

  const startPolling = useCallback(
    (taskId: string) => {
      // Don't double-poll
      if (intervalRef.current[taskId]) return;

      startTimesRef.current[taskId] = Date.now();

      intervalRef.current[taskId] = setInterval(async () => {
        // Safety timeout: stop after 2 minutes
        if (Date.now() - startTimesRef.current[taskId] > 120_000) {
          clearInterval(intervalRef.current[taskId]);
          delete intervalRef.current[taskId];
          return;
        }

        try {
          const res = await fetch(`/api/tasks/${taskId}`);
          if (!res.ok) return;
          const data = await res.json();
          const task = data.task as TaskItem;
          onUpdate(task);

          // Stop polling when task finishes (completed/failed) or
          // recurring task gets a new result (stays "active" but result updated)
          if (
            task.status === "completed" ||
            task.status === "failed" ||
            (task.status === "active" && task.result && !task.processing_started_at)
          ) {
            clearInterval(intervalRef.current[taskId]);
            delete intervalRef.current[taskId];
          }
        } catch {
          // Non-fatal
        }
      }, 3000);
    },
    [onUpdate]
  );

  const stopPolling = useCallback((taskId: string) => {
    if (intervalRef.current[taskId]) {
      clearInterval(intervalRef.current[taskId]);
      delete intervalRef.current[taskId];
    }
  }, []);

  // Start polling for all provided IDs
  useEffect(() => {
    for (const id of taskIds) {
      startPolling(id);
    }
    // Cleanup
    return () => {
      for (const id of Object.keys(intervalRef.current)) {
        clearInterval(intervalRef.current[id]);
      }
      intervalRef.current = {};
    };
  }, [taskIds, startPolling]);

  return { startPolling, stopPolling };
}

/* ─── Page ────────────────────────────────────────────────── */

export default function CommandCenterPage() {
  const [activeTab, setActiveTab] = useState<Tab>("tasks");
  const [filter, setFilter] = useState<FilterOption>("all");

  // Task state
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [isLoadingTasks, setIsLoadingTasks] = useState(true);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [pollingIds, setPollingIds] = useState<string[]>([]);
  const [failedCount, setFailedCount] = useState(0);

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isLoadingChat, setIsLoadingChat] = useState(true);
  const [chatError, setChatError] = useState<string | null>(null);
  const [savedMessageIds, setSavedMessageIds] = useState<Set<string>>(new Set());
  const [chatToast, setChatToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Model state
  const [currentModel, setCurrentModel] = useState("claude-sonnet-4-5-20250929");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [updatingModel, setUpdatingModel] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  const tabs: { key: Tab; label: string; tourKey: string }[] = [
    { key: "tasks", label: "Tasks", tourKey: "tab-tasks" },
    { key: "chat", label: "Chat", tourKey: "tab-chat" },
    { key: "library", label: "Library", tourKey: "tab-library" },
  ];

  // Scroll to bottom of chat
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  // ─── Fetch tasks ───────────────────────────────────────

  const fetchTasks = useCallback(async (statusFilter?: string) => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      params.set("limit", "100");
      const res = await fetch(`/api/tasks/list?${params}`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setTasks(data.tasks ?? []);
    } catch {
      setTaskError("Failed to load tasks");
    } finally {
      setIsLoadingTasks(false);
    }
  }, []);

  // Fetch failed count (for badge on "All" pill)
  const fetchFailedCount = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/list?status=failed&limit=1");
      if (res.ok) {
        const data = await res.json();
        setFailedCount(data.total ?? 0);
      }
    } catch {
      // Non-fatal
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchTasks(filterToStatus(filter));
    fetchFailedCount();
  }, [filter, fetchTasks, fetchFailedCount]);

  // Listen for onboarding wizard prefill events
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail;
      if (typeof text === "string" && text.trim()) {
        setChatInput(text);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener("instaclaw:prefill-input", handler);
    return () => window.removeEventListener("instaclaw:prefill-input", handler);
  }, []);

  // Fetch current model from VM status
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/vm/status");
        if (res.ok) {
          const data = await res.json();
          if (data.model) setCurrentModel(data.model);
        }
      } catch {
        // Non-fatal
      }
    })();
  }, []);

  // Close model picker on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    }
    if (showModelPicker) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showModelPicker]);

  async function handleModelChange(newModel: string) {
    setUpdatingModel(true);
    setShowModelPicker(false);
    const prev = currentModel;
    setCurrentModel(newModel);
    try {
      const res = await fetch("/api/vm/update-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: newModel }),
      });
      if (!res.ok) setCurrentModel(prev);
    } catch {
      setCurrentModel(prev);
    } finally {
      setUpdatingModel(false);
    }
  }

  // ─── Task polling ─────────────────────────────────────

  const handleTaskUpdate = useCallback((updated: TaskItem) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === updated.id ? updated : t))
    );
    // If task finished, remove from polling and refresh failed count
    if (updated.status === "completed" || updated.status === "failed") {
      setPollingIds((prev) => prev.filter((id) => id !== updated.id));
      if (updated.status === "failed") {
        setFailedCount((prev) => prev + 1);
      }
    }
  }, []);

  useTaskPolling(pollingIds, handleTaskUpdate);

  // ─── Create task ──────────────────────────────────────

  const createTask = useCallback(
    async (text: string) => {
      if (!text.trim()) return;
      setTaskError(null);

      // Optimistic: add a processing card at the top
      const optimisticId = "optimistic-" + Date.now();
      const optimistic: TaskItem = {
        id: optimisticId,
        user_id: "",
        title: "Processing...",
        description: text.trim(),
        status: "in_progress",
        is_recurring: false,
        frequency: null,
        streak: 0,
        last_run_at: null,
        next_run_at: null,
        result: null,
        error_message: null,
        tools_used: [],
        consecutive_failures: 0,
        processing_started_at: null,
        last_delivery_status: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setTasks((prev) => [optimistic, ...prev]);

      try {
        const res = await fetch("/api/tasks/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text.trim() }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || "Failed to create task");
        }

        const data = await res.json();
        const realTask = data.task as TaskItem;

        // Replace optimistic with real task
        setTasks((prev) =>
          prev.map((t) => (t.id === optimisticId ? realTask : t))
        );

        // Start polling for this task
        setPollingIds((prev) => [...prev, realTask.id]);
      } catch (err) {
        // Remove optimistic card
        setTasks((prev) => prev.filter((t) => t.id !== optimisticId));
        setTaskError(
          err instanceof Error ? err.message : "Failed to create task"
        );
      }
    },
    []
  );

  // ─── Toggle task complete ─────────────────────────────

  const toggleComplete = useCallback(async (task: TaskItem) => {
    const newStatus = task.status === "completed" ? "queued" : "completed";
    // Optimistic update
    setTasks((prev) =>
      prev.map((t) =>
        t.id === task.id ? { ...t, status: newStatus as TaskStatus } : t
      )
    );

    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) {
        // Revert on failure
        setTasks((prev) =>
          prev.map((t) => (t.id === task.id ? task : t))
        );
      }
    } catch {
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? task : t))
      );
    }
  }, []);

  // ─── Delete task ──────────────────────────────────────

  const deleteTask = useCallback(async (taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    setExpandedTaskId(null);

    try {
      await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
    } catch {
      // Already removed from UI — re-fetch to sync
      fetchTasks(filterToStatus(filter));
    }
  }, [fetchTasks, filter]);

  // ─── Rerun task ───────────────────────────────────────

  const rerunTask = useCallback(async (taskId: string) => {
    // Optimistic: set to processing
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? { ...t, status: "in_progress" as TaskStatus, title: "Processing...", result: null, error_message: null }
          : t
      )
    );

    try {
      const res = await fetch(`/api/tasks/${taskId}/rerun`, { method: "POST" });
      if (res.ok) {
        setPollingIds((prev) => [...prev, taskId]);
      }
    } catch {
      // Re-fetch to get true state
      fetchTasks(filterToStatus(filter));
    }
  }, [fetchTasks, filter]);

  // ─── Trigger recurring task (run now) ────────────────

  const triggerTask = useCallback(async (taskId: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? { ...t, result: null, error_message: null }
          : t
      )
    );
    setPollingIds((prev) => [...prev, taskId]);

    try {
      await fetch(`/api/tasks/${taskId}/trigger`, { method: "POST" });
    } catch {
      fetchTasks(filterToStatus(filter));
    }
  }, [fetchTasks, filter]);

  // ─── Pause recurring task ───────────────────────────

  const pauseTask = useCallback(async (task: TaskItem) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === task.id ? { ...t, status: "paused" as TaskStatus } : t
      )
    );
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "paused" }),
      });
      if (!res.ok) {
        setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
      }
    } catch {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
    }
  }, []);

  // ─── Resume recurring task ──────────────────────────

  const resumeTask = useCallback(async (task: TaskItem) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === task.id ? { ...t, status: "active" as TaskStatus } : t
      )
    );
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      if (res.ok) {
        const data = await res.json();
        setTasks((prev) =>
          prev.map((t) => (t.id === task.id ? data.task : t))
        );
      } else {
        setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
      }
    } catch {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
    }
  }, []);

  // ─── Fetch chat history on mount ──────────────────────

  useEffect(() => {
    async function loadHistory() {
      try {
        const res = await fetch("/api/chat/history");
        if (res.ok) {
          const data = await res.json();
          setChatMessages(data.messages ?? []);
        }
      } catch {
        // Non-fatal — start with empty chat
      } finally {
        setIsLoadingChat(false);
      }
    }
    async function loadSavedMsgIds() {
      try {
        const res = await fetch("/api/library/saved-messages");
        if (res.ok) {
          const data = await res.json();
          setSavedMessageIds(new Set(data.ids ?? []));
        }
      } catch {
        // Non-fatal
      }
    }
    loadHistory();
    loadSavedMsgIds();
  }, []);

  // Auto-scroll when messages change or tab switches to chat
  useEffect(() => {
    if (activeTab === "chat") {
      scrollToBottom();
    }
  }, [chatMessages, activeTab, scrollToBottom]);

  // ─── Send chat message ────────────────────────────────

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isSending) return;
      const userMsg: ChatMsg = {
        role: "user",
        content: text.trim(),
        created_at: new Date().toISOString(),
      };

      setChatMessages((prev) => [...prev, userMsg]);
      setChatInput("");
      setIsSending(true);
      setChatError(null);

      const streamingId = "streaming-" + Date.now();
      setChatMessages((prev) => [
        ...prev,
        { id: streamingId, role: "assistant", content: "", isStreaming: true },
      ]);

      try {
        const res = await fetch("/api/chat/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text.trim() }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(
            err.error || "Your agent is currently offline. Check your dashboard for status."
          );
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response stream");

        await readSseStream(
          reader,
          (delta) => {
            setChatMessages((prev) =>
              prev.map((m) =>
                m.id === streamingId
                  ? { ...m, content: m.content + delta }
                  : m
              )
            );
          },
          () => {
            setChatMessages((prev) =>
              prev.map((m) =>
                m.id === streamingId
                  ? {
                      ...m,
                      isStreaming: false,
                      created_at: new Date().toISOString(),
                      id: undefined,
                    }
                  : m
              )
            );
          },
          (err) => {
            setChatError(err);
            setChatMessages((prev) =>
              prev.filter((m) => m.id !== streamingId)
            );
          }
        );
      } catch (err) {
        const errorMsg =
          err instanceof Error
            ? err.message
            : "Your agent is currently offline. Check your dashboard for status.";
        setChatError(errorMsg);
        setChatMessages((prev) =>
          prev.filter((m) => m.id !== streamingId)
        );
      } finally {
        setIsSending(false);
      }
    },
    [isSending]
  );

  // ─── Save chat message to library ──────────────────

  const saveChatToLibrary = useCallback(async (msg: ChatMsg) => {
    if (!msg.id && !msg.created_at) return;
    const msgId = msg.id || msg.created_at || "";
    if (savedMessageIds.has(msgId)) {
      setChatToast("Already in your Library");
      setTimeout(() => setChatToast(null), 2000);
      return;
    }
    try {
      const res = await fetch("/api/library/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: msg.content,
          source_chat_message_id: msgId,
        }),
      });
      if (res.status === 409) {
        setSavedMessageIds((prev) => new Set(prev).add(msgId));
        setChatToast("Already in your Library");
      } else if (res.ok) {
        setSavedMessageIds((prev) => new Set(prev).add(msgId));
        setChatToast("Saved to Library");
      }
    } catch {
      // Non-fatal
    }
    setTimeout(() => setChatToast(null), 2000);
  }, [savedMessageIds]);

  // ─── Handle input submit ─────────────────────────────

  const handleSubmit = useCallback(() => {
    if (!chatInput.trim()) return;

    if (activeTab === "tasks") {
      // Tasks tab: create a task
      createTask(chatInput);
      setChatInput("");
    } else if (activeTab === "chat") {
      // Chat tab: send message
      sendMessage(chatInput);
    }
  }, [chatInput, activeTab, createTask, sendMessage]);

  // ─── Handle chip click ────────────────────────────────

  const handleChipClick = useCallback(
    (prefill: string) => {
      if (activeTab === "chat") {
        // Chat tab: same behavior as before
        if (prefill.endsWith("?") || !prefill.endsWith(" ")) {
          sendMessage(prefill);
        } else {
          setChatInput(prefill);
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      } else {
        // Tasks tab: create a task or prefill input
        if (prefill.endsWith(" ")) {
          setChatInput(prefill);
          requestAnimationFrame(() => inputRef.current?.focus());
        } else {
          createTask(prefill);
        }
      }
    },
    [activeTab, sendMessage, createTask]
  );

  return (
    <div className="flex flex-col h-[calc(100dvh-9.5rem)] sm:h-[calc(100dvh-11.5rem)]">
      {/* ── Static header (never scrolls) ───────────────────── */}
      <div className="shrink-0">
        <h1
          className="text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Command Center
        </h1>
        <p className="text-base mt-2" style={{ color: "var(--muted)" }}>
          Your agent works around the clock. Here&apos;s everything
          it&apos;s handling.
        </p>

        <div className="mt-4">
          <FilterPills
            active={filter}
            onChange={setFilter}
            visible={activeTab === "tasks"}
            failedCount={failedCount}
          />
        </div>

        <div
          className="flex items-center gap-6 border-b mt-4"
          style={{ borderColor: "var(--border)" }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              data-tour={tab.tourKey}
              onClick={() => setActiveTab(tab.key)}
              className="relative pb-3 text-sm font-medium transition-colors cursor-pointer"
              style={{
                color:
                  activeTab === tab.key ? "var(--foreground)" : "var(--muted)",
              }}
            >
              {tab.label}
              {activeTab === tab.key && (
                <motion.div
                  layoutId="command-center-tab"
                  className="absolute bottom-0 left-0 right-0 h-[2px]"
                  style={{ background: "var(--foreground)" }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Scrollable content area ─────────────────────────── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 pt-6 pb-2">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
          >
            {activeTab === "tasks" && (
              <div>
                {/* Task error banner */}
                {taskError && (
                  <div
                    className="mb-4 rounded-xl px-4 py-3 text-sm flex items-center justify-between"
                    style={{
                      background: "#fef2f2",
                      border: "1px solid #fecaca",
                      color: "#b91c1c",
                    }}
                  >
                    <span>{taskError}</span>
                    <button
                      onClick={() => setTaskError(null)}
                      className="ml-3 text-xs font-medium cursor-pointer hover:underline"
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {isLoadingTasks ? (
                  <TasksSkeleton />
                ) : tasks.length === 0 ? (
                  <TasksEmptyState />
                ) : (
                  <div className="space-y-4">
                    {tasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        isExpanded={expandedTaskId === task.id}
                        onToggleExpand={() =>
                          setExpandedTaskId(
                            expandedTaskId === task.id ? null : task.id
                          )
                        }
                        onToggleComplete={() => toggleComplete(task)}
                        onDelete={() => deleteTask(task.id)}
                        onRerun={() => rerunTask(task.id)}
                        onTrigger={() => triggerTask(task.id)}
                        onPause={() => pauseTask(task)}
                        onResume={() => resumeTask(task)}
                        onTaskUpdated={(updated) =>
                          setTasks((prev) =>
                            prev.map((t) => (t.id === updated.id ? updated : t))
                          )
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === "chat" && (
              <div>
                {isLoadingChat ? (
                  <ChatSkeleton />
                ) : chatMessages.length === 0 && !isSending ? (
                  <ChatEmptyState onChipClick={handleChipClick} />
                ) : (
                  <div className="space-y-4">
                    {chatMessages.map((msg, i) => (
                      <ChatBubble
                        key={msg.id || `msg-${i}`}
                        msg={msg}
                        isSaved={savedMessageIds.has(msg.id || msg.created_at || "")}
                        onSave={msg.role === "assistant" ? () => saveChatToLibrary(msg) : undefined}
                      />
                    ))}
                    {isSending &&
                      !chatMessages.some((m) => m.isStreaming) && (
                        <TypingIndicator />
                      )}
                  </div>
                )}

                {/* Error banner */}
                {chatError && (
                  <div
                    className="mt-4 rounded-xl px-4 py-3 text-sm flex items-center justify-between"
                    style={{
                      background: "#fef2f2",
                      border: "1px solid #fecaca",
                      color: "#b91c1c",
                    }}
                  >
                    <span>{chatError}</span>
                    <button
                      onClick={() => setChatError(null)}
                      className="ml-3 text-xs font-medium cursor-pointer hover:underline"
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {/* Chat toast */}
                <AnimatePresence>
                  {chatToast && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 8 }}
                      className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg text-xs font-medium"
                      style={{ background: "var(--foreground)", color: "var(--background)" }}
                    >
                      {chatToast}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}

            {activeTab === "library" && <LibraryContent onSwitchToTasks={() => setActiveTab("tasks")} />}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Sticky input (pinned below scroll area) ─────────── */}
      {activeTab === "tasks" && (
        <div
          className="shrink-0 -mx-4 px-4 pt-4"
          data-tour="input-bar"
          style={{
            background: "linear-gradient(to top, #f8f7f4 80%, transparent)",
            paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
          }}
        >
          <div
            className="rounded-2xl px-5 py-3.5 flex items-center gap-3"
            style={{
              background: "rgba(255,255,255,0.8)",
              backdropFilter: "blur(12px)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 0 0 1px rgba(0,0,0,0.04)",
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="Tell your agent what to do next..."
              className="flex-1 bg-transparent text-sm outline-none"
              style={{ color: "var(--foreground)" }}
            />
            <div className="flex items-center gap-1.5 shrink-0">
              <div className="relative" ref={modelPickerRef}>
                <button
                  onClick={() => setShowModelPicker(!showModelPicker)}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs cursor-pointer transition-colors hover:opacity-70"
                  style={{ color: "var(--muted)" }}
                >
                  <span>{MODEL_OPTIONS.find((m) => m.id === currentModel)?.label ?? "Sonnet 4.5"}</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showModelPicker && (
                  <div
                    className="absolute bottom-full right-0 mb-1.5 rounded-xl py-1.5 min-w-[160px] z-50"
                    style={{
                      background: "var(--card)",
                      border: "1px solid var(--border)",
                      boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
                    }}
                  >
                    {MODEL_OPTIONS.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => handleModelChange(m.id)}
                        className="w-full text-left px-3.5 py-2 text-xs cursor-pointer transition-colors flex items-center justify-between"
                        style={{
                          color: m.id === currentModel ? "var(--accent)" : "var(--foreground)",
                          background: m.id === currentModel ? "rgba(220,103,67,0.08)" : "transparent",
                        }}
                        onMouseEnter={(e) => {
                          if (m.id !== currentModel) e.currentTarget.style.background = "rgba(0,0,0,0.04)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = m.id === currentModel ? "rgba(220,103,67,0.08)" : "transparent";
                        }}
                      >
                        {m.label}
                        {m.id === currentModel && <Check className="w-3.5 h-3.5" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={handleSubmit}
                disabled={!chatInput.trim()}
                className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 cursor-pointer transition-all hover:opacity-80 disabled:opacity-30 disabled:scale-95"
                style={{ background: chatInput.trim() ? "var(--accent)" : "var(--accent)" }}
              >
                <ArrowUp className="w-4 h-4" style={{ color: "#ffffff" }} strokeWidth={2.5} />
              </button>
            </div>
          </div>
          <div
            data-tour="quick-chips"
            className="flex gap-1.5 overflow-x-auto pb-1 mt-2.5 px-1"
            style={{ scrollbarWidth: "none" }}
          >
            {quickActions.map((action) => (
              <button
                key={action.label}
                onClick={() => handleChipClick(action.prefill)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs whitespace-nowrap cursor-pointer transition-all hover:opacity-70"
                style={{
                  background: "rgba(0,0,0,0.04)",
                  color: "var(--muted)",
                }}
              >
                <span>{action.icon}</span>
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {activeTab === "chat" && (
        <div
          className="shrink-0 -mx-4 px-4 pt-3"
          style={{
            background: "#f8f7f4",
            boxShadow: "0 -4px 12px rgba(0,0,0,0.04)",
            paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
          }}
        >
          <div
            className="rounded-2xl p-3 flex items-center gap-3"
            style={{ background: "var(--card)", border: "1px solid var(--border)" }}
          >
            <input
              ref={activeTab === "chat" ? inputRef : undefined}
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
              placeholder="Message your agent..."
              className="flex-1 bg-transparent text-sm outline-none"
              style={{ color: "var(--foreground)" }}
              disabled={isSending}
            />
            <div className="flex items-center gap-1.5 shrink-0">
              <div className="relative" ref={activeTab === "chat" ? modelPickerRef : undefined}>
                <button
                  onClick={() => setShowModelPicker(!showModelPicker)}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs cursor-pointer transition-colors hover:opacity-70"
                  style={{ color: "var(--muted)" }}
                >
                  <span>{MODEL_OPTIONS.find((m) => m.id === currentModel)?.label ?? "Sonnet 4.5"}</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
                {showModelPicker && (
                  <div
                    className="absolute bottom-full right-0 mb-1.5 rounded-xl py-1.5 min-w-[160px] z-50"
                    style={{
                      background: "var(--card)",
                      border: "1px solid var(--border)",
                      boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
                    }}
                  >
                    {MODEL_OPTIONS.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => handleModelChange(m.id)}
                        className="w-full text-left px-3.5 py-2 text-xs cursor-pointer transition-colors flex items-center justify-between"
                        style={{
                          color: m.id === currentModel ? "var(--accent)" : "var(--foreground)",
                          background: m.id === currentModel ? "rgba(220,103,67,0.08)" : "transparent",
                        }}
                        onMouseEnter={(e) => {
                          if (m.id !== currentModel) e.currentTarget.style.background = "rgba(0,0,0,0.04)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = m.id === currentModel ? "rgba(220,103,67,0.08)" : "transparent";
                        }}
                      >
                        {m.label}
                        {m.id === currentModel && <Check className="w-3.5 h-3.5" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={handleSubmit}
                disabled={isSending || !chatInput.trim()}
                className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 cursor-pointer transition-all hover:opacity-80 disabled:opacity-30 disabled:scale-95"
                style={{ background: "var(--accent)" }}
              >
                <ArrowUp className="w-4 h-4" style={{ color: "#ffffff" }} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Library Content ────────────────────────────────────── */

function LibraryContent({ onSwitchToTasks }: { onSwitchToTasks: () => void }) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortField, setSortField] = useState("created_at");
  const [sortOrder, setSortOrder] = useState("desc");
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [editTitleDraft, setEditTitleDraft] = useState("");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }

  // Debounced search
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [searchQuery]);

  // Fetch items
  const fetchItems = useCallback(
    async (append = false, offset = 0) => {
      try {
        const params = new URLSearchParams();
        if (typeFilter !== "all") params.set("type", typeFilter);
        if (debouncedSearch) params.set("search", debouncedSearch);
        params.set("sort", sortField);
        params.set("order", sortOrder);
        params.set("limit", "20");
        params.set("offset", String(offset));
        const res = await fetch(`/api/library/list?${params}`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (append) {
          setItems((prev) => [...prev, ...(data.items ?? [])]);
        } else {
          setItems(data.items ?? []);
        }
        setTotal(data.total ?? 0);
        setHasMore(data.hasMore ?? false);
      } catch {
        // Non-fatal
      } finally {
        setIsLoading(false);
      }
    },
    [typeFilter, debouncedSearch, sortField, sortOrder]
  );

  useEffect(() => {
    setIsLoading(true);
    fetchItems();
  }, [fetchItems]);

  // Pin / unpin
  async function togglePin(item: LibraryItem) {
    const newPinned = !item.is_pinned;
    setItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, is_pinned: newPinned } : i))
    );
    try {
      await fetch(`/api/library/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ is_pinned: newPinned }),
      });
      showToast(newPinned ? "Pinned" : "Unpinned");
      fetchItems(); // Re-fetch to get correct sort order
    } catch {
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, is_pinned: !newPinned } : i))
      );
    }
  }

  // Copy to clipboard
  async function copyContent(item: LibraryItem) {
    try {
      await navigator.clipboard.writeText(item.content);
      showToast("Copied to clipboard");
    } catch {
      showToast("Failed to copy");
    }
  }

  // Export as .md
  function exportItem(item: LibraryItem) {
    window.open(`/api/library/export/${item.id}`, "_blank");
    showToast(`Downloaded ${item.title.slice(0, 30)}.md`);
  }

  // Delete
  async function deleteItem(itemId: string) {
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    setExpandedId(null);
    showToast("Deleted");
    try {
      await fetch(`/api/library/${itemId}`, { method: "DELETE" });
    } catch {
      fetchItems();
    }
  }

  // Inline title edit
  async function saveTitle(itemId: string) {
    if (!editTitleDraft.trim()) {
      setEditingTitle(null);
      return;
    }
    setItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, title: editTitleDraft.trim() } : i))
    );
    setEditingTitle(null);
    try {
      await fetch(`/api/library/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: editTitleDraft.trim() }),
      });
      showToast("Saved");
    } catch {
      fetchItems();
    }
  }

  return (
    <div className="space-y-4 relative">
      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="fixed top-20 right-4 z-50 px-4 py-2 rounded-lg text-xs font-medium"
            style={{ background: "var(--foreground)", color: "var(--background)" }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Search bar */}
      <div
        className="rounded-xl px-4 py-3 flex items-center gap-3"
        style={{ background: "var(--card)", border: "1px solid var(--border)" }}
      >
        <Search className="w-4 h-4 shrink-0" style={{ color: "var(--muted)" }} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search your library..."
          className="flex-1 bg-transparent text-sm outline-none"
          style={{ color: "var(--foreground)" }}
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            className="p-0.5 cursor-pointer"
            style={{ color: "var(--muted)" }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Type filters + sort */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1.5 flex-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          {libraryTypeFilters.map((f) => (
            <button
              key={f.key}
              onClick={() => setTypeFilter(f.key)}
              className="px-2.5 py-1 rounded-full text-xs font-medium cursor-pointer whitespace-nowrap transition-colors"
              style={{
                background: typeFilter === f.key ? "#2d2d2d" : "transparent",
                color: typeFilter === f.key ? "#ffffff" : "var(--muted)",
                border: `1px solid ${typeFilter === f.key ? "#2d2d2d" : "var(--border)"}`,
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          value={`${sortField}-${sortOrder}`}
          onChange={(e) => {
            const [f, o] = e.target.value.split("-");
            setSortField(f);
            setSortOrder(o);
          }}
          className="text-xs rounded-lg px-2 py-1 outline-none cursor-pointer"
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            color: "var(--muted)",
          }}
        >
          <option value="created_at-desc">Newest first</option>
          <option value="created_at-asc">Oldest first</option>
          <option value="title-asc">A-Z</option>
          <option value="title-desc">Z-A</option>
        </select>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 animate-pulse">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="rounded-xl p-5"
              style={{ border: "1px solid var(--border)", opacity: 0.5 }}
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full" style={{ background: "var(--border)" }} />
                <div className="flex-1 space-y-2">
                  <div className="h-4 rounded" style={{ background: "var(--border)", width: "70%" }} />
                  <div className="h-3 rounded" style={{ background: "var(--border)", width: "40%" }} />
                </div>
              </div>
              <div className="h-3 rounded mt-3" style={{ background: "var(--border)", width: "90%" }} />
              <div className="h-3 rounded mt-1" style={{ background: "var(--border)", width: "60%" }} />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        debouncedSearch ? (
          <div className="text-center py-12">
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              No items matching &ldquo;{debouncedSearch}&rdquo;
            </p>
            <button
              onClick={() => setSearchQuery("")}
              className="mt-2 text-xs font-medium cursor-pointer hover:underline"
              style={{ color: "var(--foreground)" }}
            >
              Clear search
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center text-2xl mb-4"
              style={{ background: "var(--card)", border: "1px solid var(--border)" }}
            >
              {"\u{1F4DA}"}
            </div>
            <h3 className="text-lg font-normal mb-1" style={{ fontFamily: "var(--font-serif)" }}>
              Your library is empty
            </h3>
            <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
              Completed tasks and saved chat messages will appear here automatically.
            </p>
            <button
              onClick={onSwitchToTasks}
              className="px-4 py-2 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:opacity-90"
              style={{ background: "var(--foreground)", color: "var(--background)" }}
            >
              Go to Tasks &rarr;
            </button>
            <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
              Or save something from Chat using the bookmark icon
            </p>
          </div>
        )
      ) : (
        <>
          {total > 0 && (
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {total} item{total !== 1 ? "s" : ""}
              {debouncedSearch && ` matching \u201C${debouncedSearch}\u201D`}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {items.map((item) => {
              const cfg = LIBRARY_TYPE_CONFIG[item.type] || LIBRARY_TYPE_CONFIG.other;
              const isExpanded = expandedId === item.id;
              return (
                <div key={item.id} className={isExpanded ? "sm:col-span-2" : ""}>
                  <div
                    className="glass rounded-xl overflow-hidden cursor-pointer group"
                    style={{
                      border: item.is_pinned
                        ? "1px solid #d4d4d4"
                        : "1px solid var(--border)",
                    }}
                  >
                    {/* Card header */}
                    <div
                      className="p-5"
                      onClick={() => setExpandedId(isExpanded ? null : item.id)}
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className="w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0"
                          style={{ background: cfg.bg }}
                        >
                          {cfg.icon}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p
                            className="font-medium text-base line-clamp-2"
                            style={{ color: "var(--foreground)" }}
                          >
                            {item.title}
                          </p>
                          <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                            {cfg.label} &middot; {timeAgo(item.created_at)}
                          </p>
                        </div>
                        {item.is_pinned && (
                          <Pin className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--muted)" }} />
                        )}
                      </div>
                      {!isExpanded && (
                        <p className="text-sm mt-3 line-clamp-2" style={{ color: "var(--muted)" }}>
                          {item.preview}
                        </p>
                      )}
                      {!isExpanded && item.source_task_id && (
                        <p className="text-[11px] mt-2" style={{ color: "var(--muted)" }}>
                          From task
                        </p>
                      )}
                    </div>

                    {/* Expanded detail */}
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          <div
                            className="px-5 pb-5 pt-0 space-y-3"
                            style={{ borderTop: "1px solid var(--border)" }}
                          >
                            {/* Editable title */}
                            <div className="pt-3">
                              {editingTitle === item.id ? (
                                <input
                                  type="text"
                                  value={editTitleDraft}
                                  onChange={(e) => setEditTitleDraft(e.target.value)}
                                  onBlur={() => saveTitle(item.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") saveTitle(item.id);
                                    if (e.key === "Escape") setEditingTitle(null);
                                  }}
                                  autoFocus
                                  className="w-full font-medium text-lg outline-none bg-transparent"
                                  style={{ color: "var(--foreground)", borderBottom: "1px solid var(--border)" }}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              ) : (
                                <p
                                  className="font-medium text-lg cursor-text hover:opacity-70 transition-opacity"
                                  style={{ color: "var(--foreground)" }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditingTitle(item.id);
                                    setEditTitleDraft(item.title);
                                  }}
                                >
                                  {item.title}
                                </p>
                              )}
                              <div className="flex items-center gap-2 mt-1">
                                <span
                                  className="px-2 py-0.5 rounded-full text-[11px] font-medium"
                                  style={{ background: cfg.bg, color: "#000" }}
                                >
                                  {cfg.label}
                                </span>
                                <span className="text-xs" style={{ color: "var(--muted)" }}>
                                  {formatDate(item.created_at)}
                                </span>
                              </div>
                              {item.source_task_id && (
                                <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
                                  Generated from a task
                                </p>
                              )}
                              {item.source_chat_message_id && (
                                <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
                                  Saved from chat
                                </p>
                              )}
                              {item.run_number > 1 && (
                                <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>
                                  Run #{item.run_number}
                                </p>
                              )}
                            </div>

                            {/* Full content */}
                            <div
                              className="rounded-lg p-3 text-sm"
                              style={{ background: "rgba(0,0,0,0.02)", border: "1px solid var(--border)" }}
                            >
                              <div className="prose prose-sm max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_pre]:my-2 [&_pre]:rounded-lg [&_pre]:bg-black/5 [&_pre]:p-3 [&_code]:text-xs [&_code]:bg-black/5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_a]:text-blue-600 [&_a]:underline">
                                <ReactMarkdown>{item.content}</ReactMarkdown>
                              </div>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-2 flex-wrap pt-1">
                              <button
                                onClick={(e) => { e.stopPropagation(); togglePin(item); }}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-black/5"
                                style={{ border: "1px solid var(--border)", color: "var(--foreground)" }}
                              >
                                <Pin className="w-3 h-3" />
                                {item.is_pinned ? "Unpin" : "Pin"}
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); copyContent(item); }}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-black/5"
                                style={{ border: "1px solid var(--border)", color: "var(--foreground)" }}
                              >
                                <Copy className="w-3 h-3" />
                                Copy
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); exportItem(item); }}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-black/5"
                                style={{ border: "1px solid var(--border)", color: "var(--foreground)" }}
                              >
                                <Download className="w-3 h-3" />
                                Export
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (confirm(`Delete \u201C${item.title}\u201D from your library? This can\u2019t be undone.`)) {
                                    deleteItem(item.id);
                                  }
                                }}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-red-50 ml-auto"
                                style={{ color: "#ef4444" }}
                              >
                                <Trash2 className="w-3 h-3" />
                                Delete
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Load more */}
          {hasMore && (
            <div className="text-center pt-2">
              <button
                onClick={() => fetchItems(true, items.length)}
                className="px-4 py-2 rounded-lg text-xs font-medium cursor-pointer transition-colors hover:bg-black/5"
                style={{ border: "1px solid var(--border)", color: "var(--foreground)" }}
              >
                Load more
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
