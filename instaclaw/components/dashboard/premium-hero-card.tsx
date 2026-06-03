"use client";

/**
 * Premium Hero Card — SCREENSHOT-ONLY, editable in isolation.
 *
 * The recovered original /skills full-width hero (verified/armed state),
 * upscaled to launch-grade for the World ToolRouter announcement image and
 * held to InstaClaw's REAL glass material + tokens (not a lookalike):
 *
 *   - Card surface: the real dashboard `.glass` class (−75° white sheen +
 *     4-layer box-shadow, border:none). The green identity is layered INSIDE
 *     via wash + tiles + chips + pill — matching the live /skills surface,
 *     which is also borderless `.glass` with green accents on top.
 *   - Icon chips, tiles, and the Human-Verified pill all use the canonical
 *     skill-pill glass recipe (`globals.css` `.skill-pill.is-green`):
 *     transparent bg + backdrop-blur + (−75° sheen ⊕ radial color-under-glass)
 *     + the 4-layer highlight/shadow stack — proportioned per element size.
 *   - Real green tokens: rgb(31,173,62) glass-fill, rgb(20,120,57) on-glass
 *     text/icon, var(--success) #16a34a for standalone marks/links. Real
 *     --foreground / --muted / --font-serif throughout.
 *
 * NOT mounted on /skills. The live skills page, its compact Premium Tools
 * tile, and the modal are unchanged. Restyle here, screenshot from
 * /premium-hero-preview, ship the image.
 *
 * JOB 1: all six "in action" examples are PERMANENT (was hover-only), each a
 * real user request → finished result, separated from the description by a
 * hairline green divider; tiles forced equal-height via grid-auto-rows:1fr.
 * Copy fixes intact (StableTravel "booking coming soon"; instant-unlock
 * subhead). Logos intentionally NOT used — uniform lucide icons on real glass.
 */

import Link from "next/link";
import { motion } from "motion/react";
import {
  Search,
  Telescope,
  Globe,
  Layers,
  Mail,
  Plane,
  CheckCircle2,
  ArrowRight,
} from "lucide-react";
import { WorldLogo } from "@/components/icons/world-logo";

// ── Real glass material, lifted from globals.css `.skill-pill.is-green` ──
// The −75° white sheen layer (top, common to every glass element here).
const SHEEN =
  "linear-gradient(-75deg, rgba(255,255,255,0.10), rgba(255,255,255,0.32), rgba(255,255,255,0.10))";
const SHEEN_SOFT =
  "linear-gradient(-75deg, rgba(255,255,255,0.06), rgba(255,255,255,0.18), rgba(255,255,255,0.06))";

// Icon chip: pill-strength green radial under the sheen; box-shadow scaled
// from the 19px skill-pill recipe up to the 44px chip (≈2×: dark-top inset,
// white bottom-edge inset, soft lift, white inner glow-ring).
const CHIP_STYLE: React.CSSProperties = {
  backgroundColor: "rgba(0,0,0,0)",
  backdropFilter: "blur(3px)",
  WebkitBackdropFilter: "blur(3px)",
  backgroundImage:
    SHEEN +
    ", radial-gradient(125% 150% at 26% 22%, rgba(31,173,62,0.40) 0%, rgba(31,173,62,0.24) 55%, rgba(31,173,62,0.15) 100%)",
  boxShadow:
    "rgba(0,0,0,0.06) 0px 1px 1.5px 0px inset, " +
    "rgba(255,255,255,0.55) 0px -1px 2px 0px inset, " +
    "rgba(0,0,0,0.10) 0px 2px 5px -2px, " +
    "rgba(255,255,255,0.30) 0px 0px 1px 1.5px inset",
};

// Tile: the same glass family at large scale — soft sheen + a FAINT green key
// (dialed far down from pill strength so six of them read as glass, not green
// blocks), card-proportioned 4-layer shadow.
const TILE_STYLE: React.CSSProperties = {
  backgroundColor: "rgba(0,0,0,0)",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  backgroundImage:
    SHEEN_SOFT +
    ", radial-gradient(120% 130% at 24% 12%, rgba(31,173,62,0.12) 0%, rgba(31,173,62,0.06) 58%, rgba(31,173,62,0.02) 100%)",
  boxShadow:
    "rgba(0,0,0,0.04) 0px 1px 1.5px 0px inset, " +
    "rgba(255,255,255,0.42) 0px -1.5px 2px 0px inset, " +
    "rgba(0,0,0,0.10) 0px 5px 16px -10px, " +
    "rgba(255,255,255,0.18) 0px 0px 1.5px 2px inset",
};

// Human-Verified pill: the skill-pill.is-green recipe verbatim (19px proportions).
const VERIFIED_PILL_STYLE: React.CSSProperties = {
  color: "rgb(20,120,57)",
  backgroundColor: "rgba(0,0,0,0)",
  backdropFilter: "blur(3px)",
  WebkitBackdropFilter: "blur(3px)",
  backgroundImage:
    SHEEN +
    ", radial-gradient(125% 150% at 26% 26%, rgba(31,173,62,0.40) 0%, rgba(31,173,62,0.24) 55%, rgba(31,173,62,0.15) 100%)",
  boxShadow:
    "rgba(0,0,0,0.05) 0px 0.5px 1px 0px inset, " +
    "rgba(255,255,255,0.42) 0px -0.5px 1.5px 0px inset, " +
    "rgba(0,0,0,0.09) 0px 1px 2px -1px, " +
    "rgba(255,255,255,0.22) 0px 0px 0.5px 0.5px inset",
};

type Tool = {
  id: string;
  name: string;
  Icon: typeof Search;
  line: string;
  example: { ask: string; result: string };
};

