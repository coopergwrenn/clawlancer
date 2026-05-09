"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface BannerState {
  registered: boolean;
  dismissed: boolean;
  shouldShow: boolean;
}

const VISIT_COUNT_KEY = "instaclaw:dashboard:visit_count";
const MIN_VISITS_BEFORE_SHOW = 2;

/**
 * AgentBook hat-claim promotional banner.
 *
 * Visibility gates (ALL must hold):
 *   1. Server says shouldShow=true (user not registered AND not dismissed in 30d)
 *   2. Client localStorage visit count >= 2 (don't show on first-ever load —
 *      give the user a chance to explore the dashboard before pitching)
 *
 * Style mirrors WorldIDBanner — same glassmorphism aesthetic, same dismiss
 * affordance, same shrink-0 CTA pattern. Mobile-responsive: at narrow
 * viewports the layout stacks vertically with the CTA going full-width.
 *
 * Dismissal flow: optimistic local hide + best-effort POST. If the POST
 * fails the next page load will check server again and may re-show — fine
 * for a promo banner.
 */
export function AgentbookHatBanner() {
  const [state, setState] = useState<BannerState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [visitGated, setVisitGated] = useState(true);

  // Track visit count locally; gate the banner on second-or-later visit.
  // Wrapped in try/catch so a quota-exceeded localStorage doesn't break
  // the dashboard render.
  useEffect(() => {
    try {
      const prior = parseInt(localStorage.getItem(VISIT_COUNT_KEY) ?? "0", 10) || 0;
      const next = prior + 1;
      localStorage.setItem(VISIT_COUNT_KEY, String(next));
      if (next >= MIN_VISITS_BEFORE_SHOW) setVisitGated(false);
    } catch {
      // Storage disabled or full — ungate so the banner can still appear.
      // Better to show one promo a user might dismiss than to silently hide
      // it forever in a private-browsing session.
      setVisitGated(false);
    }
  }, []);

  // Fetch server-side eligibility. Runs once per mount; the banner is
  // mounted at the top of the dashboard page so this fires on each visit.
  useEffect(() => {
    fetch("/api/agentbook/banner-state")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: BannerState | null) => {
        if (data) setState(data);
      })
      .catch(() => {
        // Silent — if the API is down we just don't show the banner this load.
      });
  }, []);

  async function handleDismiss() {
    setHidden(true); // optimistic — slide out immediately
    try {
      await fetch("/api/agentbook/banner-state", { method: "POST" });
    } catch {
      // Best-effort. Local state already hidden for this session.
    }
  }

  const visible = state?.shouldShow && !hidden && !visitGated;

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -8, height: 0 }}
          animate={{ opacity: 1, y: 0, height: "auto" }}
          exit={{ opacity: 0, y: -8, height: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
          style={{ overflow: "hidden" }}
        >
          <div
            className="rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3"
            style={{
              background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
              backdropFilter: "blur(2px)",
              WebkitBackdropFilter: "blur(2px)",
              boxShadow: `
                rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,
                rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,
                rgba(0, 0, 0, 0.1) 0px 2px 4px 0px,
                rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset
              `,
            }}
          >
            {/* Hat emoji icon — keeps the bundle small and renders crisp on every device */}
            <div
              className="shrink-0 flex items-center justify-center text-2xl sm:text-xl leading-none w-10 h-10 sm:w-8 sm:h-8 rounded-full"
              aria-hidden="true"
              style={{
                background: "rgba(245,158,11,0.12)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25)",
              }}
            >
              🎩
            </div>

            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold leading-tight" style={{ color: "#333334" }}>
                Your agent can claim you a free $100 hat.
              </p>
              <p className="text-xs mt-0.5 leading-snug" style={{ color: "#6b6b6b" }}>
                Register in AgentBook to unlock it. Only 500 ever made.
              </p>
            </div>

            <div className="flex items-center gap-2 sm:shrink-0 w-full sm:w-auto">
              <Link
                href="/settings#human-verification"
                className="flex-1 sm:flex-initial text-center px-3 py-2 sm:py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all"
                style={{
                  background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.05))",
                  boxShadow: `
                    rgba(0, 0, 0, 0.05) 0px 1px 1px 0px inset,
                    rgba(255, 255, 255, 0.4) 0px -1px 1px 0px inset,
                    rgba(0, 0, 0, 0.08) 0px 1px 3px 0px
                  `,
                  color: "#333334",
                }}
              >
                Register in AgentBook →
              </Link>
              <button
                onClick={handleDismiss}
                className="shrink-0 p-1.5 rounded cursor-pointer transition-colors hover:bg-black/5"
                style={{ color: "#6b6b6b" }}
                aria-label="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
