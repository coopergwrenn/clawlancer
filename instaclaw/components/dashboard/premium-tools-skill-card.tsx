"use client";

/**
 * Premium Tools — a skill entry IN the /skills grid (not a top banner).
 *
 * Premium tools are functionally a skill: a peer of E-Commerce, Clawlancer,
 * Solana DeFi, etc. So this renders as a normal grid card (collapsed) that
 * expands into a detail overlay — reusing the SAME toggle→overlay mechanism as
 * the Solana DeFi "Wallet ▼" expander, so it reads as the same component
 * family, not bolted on. The page mounts it as the first grid card on the
 * "all" category, so it is prominent by being first, not by being huge.
 *
 * Data layer is unchanged from the prior banner: GET /api/auth/world-id/status
 * drives verified / verified_at / count. Relocated and reshaped, not rebuilt.
 *
 * States:
 *   loading    → neutral skeleton card (no lock, no green) so we never flash
 *                unverified-then-verified or vice versa.
 *   unverified → collapsed: the trade hook ("One scan, six premium tools").
 *                expanded: the six tools as the prize + Verify CTA.
 *   verified   → collapsed: calm ownership ("live in your agent's toolkit").
 *                expanded: the six owned tools + dashboard-usage link.
 *   hidden     → render null on fetch failure / 401 / timeout.
 *
 * Unlock moment: a focus/visibilitychange refetch updates the card live when
 * the user returns from verifying. Celebration is deliberately TONED DOWN from
 * the banner's full-screen confetti to a single in-card green pulse + badge
 * flip — confetti is disproportionate for a small inline grid card; the
 * satisfying signal here is the card itself flipping to owned. Once per session
 * (sessionStorage), respects prefers-reduced-motion.
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
  ChevronDown,
  X,
  type LucideIcon,
} from "lucide-react";
import { WorldLogo } from "@/components/icons/world-logo";
import { SkillOrb } from "@/components/skill-orb";

// World-premium orb color. This orb's 3D pop comes from a BRIGHT center in the
// radial gradient — a dark/obsidian color can't produce that (tested: obsidian
// read flat/dull next to the vivid siblings and missed the "comparable visual
// weight" bar), so a saturated hue is required to match their dimensionality.
// Iris-indigo reads premium + World-tech, and among the actual grid neighbors
// (ecommerce sky-blue #4A90D9, clawlancer amber #E5A13B, virtuals/solana violet
// #7C3AED) it's distinct — bluer than the violets, more saturated than the
// sky-blue. (The only same-family value in the broader skill map is
// email-outreach #6366F1, which does not appear alongside Premium Tools.)
// The glossy sphere render is the real SkillOrb — identical to siblings by
// construction; only the color + glyph differ.
const WORLD_ORB_COLOR = "#5D5FEF";
// WorldLogo is an ({className, style}) => <svg fill="currentColor"> — it honors
// className (sizing) + style (color=white from SkillOrb) and harmlessly ignores
// the strokeWidth SkillOrb passes. The cast bridges it to SkillOrb's
// icon: LucideIcon prop WITHOUT modifying the shared SkillOrb component.
const WorldOrbIcon = WorldLogo as unknown as LucideIcon;

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

// Benefit-first one-liners — never spec-speak. These stay exactly as written.
const TOOLS: { id: string; name: string; Icon: typeof Search; line: string }[] = [
  { id: "exa", name: "Exa", Icon: Search, line: "Finds the exact answer on the first try, where a normal search takes three." },
  { id: "manus", name: "Manus", Icon: Telescope, line: "Hand it a hard question and it runs a full research project, reading dozens of sources before it reports back." },
  { id: "browserbase", name: "Browserbase", Icon: Globe, line: "Drives a real cloud browser, so it can work sites that block bots and act behind logins." },
  { id: "parallel", name: "Parallel", Icon: Layers, line: "Pulls clean, cited data from across the web at scale, the report you would spend an afternoon building." },
  { id: "agentmail", name: "AgentMail", Icon: Mail, line: "Gives your agent its own inbox. It sends and handles email without ever touching yours." },
  { id: "stabletravel", name: "StableTravel", Icon: Plane, line: "Plans the whole trip: the best flights and hotels, priced and ready. Booking end to end coming soon." },
];

export function PremiumToolsSkillCard() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false); // expand modal — resets per load (matches Solana wallet)
  const [celebrating, setCelebrating] = useState(false);

  const phaseRef = useRef<Phase>("loading");
  phaseRef.current = phase;
  const celebratedRef = useRef(false);
  const reducedMotionRef = useRef(false);

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

  const applyStatus = useCallback((data: WorldIDStatus) => {
    setCount(typeof data.total_verified_count === "number" ? data.total_verified_count : 0);
    if (data.verified) {
      setVerifiedAt(data.verified_at ?? null);
      const fresh = data.verified_at
        ? Date.now() - new Date(data.verified_at).getTime() < FRESH_WINDOW_MS
        : false;
      const wasLockedOnScreen = phaseRef.current === "unverified";
      const shouldCelebrate =
        !celebratedRef.current && !reducedMotionRef.current && (wasLockedOnScreen || fresh);
      setPhase("verified");
      if (shouldCelebrate) {
        celebratedRef.current = true;
        try {
          sessionStorage.setItem(CELEBRATED_KEY, "1");
        } catch {
          /* best effort */
        }
        setCelebrating(true);
        window.setTimeout(() => setCelebrating(false), 1600);
      }
      return;
    }
    // Verification is permanent — never downgrade a shown verified card.
    if (phaseRef.current !== "verified") setPhase("unverified");
  }, []);

  const fetchStatus = useCallback(async () => {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), STATUS_TIMEOUT_MS);
    try {
      const res = await fetch("/api/auth/world-id/status", { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) {
        if (phaseRef.current === "loading") setPhase("hidden"); // hide on failure (spec)
        return;
      }
      applyStatus((await res.json()) as WorldIDStatus);
    } catch {
      if (phaseRef.current === "loading") setPhase("hidden");
    } finally {
      window.clearTimeout(timer);
    }
  }, [applyStatus]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Refetch on focus / visibility — updates the card live when the user
  // returns from verifying (dashboard, phone, or another tab).
  useEffect(() => {
    function recheck() {
      if (phaseRef.current === "verified") return;
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

  // ── Loading: neutral skeleton card (matches grid card height) ──
  if (phase === "loading") {
    return (
      <div
        className="glass rounded-xl p-5 h-[120px] animate-pulse"
        style={{ border: "1px solid var(--border)" }}
        aria-hidden
      />
    );
  }

  const verified = phase === "verified";

  return (
    <>
      {/* ── Collapsed card — peer of the other grid skill cards ── */}
      <motion.button
        type="button"
        onClick={() => setOpen(true)}
        initial={{ opacity: 0, y: 12 }}
        animate={{
          opacity: 1,
          y: 0,
          boxShadow: celebrating
            ? [
                "0 0 0 0px rgba(34,197,94,0)",
                "0 0 0 4px rgba(34,197,94,0.35)",
                "0 0 0 0px rgba(34,197,94,0)",
              ]
            : "0 0 0 0px rgba(34,197,94,0)",
        }}
        transition={celebrating ? { duration: 1.5 } : { duration: 0.25 }}
        className="group glass rounded-xl p-5 h-[120px] relative overflow-hidden text-left w-full cursor-pointer block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(220,103,67,0.5)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f8f7f4]"
        style={{
          border: verified ? "1px solid rgba(34,197,94,0.3)" : "1px solid var(--border)",
        }}
        aria-label="Premium Tools — see all six"
      >
        <div className="flex items-start gap-3.5">
          {/* Icon — the World mark in the real SkillOrb glossy sphere, so it
              renders identically to the other grid cards (E-Commerce, etc.).
              Constant World color across states; the Active/Locked badge
              already carries the state, and sibling orbs don't state-tint. */}
          <SkillOrb size="sm" color={WORLD_ORB_COLOR} icon={WorldOrbIcon} className="mt-0.5" />

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="text-sm font-medium truncate">Premium Tools</h3>
              {verified ? (
                <span className="skill-pill is-green gap-1 shrink-0">
                  <CheckCircle2 className="w-2.5 h-2.5" />
                  Active
                </span>
              ) : (
                <span className="skill-pill is-neutral gap-1 shrink-0">
                  <Lock className="w-2.5 h-2.5" />
                  Locked
                </span>
              )}
            </div>
            <p className="text-xs leading-relaxed line-clamp-2" style={{ color: "var(--muted)" }}>
              {verified
                ? "Six premium tools, live in your agent's toolkit. Exa, Manus, Browserbase, and three more."
                : "One scan, six premium tools. Exa, Manus, Browserbase and three more, free the moment you verify."}
            </p>
          </div>
        </div>

        {/* Expand affordance — a coral glass pill that reads as a tappable
            button. Same liquid-glass recipe as the Active/Locked skill-pills
            (-75deg white sheen over a radial color-under-glass + layered
            highlight/shadow), in the brand coral, dialed back so it stays calm.
            The hairline coral ring (outer box-shadow layer) gives it a pressable
            surface edge. States are driven by the card (the real <button>):
            group-hover lifts + brightens, group-active presses; the card carries
            the focus-visible ring. Opens the same six-tool modal — behavior
            unchanged. */}
        <span
          className="absolute bottom-2.5 right-2.5 inline-flex items-center gap-1 h-[23px] pl-2.5 pr-2 rounded-full text-[11px] font-semibold leading-none whitespace-nowrap select-none transition-all duration-150 ease-out group-hover:-translate-y-px group-hover:brightness-[1.06] group-active:translate-y-0 group-active:scale-[0.97]"
          style={{
            color: "rgb(178, 66, 40)",
            backgroundColor: "rgba(0,0,0,0)",
            backdropFilter: "blur(3px)",
            WebkitBackdropFilter: "blur(3px)",
            backgroundImage:
              "linear-gradient(-75deg, rgba(255,255,255,0.10), rgba(255,255,255,0.34), rgba(255,255,255,0.10)), " +
              "radial-gradient(125% 150% at 26% 26%, rgba(220,103,67,0.34) 0%, rgba(220,103,67,0.20) 55%, rgba(220,103,67,0.12) 100%)",
            boxShadow:
              "rgba(0,0,0,0.05) 0px 0.5px 1px 0px inset, " +
              "rgba(255,255,255,0.45) 0px -0.5px 1.5px 0px inset, " +
              "rgba(0,0,0,0.10) 0px 1px 2.5px -1px, " +
              "rgba(255,255,255,0.25) 0px 0px 0.5px 0.5px inset, " +
              "rgba(220,103,67,0.22) 0px 0px 0px 0.75px",
          }}
        >
          {verified ? "View tools" : "See all six"}
          <ChevronDown className="w-[13px] h-[13px]" strokeWidth={2.5} aria-hidden />
        </span>
      </motion.button>

      {/* ── Expand overlay — same fixed-modal mechanism as the Solana wallet ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: "rgba(0,0,0,0.4)", backdropFilter: "blur(4px)" }}
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              className="rounded-2xl p-6 w-full max-w-md max-h-[85vh] overflow-y-auto relative"
              style={{
                // Near-solid base so the busy skills page can't bleed through the
                // copy. The `.glass` class was the legibility bug: its
                // `background: linear-gradient(...) !important` overrode the intended
                // `var(--card)` and made the text panel see-through. --card #fff at
                // ~0.97 keeps a hair of glass; the layered inset highlights + glow-ring
                // keep our premium edge; the deep drop shadow matches the proven
                // gmail-connect / chatgpt-connect dialogs.
                background: "rgba(255,255,255,0.97)",
                backdropFilter: "blur(16px)",
                WebkitBackdropFilter: "blur(16px)",
                border: verified ? "1px solid rgba(34,197,94,0.35)" : "1px solid var(--border)",
                boxShadow:
                  "rgba(0,0,0,0.05) 0px 2px 2px 0px inset, " +
                  "rgba(255,255,255,0.6) 0px -2px 2px 0px inset, " +
                  "rgba(255,255,255,0.5) 0px 0px 1.6px 2px inset, " +
                  "0 24px 64px rgba(0,0,0,0.22)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Close */}
              <button
                onClick={() => setOpen(false)}
                className="absolute top-4 right-4 p-1 rounded-lg cursor-pointer transition-opacity hover:opacity-60"
                style={{ color: "var(--muted)" }}
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>

              {/* Header */}
              <div className="flex items-center gap-1.5 mb-1">
                <WorldLogo
                  className="w-3.5 h-3.5"
                  style={{ color: verified ? "#16a34a" : "var(--muted)" }}
                />
                <span
                  className="text-[11px] font-semibold tracking-wide uppercase"
                  style={{ color: "var(--muted)" }}
                >
                  Premium · World ID
                </span>
              </div>
              <h3
                className="text-xl font-normal tracking-[-0.3px] pr-6"
                style={{ fontFamily: "var(--font-serif)" }}
              >
                {verified ? "Your agent gets six new premium tools." : "One scan. Six premium tools."}
              </h3>
              <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--muted)" }}>
                {verified ? (
                  <>Wired into your agent the second you verify your World ID. No keys, no setup.</>
                ) : (
                  <>
                    Verify your World ID and all six go live in your agent&apos;s toolkit. Free, and
                    it takes about 30 seconds.
                  </>
                )}
              </p>

              {/* The six tools */}
              <div className="mt-4 space-y-2.5">
                {TOOLS.map((tool) => (
                  <div key={tool.id} className="flex items-start gap-3">
                    <div
                      className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center mt-0.5"
                      style={{
                        background: verified
                          ? "linear-gradient(135deg, rgba(34,197,94,0.18), rgba(22,163,74,0.12))"
                          : "rgba(0,0,0,0.04)",
                        border: verified ? "1px solid rgba(34,197,94,0.2)" : "1px solid var(--border)",
                      }}
                    >
                      <tool.Icon
                        className="w-4 h-4"
                        style={{ color: verified ? "rgb(22,163,74)" : "var(--foreground)" }}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <h4 className="text-[13px] font-semibold leading-none">{tool.name}</h4>
                        {verified && (
                          <CheckCircle2 className="w-3 h-3 shrink-0" style={{ color: "rgb(34,197,94)" }} />
                        )}
                      </div>
                      <p className="text-[11px] leading-relaxed mt-1" style={{ color: "var(--muted)" }}>
                        {tool.line}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Action */}
              <div className="mt-5">
                {verified ? (
                  <Link
                    href="/dashboard"
                    className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-70"
                    style={{ color: "rgb(22,163,74)" }}
                  >
                    Track your monthly allocation on your dashboard
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <Link
                        href={VERIFY_HREF}
                        className="inline-flex items-center gap-2.5 px-6 py-3 rounded-full text-sm font-semibold transition-transform active:scale-[0.97] hover:scale-[1.02]"
                        style={{
                          background: "linear-gradient(135deg, #1a1a1a 0%, #000000 100%)",
                          color: "#ffffff",
                          boxShadow: "0 0 0 1px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.12)",
                        }}
                      >
                        <WorldLogo className="w-[18px] h-[18px]" style={{ color: "#ffffff" }} />
                        Verify with World ID
                      </Link>
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
                    <p className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                      World ID proves you are a unique human with zero-knowledge proofs. We never see
                      who you are, and your tools activate the second you finish.
                    </p>
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
