import Link from "next/link";
import { createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "Intent Matching · Preview · InstaClaw",
  description:
    "What intent matching looks like at Consensus 2026. Tell your agent what you're working on, what you're after, who you want to meet. It surfaces the people most relevant to your goals: speakers, attendees, side-event hosts. Beta this week, full feature ships tomorrow.",
  path: "/consensus/matches",
});

// Canonical project glass UI: matches components/landing/pricing.tsx and the
// rest of the marketing site. Light-glass surface with subtle gradient,
// backdrop blur, and inset highlights for depth.
const glassStyle = {
  background:
    "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  boxShadow:
    "rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset, rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset, rgba(0, 0, 0, 0.1) 0px 2px 4px 0px, rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset",
} as const;

const glassOrange = {
  background:
    "linear-gradient(-75deg, rgba(220,103,67,0.08), rgba(220,103,67,0.22), rgba(220,103,67,0.08))",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  boxShadow:
    "rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset, rgba(255, 255, 255, 0.4) 0px -2px 2px 0px inset, rgba(220, 103, 67, 0.15) 0px 2px 4px 0px, rgba(255, 255, 255, 0.18) 0px 0px 1.6px 4px inset",
} as const;

const glassButtonOrange = {
  background:
    "linear-gradient(-75deg, rgba(220,103,67,0.85), rgba(220,103,67,1), rgba(220,103,67,0.85))",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  boxShadow:
    "rgba(255, 255, 255, 0.2) 0px 2px 2px 0px inset, rgba(0, 0, 0, 0.15) 0px -2px 2px 0px inset, rgba(220, 103, 67, 0.4) 0px 2px 8px 0px, rgba(255, 255, 255, 0.25) 0px 0px 1.6px 4px inset",
} as const;

// Real Consensus 2026 speakers, hand-curated for the demo's "onchain AI infra"
// scenario. Names, companies, roles, and session titles are pulled from the
// official consensus-2026-skill speaker index. Match-rationale and suggested
// times are illustrative of what the agent will produce when the full feature
// ships tomorrow.
const matches = [
  {
    initial: "DW",
    name: "David Wachsman",
    role: "Founder & CEO",
    company: "Wachsman",
    relevance: 94,
    why: "Building infra for the institutional crypto stack. His Wednesday panel on \"DeFi's Infra, Data & Oracle Renaissance\" is the closest agenda match to your stated focus on onchain AI infrastructure.",
    where: "Wed · 11:30 AM · Frontier Stage",
    intro: "Coffee right after his panel. Frontier lobby, ~12:35 PM.",
  },
  {
    initial: "DJ",
    name: "David Johnston",
    role: "Code Maintainer",
    company: "Morpheus",
    relevance: 91,
    why: "Confidential compute for AI workloads is his exact wedge. His talk \"Enterprise AI Without Surveillance: Privacy, Confidential Compute\" overlaps directly with the privacy primitives on your roadmap.",
    where: "Tue · 3:15 PM · Convergence Stage",
    intro: "30-min open block Tuesday after his talk. 4:00 PM, Speaker Lounge.",
  },
  {
    initial: "BT",
    name: "Brian Trunzo",
    role: "Chief Growth Officer",
    company: "Succinct Labs",
    relevance: 87,
    why: "Succinct's zk-prover stack is what every agentic settlement layer eventually needs. He's at the same DeFi infra panel as Wachsman. Natural double-up.",
    where: "Wed · 11:30 AM · Frontier Stage",
    intro: "Catch him at the Succinct booth Tuesday afternoon (confirmed 2–4 PM block).",
  },
  {
    initial: "MZ",
    name: "May Zabaneh",
    role: "SVP & General Manager",
    company: "PayPal",
    relevance: 82,
    why: "Enterprise voice on agent payments. Her panel \"Scaling Agentic Commerce through Crypto-Rails and Open Protocols\" is the demand-side perspective you need before pitching infra to enterprise.",
    where: "Wed · 2:45 PM · Mainstage",
    intro: "PayPal hosting a meet-and-greet Tuesday 6 PM at the W Brickell. RSVP queued.",
  },
];

