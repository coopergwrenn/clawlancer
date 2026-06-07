"use client";

import { motion } from "motion/react";
import { Wallet, Trophy, TrendingUp } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { CARD_STYLE } from "./economy-hero";

/**
 * EconomyHeroActive — the RICH-DATA headline for a !firstRun agent.
 *
 * The first-run hero (economy-hero.tsx) is untouched and owns the pre-activity
 * state; this owns the headline once the agent has an economic life, replacing
 * the bare "Economy" title. It is the first-run hero's equal in voice + material
 * (warm terracotta wash, "Live on Base" eyebrow, Instrument Serif), just
 * declaring what the agent has BECOME instead of what it's ready to become.
 *
 * The thesis ("accountable, not just funded") is enforced in the copy logic:
 * the standing is COMPUTED (no flat seed) — a brand-new agent is ~438, and 500
 * is the UNVERIFIED_CAP (frontier-standing.ts). So "earned" language is gated on
 * score >= 550 (leaving the "audit" level): because unverified agents can never
 * exceed 500, >= 550 self-guarantees the agent is BOTH World-ID-verified AND
 * above the audit baseline. Three states:
 *   - EARNED (>= 550): standing leads, fused into the sentence ("earned a
 *     standing of N"); money + wallet are proof tiles.
 *   - AT-BASELINE (< 550, the common early case): statement leads on the real
 *     work it's doing; standing shown HONESTLY as a starting point ("building
 *     from here"), NEVER "earned". Confident-in-progress, not a not-yet state.
 *   - DEGRADED (null): activity leads, "standing is updating", no fake number;
 *     wallet null → "provisioning". The #2-fix honest-degradation discipline.
 *
 * Visual material (wash gradient, orb, rise stagger) is re-created here rather
 * than imported, deliberately, to keep economy-hero.tsx byte-identical (the
 * first-run hero is the quality bar and must stay provably untouched).
 */

const ACCENT = "var(--accent, #DC6743)";
const SERIF = "var(--font-serif)";
// Leaving the "audit" level (frontier-standing.ts). UNVERIFIED_CAP=500 < this,
// so score >= 550 ⟹ World-ID-verified AND earned above the baseline. Exported so
// the Standing card (economy/page.tsx) gates its "earned" copy the SAME way —
// one threshold, so the hero and the card can't tell contradicting stories.
export const EARNED_THRESHOLD = 550;

interface Props {
  standingScore: number | null;
  earnedUsd: number;
  spentUsd: number;
  netUsd: number;
  walletAddress: string | null;
  walletBalanceUsd: number | null;
}

const fmtUsd = (n: number | null | undefined) =>
  n == null ? "—" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const rise = {
  hidden: { opacity: 0, y: 14 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.07 * i, duration: 0.6, ease: [0.23, 1, 0.32, 1] as const },
  }),
};

function Tile({ icon: Icon, label, value, valueColor, sub }: {
  icon: typeof Wallet;
  label: string;
  value: ReactNode;
  valueColor?: string;
  sub: string;
}) {
  return (
    <div className="rounded-2xl p-5" style={CARD_STYLE}>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
        <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          {label}
        </span>
      </div>
      <div className="text-[1.9rem] leading-none tracking-tight tabular-nums" style={{ fontFamily: SERIF, color: valueColor ?? "var(--foreground)" }}>
        {value}
      </div>
      <p className="text-[12px] mt-3" style={{ color: "var(--muted)" }}>
        {sub}
      </p>
    </div>
  );
}

