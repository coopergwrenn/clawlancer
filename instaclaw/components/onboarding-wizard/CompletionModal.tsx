"use client";

import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { PartyPopper, Zap, Clock, MessageSquare, MessageCircle, Loader2 } from "lucide-react";

interface CompletionModalProps {
  gmailConnected: boolean;
  /**
   * 2026-05-22 FIX B — the user's Telegram bot username (e.g.,
   * "myagent_bot"). Drives the prominent "Open your bot in Telegram"
   * CTA at the top of the modal. When null/empty, the CTA is suppressed
   * (e.g., for Discord-only users — they wouldn't have a Telegram bot).
   * Plumbed from OnboardingWizard's `state.botUsername`.
   */
  telegramBotUsername: string | null;
  onDone: () => void;
  onSuggestion: (action: string) => void;
}

interface Suggestion {
  icon: typeof Zap;
  label: string;
  description: string;
}

const DEFAULT_SUGGESTIONS: Suggestion[] = [
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
];

const FALLBACK_SUGGESTION: Suggestion = {
  icon: MessageSquare,
  label: "What can you help me with?",
  description: "Start a conversation with your agent",
};

export default function CompletionModal({ gmailConnected, telegramBotUsername, onDone, onSuggestion }: CompletionModalProps) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>(DEFAULT_SUGGESTIONS);
  const [loading, setLoading] = useState(gmailConnected);

  // Fetch personalized suggestions if Gmail is connected
  useEffect(() => {
    if (!gmailConnected) return;

    (async () => {
      try {
        const res = await fetch("/api/onboarding/suggested-tasks");
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (data.suggestions?.length === 2) {
          setSuggestions([
            { icon: Zap, label: data.suggestions[0].label, description: data.suggestions[0].description },
            { icon: Clock, label: data.suggestions[1].label, description: data.suggestions[1].description },
          ]);
        }
      } catch {
        // Fall back to defaults silently
      } finally {
        setLoading(false);
      }
    })();
  }, [gmailConnected]);

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
        {/* Confetti icon */}
        <motion.div
          className="w-16 h-16 rounded-2xl mx-auto mb-5 flex items-center justify-center"
          style={{
            background: "rgba(0,0,0,0.04)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06), 0 0 0 1px rgba(255,255,255,0.5) inset",
          }}
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
          Your agent is ready and waiting. The more you use it, the smarter it gets.
        </p>

        {/* 2026-05-22 FIX B — prominent "Open your bot in Telegram" CTA.
            Deep link includes ?start=start which auto-sends /start the
            moment the chat opens — so the user lands in Telegram with
            their agent already responding to the first message. Eliminates
            the "now what do I type?" moment Charlie's beta test flagged.
            Suppressed for Discord-only users (no telegram bot to link to). */}
        {telegramBotUsername && (
          <a
            href={`https://t.me/${telegramBotUsername}?start=start`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2.5 mb-4 w-full px-5 py-3.5 rounded-xl text-base font-semibold transition-all cursor-pointer hover:opacity-95 active:scale-[0.99]"
            style={{
              background:
                "linear-gradient(135deg, rgba(38,165,228,0.95), rgba(34,153,217,1))",
              color: "#ffffff",
              boxShadow:
                "rgba(255,255,255,0.25) 0px -1px 1px 0px inset, rgba(38,165,228,0.4) 0px 6px 18px -2px",
            }}
          >
            {/* Telegram paper-plane logo — inlined SVG, no extra dep. */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71l-4.13-3.05-1.99 1.93c-.23.23-.42.42-.84.42z" />
            </svg>
            Open your bot in Telegram
          </a>
        )}

        <p
          className="text-xs text-center mb-5"
          style={{ color: "var(--muted)" }}
        >
          Or try one of these to get started:
        </p>

        {/* Pro tip callout */}
        <div
          className="rounded-xl px-4 py-3.5 mb-4 flex items-start gap-3"
          style={{
            background: "rgba(220,103,67,0.06)",
            border: "1px solid rgba(220,103,67,0.15)",
          }}
        >
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
            style={{ background: "rgba(220,103,67,0.12)" }}
          >
            <MessageCircle className="w-4 h-4" style={{ color: "var(--accent)" }} />
          </div>
          <div>
            <div className="text-sm font-medium mb-0.5" style={{ color: "var(--foreground)" }}>
              The best way to use InstaClaw
            </div>
            <div className="text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
              Message your agent through <strong style={{ color: "var(--foreground)" }}>Telegram</strong> or your connected platform for the best experience. Just tell it what you need and it handles everything, only checking in when it needs your input. Coming this week: our <strong style={{ color: "var(--foreground)" }}>iOS app</strong> puts the full Command Center in your pocket.
            </div>
          </div>
        </div>

        {/* Suggestions */}
        <div className="space-y-2">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--muted)" }} />
              <span className="text-xs" style={{ color: "var(--muted)" }}>
                Personalizing suggestions for you...
              </span>
            </div>
          ) : (
            <>
              {suggestions.map((s) => (
                <button
                  key={s.label}
                  onClick={() => onSuggestion(s.label)}
                  className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-left cursor-pointer transition-all hover:bg-black/[0.03] active:scale-[0.98]"
                  style={{
                    border: "1px solid rgba(0,0,0,0.08)",
                    background: "rgba(255,255,255,0.5)",
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
              <button
                onClick={() => onSuggestion(FALLBACK_SUGGESTION.label)}
                className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl text-left cursor-pointer transition-all hover:bg-black/[0.03] active:scale-[0.98]"
                style={{
                  border: "1px solid rgba(0,0,0,0.08)",
                  background: "rgba(255,255,255,0.5)",
                }}
              >
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: "rgba(0,0,0,0.04)" }}
                >
                  <FALLBACK_SUGGESTION.icon className="w-4 h-4" style={{ color: "var(--foreground)" }} />
                </div>
                <div className="min-w-0">
                  <div
                    className="text-sm font-medium truncate"
                    style={{ color: "var(--foreground)" }}
                  >
                    {FALLBACK_SUGGESTION.label}
                  </div>
                  <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                    {FALLBACK_SUGGESTION.description}
                  </div>
                </div>
              </button>
            </>
          )}
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
