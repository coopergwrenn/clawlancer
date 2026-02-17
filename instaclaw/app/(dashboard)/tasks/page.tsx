"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ChevronLeft,
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
  Plus,
  MessageSquare,
  PanelLeft,
} from "lucide-react";
import ReactMarkdown from "react-markdown";

/* ─── Inline Tool Brand Icons ─────────────────────────────── */

function TelegramMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M20 4.5L3 11.5c-.6.3-.6.8.1.9l4.4 1.4 1.7 5.3c.2.5.6.6 1 .3l2.4-2 4.7 3.5c.5.4 1 .2 1.2-.5L21.2 5.6c.2-.8-.3-1.3-1.2-.9l0 0zM9.5 14.2l7.5-5.2c.3-.2.3.1.1.2L10.5 15l-.4 3-1-3.5.4-.3z" fill="currentColor"/>
    </svg>
  );
}

function DiscordMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M19.3 5.3a16.5 16.5 0 0 0-4.1-1.3c-.2.3-.4.8-.5 1.1a15.3 15.3 0 0 0-4.6 0c-.1-.3-.3-.8-.5-1.1a16.5 16.5 0 0 0-4.1 1.3A17 17 0 0 0 2.5 17.7a16.6 16.6 0 0 0 5 2.5c.4-.5.8-1.1 1.1-1.7-.6-.2-1.2-.5-1.8-.8l.4-.3a11.8 11.8 0 0 0 10.1 0l.4.3c-.6.3-1.2.6-1.8.8.3.6.7 1.2 1.1 1.7a16.5 16.5 0 0 0 5-2.5c.5-5.2-.8-9.7-3.5-13.4zM8.7 15c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4zm6.6 0c-1.2 0-2.1-1.1-2.1-2.4s.9-2.4 2.1-2.4 2.2 1.1 2.1 2.4c0 1.3-.9 2.4-2.1 2.4z" fill="#fff"/>
    </svg>
  );
}

function GmailMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M3 6.5V18h4V10l5 4 5-4v8h4V6.5l-2-1.5-7 5.5L5 5 3 6.5z" fill="#fff"/>
    </svg>
  );
}

function BraveMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M19 9.2l-.4-1.3.7-1.1-1.4-.4L17 5h-2.4L12 3.5 9.4 5H7l-.9 1.4-1.4.4.7 1.1L5 9.2s1.1 4.5 1.5 5.3c.4.8 1 1.7 1.7 2.3L12 19.5l3.8-2.7c.7-.6 1.3-1.5 1.7-2.3.4-.8 1.5-5.3 1.5-5.3zM14.5 14l-2.5 1.8L9.5 14l-.8-2 1.5-1.2h3.6l1.5 1.2-.8 2z" fill="#fff"/>
    </svg>
  );
}

function SearchMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="10.5" cy="10.5" r="6" stroke="#fff" strokeWidth="2.5"/>
      <line x1="15" y1="15" x2="20.5" y2="20.5" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

function CodeMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M9 6l-5 6 5 6" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M15 6l5 6-5 6" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function CalendarMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="16" rx="2" stroke="#fff" strokeWidth="2"/>
      <line x1="3" y1="10" x2="21" y2="10" stroke="#fff" strokeWidth="2"/>
      <line x1="8" y1="3" x2="8" y2="7" stroke="#fff" strokeWidth="2" strokeLinecap="round"/>
      <line x1="16" y1="3" x2="16" y2="7" stroke="#fff" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

function DatabaseMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <ellipse cx="12" cy="6" rx="8" ry="3" stroke="#fff" strokeWidth="2"/>
      <path d="M4 6v5c0 1.7 3.6 3 8 3s8-1.3 8-3V6" stroke="#fff" strokeWidth="2"/>
      <path d="M4 11v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5" stroke="#fff" strokeWidth="2"/>
    </svg>
  );
}

function FileMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" stroke="#fff" strokeWidth="2"/>
      <path d="M14 3v5h5" stroke="#fff" strokeWidth="2"/>
    </svg>
  );
}

function ImageMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="#fff" strokeWidth="2"/>
      <circle cx="8.5" cy="8.5" r="2" fill="#fff"/>
      <path d="M3 17l4.5-6 3 4 3.5-5 7 7H3z" fill="#fff"/>
    </svg>
  );
}

function StarMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M12 3l2.5 5.5H20l-4.5 3.5 1.7 5.5L12 14l-5.2 3.5 1.7-5.5L4 8.5h5.5z" fill="#fff"/>
    </svg>
  );
}

function WrenchMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

type ToolConfig = { mark: React.FC<{ size?: number }>; label: string; color: string };

const TOOL_CONFIGS: Record<string, ToolConfig> = {
  web_search:   { mark: SearchMark,   label: "Web Search",   color: "#4285F4" },
  brave_search: { mark: BraveMark,    label: "Brave Search", color: "#FB542B" },
  search:       { mark: SearchMark,   label: "Search",       color: "#4285F4" },
  telegram:     { mark: TelegramMark, label: "Telegram",     color: "#2AABEE" },
  discord:      { mark: DiscordMark,  label: "Discord",      color: "#5865F2" },
  email:        { mark: GmailMark,    label: "Email",        color: "#EA4335" },
  gmail:        { mark: GmailMark,    label: "Gmail",        color: "#EA4335" },
  clawlancer:   { mark: StarMark,     label: "Instaclaw",    color: "#DC6743" },
  marketplace:  { mark: StarMark,     label: "Marketplace",  color: "#DC6743" },
  file:         { mark: FileMark,     label: "Files",        color: "#34A853" },
  code:         { mark: CodeMark,     label: "Code",         color: "#24292e" },
  database:     { mark: DatabaseMark, label: "Database",     color: "#8b5cf6" },
  calendar:     { mark: CalendarMark, label: "Calendar",     color: "#4285F4" },
  image:        { mark: ImageMark,    label: "Image",        color: "#ec4899" },
};

const DEFAULT_TOOL: ToolConfig = { mark: WrenchMark, label: "Tool", color: "#71717a" };

function getToolConfig(tool: string): ToolConfig {
  const key = tool.toLowerCase().replace(/[\s_-]+/g, "_");
  if (TOOL_CONFIGS[key]) return TOOL_CONFIGS[key];
  for (const [k, v] of Object.entries(TOOL_CONFIGS)) {
    if (key.includes(k)) return v;
  }
  return { ...DEFAULT_TOOL, label: tool };
}