export function EconomyHeroActive({ standingScore, earnedUsd, spentUsd, netUsd, walletAddress, walletBalanceUsd }: Props) {
  const earned = standingScore != null && standingScore >= EARNED_THRESHOLD;
  const degraded = standingScore == null;
  const walletKnown = typeof walletBalanceUsd === "number";
  const hasWalletAddr = !!walletAddress;
  const moved = earnedUsd + spentUsd; // gross economic flow the agent has put through

  const section: CSSProperties = {
    background:
      "linear-gradient(158deg, rgba(220,103,67,0.10) 0%, rgba(255,251,249,0.72) 46%, rgba(255,255,255,0.58) 100%)",
    border: "1px solid rgba(220,103,67,0.16)",
    boxShadow: "0 16px 48px rgba(150,75,50,0.12), 0 1px 0 rgba(255,255,255,0.85) inset",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
  };

  // ── headline + subhead, per state ──
  let headline: ReactNode;
  let subhead: string;
  if (earned) {
    // FUSION: the sentence carries the number; the number punctuates it.
    headline = (
      <>
        Your agent has earned a standing of{" "}
        <span style={{ color: ACCENT }}>{standingScore}</span>.
      </>
    );
    subhead = "Built by doing real, undisputed business on Base, within the limits it earns.";
  } else {
    // AT-BASELINE and DEGRADED both lead on the real work — confident-in-progress.
    headline = (
      <>
        Your agent is putting its <span style={{ color: ACCENT }}>own money to work</span> on Base.
      </>
    );
    subhead = degraded
      ? "Doing real business within the limits it earns. Its standing is updating."
      : "Doing real business within the limits it earns, and building a standing as it goes.";
  }

  // ── identity tiles, per state ──
  const walletTile = (
    <Tile
      icon={Wallet}
      label="Wallet"
      value={hasWalletAddr ? (walletKnown ? fmtUsd(walletBalanceUsd) : "$—") : "Provisioning"}
      sub={hasWalletAddr ? "USDC · Base" : "Setting up your agent's wallet…"}
    />
  );

  let firstTile: ReactNode;
  if (earned) {
    // money it's put to work is the proof; standing is the headline.
    firstTile = (
      <Tile
        icon={TrendingUp}
        label="Put to work"
        value={fmtUsd(moved)}
        sub={`Net ${netUsd >= 0 ? "+" : "−"}${fmtUsd(Math.abs(netUsd)).slice(1)} so far`}
      />
    );
  } else if (degraded) {
    firstTile = (
      <Tile icon={Trophy} label="Standing" value="Updating…" valueColor="var(--muted)" sub="Catching up on its latest decisions" />
    );
  } else {
    // AT-BASELINE: the standing number, framed honestly as a starting point — never "earned".
    firstTile = (
      <Tile icon={Trophy} label="Standing" value={standingScore} sub="Building from here as it earns trust" />
    );
  }

  return (
    <section className="relative overflow-hidden rounded-3xl p-8 sm:p-10" style={section}>
      <div
        aria-hidden
        className="pointer-events-none absolute -top-28 -right-20 w-[22rem] h-[22rem] rounded-full animate-orb"
        style={{ background: "radial-gradient(circle, rgba(220,103,67,0.26), transparent 68%)", filter: "blur(40px)" }}
      />

      <div className="relative">
        {/* eyebrow — it's real, on-chain, live (same as the first-run hero) */}
        <motion.div custom={0} variants={rise} initial="hidden" animate="show" className="flex items-center gap-2 mb-5">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping" style={{ background: ACCENT }} />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: ACCENT }} />
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em]" style={{ color: ACCENT }}>
            Live on Base
          </span>
        </motion.div>

        {/* headline — Instrument Serif; for the earned state the number is fused in */}
        <motion.h1
          custom={1}
          variants={rise}
          initial="hidden"
          animate="show"
          className="text-[2rem] leading-[1.08] sm:text-5xl sm:leading-[1.04] tracking-[-0.6px] max-w-2xl"
          style={{ fontFamily: SERIF, fontWeight: 400, color: "var(--foreground)" }}
        >
          {headline}
        </motion.h1>

        <motion.p
          custom={2}
          variants={rise}
          initial="hidden"
          animate="show"
          className="mt-4 text-[15px] leading-relaxed max-w-xl"
          style={{ color: "var(--muted)" }}
        >
          {subhead}
        </motion.p>

        <motion.div custom={3} variants={rise} initial="hidden" animate="show" className="mt-8 grid sm:grid-cols-2 gap-3">
          {firstTile}
          {walletTile}
        </motion.div>
      </div>
    </section>
  );
}
