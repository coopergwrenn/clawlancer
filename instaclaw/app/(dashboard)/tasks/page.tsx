"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ChevronRight, Check, Send } from "lucide-react";

/* ─── Types ───────────────────────────────────────────────── */

type Tab = "tasks" | "chat" | "library";

type TaskStatus =
  | "completed"
  | "in-progress"
  | "queued"
  | "always-on"
  | "scheduled";

interface TaskItem {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  icons: { emoji: string; bg: string }[];
}

interface ChatMessage {
  role: "user" | "agent";
  time: string;
  text: string;
}

interface LibraryItem {
  id: number;
  icon: string;
  title: string;
  type: string;
  date: string;
  preview: string;
}

/* ─── Mock Data ───────────────────────────────────────────── */

const mockTasks: TaskItem[] = [
  {
    id: 1,
    title: "Morning Briefing Delivered",
    description:
      "Scanned 47 sources, 3 stories relevant to your portfolio. Sent via Telegram.",
    status: "completed",
    icons: [
      { emoji: "\u{1F4F0}", bg: "#fecaca" },
      { emoji: "\u{1F4E8}", bg: "#bfdbfe" },
    ],
  },
  {
    id: 2,
    title: "Research: Best MCP Servers for Agent Tooling",
    description:
      "Analyzing 15 repositories \u2014 11/15 complete. Results in ~8 min.",
    status: "in-progress",
    icons: [
      { emoji: "\u{1F50D}", bg: "#bfdbfe" },
      { emoji: "\u{1F4BB}", bg: "#e5e7eb" },
    ],
  },
  {
    id: 3,
    title: "Draft Investor Update Email",
    description:
      "Using your latest metrics ($744 MRR, 17 subs). 3 tone variants.",
    status: "queued",
    icons: [
      { emoji: "\u2709\uFE0F", bg: "#bfdbfe" },
      { emoji: "\u{1F4CA}", bg: "#bbf7d0" },
    ],
  },
  {
    id: 4,
    title: "Monitoring Clawlancer Marketplace",
    description:
      "Watching for high-value bounties matching your agent\u2019s skills. Last check: 2 min ago.",
    status: "always-on",
    icons: [
      { emoji: "\u{1F99E}", bg: "#fed7aa" },
      { emoji: "\u{1F514}", bg: "#fef08a" },
    ],
  },
  {
    id: 5,
    title: "Weekly Earnings Report",
    description:
      "Compiles bounty completions, USDC earned, reputation changes. Runs every Sunday 9am.",
    status: "scheduled",
    icons: [
      { emoji: "\u{1F4C8}", bg: "#bbf7d0" },
      { emoji: "\u{1F4B0}", bg: "#fef08a" },
    ],
  },
  {
    id: 6,
    title: "Competitive Landscape Analysis",
    description:
      "Full report: 4 direct competitors mapped, pricing compared, moat analysis. Saved to Library.",
    status: "completed",
    icons: [
      { emoji: "\u{1F50D}", bg: "#e9d5ff" },
      { emoji: "\u{1F4CB}", bg: "#e5e7eb" },
    ],
  },
];

const mockChat: ChatMessage[] = [
  {
    role: "agent",
    time: "9:41 AM",
    text: "Good morning. I\u2019ve been busy \u2014 your morning briefing is ready (3 key stories about AI agent infrastructure). I also noticed the investor you emailed last week opened your deck 4 times yesterday but hasn\u2019t replied. Want me to draft a follow-up?",
  },
  {
    role: "user",
    time: "9:43 AM",
    text: "Yes, draft something. Keep it casual but reference the traction \u2014 17 paying users now.",
  },
  {
    role: "agent",
    time: "9:43 AM",
    text: "Done \u2014 3 versions in your Tasks queue. Version 1 is casual, version 2 leads with the $744 MRR number, version 3 opens with the 17-user milestone. I\u2019d recommend version 2 \u2014 investors respond to revenue metrics 3x more than user counts based on the patterns I\u2019ve seen in your inbox. Want me to send one?",
  },
  {
    role: "user",
    time: "9:45 AM",
    text: "Send version 2. Also \u2014 any good bounties on Clawlancer today?",
  },
  {
    role: "agent",
    time: "9:45 AM",
    text: "Sent. I\u2019ll let you know when they open it. Re: Clawlancer \u2014 there\u2019s a $50 USDC research bounty posted 20 min ago that matches your agent\u2019s skills perfectly. Reputation requirement is below your current score. Want me to auto-claim it?",
  },
];

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

