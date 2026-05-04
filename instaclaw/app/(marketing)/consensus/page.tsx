import Link from "next/link";
import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { ConsensusClient } from "./consensus-client";

// Canonical project glass UI — matches components/landing/pricing.tsx and the
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

// Orange-tinted glass for brand pills and accents (date pill, FAQ "+" badge).
const glassOrange = {
  background:
    "linear-gradient(-75deg, rgba(220,103,67,0.08), rgba(220,103,67,0.22), rgba(220,103,67,0.08))",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  boxShadow:
    "rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset, rgba(255, 255, 255, 0.4) 0px -2px 2px 0px inset, rgba(220, 103, 67, 0.15) 0px 2px 4px 0px, rgba(255, 255, 255, 0.18) 0px 0px 1.6px 4px inset",
} as const;

export const metadata = createMetadata({
  title: "Personal AI Agent for Consensus 2026 Miami",
  description:
    "Every Consensus attendee gets a personal AI agent that knows all 326 sessions across 9 stages and all 219 side events. Ask it where the free dinner is. Ask it which talks mention zk. Ask it to build you an AI-track itinerary. Free 3-day trial.",
  path: "/consensus",
  ogTitle: "Your AI agent for Consensus 2026 · 326 sessions · 219 side events",
});

const eventJsonLd = {
  "@context": "https://schema.org",
  "@type": "Event",
  name: "Consensus 2026 — Miami",
  description:
    "InstaClaw partner skill: a personal AI agent for every Consensus 2026 attendee, with the full official agenda and the full side-event scene at its fingertips.",
  startDate: "2026-05-05",
  endDate: "2026-05-07",
  eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
  eventStatus: "https://schema.org/EventScheduled",
  location: {
    "@type": "Place",
    name: "Miami Beach Convention Center",
    address: {
      "@type": "PostalAddress",
      streetAddress: "1901 Convention Center Dr",
      addressLocality: "Miami Beach",
      addressRegion: "FL",
      postalCode: "33139",
      addressCountry: "US",
    },
  },
  organizer: {
    "@type": "Organization",
    name: "CoinDesk",
    url: "https://consensus.coindesk.com",
  },
};

const queryDemos = [
  {
    label: "Free-food finder",
    prompt: "Where's the free dinner Tuesday?",
    body: "37 free events with food on Tuesday alone. Your agent surfaces them by time, organizer, and location — and offers to filter to your neighborhood. The single most-asked Consensus question, answered in one tap.",
  },
  {
    label: "AI-track binge mode",
    prompt: "Build me a 3-day AI itinerary.",
    body: "75 sessions mention AI or agents. Your agent picks a non-overlapping schedule across all three days, hitting Mainstage keynotes and panel sessions, and tells you which conflicts you're skipping.",
  },
  {
    label: "Speaker stalker",
    prompt: "Where's Saylor speaking?",
    body: "The full speaker index across 451 names is pre-built. Ask about anyone — Saylor, Raoul Pal, A-Rod, Grant Cardone — and get every venue, every time, sorted chronologically.",
  },
  {
    label: "Conflict detector",
    prompt: "I want to go to X and Y at 2:30 Wednesday.",
    body: "Your agent compares the two by speaker firepower (rare-appearance vs. always-on), track centrality, and panel format — and tells you which to pick and why. No more fomo whiplash on the convention floor.",
  },
  {
    label: "Founder matching · Beta",
    prompt: "I'm building onchain AI infra. Find my people.",
    body: "Tell your agent your project — stack, stage, problem. It cross-references the 451 speakers and your fellow attendees and surfaces the founders working on the same thing, with warm intros queued up. Match on what you're actually building, not on labels.",
  },
];