function ToolOrb({ tool, size = 28 }: { tool: string; size?: number }) {
  const { mark: Mark, label, color } = getToolConfig(tool);
  const iconSize = Math.round(size * 0.58);
  return (
    <div
      className="rounded-full relative shrink-0 flex items-center justify-center"
      title={label}
      style={{
        width: size,
        height: size,
        color: "#fff",
        background: `radial-gradient(circle at 35% 35%, ${color}, ${color}cc 60%, ${color}88 100%)`,
        boxShadow: `
          inset 0 -2px 4px rgba(0,0,0,0.2),
          inset 0 2px 3px rgba(255,255,255,0.35),
          0 2px 6px rgba(0,0,0,0.18)
        `,
      }}
    >
      <Mark size={iconSize} />
      <div
        className="absolute rounded-full pointer-events-none"
        style={{
          top: "8%",
          left: "15%",
          width: "45%",
          height: "28%",
          background: "linear-gradient(180deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 100%)",
        }}
      />
    </div>
  );
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

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  is_archived: boolean;
  last_message_preview: string;
  message_count: number;
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
  { label: "Research", prefill: "Research " },
  { label: "Draft email", prefill: "Draft an email about " },
  { label: "Market update", prefill: "Give me a market update on the latest crypto and AI news" },
  { label: "Write a post", prefill: "Write a post about " },
  { label: "Check bounties", prefill: "Check the Clawlancer marketplace for available bounties and recommend the best ones for me" },
  { label: "Today\u2019s schedule", prefill: "Summarize what I should focus on today based on my priorities and pending work" },
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
    case "active":
      return null;
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

const THINKING_PHRASES = [
  "Noodling on that...",
  "Wrangling a response...",
  "Scratching the ol' claw...",
  "Cooking up an answer...",
  "Canoodling with context...",
  "Rounding up some thoughts...",
];

function TypingIndicator() {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [displayed, setDisplayed] = useState("");
  const [phase, setPhase] = useState<"typing" | "visible" | "exit">("typing");

  const phrase = THINKING_PHRASES[phraseIndex];

  // Typewriter effect
  useEffect(() => {
    if (phase !== "typing") return;
    if (displayed.length < phrase.length) {
      const timer = setTimeout(() => {
        setDisplayed(phrase.slice(0, displayed.length + 1));
      }, 30 + Math.random() * 30);
      return () => clearTimeout(timer);
    } else {
      setPhase("visible");
      const timer = setTimeout(() => setPhase("exit"), 2200);
      return () => clearTimeout(timer);
    }
  }, [displayed, phrase, phase]);

  // Cycle to next phrase after exit
  useEffect(() => {
    if (phase !== "exit") return;
    const timer = setTimeout(() => {
      setPhraseIndex((i) => (i + 1) % THINKING_PHRASES.length);
      setDisplayed("");
      setPhase("typing");
    }, 400);
    return () => clearTimeout(timer);
  }, [phase]);

  return (
    <div
      className="flex gap-3 justify-start"
      style={{ animation: "bubble-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
    >
      {/* Glass orb avatar */}
      <div
        className="w-8 h-8 rounded-full shrink-0 relative flex items-center justify-center"
        style={{
          background: "radial-gradient(circle at 35% 35%, rgba(248,247,244,0.95), rgba(220,215,205,0.8) 50%, rgba(180,175,165,0.6) 100%)",
          boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.2), inset 0 2px 4px rgba(255,255,255,0.5), inset 0 0 3px rgba(0,0,0,0.1), 0 1px 4px rgba(0,0,0,0.15)",
        }}
      >
        <div className="absolute top-[2px] left-[4px] w-[14px] h-[7px] rounded-full pointer-events-none z-10"
          style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.65) 0%, rgba(255,255,255,0) 100%)" }} />
        <img src="/logo.png" alt="" className="w-5 h-5 relative z-[1]" />
      </div>

      {/* Bubble with rotating shimmer phrases */}
      <div className="relative">
        <div
          className="agent-bubble px-4 py-3 text-sm leading-relaxed"
          style={{ background: "#f0efec", boxShadow: "0 1px 6px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)" }}
        >
          <span
            style={{
              opacity: phase === "exit" ? 0 : 1,
              transform: phase === "exit" ? "translateY(-4px)" : "translateY(0)",
              transition: "all 0.35s ease",
              display: "inline-block",
            }}
          >
            <span style={{ color: "#888", animation: "thinking-pulse 2s ease-in-out infinite" }}>{displayed}</span>
            {phase === "typing" && (
              <span
                className="inline-block w-[2px] h-[14px] ml-0.5 animate-pulse align-middle"
                style={{ background: "#999" }}
              />
            )}
          </span>
          {/* SVG tail */}
          <svg className="absolute bottom-0 -left-[8px] w-3 h-[18px]" viewBox="0 0 12 18" fill="none">
            <path d="M12 0C11 8 4 14 0 18H12V0Z" fill="#f0efec" />
          </svg>
        </div>
      </div>
    </div>
  );
}

/* ─── Thinking Phrases (streaming empty state) ──────────── */

