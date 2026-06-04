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
// different axis of dedicated infrastructure: physical → financial
// flow → financial storage → cognitive → digital → social →
// comprehensive → token economy → payments rail → identity. Each
// maps to a real capability:
//   computer    → dedicated Linode VM (g6-dedicated-2)
//   income      → recurring revenue flow back to wallet; token
//                  launches via Bankr partnership shipped today,
//                  on-chain trading + agent-to-agent service
//                  marketplaces + bounty platform integrations
//                  next on the roadmap (mirrors the Has Its Own
//                  Income card in features.tsx)
//   wallet      → Bankr EVM wallet on Base mainnet
//   memory      → gbrain PGLite + workspace files
//   browser     → Chromium + browser-auto plugin, persistent state
//   friends     → cross-VM agent-to-agent contact list
//   skills      → MCP skill system (polymarket, solana, …)
//   token       → ACP / Bankr token launch capability (the asset
//                  side; income above is the revenue-flow side)
//   debit card  → spendable on-chain $$ via wallet
//   soul        → SOUL.md personality + identity persistence
// Order locked by Cooper 2026-05-26. Income inserted at position 2
// (directly after computer) per Cooper's explicit call — placing
// the most "wait what?" hook second in the cycle hits the wild
// reaction harder and faster, before the reader settles. Position
// 3 (after wallet) was the alternative considered; position 2 won
// because the shock-value sequence (computer -> INCOME) beats the
// logical-financial-pair sequence (wallet -> income). Do NOT
// reorder without re-checking the visual rhythm (short → long →
// short cadence of word lengths).
const KEYWORDS = [
  "computer",
  "income",
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
            // shimmer-accent fires a one-shot CSS animation per word
            // mount: 0.5s delay (waits for slide-in to complete) +
            // 2.3s sweep + 0.2s post-shimmer buffer = settles into
            // solid base color just before the next word arrives.
            // The CSS animation lives on the inner element (NOT the
            // container) so each new word's mount triggers a fresh
            // animation cycle. Framer's transform/opacity props and
            // the CSS background-position animation target different
            // properties and don't conflict.
            className="block whitespace-nowrap shimmer-accent"
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
          blog
        </Link>
        {session ? (
          <span className="liquid-glass-nav-btn-root">
            <Link href="/tasks" className="liquid-glass-nav-btn">
              open instaclaw
            </Link>
            <div aria-hidden="true" className="liquid-glass-nav-btn-shadow"></div>
          </span>
        ) : (
          <div className="flex items-center gap-2">
            {/* Nav "sign in" stays bare — returning-user energy.
                The /signin server wrapper defaults to "sign in." for
                this entry point. Nav "get started" gets ?new=1 like
                the hero CTA so newcomers downstream see "claim your
                agent." on the auth page. */}
            <Link
              href="/signin"
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
              style={{
                color: "var(--foreground)",
                opacity: 0.7,
              }}
            >
              sign in
            </Link>
            <span className="liquid-glass-nav-btn-root">
              <Link href="/channels?new=1" className="liquid-glass-nav-btn">
                get started
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
            closer that disarms the technical-skill barrier. Plain
            text — squiggle + scribble SVG decorations removed
            2026-05-24 per Cooper after seeing them in the new
            layout. */}
        <motion.p
          className="text-base sm:text-xl max-w-md sm:max-w-xl mx-auto leading-[2] sm:leading-relaxed sm:text-balance"
          style={{ color: "var(--muted)" }}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.7, ease: SNAPPY }}
        >
          Never forgets a detail. Never sleeps. Gets smarter every day. No technical experience required, we make it easy.
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
              {/* 2026-05-30 — append ?new=1 to the unauth CTA so it
                  threads through /channels → /onboarding/web →
                  middleware → /signin with the newcomer-intent flag.
                  The server wrapper at /signin reads ?new=1 OR a
                  funnel-mid callbackUrl to swap the headline from
                  "sign in." to "claim your agent." Preserves the
                  emotional energy of the click from this CTA to the
                  auth page. Authed users → /tasks (Command Center,
                  per D1 gravity shift); no flag needed. */}
              <div className="flex justify-center pt-2">
                <div className="liquid-glass-btn-root">
                  <Link
                    href={session ? "/tasks" : "/channels?new=1"}
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
      <span>Limited cloud servers, only <span className="font-medium shimmer-text" style={{ fontFamily: "var(--font-serif)", opacity: 1 }}>{spots}</span> agents left</span>
    </motion.span>
  );
}
