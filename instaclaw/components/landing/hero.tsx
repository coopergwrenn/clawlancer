"use client";

import Image from "next/image";
import Link from "next/link";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { useSession } from "next-auth/react";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SpotsCounter, useSpotsCount } from "./spots-counter";
import { WaitlistForm } from "./waitlist-form";
import { Cloud } from "lucide-react";

const WAITLIST_MODE = process.env.NEXT_PUBLIC_WAITLIST_MODE === "true";

const SNAPPY = [0.23, 1, 0.32, 1] as const;

// ─── Hero keyword cycle ────────────────────────────────────────────────
// Each word ladders the "wait, it has its OWN ___?" reaction up a
// different axis of dedicated infrastructure: physical → financial →
// cognitive → digital → social → comprehensive → token economy →
// payments rail → identity. Each maps to a real capability:
//   computer    → dedicated Linode VM (g6-dedicated-2)
//   wallet      → Bankr EVM wallet on Base mainnet
//   memory      → gbrain PGLite + workspace files
//   browser     → Chromium + browser-auto plugin, persistent state
//   friends     → cross-VM agent-to-agent contact list
//   skills      → MCP skill system (polymarket, solana, …)
//   token       → ACP / Bankr token launch capability
//   debit card  → spendable on-chain $$ via wallet
//   soul        → SOUL.md personality + identity persistence
// Order locked by Cooper 2026-05-24. Do NOT reorder without re-checking
// the visual rhythm (short → long → short cadence of word lengths).
const KEYWORDS = [
  "computer",
  "wallet",
  "memory",
  "browser",
  "friends",
  "skills",
  "token",
  "debit card",
  "soul",
] as const;

const KEYWORD_HOLD_MS = 3000;
// 500ms transition. cubic-bezier(0.25, 1, 0.32, 1) is the same premium
// soft-out curve used by the glass button — keeps the whole landing
// page tonally consistent.
const KEYWORD_TRANSITION_S = 0.5;
const KEYWORD_EASE = [0.25, 1, 0.32, 1] as const;

/**
 * KeywordCycle — premium mask-reveal cycling word.
 *
 * Width stability: all 9 keywords are stacked invisibly in one CSS grid
 * cell. The grid cell sizes itself to the WIDEST word (likely "debit
 * card") so the surrounding "Your personal agent with its own ___"
 * never reflows. No measurement, no useEffect, no flicker.
 *
 * Mask reveal: AnimatePresence `mode="popLayout"` keeps the exiting
 * word in flow (visually) while the new word slides up from below. The
 * outer overflow:hidden creates the slot. `initial={false}` on the
 * Presence means the FIRST word ("computer") renders instantly with
 * no slide-in — no blank frame on page load.
 *
 * Reduced motion: `useReducedMotion()` collapses the slide to an
 * opacity-only swap.
 */
