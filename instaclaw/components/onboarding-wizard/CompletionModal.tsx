"use client";

import { motion } from "motion/react";
import { PartyPopper, Zap, Clock, MessageSquare, MessageCircle } from "lucide-react";

interface CompletionModalProps {
  onDone: () => void;
  onSuggestion: (action: string) => void;
}

const suggestions = [
  {
    icon: Zap,
    label: "Summarize today's tech news",
    description: "Try a quick one-off task",
  },
  {
    icon: Clock,
    label: "Every morning, brief me on AI news",
    description: "Set up a recurring daily task",
  },
  {
    icon: MessageSquare,
    label: "What can you help me with?",
    description: "Start a conversation with your agent",
  },
];

export default function CompletionModal({ onDone, onSuggestion }: CompletionModalProps) {
  return (
    <motion.div
      className="fixed inset-0 z-[9999] flex items-center justify-center px-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

      {/* Modal */}
      <motion.div
        className="relative w-full max-w-md rounded-2xl p-8"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.15)",
        }}
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
      >
        {/* Confetti icon */}
        <motion.div
          className="w-16 h-16 rounded-2xl mx-auto mb-5 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.05)" }}
          initial={{ rotate: -10 }}
          animate={{ rotate: 0 }}
          transition={{ type: "spring", stiffness: 200 }}
        >
          <PartyPopper className="w-8 h-8" style={{ color: "var(--foreground)" }} />
        </motion.div>

        <h2
          className="text-2xl font-normal tracking-[-0.5px] mb-2 text-center"
          style={{ fontFamily: "var(--font-serif)", color: "var(--foreground)" }}
        >
          You&apos;re All Set!
        </h2>

        <p
          className="text-sm text-center mb-5 leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          Your agent is ready and waiting. Here are a few things you can try right now:
        </p>

        {/* Pro tip callout */}
        <div
          className="rounded-xl px-4 py-3.5 mb-4 flex items-start gap-3"
          style={{
            background: "rgba(220,103,67,0.08)",
            border: "1px solid rgba(220,103,67,0.2)",
          }}
        >
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
            style={{ background: "rgba(220,103,67,0.15)" }}
          >
            <MessageCircle className="w-4 h-4" style={{ color: "var(--accent)" }} />
          </div>
          <div>
            <div className="text-sm font-medium mb-0.5" style={{ color: "var(--foreground)" }}>
              The best way to use InstaClaw
            </div>
            <div className="text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
              Want to install a skill, connect an API, or set something up? Just message your agent in <strong style={{ color: "var(--foreground)" }}>Telegram</strong> (or your preferred channel) and tell it what you want. It&apos;ll figure it out and ask you if it needs help along the way.
            </div>
          </div>
        </div>

        {/* Suggestions */}
        <div className="space-y-2">
          {suggestions.map((s) => (
            <button
              key={s.label}
              onClick={() => onSuggestion(s.label)}
              className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-left cursor-pointer transition-all hover:bg-black/[0.03] active:scale-[0.98]"
              style={{
                border: "1px solid var(--border)",
              }}
            >
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                style={{ background: "rgba(0,0,0,0.04)" }}
              >
                <s.icon className="w-4 h-4" style={{ color: "var(--foreground)" }} />
              </div>
              <div className="min-w-0">
                <div
                  className="text-sm font-medium truncate"
                  style={{ color: "var(--foreground)" }}
                >
                  {s.label}
                </div>
                <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                  {s.description}
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Close */}
        <button
          onClick={onDone}
          className="w-full mt-5 py-3.5 rounded-xl text-sm font-medium cursor-pointer transition-all hover:opacity-90 active:scale-[0.98]"
          style={{ background: "var(--foreground)", color: "var(--background)" }}
        >
          Close &amp; Start Using InstaClaw
        </button>
      </motion.div>
    </motion.div>
  );
}