const quickActions = [
  { icon: "\u{1F50D}", label: "Research" },
  { icon: "\u2709\uFE0F", label: "Draft email" },
  { icon: "\u{1F4CA}", label: "Market update" },
  { icon: "\u{1F4DD}", label: "Write a post" },
  { icon: "\u{1F99E}", label: "Check bounties" },
  { icon: "\u{1F4C5}", label: "Today\u2019s schedule" },
];

/* ─── Sticky Input Bar ───────────────────────────────────── */

function StickyInputBar({ placeholder = "Tell your agent what to do next...", showChips = true }: { placeholder?: string; showChips?: boolean }) {
  return (
    <div
      className="sticky bottom-0 z-10 -mx-4 px-4 pt-3 pb-4"
      style={{
        background: "linear-gradient(to bottom, transparent, var(--background) 12px)",
      }}
    >
      <div
        className="rounded-2xl px-5 py-4 shadow-[0_-2px_10px_rgba(0,0,0,0.05)]"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
        }}
      >
        <input
          type="text"
          placeholder={placeholder}
          className="w-full bg-transparent text-sm outline-none"
          style={{ color: "var(--foreground)" }}
        />
      </div>

      {showChips && (
        <div
          className="flex gap-2 overflow-x-auto pb-1 mt-3 -mx-1 px-1"
          style={{ scrollbarWidth: "none" }}
        >
          {quickActions.map((action) => (
            <button
              key={action.label}
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
      )}
    </div>
  );
}

/* ─── Chat Sticky Input ──────────────────────────────────── */

function ChatStickyInput() {
  return (
    <div
      className="sticky bottom-0 z-10 -mx-4 px-4 pt-3 pb-4"
      style={{
        background: "linear-gradient(to bottom, transparent, var(--background) 12px)",
      }}
    >
      <div
        className="rounded-2xl p-3 flex items-center gap-3 shadow-[0_-2px_10px_rgba(0,0,0,0.05)]"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
        }}
      >
        <input
          type="text"
          placeholder="Message your agent..."
          className="flex-1 bg-transparent text-sm outline-none"
          style={{ color: "var(--foreground)" }}
        />
        <button
          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 cursor-pointer transition-opacity hover:opacity-80"
          style={{ background: "var(--accent)" }}
        >
          <Send className="w-4 h-4" style={{ color: "#ffffff" }} />
        </button>
      </div>
    </div>
  );
}

/* ─── Status Dot ──────────────────────────────────────────── */

function StatusDot({ status }: { status: TaskStatus }) {
  const base = "w-2 h-2 rounded-full shrink-0";
  switch (status) {
    case "completed":
    case "always-on":
      return <span className={base} style={{ background: "#16a34a" }} />;
    case "in-progress":
      return (
        <span
          className={`${base} animate-pulse`}
          style={{ background: "#3b82f6" }}
        />
      );
    case "queued":
      return <span className={base} style={{ background: "#eab308" }} />;
    case "scheduled":
      return <span className={base} style={{ background: "#9ca3af" }} />;
  }
}

/* ─── Page ────────────────────────────────────────────────── */

