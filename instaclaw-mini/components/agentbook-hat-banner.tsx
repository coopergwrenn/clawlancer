"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { X, Sparkles } from "lucide-react";
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

const VISIT_COUNT_KEY = "instaclaw-mini:home:visit_count";
const MIN_VISITS_BEFORE_SHOW = 2;
const HAT_SHOP_URL = "https://humanrequired.shop/products/human-in-the-loop-hat";

/**
 * AgentBook hat-claim notification card — World mini app version.
 *
 * Same backend + 4-state machine as the web banner:
 *   nudge_verify | nudge_register | nudge_claim | sold_out | hidden
 *
 * Shares dismissal state with the web (DB column on instaclaw_users) so
 * dismissing on either surface dismisses both.
 *
 * The "Claim my hat" CTA opens humanrequired.shop in the device browser
 * (mini app context — handled via standard <a target="_blank">) and
 * optimistically POSTs to /api/proxy/agentbook/claim-hat to mark
 * hat_claimed_at so the banner stops appearing.
 */
export default function AgentbookHatBanner() {
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
    fetch("/api/proxy/agentbook/banner-state")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: BannerStateResponse | null) => {
        if (d) setData(d);
      })
      .catch(() => {});
  }, []);

  function handleDismiss() {
    if (!data || data.state === "sold_out" || data.state === "hidden") return;
    setHidden(true);
    fetch("/api/proxy/agentbook/banner-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: data.state }),
    }).catch(() => {});
  }

  function handleClaim() {
    fetch("/api/proxy/agentbook/claim-hat", { method: "POST" }).catch(() => {});
    window.open(HAT_SHOP_URL, "_blank", "noopener,noreferrer");
    setHidden(true);
  }

  // sold_out has no second-visit gate — show for 24h after the last
  // claim regardless of visit count (Cooper).
  const visible = data?.shouldShow
    && !hidden
    && (data.state === "sold_out" || !visitGated);

  function handleScrollToCard() {
    const target = document.getElementById("agentbook-card");
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    handleDismiss();
  }

  const copy = (() => {
    switch (data?.state) {
      case "nudge_verify":
        return {
          headline: "Free $100 hat — only 500 made",
          sub: "Verify with World ID to claim one.",
          ctaLabel: "Verify",
          onClick: handleScrollToCard,
        };
      case "nudge_register":
        return {
          headline: "Free $100 hat — only 500 made",
          sub: "Register your agent in AgentBook to claim.",
          ctaLabel: "Register",
          onClick: handleScrollToCard,
        };
      case "nudge_claim":
        return {
          headline: "Your $100 hat is ready",
          sub: "Tap to claim it on humanrequired.shop.",
          ctaLabel: "Claim my hat",
          onClick: handleClaim,
        };
      case "sold_out":
        return {
          headline: "All 500 hats claimed",
          sub: "Thanks to everyone who got one.",
          ctaLabel: null,
          onClick: null,
        };
      default:
        return null;
    }
  })();

  return (
    <AnimatePresence initial={false}>
      {visible && copy && (
        <motion.div
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
            style={{ borderColor: "rgba(245, 158, 11, 0.22)" }}
          >
            <div className="flex items-start gap-3">
              <div
                className="shrink-0 h-12 w-12 rounded-full overflow-hidden flex items-center justify-center"
                style={{
                  background: "#f4f4f5",
                  boxShadow:
                    "inset 0 0 0 1px rgba(245,158,11,0.55), 0 2px 12px rgba(245,158,11,0.22)",
                }}
              >
                <Image
                  src="/agentbook-hat.png"
                  alt="AI HUMAN hat"
                  width={96}
                  height={96}
                  unoptimized
                  className="object-contain"
                  style={{ width: "78%", height: "78%", mixBlendMode: "multiply" }}
                />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold leading-tight">{copy.headline}</p>
                  {data?.state !== "sold_out" && (
                    <button
                      onClick={handleDismiss}
                      className="shrink-0 -mt-0.5 -mr-0.5 p-1 rounded transition-all active:opacity-50 active:scale-90"
                      style={{ color: "#888" }}
                      aria-label="Dismiss"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <p className="text-[11px] mt-1 leading-snug" style={{ color: "#9b9b9b" }}>
                  {copy.sub}
                </p>

                {copy.ctaLabel && copy.onClick && (
                  <button
                    onClick={copy.onClick}
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
                    {copy.ctaLabel}
                  </button>
                )}
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
