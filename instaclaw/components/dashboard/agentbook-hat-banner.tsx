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
 * AgentBook hat-claim notification strip.
 *
 * Site-wide notification bar pattern (think GitHub "you have unread
 * notifications" or Stripe "your account needs attention"). Mounts in
 * the dashboard layout between <nav> and <main> so it sits at the very
 * top of the page, above the page heading. Full-width, slim height,
 * subtle amber tint to read as a notification rather than a card.
 *
 * Visibility gates (ALL must hold):
 *   1. Server says shouldShow=true (user not registered AND not
 *      dismissed within 30 days)
 *   2. Local visit count >= 2 (don't pitch on first-ever load)
 *
 * Cross-surface dismissal: dismissing on the web dashboard or the World
 * mini app dismisses both, via the shared
 * instaclaw_users.agentbook_banner_dismissed_at column hit by both
 * surfaces' clients.
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
          <div
            className="w-full"
            style={{
              // Soft amber tint — visible as "different from the page bg"
              // without screaming. Tuned so it pairs with the dashboard's
              // off-white page background.
              background: "linear-gradient(180deg, rgba(254, 243, 199, 0.65), rgba(254, 243, 199, 0.40))",
              borderBottom: "1px solid rgba(245, 158, 11, 0.22)",
            }}
          >
            <div className="max-w-6xl mx-auto px-4 py-2 flex items-center gap-2.5 sm:gap-3">
              {/* Small inline hat — 28px circle, white-bg-removed via blend */}
              <div
                className="shrink-0 w-7 h-7 rounded-full overflow-hidden flex items-center justify-center"
                style={{
                  background: "rgba(255,255,255,0.7)",
                  boxShadow: "inset 0 0 0 1px rgba(146, 64, 14, 0.10)",
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
                    // Drops the source PNG's white background by multiplying
                    // its color against the container bg — white × bg = bg
                    // (transparent), the dark cap stays sharp.
                    mixBlendMode: "multiply",
                  }}
                />
              </div>

              {/* Text — inline. Secondary copy hides on narrow viewports
                  to keep everything on one line at 380px. */}
              <p
                className="text-xs sm:text-sm flex-1 min-w-0 leading-tight"
                style={{ color: "#3f2e10" }}
              >
                <span className="font-semibold">
                  Free $100 hat — only 500 made.
                </span>
                <span
                  className="hidden sm:inline"
                  style={{ color: "#73561c" }}
                >
                  {" "}
                  Your agent can claim one for you.
                </span>
              </p>

              {/* CTA — solid amber pill. Compact label on mobile to stay
                  on one line at 380px. */}
              <Link
                href="/settings#human-verification"
                className="shrink-0 text-[11px] sm:text-xs font-semibold px-2.5 sm:px-3 py-1.5 rounded-md whitespace-nowrap transition-all active:scale-95 hover:opacity-90"
                style={{
                  background: "#92400e",
                  color: "#fff",
                  boxShadow: "0 1px 2px rgba(146, 64, 14, 0.25)",
                }}
              >
                <span className="sm:hidden">Register →</span>
                <span className="hidden sm:inline">Register in AgentBook →</span>
              </Link>

              <button
                onClick={handleDismiss}
                className="shrink-0 p-1 rounded transition-all hover:bg-black/5 active:scale-90"
                style={{ color: "#78716c" }}
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
