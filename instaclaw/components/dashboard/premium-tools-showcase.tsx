"use client";

/**
 * Premium Tools Showcase — the /skills conversion hero.
 *
 * A single banner at the top of /skills that turns "six premium tools" into a
 * game: see the prize → understand the one move (verify) → make it → feel the
 * unlock → own it. Both states are driven by GET /api/auth/world-id/status.
 *
 * State machine (see the per-branch comments below):
 *   loading    → neutral skeleton, commits to neither locked nor owned, so a
 *                returning verified user NEVER sees a lock flash (and vice
 *                versa). Locks appear only once unverified is confirmed.
 *   unverified → "One scan. Six premium tools." prize grid + the CTA. Hovering
 *                a tile reveals a concrete for-instance (curiosity reward).
 *   verified   → "Your agent has six premium tools." green + checks + receipt.
 *   hidden     → fetch failed/401/timeout → render null (matches
 *                PremiumToolsCard's silent-hide contract).
 *
 * The unlock moment (the most important frame) is detected two ways, both
 * fully in-scope (no dashboard changes):
 *   - navigated away to /dashboard#human-verification and back → /skills
 *     remounts; a fresh verify (verified_at within FRESH_WINDOW) plays a
 *     celebratory arrival (no locks shown first — that would be a downgrade
 *     flash).
 *   - tab stayed open while they verified on phone / another tab → a focus +
 *     visibilitychange listener refetches; a false→true flip while the locked
 *     state is on screen pops the locks off in place.
 * Celebration fires once per session (sessionStorage flag) and respects
 * prefers-reduced-motion.
 *
 * Scope: this component + its mount in app/(dashboard)/skills/page.tsx only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  Search,
  Telescope,
  Globe,
  Layers,
  Mail,
  Plane,
  Lock,
  CheckCircle2,
  ArrowRight,
} from "lucide-react";
import { WorldLogo } from "@/components/icons/world-logo";

interface WorldIDStatus {
  verified: boolean;
  verified_at: string | null;
  verification_level: string | null;
  total_verified_count: number;
}

type Phase = "loading" | "unverified" | "verified" | "hidden";

const FRESH_WINDOW_MS = 5 * 60 * 1000; // "just verified" if within 5 minutes
const CELEBRATED_KEY = "instaclaw_premium_unlock_celebrated";
const STATUS_TIMEOUT_MS = 8_000;
const VERIFY_HREF = "/dashboard#human-verification";

// Benefit-first, never spec-speak. `line` is the crisp primary; `more` is the
// desktop-hover for-instance that makes the capability tangible. Honest
// capability illustrations, not fabricated testimonials.
const TOOLS: {
  id: string;
  name: string;
  Icon: typeof Search;
  line: string;
  more: string;
}[] = [
  {
    id: "exa",
    name: "Exa",
    Icon: Search,
    line: "Finds the exact answer on the first try, where a normal search takes three.",
    more: "Ask for “the 2017 paper that introduced transformers” and it returns the paper, not a page of links.",
  },
  {
    id: "manus",
    name: "Manus",
    Icon: Telescope,
    line: "Hand it a hard question and it runs a full research project, reading dozens of sources before it reports back.",
    more: "“Compare every major L2’s fee model” comes back as a sourced brief, not ten tabs you read yourself.",
  },
  {
    id: "browserbase",
    name: "Browserbase",
    Icon: Globe,
    line: "Drives a real cloud browser, so it can work sites that block bots and act behind logins.",
    more: "It can log in, click through a flow, and pull what is behind the wall, cleanly and without a trace.",
  },
  {
    id: "parallel",
    name: "Parallel",
    Icon: Layers,
    line: "Pulls clean, cited data from across the web at scale, the report you would spend an afternoon building.",
    more: "Point it at 200 pages and get one structured table back, every figure cited.",
  },
  {
    id: "agentmail",
    name: "AgentMail",
    Icon: Mail,
    line: "Gives your agent its own inbox. It sends and handles email without ever touching yours.",
    more: "It can email a vendor, watch for the reply, and act on it, all on its own address.",
  },
  {
    id: "stabletravel",
    name: "StableTravel",
    Icon: Plane,
    line: "Books real flights and hotels end to end, not just links you finish yourself.",
    more: "“Get me to Lisbon for the conference” becomes a booked itinerary, not a list of options.",
  },
];

function formatSince(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  } catch {
    return null;
  }
}

export function PremiumToolsShowcase() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [celebrating, setCelebrating] = useState(false);

  // Refs so the focus listener + async resolver read live values without
  // re-subscribing, and so render never reads Date/sessionStorage/matchMedia
  // (keeps SSR deterministic — first paint is always the skeleton).
  const phaseRef = useRef<Phase>("loading");
  phaseRef.current = phase;
  const celebratedRef = useRef(false);
  const reducedMotionRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    reducedMotionRef.current =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    try {
      celebratedRef.current = sessionStorage.getItem(CELEBRATED_KEY) === "1";
    } catch {
      /* sessionStorage unavailable — treat as not celebrated */
    }
  }, []);

  const fireConfetti = useCallback(async () => {
    if (reducedMotionRef.current) return;
    try {
      const mod = await import("canvas-confetti");
      const confetti = mod.default;
      const el = rootRef.current;
      const originY = el
        ? (el.getBoundingClientRect().top + 70) / window.innerHeight
        : 0.28;
      confetti({
        particleCount: 64,
        spread: 72,
        startVelocity: 38,
        gravity: 1.15,
        ticks: 170,
        scalar: 0.9,
        origin: { x: 0.5, y: Math.max(0.05, Math.min(0.6, originY)) },
        colors: ["#22c55e", "#16a34a", "#bbf7d0", "#ffffff"],
        disableForReducedMotion: true,
      });
    } catch {
      /* confetti is pure flourish — never let it throw */
    }
  }, []);

  const applyStatus = useCallback(
    (data: WorldIDStatus) => {
      setCount(
        typeof data.total_verified_count === "number"
          ? data.total_verified_count
          : 0
      );

      if (data.verified) {
        setVerifiedAt(data.verified_at ?? null);
        const fresh = data.verified_at
          ? Date.now() - new Date(data.verified_at).getTime() < FRESH_WINDOW_MS
          : false;
        // Celebrate when (a) the locked state was on screen and just flipped
        // (true in-place unlock), or (b) they just verified and navigated back
        // (fresh). Never twice in a session; never under reduced motion.
        const wasLockedOnScreen = phaseRef.current === "unverified";
        const shouldCelebrate =
          !celebratedRef.current &&
          !reducedMotionRef.current &&
          (wasLockedOnScreen || fresh);

        setPhase("verified");

        if (shouldCelebrate) {
          celebratedRef.current = true;
          try {
            sessionStorage.setItem(CELEBRATED_KEY, "1");
          } catch {
            /* best effort */
          }
          setCelebrating(true);
          fireConfetti();
          window.setTimeout(() => setCelebrating(false), 2200);
        }
        return;
      }

      // Verification is permanent — once verified, never downgrade the UI on a
      // later odd/failed refetch.
      if (phaseRef.current !== "verified") setPhase("unverified");
    },
    [fireConfetti]
  );

  const fetchStatus = useCallback(async () => {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), STATUS_TIMEOUT_MS);
    try {
      const res = await fetch("/api/auth/world-id/status", {
        cache: "no-store",
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // Hide on failure (spec) — but only from the initial load. If we are
        // already showing a state, keep it (avoid a shown→hidden flicker).
        if (phaseRef.current === "loading") setPhase("hidden");
        return;
      }
      const data = (await res.json()) as WorldIDStatus;
      applyStatus(data);
    } catch {
      if (phaseRef.current === "loading") setPhase("hidden");
    } finally {
      window.clearTimeout(timer);
    }
  }, [applyStatus]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Refetch when the tab regains focus / becomes visible — catches a verify
  // that happened on the dashboard or another device while this stayed open.
  useEffect(() => {
    function recheck() {
      if (phaseRef.current === "verified") return; // permanent; nothing to gain
      fetchStatus();
    }
    function onVisibility() {
      if (document.visibilityState === "visible") recheck();
    }
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchStatus]);

  if (phase === "hidden") return null;

  // ── Loading: neutral skeleton (no locks, no green) ──
  if (phase === "loading") {
    return (
      <div
        className="glass rounded-2xl p-7 sm:p-9 relative overflow-hidden"
        style={{ border: "1px solid var(--border)" }}
        aria-hidden
      >
        <div className="flex items-center justify-between mb-5">
          <div
            className="h-5 w-40 rounded-full animate-pulse"
            style={{ background: "rgba(0,0,0,0.05)" }}
          />
          <div
            className="h-5 w-20 rounded-full animate-pulse"
            style={{ background: "rgba(0,0,0,0.05)" }}
          />
        </div>
        <div
          className="h-8 w-72 max-w-full rounded-lg animate-pulse mb-3"
          style={{ background: "rgba(0,0,0,0.05)" }}
        />
        <div
          className="h-4 w-full max-w-lg rounded-md animate-pulse mb-6"
          style={{ background: "rgba(0,0,0,0.04)" }}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
          {TOOLS.map((t) => (
            <div
              key={t.id}
              className="rounded-xl p-4 h-[104px] animate-pulse"
              style={{
                background: "rgba(0,0,0,0.035)",
                border: "1px solid var(--border)",
              }}
            />
          ))}
        </div>
        <div
          className="h-11 w-56 rounded-full animate-pulse"
          style={{ background: "rgba(0,0,0,0.05)" }}
        />
      </div>
    );
  }

  const verified = phase === "verified";
  const sinceLabel = formatSince(verifiedAt);

  return (
    <motion.div
      ref={rootRef}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="glass rounded-2xl p-7 sm:p-9 relative overflow-hidden"
      style={{
        border: verified
          ? "1px solid rgba(34,197,94,0.35)"
          : "1px solid var(--border)",
      }}
    >
      {/* Ambient wash — green when owned, cool/neutral when locked */}
      <motion.div
        className="absolute inset-0 pointer-events-none"
        initial={false}
        animate={{ opacity: 1 }}
        style={{
          background: verified
            ? "radial-gradient(ellipse at 25% 15%, rgba(34,197,94,0.10) 0%, transparent 55%), radial-gradient(ellipse at 80% 90%, rgba(34,197,94,0.06) 0%, transparent 55%)"
            : "radial-gradient(ellipse at 25% 15%, rgba(59,130,246,0.06) 0%, transparent 55%), radial-gradient(ellipse at 80% 90%, rgba(168,85,247,0.05) 0%, transparent 55%)",
        }}
      />

      <div className="relative z-10">
        {/* Eyebrow row */}
        <div className="flex items-center justify-between gap-3 mb-3.5">
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase"
            style={{ color: "var(--muted)" }}
          >
            <WorldLogo
              className="w-3.5 h-3.5"
              style={{ color: verified ? "#16a34a" : "var(--muted)" }}
            />
            Premium · World ID
          </span>

          <AnimatePresence mode="wait" initial={false}>
            {verified ? (
              <motion.span
                key="chip-verified"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ type: "spring", stiffness: 420, damping: 24 }}
                className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full shrink-0"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(34,197,94,0.22), rgba(22,163,74,0.16))",
                  color: "rgb(34,197,94)",
                  boxShadow:
                    "0 0 0 1px rgba(34,197,94,0.25), inset 0 1px 0 rgba(255,255,255,0.15)",
                }}
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                Human Verified
              </motion.span>
            ) : (
              <motion.span
                key="chip-locked"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full shrink-0"
                style={{
                  background: "rgba(0,0,0,0.04)",
                  color: "var(--muted)",
                  border: "1px solid var(--border)",
                }}
              >
                <Lock className="w-3 h-3" />
                Locked
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* Headline — the trade (locked) / the possessive (owned) */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.h2
            key={verified ? "h-verified" : "h-locked"}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3 }}
            className="text-2xl sm:text-[2rem] font-normal tracking-[-0.5px] leading-tight"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            {verified
              ? "Your agent has six premium tools."
              : "One scan. Six premium tools."}
          </motion.h2>
        </AnimatePresence>

        {/* Subhead */}
        <p
          className="text-sm mt-2 max-w-xl leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          {verified ? (
            <>
              Exa, Manus, Browserbase, Parallel, AgentMail, and StableTravel are
              live in your agent&apos;s toolkit
              {sinceLabel ? <> since {sinceLabel}</> : null}.
            </>
          ) : (
            <>
              Exa, Manus, Browserbase, Parallel, AgentMail, and StableTravel. The
              search, research, and automation that make your agent actually get
              things done. One World ID scan unlocks them, free, and it takes
              about 30 seconds.
            </>
          )}
        </p>

        {/* Prize grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-6">
          {TOOLS.map((tool, i) => (
            <motion.div
              key={tool.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.06 + i * 0.05, duration: 0.28 }}
              whileHover={{ y: -3 }}
              className="group relative rounded-xl p-4 overflow-hidden"
              style={{
                background: verified
                  ? "rgba(34,197,94,0.05)"
                  : "rgba(255,255,255,0.4)",
                border: verified
                  ? "1px solid rgba(34,197,94,0.22)"
                  : "1px solid var(--border)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                opacity: verified ? 1 : 0.96,
                transition: "box-shadow 0.2s ease, opacity 0.4s ease",
              }}
            >
              {/* Corner state glyph — lock (soon) / check (owned) */}
              <div className="absolute top-3 right-3">
                <AnimatePresence mode="wait" initial={false}>
                  {verified ? (
                    <motion.span
                      key="check"
                      initial={
                        celebrating
                          ? { opacity: 0, scale: 0, rotate: -30 }
                          : { opacity: 0, scale: 0.6 }
                      }
                      animate={{ opacity: 1, scale: 1, rotate: 0 }}
                      exit={{ opacity: 0, scale: 0.6 }}
                      transition={
                        celebrating
                          ? {
                              type: "spring",
                              stiffness: 500,
                              damping: 18,
                              delay: 0.12 + i * 0.07,
                            }
                          : { duration: 0.2 }
                      }
                    >
                      <CheckCircle2
                        className="w-4 h-4"
                        style={{ color: "rgb(34,197,94)" }}
                      />
                    </motion.span>
                  ) : (
                    <motion.span
                      key="lock"
                      initial={{ opacity: 0, scale: 0.6 }}
                      animate={{ opacity: 0.45, scale: 1 }}
                      exit={
                        celebrating
                          ? { opacity: 0, scale: 0, y: -8, rotate: 20 }
                          : { opacity: 0, scale: 0.6 }
                      }
                      transition={
                        celebrating
                          ? { duration: 0.3, delay: i * 0.05 }
                          : { duration: 0.2 }
                      }
                    >
                      <Lock className="w-3.5 h-3.5" style={{ color: "var(--muted)" }} />
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>

              <div className="flex items-start gap-3">
                <div
                  className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
                  style={{
                    background: verified
                      ? "linear-gradient(135deg, rgba(34,197,94,0.18), rgba(22,163,74,0.12))"
                      : "rgba(0,0,0,0.04)",
                    border: verified
                      ? "1px solid rgba(34,197,94,0.2)"
                      : "1px solid var(--border)",
                  }}
                >
                  <tool.Icon
                    className="w-[18px] h-[18px]"
                    style={{ color: verified ? "rgb(22,163,74)" : "var(--foreground)" }}
                  />
                </div>
                <div className="min-w-0 pr-4">
                  <h3 className="text-sm font-semibold leading-none mb-1.5">
                    {tool.name}
                  </h3>
                  <p
                    className="text-xs leading-relaxed"
                    style={{ color: "var(--muted)" }}
                  >
                    {tool.line}
                  </p>
                  {/* Curiosity reward — desktop hover reveals the for-instance */}
                  <div
                    className="overflow-hidden max-h-0 opacity-0 group-hover:max-h-24 group-hover:opacity-100 group-hover:mt-2 transition-all duration-300"
                  >
                    <p
                      className="text-[11px] leading-relaxed italic"
                      style={{ color: "var(--muted)", opacity: 0.85 }}
                    >
                      {tool.more}
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Action row */}
        <div className="mt-7">
          {verified ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Link
                href="/dashboard"
                className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-70"
                style={{ color: "rgb(22,163,74)" }}
              >
                Track your monthly allocation on your dashboard
                <ArrowRight className="w-3.5 h-3.5" />
              </Link>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                {/* The single most important pixel — high-contrast, pressable */}
                <motion.div
                  animate={
                    reducedMotionRef.current
                      ? undefined
                      : {
                          boxShadow: [
                            "0 4px 18px rgba(0,0,0,0.18)",
                            "0 6px 26px rgba(0,0,0,0.26)",
                            "0 4px 18px rgba(0,0,0,0.18)",
                          ],
                        }
                  }
                  transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
                  className="rounded-full"
                  style={{ width: "fit-content" }}
                >
                  <Link
                    href={VERIFY_HREF}
                    className="inline-flex items-center gap-2.5 px-7 py-3.5 rounded-full text-[15px] font-semibold transition-transform active:scale-[0.97] hover:scale-[1.02]"
                    style={{
                      background:
                        "linear-gradient(135deg, #1a1a1a 0%, #000000 100%)",
                      color: "#ffffff",
                      boxShadow:
                        "0 0 0 1px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.12)",
                    }}
                  >
                    <WorldLogo className="w-[18px] h-[18px]" style={{ color: "#ffffff" }} />
                    Verify with World ID
                  </Link>
                </motion.div>

                <div className="flex flex-col">
                  <span className="text-xs font-medium" style={{ color: "var(--foreground)" }}>
                    Free · about 30 seconds
                  </span>
                  {count > 0 && (
                    <span
                      className="inline-flex items-center gap-1.5 text-[11px] mt-0.5"
                      style={{ color: "var(--muted)" }}
                    >
                      <CheckCircle2 className="w-3 h-3" style={{ color: "rgb(34,197,94)" }} />
                      {count.toLocaleString()} verified
                    </span>
                  )}
                </div>
              </div>

              <p className="text-xs max-w-xl leading-relaxed" style={{ color: "var(--muted)" }}>
                World ID proves you are a unique human with zero-knowledge proofs.
                We never see who you are, and your tools activate the second you
                finish.
              </p>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
