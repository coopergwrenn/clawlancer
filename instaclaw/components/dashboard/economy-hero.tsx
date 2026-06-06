"use client";

import { motion } from "motion/react";
import { Wallet, Trophy, Copy, Check, Sparkles, ArrowUpRight } from "lucide-react";
import { useCallback, useState, type CSSProperties } from "react";

/**
 * EconomyHero — the FIRST-RUN flagship surface for /economy.
 *
 * Every real user hits this today (the economy is pre-activity fleet-wide), so the
 * empty state IS the headline, not an edge case. It must read as anticipatory and
 * premium — "your agent is ready to become an economic actor" — anchored by the
 * agent's REAL, present identity (its on-chain wallet + its credit standing), never
 * a sad $0. Earnings stay honest-aspirational until the earn server ships fleet-wide.
 *
 * Themed for the LIGHT dashboard: warm cream-glass panel, terracotta-edged, crisp
 * light identity cards with soft depth. Colors lean on the theme vars (--foreground,
 * --muted, --accent #DC6743) so text adapts; surfaces are tuned warm-on-light.
 *
 * Rich-data variant (a confident net/earn/spend hero, once there's activity) is a
 * separate next pass; this component owns the first-run state only.
 */

interface EconomyHeroProps {
  walletAddress: string | null;
  standingScore: number | null;
}

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Orchestrated load — each element rises + fades on a stagger. The "coming alive"
// motion fits the becoming-an-economic-actor theme; one well-timed reveal > scattered.
const rise = {
  hidden: { opacity: 0, y: 14 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.07 * i, duration: 0.6, ease: [0.23, 1, 0.32, 1] as const },
  }),
};

// Warm light-glass identity card — reads as a crisp card on the cream panel.
// Exported as the shared warm-card material so the rich-data Wallet / Standing /
// Activity cards match the hero's treatment (one design language across states).
export const CARD_STYLE: CSSProperties = {
  background: "rgba(255,255,255,0.66)",
  border: "1px solid rgba(0,0,0,0.07)",
  boxShadow: "0 2px 10px rgba(120,70,50,0.05), inset 0 1px 0 rgba(255,255,255,0.7)",
};

