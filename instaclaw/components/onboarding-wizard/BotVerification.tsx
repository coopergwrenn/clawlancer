"use client";

import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { CheckCircle, ExternalLink, Loader2 } from "lucide-react";

interface BotVerificationProps {
  botUsername: string | null;
  onVerified: () => void;
  onSkip: () => void;
}

export default function BotVerification({
  botUsername,
  onVerified,
  onSkip,
}: BotVerificationProps) {
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const poll = async () => {
      if (!mountedRef.current) return;
      setChecking(true);
      try {
        const res = await fetch("/api/onboarding/check-bot-status");
        if (!res.ok) return;
        const data = await res.json();
        if (data.connected && mountedRef.current) {
          setConnected(true);
          if (intervalRef.current) clearInterval(intervalRef.current);
        }
      } catch {
        // silently retry
      } finally {
        if (mountedRef.current) setChecking(false);
      }
    };

    // Start polling every 3s
    poll();
    intervalRef.current = setInterval(poll, 3000);

    return () => {
      mountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Auto-advance 1.5s after connection detected
  useEffect(() => {
    if (!connected) return;
    const t = setTimeout(onVerified, 1500);
    return () => clearTimeout(t);
  }, [connected, onVerified]);

  const telegramUrl = botUsername
    ? `https://t.me/${botUsername}`
    : null;

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
        {connected ? (
          /* Success state */
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 500, damping: 25 }}
          >
            <div className="w-16 h-16 rounded-full mx-auto mb-5 flex items-center justify-center bg-emerald-50">
              <CheckCircle className="w-8 h-8 text-emerald-500" />
            </div>
            <h2
              className="text-2xl font-normal tracking-[-0.5px] mb-2"
              style={{ fontFamily: "var(--font-serif)", color: "var(--foreground)" }}
            >
              You&apos;re Connected!
            </h2>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              Perfect — your agent can now send you results on Telegram. Let&apos;s show you around...
            </p>
          </motion.div>
        ) : (
          /* Waiting state */
          <>
            {/* Pulsing Telegram icon */}
            <div className="relative w-16 h-16 mx-auto mb-5">
              <div
                className="absolute inset-0 rounded-full animate-ping opacity-20"
                style={{ background: "#0088cc" }}
              />
              <div
                className="relative w-16 h-16 rounded-full flex items-center justify-center"
                style={{ background: "#0088cc" }}
              >
                <svg viewBox="0 0 24 24" className="w-8 h-8 fill-white">
                  <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
                </svg>
              </div>
            </div>

            <h2
              className="text-2xl font-normal tracking-[-0.5px] mb-3"
              style={{ fontFamily: "var(--font-serif)", color: "var(--foreground)" }}
            >
              Activate Your Telegram Bot
            </h2>

            <p className="text-sm mb-4 leading-relaxed" style={{ color: "var(--muted)" }}>
              Your bot is already created — you just need to open it and send
              one message to link it to your agent.
            </p>

            {/* Step-by-step instructions */}
            <div
              className="text-left rounded-xl p-4 mb-5 space-y-3"
              style={{ background: "rgba(0,0,0,0.03)" }}
            >
              <div className="flex gap-3">
                <span className="text-xs font-semibold shrink-0 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: "var(--foreground)", color: "var(--background)" }}>1</span>
                <p className="text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                  Open Telegram and go back to your <strong style={{ color: "var(--foreground)" }}>BotFather</strong> chat
                </p>
              </div>
              <div className="flex gap-3">
                <span className="text-xs font-semibold shrink-0 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: "var(--foreground)", color: "var(--background)" }}>2</span>
                <p className="text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                  Find the message that says <strong style={{ color: "var(--foreground)" }}>&quot;Done! Congratulations on your new bot.&quot;</strong>
                </p>
              </div>
              <div className="flex gap-3">
                <span className="text-xs font-semibold shrink-0 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: "var(--foreground)", color: "var(--background)" }}>3</span>
                <p className="text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                  Tap the <strong style={{ color: "var(--foreground)" }}>t.me/{botUsername || "your_bot"}</strong> link in that message to open your bot
                </p>
              </div>
              <div className="flex gap-3">
                <span className="text-xs font-semibold shrink-0 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: "var(--foreground)", color: "var(--background)" }}>4</span>
                <p className="text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
                  Send any message — even just <strong style={{ color: "var(--foreground)" }}>&quot;hi&quot;</strong> — and we&apos;ll detect it automatically
                </p>
              </div>
            </div>

            {/* Direct link as alternative */}
            {telegramUrl && (
              <div className="mb-1">
                <p className="text-[11px] mb-2" style={{ color: "var(--muted)", opacity: 0.7 }}>
                  Or open your bot directly:
                </p>
                <a
                  href={telegramUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium text-white cursor-pointer transition-all hover:opacity-90 active:scale-[0.98]"
                  style={{ background: "#0088cc" }}
                >
                  Open @{botUsername} in Telegram
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            )}

            {/* Polling indicator */}
            <div className="flex items-center justify-center gap-2 mt-5">
              {checking ? (
                <Loader2
                  className="w-3.5 h-3.5 animate-spin"
                  style={{ color: "var(--muted)" }}
                />
              ) : (
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: "var(--muted)", opacity: 0.4 }}
                />
              )}
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                Listening for your message...
              </span>
            </div>

            {/* Skip */}
            <button
              onClick={onSkip}
              className="mt-4 text-xs cursor-pointer transition-opacity hover:opacity-70"
              style={{ color: "var(--muted)" }}
            >
              Skip for now
            </button>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}
