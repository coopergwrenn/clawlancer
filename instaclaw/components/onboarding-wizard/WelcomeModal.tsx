"use client";

import { motion } from "motion/react";
import { Sparkles } from "lucide-react";

interface WelcomeModalProps {
  onActivateBot: () => void;
  onSkip: () => void;
}

export default function WelcomeModal({ onActivateBot, onSkip }: WelcomeModalProps) {
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
        className="relative w-full max-w-md rounded-2xl p-8 text-center"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.15)",
        }}
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
      >
        {/* Icon */}
        <div
          className="w-16 h-16 rounded-2xl mx-auto mb-5 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.05)" }}
        >
          <Sparkles className="w-8 h-8" style={{ color: "var(--foreground)" }} />
        </div>

        <h2
          className="text-2xl font-normal tracking-[-0.5px] mb-2"
          style={{ fontFamily: "var(--font-serif)", color: "var(--foreground)" }}
        >
          Welcome to InstaClaw
        </h2>

        <p className="text-sm mb-3 leading-relaxed" style={{ color: "var(--muted)" }}>
          Your personal AI agent is live and ready to work for you. Let&apos;s
          get you set up in about 60 seconds.
        </p>

        <p className="text-xs mb-8 leading-relaxed" style={{ color: "var(--muted)", opacity: 0.8 }}>
          First, we&apos;ll connect your Telegram bot so your agent can send you
          results directly — then we&apos;ll give you a quick tour.
        </p>

        {/* CTA */}
        <button
          onClick={onActivateBot}
          className="w-full py-3.5 rounded-xl text-sm font-medium cursor-pointer transition-all hover:opacity-90 active:scale-[0.98]"
          style={{ background: "var(--foreground)", color: "var(--background)" }}
        >
          Let&apos;s Get Started
        </button>

        {/* Skip */}
        <button
          onClick={onSkip}
          className="mt-4 text-xs cursor-pointer transition-opacity hover:opacity-70"
          style={{ color: "var(--muted)" }}
        >
          I&apos;ll explore on my own
        </button>
      </motion.div>
    </motion.div>
  );
}
