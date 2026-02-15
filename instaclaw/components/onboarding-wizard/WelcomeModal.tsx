"use client";

import { motion } from "motion/react";
import { Sparkles } from "lucide-react";

interface WelcomeModalProps {
  botConnected: boolean;
  onActivateBot: () => void;
  onSkip: () => void;
}

export default function WelcomeModal({ botConnected, onActivateBot, onSkip }: WelcomeModalProps) {
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
          background: "rgba(255, 255, 255, 0.82)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(255, 255, 255, 0.5)",
          boxShadow:
            "0 24px 64px rgba(0,0,0,0.12), 0 0 0 1px rgba(255,255,255,0.3) inset, 0 -2px 6px rgba(255,255,255,0.4) inset",
        }}
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
      >
        {/* Icon */}
        <div
          className="w-16 h-16 rounded-2xl mx-auto mb-5 flex items-center justify-center"
          style={{
            background: "rgba(0,0,0,0.04)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 0 0 1px rgba(255,255,255,0.5) inset",
          }}
        >
          <Sparkles className="w-8 h-8" style={{ color: "var(--foreground)" }} />
        </div>

        <h2
          className="text-2xl font-normal tracking-[-0.5px] mb-2"
          style={{ fontFamily: "var(--font-serif)", color: "var(--foreground)" }}
        >
          Welcome to InstaClaw
        </h2>

        {botConnected ? (
          <>
            <p className="text-sm mb-3 leading-relaxed" style={{ color: "var(--muted)" }}>
              Your personal AI agent is deployed and your Telegram bot is
              already connected. You&apos;re good to go.
            </p>
            <p className="text-xs mb-8 leading-relaxed" style={{ color: "var(--muted)", opacity: 0.8 }}>
              Let&apos;s take a quick 30-second tour so you know where
              everything is.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm mb-3 leading-relaxed" style={{ color: "var(--muted)" }}>
              Your personal AI agent is deployed and ready to work. There&apos;s
              just one quick thing left: activating your Telegram bot so your
              agent can message you directly.
            </p>
            <p className="text-xs mb-8 leading-relaxed" style={{ color: "var(--muted)", opacity: 0.8 }}>
              After that, we&apos;ll give you a 30-second tour of the dashboard
              so you know where everything is.
            </p>
          </>
        )}

        {/* CTA */}
        <button
          onClick={onActivateBot}
          className="w-full py-3.5 rounded-xl text-sm font-medium cursor-pointer transition-all hover:opacity-90 active:scale-[0.98]"
          style={{ background: "var(--foreground)", color: "var(--background)" }}
        >
          {botConnected ? "Show Me Around" : "Activate My Bot"}
        </button>

        {/* Skip */}
        <button
          onClick={onSkip}
          className="mt-4 text-xs cursor-pointer transition-opacity hover:opacity-70"
          style={{ color: "var(--muted)" }}
        >
          {botConnected ? "I\u2019ll explore on my own" : "I\u2019ll do this later"}
        </button>
      </motion.div>
    </motion.div>
  );
}
