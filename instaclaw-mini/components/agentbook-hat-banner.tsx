"use client";

import { useState, useEffect } from "react";
import { X, Sparkles } from "lucide-react";

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
 * timestamp on instaclaw_users.agentbook_banner_dismissed_at, 30-day
 * window).
 *
 * Visibility gates (ALL must hold):
 *   1. Server says shouldShow=true (user not registered AND not dismissed
 *      in 30 days)
 *   2. Local visit count >= 2 (don't pitch on first-ever home load —
 *      give the user a chance to explore the app first; localStorage key
 *      is namespaced separately from the web dashboard so each surface
 *      gets its own grace visit)
 *
 * Style mirrors agentbook-card.tsx — same glass-card aesthetic, same
 * gold/amber accent (matches BankrTokenizeCard's celebration palette).
 * Mounted ABOVE the existing AgentBookCard on the home tab so the hat
 * promo hooks the user, then the existing card handles the actual
 * registration UX.
 */
export default function AgentbookHatBanner() {
  const [state, setState] = useState<BannerState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [closing, setClosing] = useState(false);
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
    setClosing(true);
    setTimeout(() => setHidden(true), 280); // match the fade-out duration
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

  if (hidden) return null;
  if (!state?.shouldShow) return null;
  if (visitGated) return null;

  return (
    <div
      className={`glass-card rounded-2xl p-4 mx-4 mt-3 mb-1 transition-all ${
        closing ? "" : "animate-fade-in-up"
      }`}
      style={{
        opacity: closing ? 0 : undefined,
        transform: closing ? "translateY(-4px)" : undefined,
        transition: "opacity 280ms cubic-bezier(0.23, 1, 0.32, 1), transform 280ms cubic-bezier(0.23, 1, 0.32, 1)",
        // Subtle gold accent on the border to differentiate from neutral
        // cards below; matches the BankrTokenizeCard celebration palette
        // already used elsewhere in the mini app.
        borderColor: "rgba(245, 158, 11, 0.22)",
      }}
    >
      <div className="flex items-start gap-3">
        {/* Hat in a soft gold halo */}
        <div
          className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full overflow-hidden"
          aria-hidden="true"
          style={{
            background:
              "radial-gradient(circle at 35% 30%, rgba(251,191,36,0.55), rgba(245,158,11,0.25) 55%, rgba(180,120,30,0.45) 100%)",
            boxShadow:
              "0 2px 10px rgba(245,158,11,0.30), inset 0 1px 2px rgba(255,255,255,0.20)",
          }}
        >
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background:
                "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)",
            }}
          />
          <span className="relative z-10 text-lg leading-none">🎩</span>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold leading-tight">
              Free $100 hat — only 500 made
            </p>
            <button
              onClick={handleDismiss}
              className="shrink-0 -mt-0.5 -mr-0.5 p-1 rounded transition-opacity active:opacity-50"
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
  );
}
