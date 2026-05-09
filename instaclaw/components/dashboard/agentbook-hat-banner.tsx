"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";

type BannerState =
  | "nudge_verify"
  | "nudge_register"
  | "nudge_claim"
  | "sold_out"
  | "hidden";

interface BannerStateResponse {
  state: BannerState;
  dismissed: boolean;
  shouldShow: boolean;
  hatsRemaining: number;
  totalHats: number;
}

const VISIT_COUNT_KEY = "instaclaw:dashboard:visit_count";
const MIN_VISITS_BEFORE_SHOW = 2;
const HAT_SHOP_URL = "https://humanrequired.shop/products/human-in-the-loop-hat";

/**
 * AgentBook hat-claim notification strip — state-driven.
 *
 * 4 visible states; one hidden:
 *
 *   nudge_verify  — user hasn't verified World ID. CTA: verify.
 *   nudge_register — verified, has wallet, NOT registered. CTA: register.
 *   nudge_claim    — registered, hat NOT claimed. CTA: claim → opens
 *                    humanrequired.shop in a new tab AND optimistically
 *                    POSTs to /api/agentbook/claim-hat so the banner
 *                    stops nagging this user. Actual fulfillment happens
 *                    at humanrequired.shop checkout.
 *   sold_out       — all 500 claimed, within 24h celebration window.
 *                    No CTA, no dismiss. Auto-disappears after 24h.
 *   hidden         — banner returns null.
 *
 * State-scoped dismissal: the dismiss × records the CURRENT state.
 * If state advances later (e.g., user verifies → state becomes
 * nudge_register), banner re-emerges with the new state's copy.
 *
 * Style mirrors landing-page NotificationBar — same translucent bg,
 * border, outlined-pill CTA, custom 14×14 SVG dismiss.
 */
export function AgentbookHatBanner() {
  const [data, setData] = useState<BannerStateResponse | null>(null);
  const [hidden, setHidden] = useState(false);
  const [visitGated, setVisitGated] = useState(true);

  useEffect(() => {
    try {
      const prior = parseInt(localStorage.getItem(VISIT_COUNT_KEY) ?? "0", 10) || 0;
      const next = prior + 1;
      localStorage.setItem(VISIT_COUNT_KEY, String(next));
      if (next >= MIN_VISITS_BEFORE_SHOW) setVisitGated(false);
    } catch {
      setVisitGated(false);
    }
  }, []);

  useEffect(() => {
    fetch("/api/agentbook/banner-state")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: BannerStateResponse | null) => {
        if (d) setData(d);
      })
      .catch(() => {});
  }, []);

  async function handleDismiss() {
    if (!data || data.state === "sold_out" || data.state === "hidden") return;
    setHidden(true);
    try {
      await fetch("/api/agentbook/banner-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: data.state }),
      });
    } catch {
      // Best-effort. Local state already hidden.
    }
  }

  /**
   * Click handler for the nudge_claim CTA. Fires both:
   *   - Optimistic POST /api/agentbook/claim-hat (records hat_claimed_at,
   *     advances banner state to "hidden" on next load)
   *   - Window.open to humanrequired.shop in a new tab where the actual
   *     hat checkout happens
   * Banner hides locally immediately so the page stops promoting it.
   * Doesn't await the POST — we don't want to block the user from
   *  reaching the shop.
   */
  function handleClaim() {
    fetch("/api/agentbook/claim-hat", { method: "POST" }).catch(() => {});
    window.open(HAT_SHOP_URL, "_blank", "noopener,noreferrer");
    setHidden(true);
  }

  // sold_out has no second-visit gate (Cooper: show for 24h after the
  // last claim, period). For other states, gate normally.
  const visible = data?.shouldShow
    && !hidden
    && (data.state === "sold_out" || !visitGated);

  // Per-state copy. Headline is always bold; sub varies; CTA differs.
  const copy = (() => {
    switch (data?.state) {
      case "nudge_verify":
        return {
          headline: "Free $100 hat — only 500 made.",
          ctaLabel: "Verify with World ID",
          ctaShortLabel: "Verify",
          ctaHref: "/settings#human-verification" as const,
        };
      case "nudge_register":
        return {
          headline: "Free $100 hat — only 500 made.",
          ctaLabel: "Register in AgentBook",
          ctaShortLabel: "Register",
          ctaHref: "/settings#human-verification" as const,
        };
      case "nudge_claim":
        return {
          headline: "Your $100 hat is ready. Claim it.",
          ctaLabel: "Claim my hat",
          ctaShortLabel: "Claim",
          ctaHref: null, // handled by handleClaim
        };
      case "sold_out":
        return {
          headline: "All 500 hats claimed. Thank you.",
          ctaLabel: null,
          ctaShortLabel: null,
          ctaHref: null,
        };
      default:
        return null;
    }
  })();

  return (
    <AnimatePresence initial={false}>
      {visible && copy && (
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
            className="notification-bar flex items-center justify-center gap-4 px-4 py-3 text-sm"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
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
                style={{ width: "82%", height: "82%", mixBlendMode: "multiply" }}
              />
            </div>

            <p style={{ color: "var(--foreground)" }}>{copy.headline}</p>

            {copy.ctaLabel && (
              copy.ctaHref ? (
                <Link
                  href={copy.ctaHref}
                  className="shrink-0 px-4 py-1.5 rounded-full text-xs font-medium transition-snappy hover:opacity-80 cursor-pointer"
                  style={{
                    border: "1px solid var(--foreground)",
                    color: "var(--foreground)",
                  }}
                >
                  {copy.ctaLabel}
                </Link>
              ) : (
                <button
                  onClick={handleClaim}
                  className="shrink-0 px-4 py-1.5 rounded-full text-xs font-medium transition-snappy hover:opacity-80 cursor-pointer"
                  style={{
                    border: "1px solid var(--foreground)",
                    color: "var(--foreground)",
                  }}
                >
                  {copy.ctaLabel}
                </button>
              )
            )}

            {data?.state !== "sold_out" && (
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
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