const features = [
  {
    title: "Knows the official agenda cold",
    body: "All 326 sessions across 9 venues, with speakers, tracks, tags, and descriptions. Refreshes every hour through the conference so last-minute changes show up in your next message.",
  },
  {
    title: "Knows the side-event scene",
    body: "All 219 events from plan.wtf — parties, breakfasts, panels, yacht meetups — searchable by day, vibe, organizer, free-or-paid, food-or-bar. The directory crypto Twitter wishes it had.",
  },
  {
    title: "Built for the floor, not the page",
    body: "Ask in plain English from your phone. Your agent runs on its own VM and answers via Telegram or chat — no app to install, no schedule to memorize, no PDF to scroll.",
  },
  {
    title: "Memory that lasts the week",
    body: "Tell it you're here for AI infra and care about Bitcoin treasury narratives once. Every recommendation after that is filtered for you. By Thursday it knows the conference better than you do.",
  },
];

const faqs = [
  {
    q: "What does it cost?",
    a: "Every plan comes with a 3-day free trial. Full access, no restrictions, no credit card to start. Standard InstaClaw pricing ($29/$99/$299/mo) kicks in after the trial — cancel anytime before then and you won't be charged.",
  },
  {
    q: "Do I need a Consensus ticket?",
    a: "No. The skill is open to anyone — including remote attendees following along. Tagging your account just unlocks the Consensus-specific skill on your VM. If you do have a ticket, the agent is more useful because the on-the-ground queries (free food, walking time, who's at this party) actually apply.",
  },
  {
    q: "How fresh is the data?",
    a: "Main agenda re-baked from CoinDesk's venue pages every hour. Side events re-baked from plan.wtf's Google Sheet every hour. Your VM pulls fresh data every 30 minutes. End-to-end latency from a new event being added to plan.wtf to it appearing in your agent: ~90 minutes.",
  },
  {
    q: "What can it actually answer?",
    a: 'Things like: "what\'s on Mainstage at 2pm Wednesday?", "free dinner Tuesday near Brickell with food and a bar?", "which talks mention zk on Wednesday?", "find me other AI-track sessions overlapping Saylor\'s keynote", "build me a 3-day AI itinerary". Try it during the conference — the agent gets sharper as it learns your interests.',
  },
  {
    q: "Where does the data come from?",
    a: "Two public sources: CoinDesk's official Consensus 2026 agenda (consensus.coindesk.com) for sessions, and plan.wtf (community-maintained by @sheeetsxyz) for side events. We thank both — credit where it's due.",
  },
  {
    q: "Will this work after Consensus?",
    a: "The Consensus-specific skill ratchets down post-event, but your InstaClaw agent stays. Same agent, different skills loaded — Bitcoin 2026 (Las Vegas, July) and Token2049 (Singapore, October) are next, and your agent will pick up those skills when you tell it where you're going.",
  },
];