export default function ConsensusMatchesPreviewPage() {
  return (
    <>
      {/* Hero */}
      <section className="px-4 pt-16 pb-10 sm:pt-20 sm:pb-12">
        <div className="max-w-3xl mx-auto text-center">
          <div
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[10px] uppercase tracking-[0.18em] mb-8"
            style={{
              ...glassOrange,
              color: "#DC6743",
              fontFamily: "var(--font-serif)",
            }}
          >
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: "#DC6743" }}
            />
            Beta · Preview · Full launch tomorrow
          </div>

          <p
            className="text-xs uppercase tracking-[0.15em] mb-3"
            style={{ color: "#DC6743" }}
          >
            Intent matching
          </p>
          <h1
            className="text-4xl sm:text-5xl font-normal tracking-[-1px] leading-[1.05] mb-5"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Match by intent, not by title.
          </h1>
          <p
            className="text-base sm:text-lg max-w-xl mx-auto leading-relaxed"
            style={{ color: "#6b6b6b" }}
          >
            Tell your agent what you&apos;re working on. It scans 451 speakers,
            219 side events, and your fellow attendees, then surfaces the people
            most relevant to your goals.
          </p>
        </div>
      </section>

      {/* Prompt block */}
      <section className="px-4 pb-8">
        <div className="max-w-3xl mx-auto">
          <p
            className="text-[10px] uppercase tracking-[0.18em] mb-3"
            style={{ color: "#9a9a9a" }}
          >
            You asked
          </p>
          <div
            className="rounded-2xl p-6 sm:p-7"
            style={glassStyle}
          >
            <p
              className="text-base sm:text-lg leading-relaxed"
              style={{
                fontFamily: "var(--font-serif)",
                color: "#333334",
              }}
            >
              &ldquo;I&apos;m building onchain AI infrastructure. Find me the
              4 people at Consensus this week most worth meeting.&rdquo;
            </p>
          </div>
        </div>
      </section>

      {/* Reasoning trace */}
      <section className="px-4 pb-10">
        <div className="max-w-3xl mx-auto">
          <p
            className="text-[10px] uppercase tracking-[0.18em] mb-3"
            style={{ color: "#9a9a9a" }}
          >
            Your agent
          </p>
          <div
            className="rounded-2xl p-6 sm:p-7 space-y-2"
            style={glassStyle}
          >
            {[
              "Scanning 451 speakers, 219 side events, 326 sessions.",
              "Filtering by stated focus: onchain AI · infrastructure · privacy primitives.",
              "Cross-referencing your project notes with speaker session topics and panel descriptions.",
              "Found 23 candidates. Ranking by problem-overlap, not by topic tag.",
              "Surfacing the top 4. Suggested intros queued.",
            ].map((line, i) => (
              <div key={i} className="flex items-start gap-3">
                <span
                  className="shrink-0 mt-1.5 w-1 h-1 rounded-full"
                  style={{ background: "#DC6743" }}
                />
                <p
                  className="text-sm leading-relaxed"
                  style={{ color: "#6b6b6b", fontFamily: "var(--font-mono)" }}
                >
                  {line}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Match cards */}
      <section className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-baseline justify-between mb-5">
            <p
              className="text-[10px] uppercase tracking-[0.18em]"
              style={{ color: "#9a9a9a" }}
            >
              Top matches · ranked by intent overlap
            </p>
            <p
              className="text-[10px] uppercase tracking-[0.15em]"
              style={{ color: "#9a9a9a" }}
            >
              4 of 23
            </p>
          </div>

          <div className="space-y-4">
            {matches.map((m, i) => (
              <div
                key={m.name}
                className="rounded-2xl p-6 sm:p-7 transition-all duration-300 hover:-translate-y-0.5"
                style={glassStyle}
              >
                <div className="flex flex-col sm:flex-row sm:items-start gap-5">
                  {/* Initial circle */}
                  <div
                    className="shrink-0 w-12 h-12 rounded-full flex items-center justify-center text-sm font-medium"
                    style={{
                      ...glassOrange,
                      color: "#DC6743",
                      fontFamily: "var(--font-serif)",
                    }}
                  >
                    {m.initial}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-1">
                      <span
                        className="text-[10px] tabular-nums tracking-[0.05em]"
                        style={{ color: "#9a9a9a" }}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <h2
                        className="text-xl sm:text-2xl font-normal tracking-[-0.3px] leading-tight"
                        style={{ fontFamily: "var(--font-serif)" }}
                      >
                        {m.name}
                      </h2>
                      <span
                        className="text-xs"
                        style={{ color: "#9a9a9a" }}
                      >
                        · {m.relevance}% match
                      </span>
                    </div>
                    <p
                      className="text-sm mb-4"
                      style={{ color: "#6b6b6b" }}
                    >
                      {m.role}, {m.company}
                    </p>

                    <div className="space-y-3 mb-5">
                      <div>
                        <p
                          className="text-[10px] uppercase tracking-[0.15em] mb-1"
                          style={{ color: "#DC6743" }}
                        >
                          Why match
                        </p>
                        <p
                          className="text-sm leading-relaxed"
                          style={{ color: "#333334" }}
                        >
                          {m.why}
                        </p>
                      </div>
                      <div className="grid sm:grid-cols-2 gap-3">
                        <div>
                          <p
                            className="text-[10px] uppercase tracking-[0.15em] mb-1"
                            style={{ color: "#DC6743" }}
                          >
                            Where to find them
                          </p>
                          <p
                            className="text-sm leading-relaxed"
                            style={{ color: "#333334" }}
                          >
                            {m.where}
                          </p>
                        </div>
                        <div>
                          <p
                            className="text-[10px] uppercase tracking-[0.15em] mb-1"
                            style={{ color: "#DC6743" }}
                          >
                            Suggested intro
                          </p>
                          <p
                            className="text-sm leading-relaxed"
                            style={{ color: "#333334" }}
                          >
                            {m.intro}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="px-4 py-2 rounded-full text-xs font-medium transition-all duration-200 hover:-translate-y-0.5 hover:brightness-105 active:translate-y-0"
                        style={{
                          ...glassButtonOrange,
                          color: "#ffffff",
                        }}
                      >
                        Request intro →
                      </button>
                      <button
                        type="button"
                        className="px-4 py-2 rounded-full text-xs font-medium transition-all duration-200 hover:-translate-y-0.5"
                        style={{
                          ...glassStyle,
                          color: "#333334",
                        }}
                      >
                        Save for later
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 pb-24">
        <div className="max-w-3xl mx-auto text-center">
          <p
            className="text-sm sm:text-base mb-6 leading-relaxed max-w-xl mx-auto"
            style={{ color: "#6b6b6b" }}
          >
            This is what intent matching looks like when it ships. Beta is live
            now in the agent. The full UI drops tomorrow.
          </p>
          <Link
            href="/consensus"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium transition-all duration-200 hover:-translate-y-0.5 hover:brightness-105"
            style={{ ...glassButtonOrange, color: "#ffffff" }}
          >
            Claim your agent →
          </Link>
          <p className="text-xs mt-4" style={{ color: "#9a9a9a" }}>
            Free 3-day trial. No ticket required, no credit card.
          </p>
        </div>
      </section>
    </>
  );
}