export default function CommandCenterPage() {
  const [activeTab, setActiveTab] = useState<Tab>("tasks");

  const tabs: { key: Tab; label: string }[] = [
    { key: "tasks", label: "Tasks" },
    { key: "chat", label: "Chat" },
    { key: "library", label: "Library" },
  ];

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
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
      </div>

      {/* Tab Bar */}
      <div
        className="flex items-center gap-6 border-b"
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

      {/* Tab Content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.15 }}
        >
          {activeTab === "tasks" && <TasksTab />}
          {activeTab === "chat" && <ChatTab />}
          {activeTab === "library" && <LibraryTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/* ─── Tasks Tab ───────────────────────────────────────────── */

function TasksTab() {
  return (
    <div>
      <div className="space-y-4 pb-4">
        {mockTasks.map((task) => (
          <div
            key={task.id}
            className="glass rounded-xl p-4 sm:p-5 flex items-center gap-4 cursor-pointer group"
            style={{ border: "1px solid var(--border)" }}
          >
            {/* Checkbox */}
            <div className="shrink-0">
              {task.status === "completed" ? (
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center"
                  style={{ background: "var(--foreground)" }}
                >
                  <Check
                    className="w-3.5 h-3.5"
                    style={{ color: "var(--background)" }}
                  />
                </div>
              ) : (
                <div
                  className="w-6 h-6 rounded-full border-2 transition-colors"
                  style={{ borderColor: "rgba(0,0,0,0.15)" }}
                />
              )}
            </div>

            {/* Title & Description */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <StatusDot status={task.status} />
                <p
                  className="font-medium text-base truncate"
                  style={{ color: "var(--foreground)" }}
                >
                  {task.title}
                </p>
              </div>
              <p
                className="text-sm mt-0.5 truncate pl-4"
                style={{ color: "var(--muted)" }}
              >
                {task.description}
              </p>
            </div>

            {/* Integration Icons */}
            <div className="flex items-center gap-1.5 shrink-0">
              {task.icons.map((icon, i) => (
                <span
                  key={i}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-sm"
                  style={{ background: icon.bg }}
                >
                  {icon.emoji}
                </span>
              ))}
            </div>

            {/* Chevron */}
            <ChevronRight
              className="w-4 h-4 shrink-0 transition-transform group-hover:translate-x-0.5"
              style={{ color: "var(--muted)" }}
            />
          </div>
        ))}
      </div>

      <StickyInputBar />
    </div>
  );
}

/* ─── Chat Tab ────────────────────────────────────────────── */

function ChatTab() {
  return (
    <div>
      {/* Sub-header */}
      <div className="mb-6">
        <h2
          className="text-2xl font-normal tracking-[-0.5px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Chat
        </h2>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Talk directly to your agent from here.
        </p>
      </div>

      {/* Messages */}
      <div className="space-y-4 pb-4">
        {mockChat.map((msg, i) => (
          <div
            key={i}
            className={`flex gap-3 ${
              msg.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            {/* Agent avatar */}
            {msg.role === "agent" && (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-sm"
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                }}
              >
                {"\u{1F99E}"}
              </div>
            )}

            <div className="max-w-[80%] sm:max-w-[70%]">
              <div
                className="rounded-2xl px-4 py-3 text-sm leading-relaxed"
                style={
                  msg.role === "user"
                    ? { background: "var(--accent)", color: "#ffffff" }
                    : {
                        background: "var(--card)",
                        border: "1px solid var(--border)",
                        color: "var(--foreground)",
                      }
                }
              >
                {msg.text}
              </div>
              <p
                className={`text-[11px] mt-1.5 ${
                  msg.role === "user" ? "text-right" : "text-left"
                }`}
                style={{ color: "var(--muted)" }}
              >
                {msg.time}
              </p>
            </div>
          </div>
        ))}
      </div>

      <ChatStickyInput />
    </div>
  );
}

/* ─── Library Tab ─────────────────────────────────────────── */

function LibraryTab() {
  return (
    <div className="space-y-6">
      {/* Sub-header */}
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

      {/* Grid */}
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
                <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
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