function ThinkingPhrases() {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [displayed, setDisplayed] = useState("");
  const [phase, setPhase] = useState<"typing" | "visible" | "exit">("typing");

  const phrase = THINKING_PHRASES[phraseIndex];

  useEffect(() => {
    if (phase !== "typing") return;
    if (displayed.length < phrase.length) {
      const timer = setTimeout(() => {
        setDisplayed(phrase.slice(0, displayed.length + 1));
      }, 30 + Math.random() * 30);
      return () => clearTimeout(timer);
    } else {
      setPhase("visible");
      const timer = setTimeout(() => setPhase("exit"), 2200);
      return () => clearTimeout(timer);
    }
  }, [displayed, phrase, phase]);

  useEffect(() => {
    if (phase !== "exit") return;
    const timer = setTimeout(() => {
      setPhraseIndex((i) => (i + 1) % THINKING_PHRASES.length);
      setDisplayed("");
      setPhase("typing");
    }, 400);
    return () => clearTimeout(timer);
  }, [phase]);

  return (
    <span
      style={{
        opacity: phase === "exit" ? 0 : 1,
        transform: phase === "exit" ? "translateY(-4px)" : "translateY(0)",
        transition: "all 0.35s ease",
        display: "inline-block",
      }}
    >
      <span className="thinking-text">{displayed}</span>
      {phase === "typing" && (
        <span
          className="inline-block w-[2px] h-[14px] ml-0.5 align-middle"
          style={{ background: "#888", animation: "cursor-blink 0.8s step-end infinite" }}
        />
      )}
    </span>
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
      style={{ animation: "bubble-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both" }}
    >
      {!isUser && (
        <div
          className="w-8 h-8 rounded-full shrink-0 relative flex items-center justify-center"
          style={{
            background: "radial-gradient(circle at 35% 35%, rgba(248,247,244,0.95), rgba(220,215,205,0.8) 50%, rgba(180,175,165,0.6) 100%)",
            boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.2), inset 0 2px 4px rgba(255,255,255,0.5), inset 0 0 3px rgba(0,0,0,0.1), 0 1px 4px rgba(0,0,0,0.15)",
          }}
        >
          <div className="absolute top-[2px] left-[4px] w-[14px] h-[7px] rounded-full pointer-events-none z-10"
            style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.65) 0%, rgba(255,255,255,0) 100%)" }} />
          <img src="/logo.png" alt="" className="w-5 h-5 relative z-[1]" />
        </div>
      )}

      <div className="max-w-[80%] sm:max-w-[70%] relative">
        <div
          className={`${isUser ? "user-bubble" : "agent-bubble"} px-4 py-3 text-sm leading-relaxed`}
          style={
            isUser
              ? {
                  background: "#dc6743",
                  boxShadow: "0 2px 8px rgba(220,103,67,0.25), 0 1px 3px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.20)",
                  color: "#ffffff",
                }
              : {
                  background: "#f0efec",
                  boxShadow: "0 1px 6px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
                  color: "var(--foreground)",
                }
          }
        >
          {msg.isStreaming && !msg.content ? (
            <ThinkingPhrases />
          ) : isUser ? (
            msg.content
          ) : (
            <div className="prose prose-sm max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_pre]:my-2 [&_pre]:rounded-lg [&_pre]:bg-black/5 [&_pre]:p-3 [&_code]:text-xs [&_code]:bg-black/5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre_code]:bg-transparent [&_pre_code]:p-0">
              <ReactMarkdown>{msg.content}</ReactMarkdown>
            </div>
          )}
          {msg.isStreaming && msg.content && (
            <span className="inline-block w-1.5 h-4 ml-0.5 bg-current animate-pulse" />
          )}
          {/* iMessage-style SVG tail */}
          {isUser ? (
            <svg className="absolute bottom-0 -right-[8px] w-3 h-[18px]" viewBox="0 0 12 18" fill="none">
              <path d="M0 0C1 8 8 14 12 18H0V0Z" fill="#dc6743" />
            </svg>
          ) : (
            <svg className="absolute bottom-0 -left-[8px] w-3 h-[18px]" viewBox="0 0 12 18" fill="none">
              <path d="M12 0C11 8 4 14 0 18H12V0Z" fill="#f0efec" />
            </svg>
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
  chips,
}: {
  onChipClick: (text: string) => void;
  chips: { label: string; prefill: string }[];
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
        {chips.map((a) => (
          <button
            key={a.label}
            onClick={() => onChipClick(a.prefill)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
            style={{
              background: "rgba(255,255,255,0.45)",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.6)",
              border: "1px solid rgba(0,0,0,0.06)",
              color: "var(--foreground)",
            }}
          >
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

function ConversationListSkeleton() {
  return (
    <div className="space-y-1 p-2 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-xl p-3"
          style={{ opacity: 0.5 }}
        >
          <div className="h-3.5 rounded-full mb-2" style={{ background: "var(--border)", width: "70%" }} />
          <div className="h-2.5 rounded-full" style={{ background: "var(--border)", width: "90%" }} />
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
  // Run history
  const [runHistory, setRunHistory] = useState<LibraryItem[] | null>(null);
  const [runHistoryLoading, setRunHistoryLoading] = useState(false);
  const [currentRunIndex, setCurrentRunIndex] = useState(0);

  // Fetch run history when a recurring task with a result is expanded
  useEffect(() => {
    if (!isExpanded || !task.is_recurring || !task.result || runHistory !== null) return;
    let cancelled = false;
    setRunHistoryLoading(true);
    fetch(`/api/library/list?source_task_id=${task.id}&limit=100&sort=created_at&order=desc`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setRunHistory(data.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setRunHistory([]);
      })
      .finally(() => {
        if (!cancelled) setRunHistoryLoading(false);
      });
    return () => { cancelled = true; };
  }, [isExpanded, task.is_recurring, task.result, task.id, runHistory]);

  // Reset index on collapse
  useEffect(() => {
    if (!isExpanded) setCurrentRunIndex(0);
  }, [isExpanded]);

  const allRuns = runHistory ?? [];
  const totalRuns = allRuns.length;
  const hasHistory = totalRuns > 1;
  const currentRun = allRuns[currentRunIndex];
  const displayedContent = currentRun?.content ?? task.result;
  const displayedDate = currentRun?.created_at ?? task.last_run_at;

  const isFailed = task.status === "failed";
  const isProcessing = task.status === "in_progress";
  const isCompleted = task.status === "completed";
  const isActive = task.status === "active";
  const isPaused = task.status === "paused";

  const streakText =
    task.streak === 0
      ? "New"
      : task.frequency?.includes("week")
        ? `${task.streak} ${task.streak === 1 ? "week" : "weeks"}`
        : `${task.streak} ${task.streak === 1 ? "day" : "days"}`;

  const frequencyLabel = task.frequency
    ? `Runs ${task.frequency}`
    : null;

  const isOverdue =
    !isPaused &&
    !!task.next_run_at &&
    new Date(task.next_run_at).getTime() < Date.now();

  const nextRunLabel: string | null = isPaused
    ? "Paused"
    : task.is_recurring && task.next_run_at
      ? isOverdue
        ? "Running now"
        : `Next ${formatNextRun(task.next_run_at, false)}`
      : task.last_run_at
        ? `Last run ${timeAgo(task.last_run_at)}`
        : null;

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
          ) : isProcessing ? (
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center relative"
              style={{
                background: "radial-gradient(circle, rgba(99,102,241,0.10) 0%, rgba(99,102,241,0.03) 70%, transparent 100%)",
              }}
            >
              <motion.div
                className="absolute inset-0 rounded-full"
                style={{
                  background: "conic-gradient(from 0deg, transparent 0%, rgba(99,102,241,0.5) 30%, transparent 55%)",
                  mask: "radial-gradient(circle, transparent 58%, black 62%, black 100%)",
                  WebkitMask: "radial-gradient(circle, transparent 58%, black 62%, black 100%)",
                }}
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
              />
              <span
                className="w-2 h-2 rounded-full relative z-10"
                style={{
                  background: "radial-gradient(circle at 35% 30%, #818cf8, #6366f1)",
                  boxShadow: "0 0 6px rgba(99,102,241,0.35)",
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
              style={{ borderColor: "rgba(0,0,0,0.15)" }}
            />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {!isProcessing && <StatusDot status={task.status} />}
            {isProcessing && task.title === "Processing..." ? (
              <p
                className="font-medium text-base truncate"
                style={{ color: "#6366f1" }}
              >
                Working on it...
              </p>
            ) : (
              <p
                className="font-medium text-base truncate"
                style={{ color: "var(--foreground)" }}
              >
                {task.title}
              </p>
            )}
          </div>
          <p
            className="text-sm mt-0.5 truncate"
            style={{ color: isFailed ? "#b91c1c" : "var(--muted)" }}
          >
            {isFailed && task.error_message
              ? task.error_message
              : task.description}
          </p>
          {task.is_recurring && (frequencyLabel || nextRunLabel) && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="flex items-center gap-1.5 flex-wrap text-xs mt-2 pt-2"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              {frequencyLabel && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                  style={{
                    background: "rgba(255,255,255,0.45)",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.6)",
                    border: "1px solid rgba(0,0,0,0.06)",
                    color: "var(--muted)",
                  }}
                >
                  <Repeat className="w-2.5 h-2.5" />
                  {frequencyLabel}
                </span>
              )}
              {nextRunLabel && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                  style={{
                    background: isOverdue
                      ? "rgba(34,197,94,0.08)"
                      : isPaused
                        ? "rgba(156,163,175,0.08)"
                        : "rgba(255,255,255,0.45)",
                    boxShadow: isOverdue
                      ? "0 0 0 1px rgba(34,197,94,0.15), 0 1px 2px rgba(34,197,94,0.06)"
                      : "0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.6)",
                    border: isOverdue
                      ? "1px solid rgba(34,197,94,0.12)"
                      : "1px solid rgba(0,0,0,0.06)",
                    color: isOverdue ? "#16a34a" : isPaused ? "#9ca3af" : "var(--muted)",
                  }}
                >
                  {isOverdue && (
                    <span
                      className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
                      style={{ background: "#22c55e" }}
                    />
                  )}
                  {isPaused && <Pause className="w-2.5 h-2.5" />}
                  {nextRunLabel}
                </span>
              )}
              {!isPaused && (
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
            </motion.div>
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
              {task.tools_used.slice(0, 4).map((tool) => (
                <ToolOrb key={tool} tool={tool} size={28} />
              ))}
              {task.tools_used.length > 4 && (
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-semibold"
                  style={{
                    background: "radial-gradient(circle at 35% 35%, #e5e5e5, #d4d4d4cc 60%, #a3a3a388 100%)",
                    boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.15), inset 0 2px 3px rgba(255,255,255,0.4), 0 2px 6px rgba(0,0,0,0.15)",
                    color: "#666",
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
              {/* Original request — glass inset card */}
              <div
                className="pt-3 px-3.5 pb-3 mt-3 rounded-xl"
                style={{
                  background: "rgba(255,255,255,0.35)",
                  boxShadow: "inset 0 1px 2px rgba(0,0,0,0.04), 0 1px 0 rgba(255,255,255,0.6)",
                  border: "1px solid rgba(0,0,0,0.05)",
                }}
              >
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1.5" style={{ color: "var(--muted)", opacity: 0.6 }}>
                  You asked
                </p>
                <p className="text-sm italic" style={{ color: "var(--foreground)", opacity: 0.75 }}>
                  &ldquo;{task.description}&rdquo;
                </p>
              </div>

              {/* Result — with edit mode */}
              {task.result && (
                <div>
                  {/* Run navigator header */}
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted)", opacity: 0.6 }}>
                      Result
                    </p>
                    {task.is_recurring && runHistoryLoading ? (
                      /* Skeleton shimmer while loading */
                      <div
                        className="h-6 w-48 rounded-full animate-pulse"
                        style={{
                          background: "rgba(255,255,255,0.35)",
                          border: "1px solid rgba(0,0,0,0.05)",
                        }}
                      />
                    ) : task.is_recurring && hasHistory ? (
                      /* Run navigator pill */
                      <div
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full"
                        style={{
                          background: "rgba(255,255,255,0.45)",
                          boxShadow: "0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.6)",
                          border: "1px solid rgba(0,0,0,0.06)",
                        }}
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setCurrentRunIndex((i) => Math.min(i + 1, totalRuns - 1));
                          }}
                          disabled={currentRunIndex >= totalRuns - 1}
                          className="p-0.5 rounded transition-all cursor-pointer disabled:opacity-25 hover:bg-black/5"
                          title="Older run"
                        >
                          <ChevronLeft className="w-3 h-3" style={{ color: "var(--muted)" }} />
                        </button>
                        <span
                          className="text-[11px] font-medium"
                          style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}
                        >
                          Run {totalRuns - currentRunIndex} of {totalRuns}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setCurrentRunIndex((i) => Math.max(i - 1, 0));
                          }}
                          disabled={currentRunIndex <= 0}
                          className="p-0.5 rounded transition-all cursor-pointer disabled:opacity-25 hover:bg-black/5"
                          title="Newer run"
                        >
                          <ChevronRight className="w-3 h-3" style={{ color: "var(--muted)" }} />
                        </button>
                        <span className="text-[10px] ml-0.5" style={{ color: "var(--muted)", opacity: 0.6 }}>
                          {formatDate(displayedDate)}
                        </span>
                      </div>
                    ) : !isEditing ? (
                      /* Default edit button for non-recurring or single-run */
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit();
                        }}
                        className="p-1.5 rounded-lg transition-all opacity-40 hover:opacity-100 cursor-pointer"
                        style={{
                          background: "transparent",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = "rgba(255,255,255,0.5)";
                          e.currentTarget.style.boxShadow = "0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.6)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = "transparent";
                          e.currentTarget.style.boxShadow = "none";
                        }}
                        title="Edit result"
                      >
                        <Pencil className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
                      </button>
                    ) : null}
                  </div>

                  {/* Delivery banner — only for latest run of recurring tasks */}
                  {task.is_recurring && currentRunIndex === 0 && task.last_delivery_status && (
                    <div
                      className="flex items-center gap-2 px-3 py-2 rounded-xl mb-2 text-xs font-medium"
                      style={{
                        background: task.last_delivery_status === "delivered"
                          ? "rgba(34,197,94,0.06)"
                          : task.last_delivery_status === "delivery_failed"
                            ? "rgba(239,68,68,0.06)"
                            : "rgba(255,255,255,0.35)",
                        border: task.last_delivery_status === "delivered"
                          ? "1px solid rgba(34,197,94,0.12)"
                          : task.last_delivery_status === "delivery_failed"
                            ? "1px solid rgba(239,68,68,0.12)"
                            : "1px solid rgba(0,0,0,0.06)",
                        boxShadow: task.last_delivery_status === "delivered"
                          ? "0 0 0 1px rgba(34,197,94,0.08), 0 1px 2px rgba(34,197,94,0.04)"
                          : task.last_delivery_status === "delivery_failed"
                            ? "0 0 0 1px rgba(239,68,68,0.08), 0 1px 2px rgba(239,68,68,0.04)"
                            : "0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.6)",
                        color: task.last_delivery_status === "delivered"
                          ? "#16a34a"
                          : task.last_delivery_status === "delivery_failed"
                            ? "#ef4444"
                            : "var(--muted)",
                      }}
                    >
                      <span
                        className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                        style={{
                          background: task.last_delivery_status === "delivered"
                            ? "rgba(34,197,94,0.12)"
                            : task.last_delivery_status === "delivery_failed"
                              ? "rgba(239,68,68,0.12)"
                              : "rgba(0,0,0,0.06)",
                          boxShadow: task.last_delivery_status === "delivered"
                            ? "0 0 0 1px rgba(34,197,94,0.15), inset 0 1px 0 rgba(255,255,255,0.5)"
                            : task.last_delivery_status === "delivery_failed"
                              ? "0 0 0 1px rgba(239,68,68,0.15), inset 0 1px 0 rgba(255,255,255,0.5)"
                              : "0 0 0 1px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.5)",
                          color: task.last_delivery_status === "delivered"
                            ? "#16a34a"
                            : task.last_delivery_status === "delivery_failed"
                              ? "#ef4444"
                              : "#9ca3af",
                        }}
                      >
                        <TelegramMark size={11} />
                      </span>
                      {task.last_delivery_status === "delivered" ? (
                        "Auto-sent to Telegram"
                      ) : task.last_delivery_status === "delivery_failed" ? (
                        "Delivery failed"
                      ) : (
                        "Telegram not connected"
                      )}
                    </div>
                  )}

                  {isEditing ? (
                    /* Edit mode: textarea */
                    <div className="space-y-2">
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        className="w-full rounded-xl p-3.5 text-sm font-mono outline-none resize-y"
                        style={{
                          background: "rgba(255,255,255,0.4)",
                          border: "1px solid rgba(0,0,0,0.06)",
                          boxShadow: "inset 0 2px 4px rgba(0,0,0,0.03), 0 1px 0 rgba(255,255,255,0.6)",
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
                          className="px-3.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all disabled:opacity-50"
                          style={{
                            background: "var(--foreground)",
                            color: "var(--background)",
                            boxShadow: "0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)",
                          }}
                        >
                          {isSavingEdit ? "Saving..." : "Save"}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            cancelEdit();
                          }}
                          className="px-3.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all"
                          style={{
                            color: "var(--muted)",
                            background: "rgba(255,255,255,0.35)",
                            boxShadow: "0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.6)",
                            border: "1px solid rgba(0,0,0,0.06)",
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Rendered markdown view — glass card with crossfade */
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={currentRunIndex}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.15 }}
                        className="rounded-xl p-3.5 text-sm relative"
                        style={{
                          background: "rgba(255,255,255,0.35)",
                          border: "1px solid rgba(0,0,0,0.05)",
                          boxShadow: "inset 0 1px 2px rgba(0,0,0,0.03), 0 1px 0 rgba(255,255,255,0.6)",
                          ...(isRefining ? { opacity: 0.5 } : {}),
                        }}
                      >
                        {isRefining && (
                          <div
                            className="absolute inset-0 flex items-center justify-center rounded-xl"
                            style={{
                              background: "rgba(255,255,255,0.6)",
                              backdropFilter: "blur(2px)",
                            }}
                          >
                            <p className="text-xs font-medium animate-pulse" style={{ color: "var(--muted)" }}>Refining...</p>
                          </div>
                        )}
                        <div className="prose prose-sm max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_pre]:my-2 [&_pre]:rounded-lg [&_pre]:bg-black/5 [&_pre]:p-3 [&_code]:text-xs [&_code]:bg-black/5 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre_code]:bg-transparent [&_pre_code]:p-0">
                          <ReactMarkdown>{displayedContent}</ReactMarkdown>
                        </div>
                      </motion.div>
                    </AnimatePresence>
                  )}
                </div>
              )}

              {/* Error message — glass error card */}
              {isFailed && task.error_message && (
                <div
                  className="rounded-xl p-3.5 text-sm flex items-start gap-2.5"
                  style={{
                    background: "rgba(239,68,68,0.04)",
                    border: "1px solid rgba(239,68,68,0.12)",
                    boxShadow: "inset 0 1px 2px rgba(239,68,68,0.04), 0 1px 0 rgba(255,255,255,0.4)",
                    color: "#b91c1c",
                  }}
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  {task.error_message}
                </div>
              )}

              {/* Tools used — glass pills */}
              {task.tools_used.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted)", opacity: 0.6 }}>
                    Tools
                  </span>
                  {task.tools_used.map((tool) => {
                    const { label } = getToolConfig(tool);
                    return (
                      <span
                        key={tool}
                        className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] font-medium"
                        style={{
                          background: "rgba(255,255,255,0.45)",
                          boxShadow: "0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.6)",
                          border: "1px solid rgba(0,0,0,0.06)",
                          color: "var(--foreground)",
                        }}
                      >
                        <ToolOrb tool={tool} size={20} />
                        {label}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* Timestamps + recurring info + delivery status — glass info pills */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px]"
                  style={{
                    background: "rgba(255,255,255,0.45)",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.6)",
                    border: "1px solid rgba(0,0,0,0.06)",
                    color: "var(--muted)",
                  }}
                >
                  Created {formatDate(task.created_at)}
                </span>
                {isCompleted && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px]"
                    style={{
                      background: "rgba(34,197,94,0.06)",
                      boxShadow: "0 0 0 1px rgba(34,197,94,0.1), 0 1px 2px rgba(34,197,94,0.04)",
                      border: "1px solid rgba(34,197,94,0.08)",
                      color: "#16a34a",
                    }}
                  >
                    <Check className="w-2.5 h-2.5" />
                    Completed {formatDate(task.updated_at)}
                  </span>
                )}
                {task.is_recurring && task.frequency && (
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px]"
                    style={{
                      background: "rgba(255,255,255,0.45)",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.6)",
                      border: "1px solid rgba(0,0,0,0.06)",
                      color: "var(--muted)",
                    }}
                  >
                    <Repeat className="w-2.5 h-2.5" />
                    {task.frequency}
                    {task.streak > 0 && ` \u00B7 ${task.streak} streak`}
                  </span>
                )}
              </div>

              {/* Action buttons — glass styled */}
              {!isEditing && (
                <div
                  className="flex items-center gap-2 pt-2 mt-1 flex-wrap"
                  style={{ borderTop: "1px solid rgba(0,0,0,0.04)" }}
                >
                  {/* Run now (recurring) or Re-run (non-recurring) */}
                  {task.is_recurring && (isActive || isFailed) ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onTrigger();
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
                      style={{
                        background: "rgba(255,255,255,0.5)",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.7)",
                        border: "1px solid rgba(0,0,0,0.08)",
                        color: "var(--foreground)",
                      }}
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
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
                      style={{
                        background: "rgba(34,197,94,0.06)",
                        boxShadow: "0 1px 3px rgba(34,197,94,0.08), inset 0 1px 0 rgba(255,255,255,0.5)",
                        border: "1px solid rgba(34,197,94,0.12)",
                        color: "#16a34a",
                      }}
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
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
                      style={{
                        background: "rgba(255,255,255,0.5)",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.7)",
                        border: "1px solid rgba(0,0,0,0.08)",
                        color: "var(--foreground)",
                      }}
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
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
                      style={{
                        background: "rgba(255,255,255,0.5)",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.7)",
                        border: "1px solid rgba(0,0,0,0.08)",
                        color: "var(--muted)",
                      }}
                    >
                      <Pause className="w-3 h-3" />
                      Pause
                    </button>
                  )}
                  {task.result && currentRunIndex === 0 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openRefine();
                      }}
                      disabled={isRefining}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:hover:scale-100"
                      style={{
                        background: "rgba(255,255,255,0.5)",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.7)",
                        border: "1px solid rgba(0,0,0,0.08)",
                        color: "var(--foreground)",
                      }}
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
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] ml-auto"
                      style={{
                        background: "rgba(255,255,255,0.5)",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.7)",
                        border: "1px solid rgba(0,0,0,0.08)",
                        color: "#ef4444",
                      }}
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
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] ml-auto"
                      style={{
                        background: "rgba(239,68,68,0.12)",
                        boxShadow: "0 1px 3px rgba(239,68,68,0.1), inset 0 1px 0 rgba(255,255,255,0.4)",
                        border: "1px solid rgba(239,68,68,0.18)",
                        color: "#dc2626",
                      }}
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
                        className="rounded-xl p-2.5 flex items-center gap-2"
                        style={{
                          background: "rgba(255,255,255,0.45)",
                          border: "1px solid rgba(0,0,0,0.06)",
                          boxShadow: "inset 0 1px 2px rgba(0,0,0,0.03), 0 1px 0 rgba(255,255,255,0.6)",
                        }}
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
                          className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-all hover:scale-105 disabled:opacity-40 disabled:hover:scale-100"
                          style={{
                            background: "var(--accent)",
                            boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
                          }}
                        >
                          <Send className="w-3.5 h-3.5" style={{ color: "#ffffff" }} />
                        </button>
                        <button
                          onClick={() => {
                            setShowRefine(false);
                            setRefineInput("");
                          }}
                          className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-all hover:scale-105"
                          style={{
                            color: "var(--muted)",
                            background: "rgba(0,0,0,0.03)",
                          }}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <p className="text-[11px]" style={{ color: "var(--muted)", opacity: 0.7 }}>
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
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Multi-chat conversation state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [isLoadingConversations, setIsLoadingConversations] = useState(true);
  const [showConversationList, setShowConversationList] = useState(false);
  const [renamingConvId, setRenamingConvId] = useState<string | null>(null);
  const [renameTitleDraft, setRenameTitleDraft] = useState("");
  const loadingConvRef = useRef<string | null>(null);

  // Dynamic viewport height for keyboard-aware layout on mobile
  const [chatViewHeight, setChatViewHeight] = useState<number | null>(null);

  // Personalized quick action chips
  const [personalChips, setPersonalChips] = useState<{ label: string; prefill: string }[] | null>(null);

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
    const el = chatScrollRef.current || scrollRef.current;
    if (el) {
      el.scrollTo({
        top: el.scrollHeight,
        behavior: "smooth",
      });
    }
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

  // Fetch personalized quick action suggestions
  useEffect(() => {
    fetch("/api/tasks/suggestions")
      .then((res) => res.json())
      .then((data) => {
        if (data.suggestions) setPersonalChips(data.suggestions);
      })
      .catch(() => {});
  }, []);

  const chips = personalChips ?? quickActions;

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

  // Keyboard-aware layout: dynamically resize chat container using visualViewport
  // When keyboard opens, visualViewport.height shrinks → container shrinks → input stays visible
  // When keyboard closes, height grows back → input returns to bottom
  useEffect(() => {
    if (activeTab !== "chat") {
      setChatViewHeight(null);
      return;
    }

    window.scrollTo(0, 0);
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    const vv = window.visualViewport;
    if (!vv) return;

    // nav(56px) + main-padding-top(48px) - negative-margin-top(40px) = 64px
    const MOBILE_OFFSET = 64;

    const update = () => {
      if (window.innerWidth < 640) {
        setChatViewHeight(vv.height - MOBILE_OFFSET);
      }
      // Reset any page scroll iOS Safari might have caused
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);

    return () => {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      setChatViewHeight(null);
    };
  }, [activeTab]);

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

  // ─── Load conversations on mount ──────────────────────

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/conversations");
      if (res.ok) {
        const data = await res.json();
        const convs: Conversation[] = data.conversations ?? [];
        setConversations(convs);
        // Auto-select most recent if nothing active
        if (convs.length > 0) {
          setActiveConversationId((prev) => {
            if (prev && convs.some((c) => c.id === prev)) return prev;
            return convs[0].id;
          });
        }
      }
    } catch {
      // Non-fatal
    } finally {
      setIsLoadingConversations(false);
    }
  }, []);

  const loadConversationMessages = useCallback(async (convId: string) => {
    loadingConvRef.current = convId;
    setIsLoadingChat(true);
    setChatMessages([]);
    try {
      const res = await fetch(`/api/chat/conversations/${convId}/messages`);
      if (res.ok && loadingConvRef.current === convId) {
        const data = await res.json();
        setChatMessages(data.messages ?? []);
      }
    } catch {
      // Non-fatal
    } finally {
      if (loadingConvRef.current === convId) {
        setIsLoadingChat(false);
      }
    }
  }, []);

  useEffect(() => {
    loadConversations();
    // Load saved message IDs for library bookmarks
    (async () => {
      try {
        const res = await fetch("/api/library/saved-messages");
        if (res.ok) {
          const data = await res.json();
          setSavedMessageIds(new Set(data.ids ?? []));
        }
      } catch {
        // Non-fatal
      }
    })();
  }, [loadConversations]);

  // Load messages when active conversation changes
  useEffect(() => {
    if (activeConversationId) {
      loadConversationMessages(activeConversationId);
    } else {
      setChatMessages([]);
      setIsLoadingChat(false);
    }
  }, [activeConversationId, loadConversationMessages]);

  // Auto-scroll: tab switch → delayed (wait for AnimatePresence) + safety retry
  useEffect(() => {
    if (activeTab === "chat") {
      const t1 = setTimeout(scrollToBottom, 450);
      const t2 = setTimeout(scrollToBottom, 1000);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
  }, [activeTab, scrollToBottom]);

  // Auto-scroll: new messages → immediate (only when count actually grows)
  const prevMsgCount = useRef(chatMessages.length);
  useEffect(() => {
    if (activeTab === "chat" && chatMessages.length > prevMsgCount.current) {
      requestAnimationFrame(scrollToBottom);
    }
    prevMsgCount.current = chatMessages.length;
  }, [chatMessages.length, activeTab, scrollToBottom]);

  // Auto-scroll: during streaming → scroll as new content arrives
  const streamingContent = chatMessages.find((m) => m.isStreaming)?.content ?? "";
  useEffect(() => {
    if (activeTab === "chat" && streamingContent) {
      const el = chatScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [activeTab, streamingContent]);

  // ─── Conversation actions ─────────────────────────────

  const createNewConversation = useCallback(() => {
    setActiveConversationId(null);
    setChatMessages([]);
    setChatError(null);
    setShowConversationList(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const renameConversation = useCallback(async (convId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    // Optimistic update
    setConversations((prev) =>
      prev.map((c) => (c.id === convId ? { ...c, title: trimmed } : c))
    );
    setRenamingConvId(null);
    try {
      await fetch(`/api/chat/conversations/${convId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
    } catch {
      // Revert on error — reload
      loadConversations();
    }
  }, [loadConversations]);

  const archiveConversation = useCallback(async (convId: string) => {
    // Optimistic removal
    setConversations((prev) => prev.filter((c) => c.id !== convId));
    if (activeConversationId === convId) {
      setActiveConversationId(null);
      setChatMessages([]);
      setShowConversationList(true);
    }
    try {
      await fetch(`/api/chat/conversations/${convId}`, {
        method: "DELETE",
      });
    } catch {
      loadConversations();
    }
  }, [activeConversationId, loadConversations]);

  // ─── Send chat message ────────────────────────────────

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isSending) return;

      let convId = activeConversationId;

      // If no active conversation, create one first
      if (!convId) {
        try {
          const res = await fetch("/api/chat/conversations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          });
          if (res.ok) {
            const data = await res.json();
            convId = data.conversation.id;
            setActiveConversationId(convId);
          }
        } catch {
          // Fall through — send endpoint will create one
        }
      }

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
          body: JSON.stringify({
            message: text.trim(),
            conversation_id: convId,
          }),
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
            // Refresh conversation list to pick up auto-title & preview
            loadConversations();
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
    [isSending, activeConversationId, loadConversations]
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
    <div
      className="flex flex-col h-[calc(100dvh-4rem)] sm:h-[calc(100dvh-7.5rem)] -mt-10 sm:mt-0 -mb-12 sm:-mb-16"
      style={chatViewHeight != null ? { height: `${chatViewHeight}px` } : undefined}
    >
      {/* ── Static header (never scrolls) ───────────────────── */}
      <div className="shrink-0">
        <h1
          className="hidden sm:block text-3xl sm:text-4xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Command Center
        </h1>
        <p className="hidden sm:block text-base mt-2" style={{ color: "var(--muted)" }}>
          Your agent works around the clock. Here&apos;s everything
          it&apos;s handling.
        </p>

        <div className="mt-1 sm:mt-4">
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
      <div ref={scrollRef} className={`flex-1 min-h-0 ${activeTab === "chat" ? "flex flex-col overflow-hidden pt-2 -mx-4 sm:mx-0" : "overflow-y-auto pt-6 pb-2"}`}>
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className={activeTab === "chat" ? "flex-1 min-h-0 flex flex-col" : ""}
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
              <div className="relative overflow-hidden flex-1 min-h-0 flex flex-col">
                {/* ── Overlay sidebar: Conversation list ─────────── */}
                <AnimatePresence>
                  {showConversationList && (
                    <>
                      {/* Backdrop — contained within chat section */}
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="absolute inset-0 z-30"
                        style={{ background: "rgba(0,0,0,0.15)" }}
                        onClick={() => setShowConversationList(false)}
                      />
                      {/* Sidebar panel — within chat section */}
                      <motion.div
                        initial={{ x: "-100%" }}
                        animate={{ x: 0 }}
                        exit={{ x: "-100%" }}
                        transition={{ type: "spring", damping: 28, stiffness: 320 }}
                        className="absolute top-0 left-0 bottom-0 z-40 flex flex-col w-[280px] max-w-[85vw]"
                        style={{
                          background: "#f8f7f4",
                          borderRight: "1px solid var(--border)",
                          boxShadow: "4px 0 24px rgba(0,0,0,0.08)",
                        }}
                      >
                        {/* Sidebar header */}
                        <div className="flex items-center justify-between px-3 py-2.5 shrink-0">
                          <span className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
                            Chats
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={createNewConversation}
                              className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-all hover:scale-105 active:scale-95"
                              style={{ background: "var(--accent)" }}
                              title="New Chat"
                            >
                              <Plus className="w-4 h-4" style={{ color: "#fff" }} strokeWidth={2.5} />
                            </button>
                            <button
                              onClick={() => setShowConversationList(false)}
                              className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-black/5"
                              title="Close sidebar"
                            >
                              <PanelLeft className="w-4 h-4" style={{ color: "var(--muted)" }} />
                            </button>
                          </div>
                        </div>

                        {/* Conversation list */}
                        <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
                          {isLoadingConversations ? (
                            <ConversationListSkeleton />
                          ) : conversations.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                              <MessageSquare className="w-8 h-8 mb-3" style={{ color: "var(--border)" }} />
                              <p className="text-sm" style={{ color: "var(--muted)" }}>
                                No conversations yet
                              </p>
                              <button
                                onClick={createNewConversation}
                                className="mt-3 text-xs font-medium cursor-pointer transition-colors hover:opacity-80"
                                style={{ color: "var(--accent)" }}
                              >
                                Start a new chat
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-0.5 px-1.5 pb-2">
                              {conversations.map((conv) => (
                                <div
                                  key={conv.id}
                                  onClick={() => {
                                    setActiveConversationId(conv.id);
                                    // Close sidebar on mobile, keep open on desktop
                                    if (window.innerWidth < 640) setShowConversationList(false);
                                  }}
                                  className={`group/conv relative rounded-xl px-3 py-2.5 cursor-pointer transition-all ${
                                    activeConversationId === conv.id
                                      ? ""
                                      : "hover:bg-black/[0.03]"
                                  }`}
                                  style={
                                    activeConversationId === conv.id
                                      ? {
                                          background: "rgba(220,103,67,0.08)",
                                          boxShadow: "inset 0 0 0 1px rgba(220,103,67,0.15)",
                                        }
                                      : undefined
                                  }
                                >
                                  {renamingConvId === conv.id ? (
                                    <input
                                      autoFocus
                                      value={renameTitleDraft}
                                      onChange={(e) => setRenameTitleDraft(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                          renameConversation(conv.id, renameTitleDraft);
                                        } else if (e.key === "Escape") {
                                          setRenamingConvId(null);
                                        }
                                      }}
                                      onBlur={() => {
                                        if (renameTitleDraft.trim()) {
                                          renameConversation(conv.id, renameTitleDraft);
                                        } else {
                                          setRenamingConvId(null);
                                        }
                                      }}
                                      className="w-full text-sm bg-transparent outline-none rounded px-1 -mx-1"
                                      style={{
                                        color: "var(--foreground)",
                                        boxShadow: "0 0 0 1.5px var(--accent)",
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                  ) : (
                                    <>
                                      <div className="flex items-center justify-between gap-1">
                                        <p
                                          className="text-sm font-medium truncate flex-1"
                                          style={{
                                            color:
                                              activeConversationId === conv.id
                                                ? "var(--accent)"
                                                : "var(--foreground)",
                                          }}
                                        >
                                          {conv.title}
                                        </p>
                                        <div className="flex items-center gap-0.5 opacity-0 group-hover/conv:opacity-100 transition-opacity shrink-0">
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setRenamingConvId(conv.id);
                                              setRenameTitleDraft(conv.title);
                                            }}
                                            className="p-1 rounded-md cursor-pointer hover:bg-black/5 transition-colors"
                                            title="Rename"
                                          >
                                            <Pencil className="w-3 h-3" style={{ color: "var(--muted)" }} />
                                          </button>
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              archiveConversation(conv.id);
                                            }}
                                            className="p-1 rounded-md cursor-pointer hover:bg-red-50 transition-colors"
                                            title="Delete"
                                          >
                                            <Trash2 className="w-3 h-3" style={{ color: "#b91c1c" }} />
                                          </button>
                                        </div>
                                      </div>
                                      {conv.last_message_preview && (
                                        <p
                                          className="text-xs truncate mt-0.5"
                                          style={{ color: "var(--muted)" }}
                                        >
                                          {conv.last_message_preview}
                                        </p>
                                      )}
                                      <p
                                        className="text-[10px] mt-1"
                                        style={{ color: "var(--muted)", opacity: 0.7 }}
                                      >
                                        {timeAgo(conv.updated_at)}
                                      </p>
                                    </>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    </>
                  )}
                </AnimatePresence>

                {/* ── Main chat area (always full width) ──────────── */}
                <div className="flex flex-col flex-1 min-h-0">
                  {/* Chat header with sidebar toggle */}
                  <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b" style={{ borderColor: "var(--border)" }}>
                    <button
                      onClick={() => setShowConversationList(true)}
                      className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-colors hover:bg-black/5"
                      title="Open conversations"
                    >
                      <PanelLeft className="w-4 h-4" style={{ color: "var(--muted)" }} />
                    </button>
                    <span className="text-sm font-medium truncate flex-1" style={{ color: "var(--foreground)" }}>
                      {activeConversationId
                        ? conversations.find((c) => c.id === activeConversationId)?.title ?? "Chat"
                        : "New Chat"}
                    </span>
                    <button
                      onClick={createNewConversation}
                      className="w-7 h-7 rounded-lg flex items-center justify-center cursor-pointer transition-all hover:scale-105 active:scale-95"
                      style={{ background: "var(--accent)" }}
                      title="New Chat"
                    >
                      <Plus className="w-4 h-4" style={{ color: "#fff" }} strokeWidth={2.5} />
                    </button>
                  </div>

                  {/* Messages area */}
                  <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-3 pt-4 pb-2" style={{ scrollbarWidth: "thin" }}>
                    {!activeConversationId && !isSending ? (
                      <ChatEmptyState onChipClick={handleChipClick} chips={chips} />
                    ) : isLoadingChat ? (
                      <ChatSkeleton />
                    ) : chatMessages.length === 0 && !isSending ? (
                      <ChatEmptyState onChipClick={handleChipClick} chips={chips} />
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
                  </div>

                  {/* Chat input */}
                  <div
                    className="shrink-0 px-3 pt-2"
                    style={{
                      background: "linear-gradient(to top, #f8f7f4 80%, transparent)",
                      paddingBottom: "max(0.75rem, calc(env(safe-area-inset-bottom) + 0.25rem))",
                    }}
                  >
                    <div
                      className="rounded-2xl px-4 py-3 flex items-center gap-3"
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
                        placeholder="Message your agent..."
                        className="flex-1 bg-transparent text-[16px] outline-none"
                        style={{ color: "var(--foreground)" }}
                        disabled={isSending}
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
                          disabled={isSending || !chatInput.trim()}
                          className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 cursor-pointer transition-all hover:opacity-80 disabled:opacity-30 disabled:scale-95"
                          style={{ background: "var(--accent)" }}
                        >
                          <ArrowUp className="w-4 h-4" style={{ color: "#ffffff" }} strokeWidth={2.5} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

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
          className="shrink-0 -mx-4 px-4 pt-2"
          data-tour="input-bar"
          style={{
            background: "linear-gradient(to top, #f8f7f4 80%, transparent)",
            paddingBottom: "max(1.25rem, calc(env(safe-area-inset-bottom) + 0.5rem))",
          }}
        >
          <div
            data-tour="quick-chips"
            className="flex gap-1.5 overflow-x-auto pb-2 px-1"
            style={{ scrollbarWidth: "none" }}
          >
            {chips.map((action) => (
              <button
                key={action.label}
                onClick={() => handleChipClick(action.prefill)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs whitespace-nowrap cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
                style={{
                  background: "rgba(255,255,255,0.45)",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.6)",
                  border: "1px solid rgba(0,0,0,0.06)",
                  color: "var(--muted)",
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
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
        </div>
      )}

      {/* Chat input is now inside the two-panel layout */}
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