function KeywordCycle() {
  const [index, setIndex] = useState(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % KEYWORDS.length);
    }, KEYWORD_HOLD_MS);
    return () => clearInterval(id);
  }, []);

  const word = KEYWORDS[index];

  return (
    <span
      className="relative inline-grid align-baseline"
      aria-live="polite"
      aria-atomic="true"
    >
      {/* Width sizer — every keyword overlaid invisibly in the same
          single-cell grid. The grid cell sizes to the widest entry, so
          the headline never reflows as words cycle. */}
      {KEYWORDS.map((w) => (
        <span
          key={`sizer-${w}`}
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 whitespace-nowrap"
        >
          {w}
        </span>
      ))}

      {/* Mask layer — overflow-hidden creates the slot the word slides
          through. Inherits the headline's line-height so descenders in
          "computer" (p) and "memory" (y) don't get clipped. */}
      <span
        className="col-start-1 row-start-1 relative overflow-hidden pointer-events-none"
        style={{ lineHeight: "inherit" }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={word}
            initial={reduced ? { opacity: 0 } : { y: "100%", opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { y: "-110%", opacity: 0 }}
            transition={{
              duration: reduced ? 0.01 : KEYWORD_TRANSITION_S,
              ease: KEYWORD_EASE,
            }}
            className="block whitespace-nowrap"
            style={{ color: "var(--accent)" }}
          >
            {word}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  );
}

export function Hero() {
  return (
    <Suspense>
      <HeroInner />
    </Suspense>
  );
}

function HeroInner() {
  const { data: session } = useSession();
  const searchParams = useSearchParams();

  // Migrate ?ref=CODE to localStorage so it survives navigation to /signup
  useEffect(() => {
    const ref = searchParams.get("ref");
    if (ref) {
      try { localStorage.setItem("instaclaw_ref", ref); } catch {}
    }
  }, [searchParams]);

  return (
    <section className="relative min-h-[80vh] sm:min-h-[90vh] flex flex-col items-center justify-center px-4 pt-28 sm:pt-0 pb-12 sm:pb-16 overflow-hidden">
      {/* Top-left logo */}
      <motion.div
        className="absolute top-6 left-6 z-20"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.2, duration: 0.5, ease: SNAPPY }}
      >
        <Link href="/" className="flex items-center gap-1">
          <Image src="/logo.png" alt="Instaclaw" width={44} height={44} unoptimized style={{ imageRendering: "pixelated" }} />
          <span className="text-xl tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>
            Instaclaw
          </span>
        </Link>
      </motion.div>

      {/* Top-right Sign In / Dashboard — plain div, NOT motion.div.
          Contains `.liquid-glass-nav-btn` whose backdrop-filter would
          snap if an ancestor's opacity animated through < 1. */}
      <div className="absolute top-6 right-6 z-20 flex items-center gap-1">
        <Link
          href="/blog"
          className="px-4 py-2 text-sm font-medium transition-opacity hover:opacity-70"
          style={{ color: "var(--foreground)" }}
        >
          Blog
        </Link>
        {session ? (
          <span className="liquid-glass-nav-btn-root">
            <Link href="/dashboard" className="liquid-glass-nav-btn">
              Dashboard
            </Link>
            <div aria-hidden="true" className="liquid-glass-nav-btn-shadow"></div>
          </span>
        ) : (
          <div className="flex items-center gap-2">
            <Link
              href="/signin"
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
              style={{
                color: "var(--foreground)",
                opacity: 0.7,
              }}
            >
              Sign In
            </Link>
            <span className="liquid-glass-nav-btn-root">
              <Link href="/signup" className="liquid-glass-nav-btn">
                Get Started
              </Link>
              <div aria-hidden="true" className="liquid-glass-nav-btn-shadow"></div>
            </span>
          </div>
        )}
      </div>

      {/* Outer hero wrapper — deliberately a plain div, NOT motion.div.
          Any ancestor of `.liquid-glass-btn` that animates opacity or
          transform creates a stacking context that breaks backdrop-filter
          rendering on the button, producing a visible darker→lighter snap
          when the animation settles. Individual children (spots counter,
          headline, subhead, button wrapper) keep their own motion entrances. */}
      <div className="relative z-10 max-w-3xl w-full text-center space-y-8">
        {/* Live spots counter — wrapper is plain div, not motion.div.
            Both opacity and scale (transform) on an ancestor of the
            .liquid-glass-pill surface create stacking contexts that
            affect backdrop-filter rendering, causing a visible snap
            when entrance animations settle. */}
        <div>
          <SpotsCounter />
        </div>

        {/* Headline — two lines, second ends with cycling keyword.
            KeywordCycle owns its own animation timeline; h1 only fires
            the entrance once at mount, then settles to a stable
            opacity:1/y:0 state — no ancestor stacking-context issue
            for the cycling word's mask reveal. */}
        <motion.h1
          className="text-5xl sm:text-6xl lg:text-[80px] font-normal tracking-[-1.5px] leading-[1.05]"
          style={{ fontFamily: "var(--font-serif)" }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.7, ease: SNAPPY }}
        >
          Your personal agent
          <br />
          with its own <KeywordCycle />
        </motion.h1>

        {/* Subtext — benefit-driven, three short beats matching the
            cycling-word cadence above, with a "we make it easy"
            closer that disarms the technical-skill barrier.
            "Never forgets a detail" / "Never sleeps" / "Gets smarter
            every day" are outcomes the user feels, not infrastructure
            features (the cycling words already handle the feature
            list). Squiggle + scribble SVG decorations from the prior
            subtitle removed — they were anchored to specific phrases
            that no longer exist. */}
        <motion.p
          className="text-base sm:text-xl max-w-md sm:max-w-xl mx-auto leading-[2] sm:leading-relaxed sm:text-balance"
          style={{ color: "var(--muted)" }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.7, ease: SNAPPY }}
        >
          Never forgets a detail. Never sleeps. Gets smarter every day. No technical experience required — we make it easy.
        </motion.p>

        {/* CTA — plain div, NOT motion.div. Both opacity AND transform on an
            ancestor of the glass button create stacking contexts that affect
            backdrop-filter rendering, causing a visible snap when animations
            settle. The button appears statically; ScarcityLine still has its
            own motion entrance below. */}
        <div className="flex flex-col items-center gap-4">
          {WAITLIST_MODE ? (
            <WaitlistForm />
          ) : (
            <>
              <div className="flex justify-center pt-2">
                <div className="liquid-glass-btn-root">
                  <Link
                    href={session ? "/dashboard" : "/signup"}
                    className="liquid-glass-btn"
                  >
                    <span>Claim My Agent</span>
                  </Link>
                  <div aria-hidden="true" className="liquid-glass-btn-shadow"></div>
                </div>
              </div>

              {/* Scarcity line — quieted to a whisper */}
              <ScarcityLine />
            </>
          )}
        </div>

      </div>
    </section>
  );
}

function ScarcityLine() {
  const spots = useSpotsCount();
  if (spots === null) return null;
  return (
    <motion.span
      className="inline-flex items-center gap-1.5 text-[11px] tracking-wide"
      style={{ color: "var(--muted)", opacity: 0.55 }}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 0.55, y: 0 }}
      transition={{ delay: 1.2, duration: 0.5, ease: SNAPPY }}
    >
      <Cloud size={11} strokeWidth={1.5} className="shrink-0" style={{ opacity: 0.7 }} />
      <span>Limited cloud servers — only <span className="font-medium shimmer-text" style={{ fontFamily: "var(--font-serif)", opacity: 1 }}>{spots}</span> agents left</span>
    </motion.span>
  );
}
