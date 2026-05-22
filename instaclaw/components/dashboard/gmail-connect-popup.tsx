"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, Mail, ShieldAlert, Sparkles } from "lucide-react";

type Phase =
  | "prompt"
  | "loading"
  | "insights"
  | "summary"
  | "error";

const BUBBLE_COLORS = [
  "radial-gradient(circle at 35% 30%, rgba(34,197,94,0.7), rgba(34,197,94,0.35) 50%, rgba(22,163,74,0.7) 100%)",
  "radial-gradient(circle at 35% 30%, rgba(147,51,234,0.7), rgba(147,51,234,0.35) 50%, rgba(126,34,206,0.7) 100%)",
  "radial-gradient(circle at 35% 30%, rgba(59,130,246,0.7), rgba(59,130,246,0.35) 50%, rgba(37,99,235,0.7) 100%)",
  "radial-gradient(circle at 35% 30%, rgba(6,182,212,0.7), rgba(6,182,212,0.35) 50%, rgba(8,145,178,0.7) 100%)",
];

const BUBBLE_SHADOWS = [
  "rgba(34,197,94,0.35) 0px 4px 12px 0px",
  "rgba(147,51,234,0.35) 0px 4px 12px 0px",
  "rgba(59,130,246,0.35) 0px 4px 12px 0px",
  "rgba(6,182,212,0.35) 0px 4px 12px 0px",
];

interface GmailConnectPopupProps {
  gmailConnected: boolean;
  gmailPopupDismissed: boolean;
  /**
   * 2026-05-22: feature flag from /api/vm/status. When false (the default
   * when GMAIL_POPUP_DISABLED env var is not "true"), the Gmail card in
   * the prompt phase is rendered grayed out with a "temporarily unavailable
   * — back soon" tag. ChatGPT remains fully active. This lets us toggle
   * Gmail personalization on/off without code changes whenever the Google
   * verification status changes.
   */
  gmailPersonalizationEnabled: boolean;
  /**
   * Callback to open the ChatGPTConnectModal. Triggered by the ChatGPT
   * card's primary CTA in the new dual-option prompt phase. The parent
   * (dashboard/page.tsx) owns the modal's open state since it already
   * owns several other modals; this keeps modal ownership in one place.
   */
  onOpenChatGPT: () => void;
  onClose: () => void;
  onConnected: () => void;
}

