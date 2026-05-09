"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
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
          // Asymmetric enter/exit: spring-y for that physical settled feel,
          // ease-out opacity/height on enter, ease-in on exit. The height
          // animation is what makes content below glide up smoothly when
          // the banner dismisses — no layout jump.
          initial={{ opacity: 0, y: -24, height: 0 }}
          animate={{ opacity: 1, y: 0, height: "auto" }}
          exit={{ opacity: 0, y: -16, height: 0 }}
          transition={{
            opacity: { duration: 0.28, ease: [0.4, 0, 0.2, 1] },
            height: { duration: 0.34, ease: [0.4, 0, 0.2, 1] },
            y: { type: "spring", stiffness: 320, damping: 28, mass: 0.9 },
          }}
          style={{ overflow: "hidden" }}
        >
          {/* Use the .glass utility class so this banner inherits the EXACT
              dashboard glass styling — same gradient bg, same multi-layer
              shadow, same blur(2px) — that the Welcome card and WorldIDBanner
              already use. Hand-rolling inline styles previously caused a
              visible mismatch (banner read as a different component). The
              [data-theme="dashboard"] override on .glass in globals.css:148
              is what makes this match. */}
          <div
            className="glass rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3"
            style={{ border: "1px solid var(--border)" }}
          >
            {/* Hat product image. Source: corduroy "AI 🤝 HUMAN" cap photo
                cropped via object-cover into the rounded container. White
                source background plays well on the dashboard's light theme;
                no manual mask needed. */}
            <div
              className="shrink-0 w-10 h-10 sm:w-9 sm:h-9 rounded-full overflow-hidden"
              style={{
                background: "#000",
                boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.08)",
              }}
            >
              <Image
                src="/agentbook-hat.png"
                alt="AI HUMAN hat"
                width={40}
                height={40}
                className="w-full h-full object-cover"
                priority={false}
                unoptimized={false}
              />
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
                className="shrink-0 p-1.5 rounded cursor-pointer transition-all hover:bg-black/5 active:scale-95"
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
