"use client";

import Image from "next/image";
import Link from "next/link";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { useSession } from "next-auth/react";
import { Suspense, useEffect, useRef, useState } from "react";
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
 * KeywordCycle — premium mask-reveal cycling word with width-fluid
 * container.
 *
 * Cooper's 2026-05-24 callout: the prior fixed-width-to-widest-word
 * approach (CSS grid sizer stack) left ugly gaps after "own" on
 * shorter words like "soul" or "skills". Fixed by replacing the
 * fixed grid with a hidden measurement layer that exposes each
 * word's natural width, and animating the visible container's
 * width to match the current word — synchronized with the slide
 * reveal so they feel like one motion.
 *
 * Width animation: framer-motion `animate={{ width }}` on the
 * visible container, same 500ms / cubic-bezier(0.25, 1, 0.32, 1)
 * as the word reveal. Width target is the measured width of the
 * current word; widths are measured once on mount and re-measured
 * after fonts load (Instrument Serif font-swap can shift glyph
 * widths a few px).
 *
 * Mask reveal: AnimatePresence `mode="popLayout"` keeps the
 * exiting word in flow visually while the new word slides up from
 * below. The container's overflow-hidden creates the slot.
 * `initial={false}` on Presence means the first word ("computer")
 * renders instantly with no slide-in.
 *
 * Left-aligned inside the container — the cycling word sits
 * directly adjacent to "own" with natural sentence spacing.
 *
 * Reduced motion: `useReducedMotion()` collapses to opacity-only.
 */
function KeywordCycle() {
  const [index, setIndex] = useState(0);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const reduced = useReducedMotion();
  const sizerContainerRef = useRef<HTMLSpanElement>(null);

  // Cycle the index on a steady interval.
  useEffect(() => {
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % KEYWORDS.length);
    }, KEYWORD_HOLD_MS);
    return () => clearInterval(id);
  }, []);

  // Measure each word's natural width via the hidden sizer block.
  // Re-measure after fonts load — Instrument Serif font-swap can
  // shift glyph widths by a few px, which would otherwise leave the
  // container slightly mis-sized on first paint.
  useEffect(() => {
    const measure = () => {
      const root = sizerContainerRef.current;
      if (!root) return;
      const next: Record<string, number> = {};
      root.querySelectorAll<HTMLElement>("[data-keyword]").forEach((el) => {
        const key = el.dataset.keyword!;
        next[key] = el.getBoundingClientRect().width;
      });
      setWidths(next);
    };
    measure();
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(measure).catch(() => {});
    }
  }, []);

  const word = KEYWORDS[index];
  const targetWidth = widths[word];

  return (
    <>
      {/* Hidden measurement layer — every keyword rendered off-screen
          (absolute, visibility:hidden, left:-9999) so it occupies no
          inline space. Inherits the headline's font/size/weight from
          its parent <h1>. Each child has data-keyword for refless
          lookup. `inline-block` (NOT block!) is load-bearing: block
          children stretch to the parent's auto-width (= widest word),
          which makes every measurement read the widest word's width.
          Inline-block sizes each child to its own content. */}
      <span
        ref={sizerContainerRef}
        aria-hidden="true"
        className="pointer-events-none whitespace-nowrap"
        style={{
          position: "absolute",
          visibility: "hidden",
          left: "-9999px",
          top: 0,
        }}
      >
        {KEYWORDS.map((w) => (
          <span
            key={w}
            data-keyword={w}
            className="inline-block whitespace-nowrap"
            style={{ marginRight: 20 }}
          >
            {w}
          </span>
        ))}
      </span>

      {/* Visible cycling container — width animates to the current
          word's measured width, overflow:hidden creates the mask
          slot.
          inline-FLEX (not inline-block!) is load-bearing for baseline
          alignment: per CSS spec, an inline-BLOCK's baseline becomes
          the bottom margin edge when overflow is non-visible, which
          would push the cycling word visibly higher than the
          surrounding "with its own" text. Inline-flex computes its
          baseline from its flex items (via align-items:baseline), so
          the cycling word's baseline ends up co-located with the
          surrounding text's baseline. */}
      <motion.span
        className="relative inline-flex overflow-hidden"
        animate={{ width: targetWidth ?? "auto" }}
        transition={{
          duration: reduced ? 0.01 : KEYWORD_TRANSITION_S,
          ease: KEYWORD_EASE,
        }}
        style={{
          verticalAlign: "baseline",
          alignItems: "baseline",
          lineHeight: "inherit",
        }}
        aria-live="polite"
        aria-atomic="true"
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
      </motion.span>
    </>
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
          Your personalized agent
          <br />
          with its own <KeywordCycle />
        </motion.h1>

        {/* Subtext — benefit-driven, three short beats matching the
            cycling-word cadence above, with a "we make it easy"
            closer that disarms the technical-skill barrier.
            Squiggle + scribble SVG decorations from the prior subtitle
            are restored on the analogous new phrases:
              • scribble circle → "Never forgets a detail"
                (heir to the old "remembers everything")
              • squiggle underline → "Never sleeps"
                (heir to the old "around the clock")
            Delays preserved (1.8s scribble, 1.4s squiggle) — start
            just after the parent <motion.p> settles at ~T=1.2s. */}
        <motion.p
          className="text-base sm:text-xl max-w-md sm:max-w-xl mx-auto leading-[2] sm:leading-relaxed sm:text-balance"
          style={{ color: "var(--muted)" }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.7, ease: SNAPPY }}
        >
          <span className="relative inline-block">
            <motion.svg
              className="absolute pointer-events-none"
              style={{
                left: "-12px",
                top: "-6px",
                width: "calc(100% + 24px)",
                height: "calc(100% + 12px)",
              }}
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 200 100"
              preserveAspectRatio="none"
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.7 }}
              transition={{ delay: 1.8, duration: 0.1 }}
            >
              <motion.path
                d="M8,50 Q10,16 55,13 Q120,10 170,20 Q192,35 190,55 Q188,78 150,86 Q100,92 40,84 Q6,74 8,50"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ delay: 1.8, duration: 0.7, ease: "easeOut" }}
              />
            </motion.svg>
            <span className="relative">Never forgets a detail</span>
          </span>
          .{" "}
          <span className="relative inline-block">
            Never sleeps
            <motion.span
              className="absolute pointer-events-none left-0 bottom-0"
              style={{
                height: "6px",
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='6' viewBox='0 0 20 6'%3E%3Cpath d='M0,3 Q5,0.5 10,3 Q15,5.5 20,3' fill='none' stroke='%23DC6743' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E")`,
                backgroundRepeat: "repeat-x",
                backgroundSize: "20px 6px",
                transformOrigin: "left center",
              }}
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: "100%", opacity: 0.85 }}
              transition={{ delay: 1.4, duration: 0.6, ease: "easeOut" }}
            />
          </span>
          . Gets smarter every day. No technical experience required — we make it easy.
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