export function GmailConnectPopup({
  gmailConnected,
  gmailPopupDismissed,
  gmailPersonalizationEnabled,
  onOpenChatGPT,
  onClose,
  onConnected,
}: GmailConnectPopupProps) {
  const [phase, setPhase] = useState<Phase>("prompt");
  const [insights, setInsights] = useState<string[]>([]);
  const [summary, setSummary] = useState("");
  const [cards, setCards] = useState<{ title: string; description: string }[]>([]);
  const [currentInsight, setCurrentInsight] = useState(0);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);

  // Determine if popup should show
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmailReady = params.get("gmail_ready") === "1";
    const gmailError = params.get("gmail_error");

    if (gmailReady) {
      // Just came back from OAuth — show popup in loading mode
      window.history.replaceState({}, "", "/dashboard");
      setVisible(true);
      fetchInsights();
    } else if (gmailError) {
      window.history.replaceState({}, "", "/dashboard");
      setVisible(true);
      if (gmailError === "csrf") {
        setError("Security check failed. Please try again.");
      } else {
        setError("Failed to connect Gmail. Please try again.");
      }
      setPhase("error");
    } else if (!gmailConnected && !gmailPopupDismissed) {
      // Show the prompt popup
      setVisible(true);
    }
  }, [gmailConnected, gmailPopupDismissed]);

  // Fetch insights from API
  const fetchInsights = useCallback(async () => {
    setPhase("loading");
    setProgress(0);

    const progressInterval = setInterval(() => {
      setProgress((p) => Math.min(p + 2, 85));
    }, 200);

    try {
      const res = await fetch("/api/onboarding/gmail-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      clearInterval(progressInterval);

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to analyze Gmail");
      }

      const data = await res.json();
      setProgress(100);
      setInsights(data.insights);
      setSummary(data.summary);
      setCards(data.cards);

      // Sync MEMORY.md to VM in the background (with retry)
      syncMemoryToVM();

      setTimeout(() => {
        setPhase("insights");
        setCurrentInsight(0);
      }, 500);
    } catch (err) {
      clearInterval(progressInterval);
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPhase("error");
    }
  }, []);

  // Sync MEMORY.md to VM — fire-and-forget with automatic retry
  const syncMemoryToVM = useCallback(async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch("/api/vm/sync-memory", { method: "POST" });
        if (res.ok) return;
      } catch {
        // Retry
      }
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }, []);

  // Animate insights one by one
  useEffect(() => {
    if (phase !== "insights") return;
    if (currentInsight >= insights.length) {
      const timer = setTimeout(() => setPhase("summary"), 1000);
      return () => clearTimeout(timer);
    }

    const timer = setTimeout(() => {
      setCurrentInsight((c) => c + 1);
    }, 1500);

    return () => clearTimeout(timer);
  }, [phase, currentInsight, insights.length]);

  function handleConnect() {
    window.location.href = "/api/gmail/connect";
  }

  function handleDismiss() {
    fetch("/api/gmail/dismiss", { method: "POST" }).catch(() => {});
    setVisible(false);
    onClose();
    // Tell the onboarding wizard it can now show
    window.dispatchEvent(new Event("instaclaw:gmail-popup-closed"));
  }

  function handleDone() {
    fetch("/api/gmail/dismiss", { method: "POST" }).catch(() => {});
    setVisible(false);
    onConnected();
    // Tell the onboarding wizard it can now show
    window.dispatchEvent(new Event("instaclaw:gmail-popup-closed"));
  }

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
        onClick={phase === "prompt" || phase === "error" ? handleDismiss : undefined}
      />

      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.3 }}
        className="relative w-full max-w-lg rounded-2xl overflow-hidden"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.2)",
        }}
      >
        {/* Close button (only during prompt/error/summary phases) */}
        {(phase === "prompt" || phase === "error" || phase === "summary") && (
          <button
            onClick={phase === "summary" ? handleDone : handleDismiss}
            className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full transition-colors cursor-pointer z-10"
            style={{ background: "rgba(0,0,0,0.06)", color: "var(--muted)" }}
          >
            <X className="w-4 h-4" />
          </button>
        )}

        <div className="p-8">
          <AnimatePresence mode="wait">
            {/* ── PROMPT PHASE ───────────────────────────────────── */}
            {phase === "prompt" && (
              <motion.div
                key="prompt"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.3 }}
              >
                {/* ──────────────────────────────────────────────────────
                    2026-05-22 — dual-option personalization (Cooper-approved
                    spec). ChatGPT card first (active option, no scrolling
                    past disabled content). Responsive: stacked vertically
                    on mobile, side-by-side on desktop (md+ breakpoint).
                    Gmail card grays out (opacity 0.5, no grayscale) when
                    gmailPersonalizationEnabled is false — keeps icon
                    recognizable + shows "temporarily unavailable - back
                    soon" tag. Footer: low-weight "Maybe later" text link.
                ────────────────────────────────────────────────────────── */}

                <div className="text-center mb-7">
                  <h2
                    className="text-2xl mb-2"
                    style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
                  >
                    Personalize your agent
                  </h2>
                  <p
                    className="text-sm leading-relaxed max-w-sm mx-auto"
                    style={{ color: "var(--muted)" }}
                  >
                    Pick the integration that fits your style.
                  </p>
                </div>

                <div className="flex flex-col md:flex-row gap-3 mb-5">
                  {/* ─── ChatGPT card (always active, first/left) ──── */}
                  <button
                    onClick={() => {
                      // Close THIS popup before opening the ChatGPT modal so
                      // they don't stack visually. The dashboard owns the
                      // ChatGPT modal's open state via the onOpenChatGPT
                      // callback.
                      setVisible(false);
                      onOpenChatGPT();
                    }}
                    className="flex-1 text-left rounded-2xl p-5 transition-all cursor-pointer hover:scale-[1.01]"
                    style={{
                      background:
                        "linear-gradient(135deg, rgba(220,103,67,0.06), rgba(220,103,67,0.02))",
                      border: "1.5px solid rgba(220,103,67,0.25)",
                      boxShadow:
                        "rgba(220,103,67,0.08) 0px 4px 12px -2px, rgba(255,255,255,0.4) 0px -1px 1px 0px inset",
                    }}
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <div
                        className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                        style={{
                          background:
                            "linear-gradient(135deg, rgba(220,103,67,0.12), rgba(220,103,67,0.22))",
                          border: "1px solid rgba(220,103,67,0.18)",
                        }}
                      >
                        <Sparkles className="w-5 h-5" style={{ color: "#DC6743" }} />
                      </div>
                      <span
                        className="text-lg"
                        style={{
                          fontFamily: "var(--font-serif)",
                          fontWeight: 500,
                          color: "var(--foreground)",
                        }}
                      >
                        ChatGPT
                      </span>
                    </div>
                    <p
                      className="text-sm leading-relaxed mb-2.5"
                      style={{ color: "var(--foreground)" }}
                    >
                      Personalization plus a model switch to your own ChatGPT —
                      and we can import your conversation history into your
                      agent&apos;s memory.
                    </p>
                    <p
                      className="text-xs mb-4"
                      style={{ color: "var(--muted)", opacity: 0.85 }}
                    >
                      Best if you already use ChatGPT daily.
                    </p>
                    <div
                      className="text-sm font-semibold py-2 rounded-lg text-center"
                      style={{
                        background:
                          "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                        boxShadow:
                          "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(255,255,255,0.3) 0px -1px 1px 0px inset, rgba(220,103,67,0.3) 0px 3px 10px 0px",
                        color: "#ffffff",
                      }}
                    >
                      Connect ChatGPT
                    </div>
                  </button>

                  {/* ─── Gmail card (active when flag enabled, dimmed otherwise) ─── */}
                  {gmailPersonalizationEnabled ? (
                    <button
                      onClick={handleConnect}
                      className="flex-1 text-left rounded-2xl p-5 transition-all cursor-pointer hover:scale-[1.01]"
                      style={{
                        background: "rgba(255,255,255,0.5)",
                        border: "1.5px solid var(--border)",
                        boxShadow:
                          "rgba(0,0,0,0.04) 0px 4px 12px -2px, rgba(255,255,255,0.4) 0px -1px 1px 0px inset",
                      }}
                    >
                      <div className="flex items-center gap-3 mb-3">
                        <div
                          className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                          style={{
                            background:
                              "linear-gradient(135deg, rgba(220,103,67,0.08), rgba(220,103,67,0.14))",
                            border: "1px solid rgba(220,103,67,0.12)",
                          }}
                        >
                          <Mail className="w-5 h-5" style={{ color: "#DC6743" }} />
                        </div>
                        <span
                          className="text-lg"
                          style={{
                            fontFamily: "var(--font-serif)",
                            fontWeight: 500,
                            color: "var(--foreground)",
                          }}
                        >
                          Gmail
                        </span>
                      </div>
                      <p
                        className="text-sm leading-relaxed mb-2.5"
                        style={{ color: "var(--foreground)" }}
                      >
                        Personalization from your inbox patterns — your
                        communication style, recurring contacts, what you care
                        about. Only metadata is read.
                      </p>
                      <p
                        className="text-xs mb-4"
                        style={{ color: "var(--muted)", opacity: 0.85 }}
                      >
                        Best if you live in your inbox.
                      </p>
                      {/* Compact Google-warning hint, only when Gmail is actually clickable */}
                      <div
                        className="flex items-start gap-2 mb-3 px-2.5 py-2 rounded-lg"
                        style={{
                          background: "rgba(234,179,8,0.06)",
                          border: "1px solid rgba(234,179,8,0.18)",
                        }}
                      >
                        <ShieldAlert
                          className="w-3.5 h-3.5 shrink-0 mt-0.5"
                          style={{ color: "#ca8a04" }}
                        />
                        <p
                          className="text-xs leading-snug"
                          style={{ color: "#78716c" }}
                        >
                          Google will show an unverified-app warning.
                          Click <strong>Advanced</strong> →
                          <strong> Go to instaclaw.io</strong> to continue.
                        </p>
                      </div>
                      <div
                        className="text-sm font-semibold py-2 rounded-lg text-center"
                        style={{
                          background: "rgba(0,0,0,0.04)",
                          border: "1px solid var(--border)",
                          color: "var(--foreground)",
                        }}
                      >
                        Connect Gmail
                      </div>
                    </button>
                  ) : (
                    // Disabled state — fully visible (icon recognizable) but
                    // not interactive. Tag in place of the CTA so the
                    // alternative is obvious without scaring or apologizing.
                    <div
                      className="flex-1 text-left rounded-2xl p-5 cursor-not-allowed select-none"
                      style={{
                        background: "rgba(255,255,255,0.5)",
                        border: "1.5px solid var(--border)",
                        opacity: 0.5,
                      }}
                      aria-disabled="true"
                    >
                      <div className="flex items-center gap-3 mb-3">
                        <div
                          className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                          style={{
                            background:
                              "linear-gradient(135deg, rgba(220,103,67,0.08), rgba(220,103,67,0.14))",
                            border: "1px solid rgba(220,103,67,0.12)",
                          }}
                        >
                          <Mail className="w-5 h-5" style={{ color: "#DC6743" }} />
                        </div>
                        <span
                          className="text-lg"
                          style={{
                            fontFamily: "var(--font-serif)",
                            fontWeight: 500,
                            color: "var(--foreground)",
                          }}
                        >
                          Gmail
                        </span>
                      </div>
                      <p
                        className="text-sm leading-relaxed mb-2.5"
                        style={{ color: "var(--foreground)" }}
                      >
                        Personalization from your inbox patterns — your
                        communication style, recurring contacts, what you care
                        about. Only metadata is read.
                      </p>
                      <p
                        className="text-xs mb-4"
                        style={{ color: "var(--muted)", opacity: 0.85 }}
                      >
                        Best if you live in your inbox.
                      </p>
                      <div
                        className="text-xs font-medium py-2 rounded-lg text-center"
                        style={{
                          background: "rgba(0,0,0,0.04)",
                          border: "1px dashed var(--border)",
                          color: "var(--muted)",
                        }}
                      >
                        temporarily unavailable - back soon
                      </div>
                    </div>
                  )}
                </div>

                {/* Footer — low-weight "Maybe later" text link */}
                <div className="text-center">
                  <button
                    onClick={handleDismiss}
                    className="text-sm font-medium transition-opacity hover:opacity-70 cursor-pointer"
                    style={{
                      color: "var(--muted)",
                      background: "transparent",
                      border: "none",
                      padding: "8px 12px",
                    }}
                  >
                    Maybe later
                  </button>
                </div>
              </motion.div>
            )}

            {/* ── LOADING PHASE ──────────────────────────────────── */}
            {phase === "loading" && (
              <motion.div
                key="loading"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.3 }}
                className="text-center py-4"
              >
                <h2
                  className="text-xl mb-4"
                  style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
                >
                  Figuring you out...
                </h2>

                <p className="text-xs mb-6" style={{ color: "var(--muted)" }}>
                  Reading inbox patterns (metadata only, never full emails)
                </p>

                <div className="w-full max-w-xs mx-auto">
                  <div
                    className="h-2 rounded-full overflow-hidden"
                    style={{ background: "rgba(0,0,0,0.06)" }}
                  >
                    <motion.div
                      className="h-full rounded-full"
                      style={{
                        background: "linear-gradient(90deg, #c75a34, #DC6743, #e8845e)",
                      }}
                      animate={{ width: `${progress}%` }}
                      transition={{ duration: 0.3, ease: "easeOut" }}
                    />
                  </div>
                  <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
                    {progress}%
                  </p>
                </div>
              </motion.div>
            )}

            {/* ── INSIGHTS PHASE ─────────────────────────────────── */}
            {phase === "insights" && (
              <motion.div
                key="insights"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.3 }}
                className="text-center py-4"
              >
                {/* Progress dots */}
                <div className="flex justify-center gap-2 mb-8">
                  {insights.map((_, i) => (
                    <div
                      key={i}
                      className="w-2 h-2 rounded-full transition-all duration-300"
                      style={{
                        background:
                          i <= currentInsight ? "#DC6743" : "rgba(0,0,0,0.1)",
                        boxShadow:
                          i === currentInsight
                            ? "0 0 8px rgba(220,103,67,0.5)"
                            : "none",
                        transform:
                          i === currentInsight ? "scale(1.3)" : "scale(1)",
                      }}
                    />
                  ))}
                </div>

                <div className="min-h-[60px] flex items-center justify-center">
                  <AnimatePresence mode="wait">
                    {currentInsight < insights.length && (
                      <motion.p
                        key={currentInsight}
                        initial={{ opacity: 0, y: 20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -20, scale: 0.95 }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                        className="text-2xl font-medium tracking-tight"
                        style={{ fontFamily: "var(--font-serif)" }}
                      >
                        {insights[currentInsight]}
                      </motion.p>
                    )}
                  </AnimatePresence>
                </div>

                <div className="w-full max-w-xs mx-auto mt-8">
                  <div
                    className="h-1.5 rounded-full overflow-hidden"
                    style={{ background: "rgba(0,0,0,0.06)" }}
                  >
                    <motion.div
                      className="h-full rounded-full"
                      style={{
                        background: "linear-gradient(90deg, #c75a34, #DC6743, #e8845e)",
                      }}
                      animate={{
                        width: `${((currentInsight + 1) / insights.length) * 100}%`,
                      }}
                      transition={{ duration: 0.4, ease: "easeOut" }}
                    />
                  </div>
                </div>
              </motion.div>
            )}

            {/* ── SUMMARY PHASE ──────────────────────────────────── */}
            {phase === "summary" && (
              <motion.div
                key="summary"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.4 }}
              >
                <h2
                  className="text-xl text-center mb-6"
                  style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
                >
                  Your agent now knows you
                </h2>

                <div className="grid grid-cols-2 gap-3 mb-6">
                  {cards.map((card, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.1, duration: 0.3 }}
                      className="rounded-xl p-4"
                      style={{
                        background: "rgba(0,0,0,0.03)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      <div
                        className="w-6 h-6 rounded-full mb-2 relative overflow-hidden"
                        style={{
                          background: BUBBLE_COLORS[i % BUBBLE_COLORS.length],
                          boxShadow: BUBBLE_SHADOWS[i % BUBBLE_SHADOWS.length],
                        }}
                      >
                        <div
                          className="absolute inset-0 rounded-full"
                          style={{
                            background:
                              "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.5) 0%, transparent 50%)",
                          }}
                        />
                      </div>
                      <h3 className="text-xs font-semibold mb-0.5">
                        {card.title}
                      </h3>
                      <p
                        className="text-xs leading-relaxed"
                        style={{ color: "var(--muted)" }}
                      >
                        {card.description}
                      </p>
                    </motion.div>
                  ))}
                </div>

                {summary && (
                  <p
                    className="text-xs leading-relaxed mb-6 text-center"
                    style={{ color: "var(--muted)" }}
                  >
                    {summary.length > 200
                      ? summary.slice(0, 200) + "..."
                      : summary}
                  </p>
                )}

                <button
                  onClick={handleDone}
                  className="w-full px-6 py-3 rounded-xl text-sm font-semibold transition-all cursor-pointer"
                  style={{
                    background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                    boxShadow:
                      "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(255,255,255,0.3) 0px -1px 1px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px, rgba(255,255,255,0.08) 0px 0px 1.6px 4px inset",
                    color: "#ffffff",
                  }}
                >
                  Done
                </button>
              </motion.div>
            )}

            {/* ── ERROR PHASE ────────────────────────────────────── */}
            {phase === "error" && (
              <motion.div
                key="error"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.3 }}
                className="text-center py-4"
              >
                <h2
                  className="text-xl mb-3"
                  style={{ fontFamily: "var(--font-serif)", fontWeight: 400 }}
                >
                  Something went wrong
                </h2>

                <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>
                  {error}
                </p>

                <div className="flex flex-col gap-3 max-w-xs mx-auto">
                  <button
                    onClick={() => {
                      setPhase("prompt");
                      setError("");
                    }}
                    className="px-6 py-3 rounded-xl text-sm font-semibold transition-all cursor-pointer"
                    style={{
                      background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                      boxShadow:
                        "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(255,255,255,0.3) 0px -1px 1px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px",
                      color: "#ffffff",
                    }}
                  >
                    Try Again
                  </button>

                  <button
                    onClick={handleDismiss}
                    className="text-sm transition-opacity hover:opacity-70 cursor-pointer"
                    style={{ color: "var(--muted)" }}
                  >
                    Skip for now
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