export default function ConsensusPage() {
  return (
    <>
      <JsonLd data={eventJsonLd} />

      {/* Hero */}
      <section className="px-4 pt-16 pb-12 sm:pt-24 sm:pb-20">
        <div className="max-w-3xl mx-auto text-center">
          <div
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs mb-8"
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
            Consensus 2026 · May 5 – 7 · Miami Beach
          </div>

          <h1
            className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Your personal AI agent for Consensus week.
          </h1>

          <p
            className="text-base sm:text-lg max-w-xl mx-auto mb-10 leading-relaxed"
            style={{ color: "#6b6b6b" }}
          >
            Knows all 326 sessions across 9 stages. Knows all 219 side events.
            Asks what you care about. Tells you where to be. After Consensus,
            it stays.
          </p>

          <ConsensusClient />

          <p className="text-xs mt-5" style={{ color: "#9a9a9a" }}>
            Free 3-day trial. No ticket required, no credit card.
          </p>
        </div>
      </section>

      {/* Stat strip */}
      <section className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { stat: "326", label: "Sessions" },
              { stat: "219", label: "Side events" },
              { stat: "451", label: "Speakers" },
              { stat: "9", label: "Stages" },
            ].map((s) => (
              <div
                key={s.label}
                className="p-6 text-center rounded-xl transition-all duration-300 hover:-translate-y-0.5"
                style={glassStyle}
              >
                <div
                  className="text-3xl sm:text-4xl font-normal tracking-[-1px] mb-1"
                  style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
                >
                  {s.stat}
                </div>
                <div className="text-xs" style={{ color: "#6b6b6b" }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Killer query patterns */}
      <section className="px-4 pb-20">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-12">
            <p
              className="text-xs uppercase tracking-[0.15em] mb-3"
              style={{ color: "#DC6743" }}
            >
              Ask anything during the conference
            </p>
            <h2
              className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] leading-[1.1] mb-4"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Five answers your agent has, that no app has.
            </h2>
            <p
              className="text-sm sm:text-base max-w-lg mx-auto leading-relaxed"
              style={{ color: "#6b6b6b" }}
            >
              The CoinDesk app gives you the agenda. Your agent does the work
              you actually need done.
            </p>
          </div>

          <div className="space-y-0">
            {queryDemos.map((d, i) => (
              <div key={d.label}>
                <div
                  className="h-px w-full"
                  style={{ background: "rgba(0,0,0,0.08)" }}
                />
                <div className="grid grid-cols-1 sm:grid-cols-[200px_1fr] gap-4 sm:gap-8 py-8 sm:py-10">
                  <div>
                    <p
                      className="text-xs uppercase tracking-[0.12em] mb-2"
                      style={{ color: "#DC6743" }}
                    >
                      {d.label}
                    </p>
                    <p
                      className="text-base sm:text-lg leading-snug"
                      style={{
                        fontFamily: "var(--font-serif)",
                        color: "#333334",
                      }}
                    >
                      &ldquo;{d.prompt}&rdquo;
                    </p>
                  </div>
                  <p
                    className="text-sm sm:text-base leading-relaxed"
                    style={{ color: "#6b6b6b" }}
                  >
                    {d.body}
                  </p>
                </div>
                {i === queryDemos.length - 1 && (
                  <div
                    className="h-px w-full"
                    style={{ background: "rgba(0,0,0,0.08)" }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* What you get */}
      <section className="px-4 pb-20">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-12">
            <p
              className="text-xs uppercase tracking-[0.15em] mb-3"
              style={{ color: "#DC6743" }}
            >
              What you get
            </p>
            <h2
              className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] leading-[1.1]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Built for the conference floor.
            </h2>
          </div>

          <div className="grid sm:grid-cols-2 gap-6">
            {features.map((f) => (
              <div
                key={f.title}
                className="p-6 sm:p-7 rounded-xl transition-all duration-300 hover:-translate-y-0.5"
                style={glassStyle}
              >
                <h3
                  className="text-lg sm:text-xl font-normal tracking-[-0.2px] mb-3"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  {f.title}
                </h3>
                <p
                  className="text-sm leading-relaxed"
                  style={{ color: "#6b6b6b" }}
                >
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Founder matching — BETA highlight */}
      <section className="px-4 pb-20">
        <div className="max-w-3xl mx-auto">
          <div
            className="rounded-2xl p-8 sm:p-12 transition-all"
            style={glassStyle}
          >
            <div
              className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[10px] uppercase tracking-[0.18em] mb-6"
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
              Beta · Full launch tomorrow
            </div>

            <p
              className="text-xs uppercase tracking-[0.15em] mb-3"
              style={{ color: "#DC6743" }}
            >
              Founder matching
            </p>
            <h2
              className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] leading-[1.1] mb-5"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Match by what you&apos;re building.
            </h2>
            <p
              className="text-sm sm:text-base leading-relaxed mb-4 max-w-2xl"
              style={{ color: "#6b6b6b" }}
            >
              Tell your agent the problem you&apos;re solving — your stack,
              your stage, what&apos;s keeping you up at night. It cross-references
              the 451 speakers and your fellow Consensus attendees and surfaces
              the founders working on the same thing. Real overlap. Real intros.
              No &ldquo;AI people&rdquo; or &ldquo;DePIN people&rdquo; lists.
            </p>
            <p
              className="text-sm leading-relaxed"
              style={{ color: "#9a9a9a" }}
            >
              Live in beta now — full feature ships tomorrow.
            </p>
          </div>
        </div>
      </section>

      {/* Beyond Consensus — platform reframe */}
      <section className="px-4 pb-20">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-12">
            <p
              className="text-xs uppercase tracking-[0.15em] mb-3"
              style={{ color: "#DC6743" }}
            >
              Beyond Consensus
            </p>
            <h2
              className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] leading-[1.1] mb-5"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              The agent stays.
            </h2>
            <p
              className="text-base sm:text-lg max-w-2xl mx-auto leading-relaxed"
              style={{ color: "#6b6b6b" }}
            >
              Consensus is the hook. InstaClaw is the product.
            </p>
          </div>

          <div className="grid sm:grid-cols-3 gap-4">
            {[
              {
                eyebrow: "Architecture",
                title: "It's actually yours.",
                body: "Every InstaClaw agent runs on its own dedicated VM with its own crypto wallet, persistent memory, and real autonomy. Not a shared chatbot. Not a wrapper. A sovereign agent with onchain identity.",
              },
              {
                eyebrow: "Memory",
                title: "It learns you.",
                body: "Tell it your projects, your priorities, your patterns once. Every recommendation after that is filtered for who you actually are. The longer you use it, the sharper it gets.",
              },
              {
                eyebrow: "Skills",
                title: "Consensus is one of many.",
                body: "Research, writing, scheduling, code review, onchain transactions — whatever you teach it next is what it does next. The conference is just where you start.",
              },
            ].map((b) => (
              <div
                key={b.title}
                className="p-6 sm:p-7 rounded-xl transition-all duration-300 hover:-translate-y-0.5"
                style={glassStyle}
              >
                <p
                  className="text-[10px] uppercase tracking-[0.15em] mb-3"
                  style={{ color: "#DC6743" }}
                >
                  {b.eyebrow}
                </p>
                <h3
                  className="text-lg font-normal tracking-[-0.2px] mb-3 leading-snug"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  {b.title}
                </h3>
                <p
                  className="text-sm leading-relaxed"
                  style={{ color: "#6b6b6b" }}
                >
                  {b.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="px-4 pb-20">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-10">
            <p
              className="text-xs uppercase tracking-[0.15em] mb-3"
              style={{ color: "#DC6743" }}
            >
              FAQ
            </p>
            <h2
              className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] leading-[1.1]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Common questions.
            </h2>
          </div>

          <div className="space-y-0">
            {faqs.map((f, i) => (
              <div key={f.q}>
                {i === 0 && (
                  <div
                    className="h-px w-full"
                    style={{ background: "rgba(0,0,0,0.08)" }}
                  />
                )}
                <details className="group py-6">
                  <summary className="flex items-center justify-between cursor-pointer list-none">
                    <h3
                      className="text-base sm:text-lg font-normal tracking-[-0.2px] pr-6"
                      style={{ fontFamily: "var(--font-serif)" }}
                    >
                      {f.q}
                    </h3>
                    <span
                      className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition-transform group-open:rotate-45"
                      style={{
                        ...glassOrange,
                        color: "#DC6743",
                      }}
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                      >
                        <path
                          d="M5 1v8M1 5h8"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    </span>
                  </summary>
                  <p
                    className="text-sm leading-relaxed mt-3 pr-10"
                    style={{ color: "#6b6b6b" }}
                  >
                    {f.a}
                  </p>
                </details>
                <div
                  className="h-px w-full"
                  style={{ background: "rgba(0,0,0,0.08)" }}
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="px-4 pb-24">
        <div className="max-w-2xl mx-auto text-center">
          <h2
            className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] leading-[1.1] mb-4"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Claim your agent.
          </h2>
          <p
            className="text-sm sm:text-base mb-8 leading-relaxed"
            style={{ color: "#6b6b6b" }}
          >
            Free 3-day trial. No ticket required, no credit card, no waitlist.
          </p>
          <ConsensusClient />
          <p className="text-xs mt-8" style={{ color: "#9a9a9a" }}>
            Powered by{" "}
            <Link href="/" className="underline hover:opacity-70">
              InstaClaw
            </Link>{" "}
            · Agenda data from{" "}
            <a
              href="https://consensus.coindesk.com"
              className="underline hover:opacity-70"
            >
              CoinDesk
            </a>{" "}
            · Side events from{" "}
            <a href="https://plan.wtf/consensus" className="underline hover:opacity-70">
              plan.wtf
            </a>
          </p>
        </div>
      </section>
    </>
  );
}
