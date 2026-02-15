"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ChevronRight,
  ChevronDown,
  Check,
  Send,
  Repeat,
  RotateCw,
  Trash2,
  AlertCircle,
  Pencil,
  Sparkles,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";

/* ─── Types ───────────────────────────────────────────────── */

type Tab = "tasks" | "chat" | "library";

type TaskStatus = "completed" | "in_progress" | "queued" | "failed" | "active";

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
  id: number;
  icon: string;
  title: string;
  type: string;
  date: string;
  preview: string;
}

/* ─── Mock Data (Library — wired up in Phase 3) ────────────── */

const mockLibrary: LibraryItem[] = [
  {
    id: 1,
    icon: "\u{1F4C4}",
    title: "AI Agent Frameworks 2026",
    type: "Research Report",
    date: "Today",
    preview:
      "Comprehensive analysis of 12 agent frameworks. LangChain still leads in adoption but CrewAI and AutoGen are gaining\u2026",
  },
  {
    id: 2,
    icon: "\u2709\uFE0F",
    title: "Investor Follow-Up Drafts",
    type: "Email Drafts (3 versions)",
    date: "Today",
    preview:
      "Version 1: Hey [name], wanted to circle back\u2026 Version 2: Quick update \u2014 we hit $744 MRR this week with 17\u2026",
  },
  {
    id: 3,
    icon: "\u{1F4CA}",
    title: "Weekly Earnings Summary",
    type: "Report",
    date: "Yesterday",
    preview:
      "Total earned: $127 USDC across 8 completed bounties. Reputation score increased from 72 to 78\u2026",
  },
  {
    id: 4,
    icon: "\u{1F4CB}",
    title: "Competitive Landscape",
    type: "Analysis",
    date: "2 days ago",
    preview:
      "4 direct competitors identified. InstaClaw\u2019s key differentiator: dedicated VM per agent vs shared infrastructure\u2026",
  },
  {
    id: 5,
    icon: "\u{1F4DD}",
    title: "X Post Drafts: Product Update",
    type: "Social Media",
    date: "2 days ago",
    preview:
      "3 versions: Thread format, single post, and quote-tweet reply. Thread version performs best based on your engagement\u2026",
  },
  {
    id: 6,
    icon: "\u{1F50D}",
    title: "MCP Server Comparison Matrix",
    type: "Research",
    date: "3 days ago",
    preview:
      "12 MCP servers compared on stability, tool coverage, latency, cost. Top 3: Clawlancer MCP, Browserbase\u2026",
  },
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

/** Map filter option to status query param */
function filterToStatus(filter: FilterOption): string | undefined {
  switch (filter) {
    case "active":
      return "in_progress,active";
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
      return <span className={base} style={{ background: "#16a34a" }} />;
    case "active":
      return (
        <span
          className={`${base} animate-pulse`}
          style={{ background: "#16a34a" }}
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
          className="relative px-3 py-1 rounded-full text-xs font-medium cursor-pointer"
          animate={{
            background: active === f.key ? "#2d2d2d" : "rgba(0,0,0,0)",
            color: active === f.key ? "#ffffff" : "#9ca3af",
            borderColor: active === f.key ? "#2d2d2d" : "var(--border)",
          }}
          transition={{ duration: 0.15 }}
          style={{ border: "1px solid var(--border)" }}
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

function ChatBubble({ msg }: { msg: ChatMsg }) {
  const isUser = msg.role === "user";

  return (
    <div
      className={`flex gap-3 ${isUser ? "justify-end" : "justify-start"}`}
    >
      {!isUser && (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          {"\u{1F99E}"}
        </div>
      )}

      <div className="max-w-[80%] sm:max-w-[70%]">
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
        {msg.created_at && (
          <p
            className={`text-[11px] mt-1.5 ${
              isUser ? "text-right" : "text-left"
            }`}
            style={{ color: "var(--muted)" }}
          >
            {formatTime(msg.created_at)}
          </p>
        )}
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
  onTaskUpdated,
}: {
  task: TaskItem;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onToggleComplete: () => void;
  onDelete: () => void;
  onRerun: () => void;
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

  const streakLabel =
    task.streak === 0
      ? "\u{1F525} New"
      : task.streak > 1
        ? task.frequency?.includes("week")
          ? `\u{1F525} ${task.streak} weeks`
          : `\u{1F525} ${task.streak} days`
        : `\u{1F525} ${task.streak} day`;

  const timingParts: string[] = [];
  if (task.frequency) timingParts.push(task.frequency);
  if (task.is_recurring) timingParts.push(streakLabel);
  if (task.next_run_at) {
    timingParts.push(`Next: ${timeAgo(task.next_run_at)}`);
  } else if (task.last_run_at) {
    timingParts.push(`Last: ${timeAgo(task.last_run_at)} \u2705`);
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
            if (!isProcessing && !isActive) onToggleComplete();
          }}
        >
          {isActive ? (
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center"
              style={{ border: "2px solid #16a34a" }}
            >
              <span
                className="w-3 h-3 rounded-full animate-pulse"
                style={{ background: "#16a34a" }}
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
          {task.is_recurring && timingParts.length > 0 && (
            <p className="text-xs mt-1 pl-4" style={{ color: "var(--muted)" }}>
              {timingParts.join(" \u00B7 ")}
            </p>
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
            <span
              className="px-2 py-0.5 rounded-full text-[10px] font-medium"
              style={{ background: "var(--card)", border: "1px solid var(--border)", color: "var(--muted)" }}
            >
              {task.tools_used.length} tool{task.tools_used.length > 1 ? "s" : ""}
            </span>
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
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs" style={{ color: "var(--muted)" }}>
                    Tools:
                  </span>
                  {task.tools_used.map((tool) => (
                    <span
                      key={tool}
                      className="px-2 py-0.5 rounded-full text-[11px] font-medium"
                      style={{
                        background: "var(--card)",
                        border: "1px solid var(--border)",
                        color: "var(--foreground)",
                      }}
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              )}

              {/* Timestamps + recurring info */}
              <div className="text-xs space-y-0.5" style={{ color: "var(--muted)" }}>
                <p>Created: {formatDate(task.created_at)}</p>
                {isCompleted && <p>Completed: {formatDate(task.updated_at)}</p>}
                {task.is_recurring && task.frequency && (
                  <p>
                    Recurring: {task.frequency}
                    {task.streak > 0 && ` \u00B7 \u{1F525} ${task.streak} streak`}
                  </p>
                )}
              </div>

              {/* Action buttons — hidden during edit mode */}
              {!isEditing && (
                <div className="flex items-center gap-3 pt-1">
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

          if (task.status === "completed" || task.status === "failed") {
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const tabs: { key: Tab; label: string }[] = [
    { key: "tasks", label: "Tasks" },
    { key: "chat", label: "Chat" },
    { key: "library", label: "Library" },
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
    loadHistory();
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
                      <ChatBubble key={msg.id || `msg-${i}`} msg={msg} />
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
              </div>
            )}

            {activeTab === "library" && <LibraryContent />}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* ── Sticky input (pinned below scroll area) ─────────── */}
      {activeTab === "tasks" && (
        <div
          className="shrink-0 -mx-4 px-4 pt-3"
          style={{
            background: "#f8f7f4",
            boxShadow: "0 -4px 12px rgba(0,0,0,0.04)",
            paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
          }}
        >
          <div
            className="rounded-2xl px-5 py-4"
            style={{ background: "var(--card)", border: "1px solid var(--border)" }}
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
              className="w-full bg-transparent text-sm outline-none"
              style={{ color: "var(--foreground)" }}
            />
          </div>
          <div
            className="flex gap-2 overflow-x-auto pb-1 mt-3"
            style={{ scrollbarWidth: "none" }}
          >
            {quickActions.map((action) => (
              <button
                key={action.label}
                onClick={() => handleChipClick(action.prefill)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap cursor-pointer transition-all hover:scale-[1.02]"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  color: "var(--foreground)",
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
            <button
              onClick={handleSubmit}
              disabled={isSending || !chatInput.trim()}
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ background: "var(--accent)" }}
            >
              <Send className="w-4 h-4" style={{ color: "#ffffff" }} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Library Content ────────────────────────────────────── */

function LibraryContent() {
  return (
    <div className="space-y-6">
      <div>
        <h2
          className="text-2xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Library
        </h2>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Everything your agent has created, researched, and saved.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {mockLibrary.map((item) => (
          <div
            key={item.id}
            className="glass rounded-xl p-5 cursor-pointer group"
            style={{ border: "1px solid var(--border)" }}
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl">{item.icon}</span>
              <div className="flex-1 min-w-0">
                <p
                  className="font-medium text-base"
                  style={{ color: "var(--foreground)" }}
                >
                  {item.title}
                </p>
                <p
                  className="text-xs mt-0.5"
                  style={{ color: "var(--muted)" }}
                >
                  {item.type} &mdash; {item.date}
                </p>
              </div>
            </div>
            <p
              className="text-sm mt-3 line-clamp-2"
              style={{ color: "var(--muted)" }}
            >
              {item.preview}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