const TOOLS: Tool[] = [
  {
    id: "exa",
    name: "Exa",
    Icon: Search,
    line: "Finds the exact answer on the first try, where a normal search takes three.",
    example: {
      ask: "Find the 2017 paper that introduced transformers",
      result: "the paper itself, not a page of blue links.",
    },
  },
  {
    id: "manus",
    name: "Manus",
    Icon: Telescope,
    line: "Hand it a hard question and it runs a full research project, reading dozens of sources before it reports back.",
    example: {
      ask: "Compare every major L2's fee model",
      result: "a sourced brief, not ten tabs you read yourself.",
    },
  },
  {
    id: "browserbase",
    name: "Browserbase",
    Icon: Globe,
    line: "Drives a real cloud browser, so it can work sites that block bots and act behind logins.",
    example: {
      ask: "Pull the invoices behind my vendor login",
      result: "it signs in, clicks through, and brings them back.",
    },
  },
  {
    id: "parallel",
    name: "Parallel",
    Icon: Layers,
    line: "Pulls clean, cited data from across the web at scale, the report you'd spend an afternoon building.",
    example: {
      ask: "Pull pricing from 200 competitor pages",
      result: "one clean table, every figure cited.",
    },
  },
  {
    id: "agentmail",
    name: "AgentMail",
    Icon: Mail,
    line: "Gives your agent its own inbox. It sends and handles email without ever touching yours.",
    example: {
      ask: "Email the venue and lock the date",
      result: "it sends from its own address and watches for the reply.",
    },
  },
  {
    id: "stabletravel",
    name: "StableTravel",
    Icon: Plane,
    line: "Plans the whole trip: the best flights and hotels, priced and ready. Booking end to end coming soon.",
    example: {
      ask: "Get me to Lisbon for the conference",
      result: "a full itinerary, flights and hotel priced and ready.",
    },
  },
];

export function PremiumHeroCard() {
  return (
    <motion.div
      initial={false}
      className="glass rounded-[22px] p-8 sm:p-10 relative overflow-hidden"
    >
      {/* Green ambient wash — tasteful, two soft corners. Real fill green. */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at 20% 4%, rgba(31,173,62,0.10) 0%, transparent 50%), radial-gradient(ellipse at 90% 98%, rgba(31,173,62,0.06) 0%, transparent 55%)",
        }}
      />

      <div className="relative z-10">
        {/* ── Eyebrow row ── */}
        <div className="flex items-center justify-between gap-3 mb-4">
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.14em] uppercase"
            style={{ color: "var(--muted)" }}
          >
            <WorldLogo className="w-3.5 h-3.5" style={{ color: "var(--success)" }} />
            Premium · World ID
          </span>

          {/* Human Verified — exact skill-pill.is-green material */}
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-[5px] rounded-full shrink-0 tracking-[-0.1px]"
            style={VERIFIED_PILL_STYLE}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Human Verified
          </span>
        </div>

        {/* ── Headline ── */}
        <h2
          className="text-[2rem] sm:text-[2.4rem] font-normal tracking-[-0.6px] leading-[1.08]"
          style={{ fontFamily: "var(--font-serif)", color: "var(--foreground)" }}
        >
          Your agent gets six new premium tools.
        </h2>

        {/* ── Subhead — instant-unlock framing ── */}
        <p
          className="text-[15px] mt-2.5 max-w-2xl leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          Exa, Manus, Browserbase, Parallel, AgentMail, and StableTravel are
          live in your agent&apos;s toolkit the second you verify your World ID.
        </p>

        {/* ── Tool grid — equal-height glass tiles, every example shown ── */}
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 mt-7"
          style={{ gridAutoRows: "1fr" }}
        >
          {TOOLS.map((tool) => (
            <div
              key={tool.id}
              className="relative rounded-2xl p-[18px] flex flex-col"
              style={TILE_STYLE}
            >
              {/* Corner check (owned) */}
              <CheckCircle2
                className="absolute top-3.5 right-3.5 w-4 h-4"
                style={{ color: "rgb(31,173,62)" }}
              />

              {/* Header: glass chip + name */}
              <div className="flex items-center gap-3">
                <div
                  className="shrink-0 w-11 h-11 rounded-[13px] flex items-center justify-center"
                  style={CHIP_STYLE}
                >
                  <tool.Icon
                    className="w-[21px] h-[21px]"
                    strokeWidth={2}
                    style={{ color: "rgb(20,120,57)" }}
                  />
                </div>
                <h3
                  className="text-[15px] font-semibold tracking-[-0.2px] pr-5"
                  style={{ color: "var(--foreground)" }}
                >
                  {tool.name}
                </h3>
              </div>

              {/* What it does */}
              <p
                className="text-[13px] leading-relaxed mt-3.5"
                style={{ color: "var(--foreground)", opacity: 0.82 }}
              >
                {tool.line}
              </p>

              {/* Divider + example in action (permanent) */}
              <div
                className="mt-3 pt-3"
                style={{ borderTop: "1px solid rgba(31,173,62,0.16)" }}
              >
                <p className="text-[12px] leading-relaxed">
                  <span className="font-medium" style={{ color: "rgb(20,120,57)" }}>
                    &ldquo;{tool.example.ask}&rdquo;
                  </span>
                  <span style={{ color: "var(--muted)" }}>
                    {" "}
                    &rarr; {tool.example.result}
                  </span>
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Action row ── */}
        <div className="mt-8">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm font-medium transition-opacity hover:opacity-70"
            style={{ color: "var(--success)" }}
          >
            Track your monthly allocation on your dashboard
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </motion.div>
  );
}
