"use client";

import { useState, useEffect, useCallback } from "react";
import { X } from "lucide-react";

type Phase = "loading" | "insights" | "summary" | "error";

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

interface GooglePersonalizationModalProps {
  onDone: () => void;
}

/**
 * Full-screen personalization modal shown after Google OAuth completes.
 * Calls the gmail-insights API via proxy, shows animated progress,
 * then displays insights and summary cards.
 *
 * Replicates instaclaw.io's GmailConnectPopup loading→insights→summary flow.
 */
export default function GooglePersonalizationModal({
  onDone,
}: GooglePersonalizationModalProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState(0);
  const [insights, setInsights] = useState<string[]>([]);
  const [summary, setSummary] = useState("");
  const [cards, setCards] = useState<{ title: string; description: string }[]>([]);
  const [currentInsight, setCurrentInsight] = useState(0);
  const [error, setError] = useState("");

  const fetchInsights = useCallback(async () => {
    setPhase("loading");
    setProgress(0);

    const progressInterval = setInterval(() => {
      setProgress((p) => Math.min(p + 2, 85));
    }, 200);

    try {
      const res = await fetch("/api/proxy/onboarding/gmail-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      clearInterval(progressInterval);

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to analyze Gmail");
      }

      const data = await res.json();
      setProgress(100);
      setInsights(data.insights || []);
      setSummary(data.summary || "");
      setCards(data.cards || []);

      setTimeout(() => {
        if (data.insights?.length > 0) {
          setPhase("insights");
          setCurrentInsight(0);
        } else {
          setPhase("summary");
        }
      }, 500);
    } catch (err) {
      clearInterval(progressInterval);
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPhase("error");
    }
  }, []);

  // Start fetching on mount
  useEffect(() => {
    fetchInsights();
  }, [fetchInsights]);

  // Animate insights one by one
  useEffect(() => {
    if (phase !== "insights") return;
    if (currentInsight >= insights.length) {
      const timer = setTimeout(() => setPhase("summary"), 1000);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => setCurrentInsight((c) => c + 1), 1500);
    return () => clearTimeout(timer);
  }, [phase, currentInsight, insights.length]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(8px)" }}
      />

      {/* Modal */}
      <div
        className="relative w-full max-w-sm rounded-2xl overflow-hidden animate-modal-in"
        style={{
          background: "#1a1a1a",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.4)",
        }}
      >
        {/* Close button on summary/error */}
        {(phase === "summary" || phase === "error") && (
          <button
            onClick={onDone}
            className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full z-10"
            style={{ background: "rgba(255,255,255,0.06)", color: "#888" }}
          >
            <X size={14} />
          </button>
        )}

        <div className="p-6">
          {/* ── LOADING PHASE ── */}
          {phase === "loading" && (
            <div className="text-center py-4 animate-fade-in">
              <h2
                className="text-lg mb-3"
                style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontWeight: 400, color: "#f5f5f5" }}
              >
                Figuring you out...
              </h2>
              <p className="text-xs mb-6" style={{ color: "#888" }}>
                Reading inbox patterns (metadata only, never full emails)
              </p>
              <div className="w-full max-w-xs mx-auto">
                <div
                  className="h-2 rounded-full overflow-hidden"
                  style={{ background: "rgba(255,255,255,0.06)" }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-300 ease-out"
                    style={{
                      width: `${progress}%`,
                      background: "linear-gradient(90deg, #c75a34, #DC6743, #e8845e)",
                    }}
                  />
                </div>
                <p className="text-xs mt-2" style={{ color: "#666" }}>{progress}%</p>
              </div>
            </div>
          )}

          {/* ── INSIGHTS PHASE ── */}
          {phase === "insights" && (
            <div className="text-center py-4 animate-fade-in">
              {/* Progress dots */}
              <div className="flex justify-center gap-2 mb-8">
                {insights.map((_, i) => (
                  <div
                    key={i}
                    className="w-2 h-2 rounded-full transition-all duration-300"
                    style={{
                      background: i <= currentInsight ? "#DC6743" : "rgba(255,255,255,0.1)",
                      boxShadow: i === currentInsight ? "0 0 8px rgba(220,103,67,0.5)" : "none",
                      transform: i === currentInsight ? "scale(1.3)" : "scale(1)",
                    }}
                  />
                ))}
              </div>

              <div className="min-h-[60px] flex items-center justify-center">
                {currentInsight < insights.length && (
                  <p
                    key={currentInsight}
                    className="text-xl font-medium tracking-tight animate-insight-in"
                    style={{ fontFamily: "'Instrument Serif', Georgia, serif", color: "#f5f5f5" }}
                  >
                    {insights[currentInsight]}
                  </p>
                )}
              </div>

              <div className="w-full max-w-xs mx-auto mt-8">
                <div
                  className="h-1.5 rounded-full overflow-hidden"
                  style={{ background: "rgba(255,255,255,0.06)" }}
                >
                  <div
                    className="h-full rounded-full transition-all duration-400 ease-out"
                    style={{
                      width: `${((currentInsight + 1) / insights.length) * 100}%`,
                      background: "linear-gradient(90deg, #c75a34, #DC6743, #e8845e)",
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── SUMMARY PHASE ── */}
          {phase === "summary" && (
            <div className="animate-fade-in">
              <h2
                className="text-lg text-center mb-5"
                style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontWeight: 400, color: "#f5f5f5" }}
              >
                Your agent now knows you
              </h2>

              {cards.length > 0 && (
                <div className="grid grid-cols-2 gap-2.5 mb-5">
                  {cards.map((card, i) => (
                    <div
                      key={i}
                      className="rounded-xl p-3 animate-card-in"
                      style={{
                        background: "rgba(255,255,255,0.04)",
                        border: "1px solid rgba(255,255,255,0.06)",
                        animationDelay: `${i * 100}ms`,
                      }}
                    >
                      <div
                        className="w-5 h-5 rounded-full mb-2 relative overflow-hidden"
                        style={{
                          background: BUBBLE_COLORS[i % BUBBLE_COLORS.length],
                          boxShadow: BUBBLE_SHADOWS[i % BUBBLE_SHADOWS.length],
                        }}
                      >
                        <div
                          className="absolute inset-0 rounded-full"
                          style={{
                            background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.5) 0%, transparent 50%)",
                          }}
                        />
                      </div>
                      <h3 className="text-[11px] font-semibold mb-0.5" style={{ color: "#e5e5e5" }}>
                        {card.title}
                      </h3>
                      <p className="text-[10px] leading-relaxed" style={{ color: "#888" }}>
                        {card.description}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {summary && (
                <p className="text-[11px] leading-relaxed mb-5 text-center" style={{ color: "#888" }}>
                  {summary.length > 200 ? summary.slice(0, 200) + "..." : summary}
                </p>
              )}

              <button
                onClick={onDone}
                className="w-full rounded-xl py-3 text-sm font-semibold"
                style={{
                  background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                  boxShadow: "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px",
                  color: "#fff",
                }}
              >
                Done
              </button>
            </div>
          )}

          {/* ── ERROR PHASE ── */}
          {phase === "error" && (
            <div className="text-center py-4 animate-fade-in">
              <h2
                className="text-lg mb-3"
                style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontWeight: 400, color: "#f5f5f5" }}
              >
                Something went wrong
              </h2>
              <p className="text-sm mb-5" style={{ color: "#888" }}>{error}</p>
              <button
                onClick={() => fetchInsights()}
                className="w-full rounded-xl py-3 text-sm font-semibold mb-3"
                style={{
                  background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
                  boxShadow: "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px",
                  color: "#fff",
                }}
              >
                Try Again
              </button>
              <button onClick={onDone} className="text-sm" style={{ color: "#888" }}>
                Skip for now
              </button>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes modal-in {
          from { opacity: 0; transform: scale(0.95) translateY(20px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        .animate-modal-in { animation: modal-in 0.3s ease-out; }
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in { animation: fade-in 0.3s ease-out; }
        @keyframes insight-in {
          from { opacity: 0; transform: scale(0.95) translateY(16px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        .animate-insight-in { animation: insight-in 0.5s ease-out; }
        @keyframes card-in {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-card-in { animation: card-in 0.3s ease-out both; }
      `}</style>
    </div>
  );
}
