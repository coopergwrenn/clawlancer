"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { X, Sparkles } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface BannerState {
  registered: boolean;
  dismissed: boolean;
  shouldShow: boolean;
}

const VISIT_COUNT_KEY = "instaclaw-mini:home:visit_count";
const MIN_VISITS_BEFORE_SHOW = 2;

/**
 * AgentBook hat-claim promotional banner — World mini app version.
 *
 * Shares backend with the web dashboard banner via /api/proxy/agentbook/
 * banner-state, so dismissing in either UI dismisses BOTH (per-user DB
 * timestamp on instaclaw_users.agentbook_banner_dismissed_at, 30-day window).
 *
 * Visibility gates (ALL must hold):
 *   1. Server says shouldShow=true (user not registered AND not dismissed in 30d)
 *   2. Local visit count >= 2 (don't pitch on first-ever home load — give the
 *      user a chance to explore the app first; localStorage key is namespaced
 *      separately from the web dashboard so each surface gets its own grace
 *      visit, and the SHARED dismissal then prevents being pitched twice
 *      across surfaces)
 *
 * Animation contract (matches web banner):
 *   ENTER  — y: -16 → 0  (spring s=320 d=28 m=0.9, ~360ms feel)
 *            opacity: 0 → 1  (cubic-bezier 0.4,0,0.2,1, 300ms)
 *            height: 0 → auto  (cubic-bezier 0.4,0,0.2,1, 340ms)
 *   EXIT   — y: 0 → -12  (same spring)
 *            opacity: 1 → 0  (same cubic-bezier, 280ms)
 *            height: auto → 0  (same cubic-bezier, 340ms — this is what makes
 *                              the AgentBookCard below glide up smoothly with
 *                              no layout jump)
 *
 * Style mirrors agentbook-card.tsx — uses the existing glass-card class
 * (backdrop-blur 16px in globals.css) so the frosted glass renders crisp
 * on iOS Safari (which supports -webkit-backdrop-filter natively in 9+).
 * Gold/amber accent picks up BankrTokenizeCard's celebration palette to
 * differentiate from the blue AgentBookCard mounted right below.
 */
export default function AgentbookHatBanner() {
  const [state, setState] = useState<BannerState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [visitGated, setVisitGated] = useState(true);

  useEffect(() => {
    try {
      const prior = parseInt(localStorage.getItem(VISIT_COUNT_KEY) ?? "0", 10) || 0;
      const next = prior + 1;
      localStorage.setItem(VISIT_COUNT_KEY, String(next));
      if (next >= MIN_VISITS_BEFORE_SHOW) setVisitGated(false);
    } catch {
      // Storage disabled / private browsing — ungate so the banner can
      // still appear once. One promo a user might dismiss > silently
      // hidden forever.
      setVisitGated(false);
    }
  }, []);

  useEffect(() => {
    fetch("/api/proxy/agentbook/banner-state")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: BannerState | null) => {
        if (data) setState(data);
      })
      .catch(() => {
        // Silent — if proxy fails, just don't show the banner this load.
      });
  }, []);

  function handleDismiss() {
    setHidden(true);
    fetch("/api/proxy/agentbook/banner-state", { method: "POST" }).catch(() => {});
  }

  function handleScrollToCard() {
    // The full AgentBookCard with the registration UX lives below in
    // agent-dashboard.tsx — scroll smoothly to it. The id="agentbook-card"
    // anchor is set on the wrapper div so this is a no-op if the card isn't
    // mounted (e.g., during loading).
    const target = document.getElementById("agentbook-card");
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    // Also dismiss the banner — the user is acting on it; we've done our job
    handleDismiss();
  }

  const visible = state?.shouldShow && !hidden && !visitGated;

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          // Asymmetric enter/exit: spring on y for the physical settled
          // feel, ease curves on opacity + height. Animating height to/from
          // auto via motion/react is what makes content below glide up
          // smoothly when the banner dismisses — no layout jump.
          initial={{ opacity: 0, y: -16, height: 0 }}
          animate={{ opacity: 1, y: 0, height: "auto" }}
          exit={{ opacity: 0, y: -12, height: 0 }}
          transition={{
            opacity: { duration: 0.30, ease: [0.4, 0, 0.2, 1] },
            height: { duration: 0.34, ease: [0.4, 0, 0.2, 1] },
            y: { type: "spring", stiffness: 320, damping: 28, mass: 0.9 },
          }}
          style={{ overflow: "hidden" }}
          className="mx-4 mt-3 mb-1"
        >
          <div
            className="glass-card rounded-2xl p-4"
            style={{
              // Subtle gold border to differentiate from neutral cards below;
              // matches the BankrTokenizeCard celebration palette already
              // used elsewhere in the mini app.
              borderColor: "rgba(245, 158, 11, 0.22)",
            }}
          >
            <div className="flex items-start gap-3">
              {/* Hat product image — corduroy "AI HUMAN" cap.
                  Wrapped in a black rounded container so the hat (photographed
                  on white) reads cleanly against the mini app's dark theme.
                  Subtle gold ring inset preserves the warm celebration palette
                  the gold halo previously provided. */}
              <div
                className="shrink-0 h-10 w-10 rounded-full overflow-hidden"
                style={{
                  background: "#000",
                  boxShadow:
                    "inset 0 0 0 1px rgba(245,158,11,0.45), 0 2px 10px rgba(245,158,11,0.18)",
                }}
              >
                <Image
                  src="/agentbook-hat.png"
                  alt="AI HUMAN hat"
                  width={40}
                  height={40}
                  className="w-full h-full object-cover"
                />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold leading-tight">
                    Free $100 hat — only 500 made
                  </p>
                  <button
                    onClick={handleDismiss}
                    className="shrink-0 -mt-0.5 -mr-0.5 p-1 rounded transition-all active:opacity-50 active:scale-90"
                    style={{ color: "#888" }}
                    aria-label="Dismiss"
                  >
                    <X size={14} />
                  </button>
                </div>
                <p className="text-[11px] mt-1 leading-snug" style={{ color: "#9b9b9b" }}>
                  Your agent can claim one for you. Register in AgentBook to unlock.
                </p>

                <button
                  onClick={handleScrollToCard}
                  className="mt-3 w-full rounded-xl py-2.5 text-[12px] font-bold transition-all active:scale-[0.97] flex items-center justify-center gap-1.5"
                  style={{
                    background: "linear-gradient(170deg, #f59e0b, #d97706)",
                    border: "1px solid rgba(255,255,255,0.12)",
                    color: "#fff",
                    boxShadow:
                      "0 4px 16px rgba(245,158,11,0.32), inset 0 1px 0 rgba(255,255,255,0.22)",
                  }}
                >
                  <Sparkles size={12} />
                  Claim my hat
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