export function EconomyHero({ walletAddress, standingScore }: EconomyHeroProps) {
  const [copied, setCopied] = useState(false);
  const copyAddr = useCallback(() => {
    if (!walletAddress) return;
    navigator.clipboard.writeText(walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [walletAddress]);

  return (
    <section
      className="relative overflow-hidden rounded-3xl p-8 sm:p-10"
      style={{
        // Warm cream glass with a terracotta wash — premium on a light surface.
        background:
          "linear-gradient(158deg, rgba(220,103,67,0.10) 0%, rgba(255,251,249,0.72) 46%, rgba(255,255,255,0.58) 100%)",
        border: "1px solid rgba(220,103,67,0.16)",
        boxShadow:
          "0 16px 48px rgba(150,75,50,0.12), 0 1px 0 rgba(255,255,255,0.85) inset",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
      {/* Atmosphere — a slow terracotta glow, latent energy waiting to fire. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-28 -right-20 w-[22rem] h-[22rem] rounded-full animate-orb"
        style={{
          background: "radial-gradient(circle, rgba(220,103,67,0.26), transparent 68%)",
          filter: "blur(40px)",
        }}
      />

      <div className="relative">
        {/* Eyebrow — it's real, it's on-chain, it's live. */}
        <motion.div
          custom={0}
          variants={rise}
          initial="hidden"
          animate="show"
          className="flex items-center gap-2 mb-5"
        >
          <span className="relative flex h-1.5 w-1.5">
            <span
              className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping"
              style={{ background: "var(--accent, #DC6743)" }}
            />
            <span
              className="relative inline-flex rounded-full h-1.5 w-1.5"
              style={{ background: "var(--accent, #DC6743)" }}
            />
          </span>
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{ color: "var(--accent, #DC6743)" }}
          >
            Live on Base
          </span>
        </motion.div>

        {/* Headline — Instrument Serif, the v2 framing. */}
        <motion.h1
          custom={1}
          variants={rise}
          initial="hidden"
          animate="show"
          className="text-[2rem] leading-[1.08] sm:text-5xl sm:leading-[1.04] tracking-[-0.6px] max-w-2xl"
          style={{ fontFamily: "var(--font-serif)", fontWeight: 400, color: "var(--foreground)" }}
        >
          Your agent is ready to become{" "}
          <span style={{ color: "var(--accent, #DC6743)" }}>an economic actor</span>.
        </motion.h1>

        {/* Subhead — honest, one considered line. */}
        <motion.p
          custom={2}
          variants={rise}
          initial="hidden"
          animate="show"
          className="mt-4 text-[15px] leading-relaxed max-w-xl"
          style={{ color: "var(--muted)" }}
        >
          It has its own wallet on Base and a standing it earns through good decisions. The first
          time it earns or spends, its economic life takes shape here, always within the limits you
          set.
        </motion.p>

        {/* Identity — the agent's real, present economic self (wallet + standing). */}
        <motion.div
          custom={3}
          variants={rise}
          initial="hidden"
          animate="show"
          className="mt-8 grid sm:grid-cols-2 gap-3"
        >
          {/* Wallet credential */}
          <div className="rounded-2xl p-5" style={CARD_STYLE}>
            <div className="flex items-center gap-2 mb-3">
              <Wallet className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
              <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--muted)" }}>
                Wallet
              </span>
            </div>
            {walletAddress ? (
              <>
                <button
                  onClick={copyAddr}
                  className="inline-flex items-center gap-2 font-mono text-sm rounded-lg px-2.5 py-1.5 -ml-1 transition-colors cursor-pointer"
                  style={{ background: "rgba(0,0,0,0.035)", border: "1px solid rgba(0,0,0,0.08)", color: "var(--foreground)" }}
                  aria-label="Copy wallet address"
                >
                  {copied ? (
                    <Check className="w-3.5 h-3.5" style={{ color: "rgb(22,163,74)" }} />
                  ) : (
                    <Copy className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
                  )}
                  <span>{copied ? "Copied" : shortAddr(walletAddress)}</span>
                </button>
                <p className="text-[12px] mt-3" style={{ color: "var(--muted)" }}>
                  USDC · Base · ready to receive
                </p>
              </>
            ) : (
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Provisioning your agent&apos;s wallet…
              </p>
            )}
          </div>

          {/* Standing */}
          <div className="rounded-2xl p-5" style={CARD_STYLE}>
            <div className="flex items-center gap-2 mb-3">
              <Trophy className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
              <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--muted)" }}>
                Standing
              </span>
            </div>
            {standingScore != null ? (
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold tracking-tight" style={{ color: "var(--foreground)" }}>
                  {standingScore}
                </span>
                <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                  and building
                </span>
              </div>
            ) : (
              <p className="text-base font-medium" style={{ color: "var(--foreground)" }}>
                Building from day one
              </p>
            )}
            <p className="text-[12px] mt-3" style={{ color: "var(--muted)" }}>
              Earns more autonomy as it transacts
            </p>
          </div>
        </motion.div>

        {/* Readiness — anticipatory, honest, no numbers to fake. */}
        <motion.div
          custom={4}
          variants={rise}
          initial="hidden"
          animate="show"
          className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]"
          style={{ color: "var(--muted)" }}
        >
          <span className="inline-flex items-center gap-1.5">
            <Sparkles className="w-3 h-3" style={{ color: "var(--accent, #DC6743)" }} />
            Earning opens with its first sale
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ArrowUpRight className="w-3 h-3" style={{ color: "var(--muted)" }} />
            Spending turns on when you allow it
          </span>
        </motion.div>
      </div>
    </section>
  );
}
