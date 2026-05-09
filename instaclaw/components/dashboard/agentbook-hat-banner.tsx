"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";

interface BannerState {
  registered: boolean;
  dismissed: boolean;
  shouldShow: boolean;
}

const VISIT_COUNT_KEY = "instaclaw:dashboard:visit_count";
const MIN_VISITS_BEFORE_SHOW = 2;

/**
 * AgentBook hat-claim notification strip.
 *
 * Style matches the landing-page NotificationBar exactly
 * (components/landing/notification-bar.tsx + .notification-bar in
 * globals.css:258) — same translucent off-white bg with backdrop-blur,
 * same 1px var(--border) bottom rule, same outlined-pill CTA, same
 * dismiss-x affordance, same sizing + spacing. Only differences:
 *   - Adds a small inline hat thumbnail on the left (with mix-blend-mode
 *     multiply to drop the source PNG's white background against the
 *     bar's translucent bg)
 *   - Visibility-gated by server-side state (registered? dismissed
 *     within 30d?) plus client-side second-visit gate
 *   - Dismissal persists to instaclaw_users.agentbook_banner_dismissed_at
 *     so it stays dismissed across the web dashboard AND the mini app
 *
 * Mounted in (dashboard)/layout.tsx between <nav> and <main> so it
 * appears at the top of every dashboard route, above the page heading.
 */
export function AgentbookHatBanner() {
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
    fetch("/api/agentbook/banner-state")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: BannerState | null) => {
        if (data) setState(data);
      })
      .catch(() => {
        // Silent — if the API is down we just don't show the banner.
      });
  }, []);

  async function handleDismiss() {
    setHidden(true);
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
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{
            opacity: { duration: 0.24, ease: [0.4, 0, 0.2, 1] },
            height: { duration: 0.30, ease: [0.4, 0, 0.2, 1] },
          }}
          style={{ overflow: "hidden" }}
          className="w-full"
        >
          {/* notification-bar class = the exact bg + backdrop-blur the
              landing strip uses (globals.css:258). border-bottom mirrors
              the inline style on the landing component. */}
          <div
            className="notification-bar flex items-center justify-center gap-4 px-4 py-3 text-sm"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            {/* Inline hat thumbnail. Tight 22px circle with translucent
                white-frosted bg; mix-blend-mode drops the PNG's white bg. */}
            <div
              className="shrink-0 w-[22px] h-[22px] rounded-full overflow-hidden flex items-center justify-center"
              style={{
                background: "rgba(255,255,255,0.55)",
                boxShadow: "inset 0 0 0 1px var(--border)",
              }}
            >
              <Image
                src="/agentbook-hat.png"
                alt="AI HUMAN hat"
                width={56}
                height={56}
                unoptimized
                className="object-contain"
                style={{
                  width: "82%",
                  height: "82%",
                  mixBlendMode: "multiply",
                }}
              />
            </div>

            <p style={{ color: "var(--foreground)" }}>
              Your agent can claim you a free $100 hat. Only 500 ever made.
            </p>

            <Link
              href="/settings#human-verification"
              className="shrink-0 px-4 py-1.5 rounded-full text-xs font-medium transition-snappy hover:opacity-80 cursor-pointer"
              style={{
                border: "1px solid var(--foreground)",
                color: "var(--foreground)",
              }}
            >
              Register in AgentBook
            </Link>

            <button
              onClick={handleDismiss}
              className="shrink-0 ml-2 p-1 rounded-full hover:opacity-60 transition-snappy cursor-pointer"
              aria-label="Dismiss"
              style={{ color: "var(--foreground)" }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
