"use client";

/**
 * Premium Hero Card — SCREENSHOT-ONLY, editable in isolation.
 *
 * The recovered original /skills full-width hero (verified/armed state),
 * extracted from the deleted `premium-tools-showcase.tsx` (git: 1648cbab^)
 * and upscaled to launch-grade for the World ToolRouter announcement image.
 *
 * NOT mounted on /skills. The live skills page, its compact Premium Tools
 * tile, and the modal are unchanged. This is a standalone canvas: restyle
 * it here, screenshot it from /premium-hero-preview, ship the image.
 *
 * Differences from the recovered original (deliberate, per Cooper):
 *   - verified state only (state machine / fetch / locked branches removed).
 *   - all six "in action" examples are PERMANENT (was hover-only), each a
 *     real user request → finished result, separated from the description
 *     by a hairline divider. Tiles are forced to equal height.
 *   - StableTravel copy fixed (no booking endpoint ships yet); subhead
 *     reframed to the instant-unlock angle.
 *   - hierarchy, ambient wash, chips, spacing, depth upscaled to top
 *     standard for a hero screenshot at 1040px.
 *
 * Logos: each tool can carry a real brand `logo` (asset under
 * /public/hero-logos). Tools without a sourced logo fall back to the
 * lucide `Icon`. See the LOGO STATUS comment on the TOOLS array.
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

type Tool = {
  id: string;
  name: string;
  Icon: typeof Search;
  /** What it does — the primary line. */
  line: string;
  /** A concrete example in action: a real user request → the finished result. */
  example: { ask: string; result: string };
  /** Optional real brand logo (asset under /public/hero-logos). Falls back to Icon. */
  logo?: string;
};

// ── LOGO STATUS ──────────────────────────────────────────────────────────
// `logo` is wired only where a clean, official, crisp asset was sourced.
// Tools without `logo` render the lucide fallback Icon on the same chip.
// (Phase A ships lucide for all six; logos are layered in Phase B once the
// real assets are verified crisp.)
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
      className="glass rounded-[20px] p-8 sm:p-10 relative overflow-hidden"
      style={{
        border: "1px solid rgba(34,197,94,0.32)",
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.55) inset, 0 18px 50px -28px rgba(22,101,52,0.45), 0 2px 8px -4px rgba(0,0,0,0.08)",
      }}
    >
      {/* Ambient green wash — two soft corners, verified/armed */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at 22% 8%, rgba(34,197,94,0.12) 0%, transparent 52%), radial-gradient(ellipse at 88% 96%, rgba(34,197,94,0.07) 0%, transparent 55%)",
        }}
      />

      <div className="relative z-10">
        {/* ── Eyebrow row ── */}
        <div className="flex items-center justify-between gap-3 mb-4">
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.14em] uppercase"
            style={{ color: "var(--muted)" }}
          >
            <WorldLogo className="w-3.5 h-3.5" style={{ color: "#16a34a" }} />
            Premium · World ID
          </span>

          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-full shrink-0"
            style={{
              background:
                "linear-gradient(135deg, rgba(34,197,94,0.24), rgba(22,163,74,0.16))",
              color: "rgb(21,128,61)",
              boxShadow:
                "0 0 0 1px rgba(34,197,94,0.28), inset 0 1px 0 rgba(255,255,255,0.45)",
            }}
          >
            <CheckCircle2 className="w-3.5 h-3.5" style={{ color: "rgb(34,197,94)" }} />
            Human Verified
          </span>
        </div>

        {/* ── Headline ── */}
        <h2
          className="text-[2rem] sm:text-[2.4rem] font-normal tracking-[-0.6px] leading-[1.08]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Your agent has six premium tools.
        </h2>

        {/* ── Subhead — instant-unlock framing ── */}
        <p
          className="text-[15px] mt-2.5 max-w-2xl leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          Exa, Manus, Browserbase, Parallel, AgentMail, and StableTravel are
          live in your agent&apos;s toolkit the second you verify your World ID.
        </p>

        {/* ── Tool grid — equal-height tiles, every example shown ── */}
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5 mt-7"
          style={{ gridAutoRows: "1fr" }}
        >
          {TOOLS.map((tool) => (
            <div
              key={tool.id}
              className="relative rounded-2xl p-[18px] flex flex-col"
              style={{
                background: "rgba(34,197,94,0.055)",
                border: "1px solid rgba(34,197,94,0.2)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                boxShadow:
                  "0 1px 0 rgba(255,255,255,0.4) inset, 0 6px 18px -14px rgba(22,101,52,0.5)",
              }}
            >
              {/* Corner check (owned) */}
              <CheckCircle2
                className="absolute top-3.5 right-3.5 w-4 h-4"
                style={{ color: "rgb(34,197,94)" }}
              />

              {/* Header: chip + name */}
              <div className="flex items-center gap-3">
                <div
                  className="shrink-0 w-11 h-11 rounded-xl flex items-center justify-center overflow-hidden"
                  style={
                    tool.logo
                      ? {
                          background: "#ffffff",
                          border: "1px solid rgba(0,0,0,0.08)",
                          boxShadow:
                            "0 1px 2px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.9)",
                        }
                      : {
                          background:
                            "linear-gradient(135deg, rgba(34,197,94,0.2), rgba(22,163,74,0.12))",
                          border: "1px solid rgba(34,197,94,0.22)",
                          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.5)",
                        }
                  }
                >
                  {tool.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={tool.logo}
                      alt={`${tool.name} logo`}
                      className="w-7 h-7 object-contain"
                    />
                  ) : (
                    <tool.Icon
                      className="w-[21px] h-[21px]"
                      style={{ color: "rgb(22,163,74)" }}
                    />
                  )}
                </div>
                <h3 className="text-[15px] font-semibold tracking-[-0.2px] pr-5">
                  {tool.name}
                </h3>
              </div>

              {/* What it does */}
              <p
                className="text-[13px] leading-relaxed mt-3"
                style={{ color: "var(--foreground)", opacity: 0.82 }}
              >
                {tool.line}
              </p>

              {/* Divider + example in action (permanent) */}
              <div
                className="mt-3 pt-3"
                style={{ borderTop: "1px solid rgba(34,197,94,0.16)" }}
              >
                <p className="text-[12px] leading-relaxed">
                  <span
                    className="font-medium"
                    style={{ color: "rgb(21,128,61)" }}
                  >
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
            style={{ color: "rgb(22,163,74)" }}
          >
            Track your monthly allocation on your dashboard
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
    </motion.div>
  );
}
