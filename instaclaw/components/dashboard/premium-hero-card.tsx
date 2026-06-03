"use client";

/**
 * Premium Hero Card — SCREENSHOT-ONLY, editable in isolation.
 *
 * The recovered original /skills full-width hero (verified/armed state),
 * extracted verbatim from the deleted `premium-tools-showcase.tsx`
 * (git: 1648cbab^) for capturing a launch-announcement image.
 *
 * NOT mounted on /skills. The live skills page, its compact Premium Tools
 * tile, and the modal are unchanged. This is a standalone canvas: restyle
 * it here, screenshot it from /premium-hero-preview, ship the image.
 *
 * Differences from the recovered original (deliberate, per Cooper):
 *   - verified state only (the state machine / fetch / locked + CTA branches
 *     and the celebration refs are removed — none affect the resting render).
 *   - motion entrance pinned to final (initial={false}) so it renders settled
 *     and screenshots cleanly. Visual at rest is identical to the original.
 *   - StableTravel copy fixed (no booking endpoint ships yet).
 *   - subhead reframed to the instant-unlock angle for a same-day launch.
 * Everything else (classes, tokens, glass, WorldLogo, the green material) is
 * verbatim from the original.
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
    line: "Plans the whole trip: the best flights and hotels, priced and ready. Booking end to end coming soon.",
    more: "“Get me to Lisbon for the conference” comes back as a full itinerary, flights and hotel priced and ready.",
  },
];

export function PremiumHeroCard() {
  return (
    <motion.div
      initial={false}
      className="glass rounded-2xl p-7 sm:p-9 relative overflow-hidden"
      style={{ border: "1px solid rgba(34,197,94,0.35)" }}
    >
      {/* Ambient green wash (verified/armed) */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at 25% 15%, rgba(34,197,94,0.10) 0%, transparent 55%), radial-gradient(ellipse at 80% 90%, rgba(34,197,94,0.06) 0%, transparent 55%)",
        }}
      />

      <div className="relative z-10">
        {/* Eyebrow row */}
        <div className="flex items-center justify-between gap-3 mb-3.5">
          <span
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase"
            style={{ color: "var(--muted)" }}
          >
            <WorldLogo className="w-3.5 h-3.5" style={{ color: "#16a34a" }} />
            Premium · World ID
          </span>

          <span
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
          </span>
        </div>

        {/* Headline */}
        <h2
          className="text-2xl sm:text-[2rem] font-normal tracking-[-0.5px] leading-tight"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Your agent has six premium tools.
        </h2>

        {/* Subhead — instant-unlock framing */}
        <p
          className="text-sm mt-2 max-w-xl leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          Exa, Manus, Browserbase, Parallel, AgentMail, and StableTravel are
          live in your agent&apos;s toolkit the second you verify your World ID.
        </p>

        {/* Prize grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-6">
          {TOOLS.map((tool) => (
            <div
              key={tool.id}
              className="group relative rounded-xl p-4 overflow-hidden"
              style={{
                background: "rgba(34,197,94,0.05)",
                border: "1px solid rgba(34,197,94,0.22)",
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                transition: "box-shadow 0.2s ease, opacity 0.4s ease",
              }}
            >
              {/* Corner check (owned) */}
              <div className="absolute top-3 right-3">
                <CheckCircle2
                  className="w-4 h-4"
                  style={{ color: "rgb(34,197,94)" }}
                />
              </div>

              <div className="flex items-start gap-3">
                <div
                  className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center"
                  style={{
                    background:
                      "linear-gradient(135deg, rgba(34,197,94,0.18), rgba(22,163,74,0.12))",
                    border: "1px solid rgba(34,197,94,0.2)",
                  }}
                >
                  <tool.Icon
                    className="w-[18px] h-[18px]"
                    style={{ color: "rgb(22,163,74)" }}
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
                  <div className="overflow-hidden max-h-0 opacity-0 group-hover:max-h-24 group-hover:opacity-100 group-hover:mt-2 transition-all duration-300">
                    <p
                      className="text-[11px] leading-relaxed italic"
                      style={{ color: "var(--muted)", opacity: 0.85 }}
                    >
                      {tool.more}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Action row */}
        <div className="mt-7">
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
        </div>
      </div>
    </motion.div>
  );
}
