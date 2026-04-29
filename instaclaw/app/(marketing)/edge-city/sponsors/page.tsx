import Link from "next/link";
import { createMetadata } from "@/lib/seo";

export const metadata = createMetadata({
  title: "Sponsor the Agent Village — Edge Esmeralda 2026",
  description:
    "Fund 500 personal AI agents for the 28-day Edge Esmeralda village. The first longitudinal field study of personal AI agents tethered to real humans living together for a month. Pre-registered hypotheses, anonymized dataset published.",
  path: "/edge-city/sponsors",
  ogTitle: "Sponsor the Agent Village · Edge Esmeralda 2026",
});

const tiers = [
  {
    name: "Supporter",
    price: "$40,000",
    headline: "Light-to-moderate community engagement",
    note: "No buffer for unexpected demand.",
  },
  {
    name: "Lead Sponsor",
    price: "$60,000",
    headline: "Recommended — realistic mixed usage + 25% headroom",
    note: "Non-exclusive. Multiple Lead Sponsors possible.",
    featured: true,
  },
  {
    name: "Title Sponsor",
    price: "$90,000",
    headline: "Heavy adoption, premium model upgrades, full safety net",
    note: "Exclusive — currently unclaimed.",
  },
];

const benefits = [
  { label: "Acknowledgment in published research (Vendrov, Oct 2026)", supporter: true, lead: true, title: true },
  { label: "Funding-page recognition on the agent village landing page", supporter: true, lead: true, title: true },
  { label: "Acknowledgment in weekly research synthesis posts", supporter: true, lead: true, title: true },
  { label: "Aggregate token usage dashboard (real-time + weekly summaries)", supporter: true, lead: true, title: true },
  { label: "Direct access to the published anonymized dataset (Sep 2026)", supporter: true, lead: true, title: true },
  { label: "Co-marketing rights — publish your own writeup citing the research", supporter: false, lead: true, title: true },
  { label: "Custom acknowledgment language across all touchpoints", supporter: false, lead: true, title: true },
  { label: "Lead-Sponsor placement on the agent village landing page", supporter: false, lead: true, title: true },
  { label: "Dedicated comms channel during village (Cooper + Timour + Vendrov)", supporter: false, lead: true, title: true },
  { label: "Title-Sponsor presentation: “Agent Village, presented by [Sponsor]”", supporter: false, lead: false, title: true },
  { label: "Front-page logo placement on Edge Esmeralda research site", supporter: false, lead: false, title: true },
  { label: "Priority signal on research questions of interest (no editorial control)", supporter: false, lead: false, title: true },
  { label: "Optional co-author consideration on derivative writeups", supporter: false, lead: false, title: true },
];

const fundingModels = [
  {
    name: "Model A",
    title: "Shared API keys",
    body: "You provide one shared Anthropic + OpenAI key; all 500 village agents route through it. Simplest, fastest to confirm. You see aggregate token usage but no per-agent or per-message content.",
    recommended: true,
  },
  {
    name: "Model B",
    title: "Per-agent BYOK",
    body: "You mint or fund individual API keys; each agent uses its own. Per-agent attribution. Higher operational overhead during the village.",
  },
  {
    name: "Model C",
    title: "InstaClaw billing intermediary",
    body: "You pay InstaClaw; we provision inference using our own accounts. Cleanest UX for sponsors. We become the billing intermediary.",
  },
];

const timeline = [
  { date: "May 15, 2026", milestone: "Sponsor commitments confirmed" },
  { date: "May 30", milestone: "Village opens — agents go live night 1" },
  { date: "Jun 27", milestone: "Village concludes; data export pipeline runs final extract" },
  { date: "Jul–Aug 2026", milestone: "Data analysis; weekly research syntheses published" },
  { date: "Sep 2026", milestone: "Anonymized dataset published" },
  { date: "Oct 2026", milestone: "Research paper submitted; deployment playbook open-sourced" },
];

const mailtoSubject = encodeURIComponent("Edge Esmeralda 2026 — sponsor inquiry");
const mailtoBody = encodeURIComponent(
  "Hi Cooper and Timour,\n\nI'd like to learn more about sponsoring the Agent Village at Edge Esmeralda 2026. Particularly interested in:\n\n[ ] Supporter ($40K)\n[ ] Lead Sponsor ($60K)\n[ ] Title Sponsor ($90K)\n[ ] Need to discuss\n\n— [Your name]\n  [Your org]\n"
);

export default function EdgeCitySponsorsPage() {
  return (
    <>
      {/* Hero */}
      <section className="px-4 pt-16 pb-10 sm:pt-24 sm:pb-14">
        <div className="max-w-3xl mx-auto">
          <Link
            href="/edge-city"
            className="inline-flex items-center gap-2 text-xs mb-8 hover:opacity-70 transition-opacity"
            style={{ color: "#6b6b6b" }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M7 3L4 6l3 3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Back to /edge-city
          </Link>

          <p
            className="text-xs uppercase tracking-[0.15em] mb-4"
            style={{ color: "#DC6743" }}
          >
            Sponsor the Agent Village
          </p>
          <h1
            className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Help us run the first 28-day field study of personal AI agents.
          </h1>
          <p
            className="text-base sm:text-lg leading-relaxed mb-8"
            style={{ color: "#6b6b6b" }}
          >
            500 agents. 28 days. Fully ungated. Pre-registered hypotheses. An
            anonymized dataset and an open-sourced deployment playbook
            published after the village ends. Sponsor funding directly enables
            the ungated agent experience that makes the research credible.
          </p>

          <a
            href={`mailto:cooper@instaclaw.io,timour@edgecity.live?subject=${mailtoSubject}&body=${mailtoBody}`}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium transition-all hover:opacity-90"
            style={{
              background: "#DC6743",
              color: "#ffffff",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.2), 0 1px 3px rgba(220,103,67,0.3)",
            }}
          >
            Talk to us about sponsoring
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M5 3l4 4-4 4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
        </div>
      </section>

      {/* What you'd be funding */}
      <section className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          <div
            className="rounded-2xl p-8 sm:p-10"
            style={{
              background: "linear-gradient(135deg, rgba(220,103,67,0.06), rgba(220,103,67,0.02))",
              border: "1px solid rgba(220,103,67,0.15)",
            }}
          >
            <p
              className="text-xs uppercase tracking-[0.15em] mb-4"
              style={{ color: "#DC6743" }}
            >
              What you&apos;d be funding
            </p>
            <h2
              className="text-2xl sm:text-3xl font-normal tracking-[-0.4px] leading-[1.15] mb-4"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              The variable inference cost of running 500 agents continuously for 28 days.
            </h2>
            <p
              className="text-sm sm:text-base leading-relaxed mb-3"
              style={{ color: "#6b6b6b" }}
            >
              Sponsor commitment covers Anthropic Claude + OpenAI inference + Index
              Network compute pass-through. Specifically, the marginal cost of
              compute that exists *because* 500 agents are running — not the
              platform that lets us run them.
            </p>
            <p
              className="text-sm sm:text-base leading-relaxed"
              style={{ color: "#6b6b6b" }}
            >
              InstaClaw covers the rest: VM compute, engineering time, Supabase
              infrastructure, fleet operations, on-the-ground support during
              the village.
            </p>
          </div>
        </div>
      </section>

      {/* Tier cards */}
      <section className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-10">
            <p
              className="text-xs uppercase tracking-[0.15em] mb-3"
              style={{ color: "#DC6743" }}
            >
              Sponsor tiers
            </p>
            <h2
              className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] leading-[1.1]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Three commitment levels.
            </h2>
          </div>

          <div className="grid sm:grid-cols-3 gap-4">
            {tiers.map((tier) => (
              <div
                key={tier.name}
                className="rounded-xl p-6 flex flex-col"
                style={{
                  background: tier.featured ? "#ffffff" : "rgba(255,255,255,0.5)",
                  border: tier.featured
                    ? "1.5px solid #DC6743"
                    : "1px solid rgba(0,0,0,0.08)",
                  boxShadow: tier.featured
                    ? "0 4px 16px rgba(220,103,67,0.08)"
                    : "none",
                  position: "relative",
                }}
              >
                {tier.featured && (
                  <div
                    className="absolute -top-2 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-[0.1em]"
                    style={{
                      background: "#DC6743",
                      color: "#ffffff",
                      fontFamily: "var(--font-serif)",
                    }}
                  >
                    Recommended
                  </div>
                )}
                <h3
                  className="text-lg font-normal tracking-[-0.2px] mb-1"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  {tier.name}
                </h3>
                <p
                  className="text-3xl font-normal tracking-[-0.5px] mb-3"
                  style={{ fontFamily: "var(--font-serif)", color: "#DC6743" }}
                >
                  {tier.price}
                </p>
                <p className="text-sm leading-relaxed mb-2" style={{ color: "#333334" }}>
                  {tier.headline}
                </p>
                <p className="text-xs mt-auto" style={{ color: "#9a9a9a" }}>
                  {tier.note}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Benefits matrix */}
      <section className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-10">
            <p
              className="text-xs uppercase tracking-[0.15em] mb-3"
              style={{ color: "#DC6743" }}
            >
              Per-tier recognition
            </p>
            <h2
              className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] leading-[1.1]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              What sponsors get.
            </h2>
          </div>

          <div
            className="rounded-xl overflow-hidden"
            style={{ border: "1px solid rgba(0,0,0,0.08)" }}
          >
            <div
              className="grid grid-cols-[1fr_60px_60px_60px] sm:grid-cols-[1fr_90px_90px_90px] text-xs sm:text-sm py-3 px-4 sm:px-5"
              style={{
                background: "#ffffff",
                borderBottom: "1px solid rgba(0,0,0,0.08)",
                color: "#9a9a9a",
                fontFamily: "var(--font-serif)",
              }}
            >
              <div>Benefit</div>
              <div className="text-center">$40K</div>
              <div className="text-center">$60K</div>
              <div className="text-center">$90K</div>
            </div>
            {benefits.map((b, i) => (
              <div
                key={b.label}
                className="grid grid-cols-[1fr_60px_60px_60px] sm:grid-cols-[1fr_90px_90px_90px] text-xs sm:text-sm py-3 px-4 sm:px-5 items-center"
                style={{
                  background: i % 2 === 0 ? "#ffffff" : "rgba(248,247,244,0.6)",
                  color: "#333334",
                }}
              >
                <div className="pr-2 leading-snug">{b.label}</div>
                <Cell on={b.supporter} />
                <Cell on={b.lead} />
                <Cell on={b.title} />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* What sponsors don't see */}
      <section className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          <div
            className="rounded-2xl p-8 sm:p-10"
            style={{
              background: "#ffffff",
              border: "1px solid rgba(0,0,0,0.08)",
            }}
          >
            <p
              className="text-xs uppercase tracking-[0.15em] mb-4"
              style={{ color: "#DC6743" }}
            >
              Privacy boundary
            </p>
            <h2
              className="text-2xl sm:text-3xl font-normal tracking-[-0.4px] leading-[1.15] mb-5"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              What sponsors do not see.
            </h2>
            <ul className="space-y-3">
              {[
                "Per-agent or per-message content — agent-to-agent conversations are end-to-end encrypted (XMTP).",
                "Real names, contact info, or wallet addresses of attendees — the published dataset is anonymized at source via HMAC-SHA-256, with a salt rotated post-village.",
                "Any individual attendee's data — sponsor visibility is aggregate-only.",
              ].map((line) => (
                <li key={line} className="flex gap-3 text-sm leading-relaxed">
                  <svg
                    className="shrink-0 mt-0.5"
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                  >
                    <circle cx="7" cy="7" r="6" stroke="#DC6743" strokeWidth="1.2" />
                    <path
                      d="M4.5 4.5l5 5M9.5 4.5l-5 5"
                      stroke="#DC6743"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                    />
                  </svg>
                  <span style={{ color: "#333334" }}>{line}</span>
                </li>
              ))}
            </ul>
            <p className="text-sm leading-relaxed mt-6" style={{ color: "#6b6b6b" }}>
              What sponsors <em>do</em> see: token-usage dashboards by week, the
              published anonymized dataset, and the published paper. Same data
              the research community gets.
            </p>
          </div>
        </div>
      </section>

      {/* Funding routing */}
      <section className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-10">
            <p
              className="text-xs uppercase tracking-[0.15em] mb-3"
              style={{ color: "#DC6743" }}
            >
              Funding routing
            </p>
            <h2
              className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] leading-[1.1] mb-3"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              Three ways to route the funds.
            </h2>
            <p
              className="text-sm sm:text-base max-w-lg mx-auto leading-relaxed"
              style={{ color: "#6b6b6b" }}
            >
              Final structure decided with the lead sponsor. We recommend Model
              A for round one.
            </p>
          </div>

          <div className="grid sm:grid-cols-3 gap-4">
            {fundingModels.map((m) => (
              <div
                key={m.name}
                className="rounded-xl p-6"
                style={{
                  background: "#ffffff",
                  border: m.recommended
                    ? "1.5px solid rgba(220,103,67,0.4)"
                    : "1px solid rgba(0,0,0,0.08)",
                }}
              >
                <p
                  className="text-xs uppercase tracking-[0.1em] mb-2"
                  style={{ color: "#DC6743" }}
                >
                  {m.name}
                  {m.recommended ? " · recommended" : ""}
                </p>
                <h3
                  className="text-lg font-normal tracking-[-0.2px] mb-3"
                  style={{ fontFamily: "var(--font-serif)" }}
                >
                  {m.title}
                </h3>
                <p className="text-sm leading-relaxed" style={{ color: "#6b6b6b" }}>
                  {m.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Why this moment */}
      <section className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          <p
            className="text-xs uppercase tracking-[0.15em] mb-3"
            style={{ color: "#DC6743" }}
          >
            Why this is the moment
          </p>
          <h2
            className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] leading-[1.1] mb-6"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            The first longitudinal field test.
          </h2>
          <div className="space-y-4 text-sm sm:text-base leading-relaxed" style={{ color: "#6b6b6b" }}>
            <p>
              DeepMind&apos;s Habermas Machine validated AI-mediated deliberation
              with 5,700 participants — in a controlled <em>online</em> study.
              Anthropic&apos;s Collective Constitutional AI was a one-shot
              survey aggregation. CIP&apos;s Alignment Assemblies are short-form
              events.
            </p>
            <p style={{ color: "#333334" }}>
              <strong>Nothing has tested whether AI agents — running
              continuously, embedded in real human relationships, across weeks
              — actually produce the outcomes the methodology predicts.</strong>
            </p>
            <p>
              Edge Esmeralda is that test. It&apos;s the difference between
              &ldquo;we showed in a lab&rdquo; and &ldquo;we showed in the
              field.&rdquo; If the hypotheses hold, the result is the strongest
              field evidence to date that personal AI agents can mediate
              community coordination. If they don&apos;t, the negative result
              is just as valuable — it tells the field where the limits
              actually are.
            </p>
            <p>
              Either way, the dataset and playbook ship publicly. This is
              research infrastructure, not a closed experiment.
            </p>
          </div>
        </div>
      </section>

      {/* Timeline */}
      <section className="px-4 pb-16">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-10">
            <p
              className="text-xs uppercase tracking-[0.15em] mb-3"
              style={{ color: "#DC6743" }}
            >
              Timeline
            </p>
            <h2
              className="text-3xl sm:text-4xl font-normal tracking-[-0.5px] leading-[1.1]"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              From commitment to playbook.
            </h2>
          </div>

          <div className="space-y-0">
            {timeline.map((t, i) => (
              <div key={t.date}>
                <div className="h-px w-full" style={{ background: "rgba(0,0,0,0.08)" }} />
                <div className="grid grid-cols-[110px_1fr] sm:grid-cols-[160px_1fr] gap-4 sm:gap-8 py-5 items-baseline">
                  <div className="text-xs sm:text-sm" style={{ color: "#DC6743", fontFamily: "var(--font-serif)" }}>
                    {t.date}
                  </div>
                  <div className="text-sm sm:text-base" style={{ color: "#333334" }}>
                    {t.milestone}
                  </div>
                </div>
                {i === timeline.length - 1 && (
                  <div className="h-px w-full" style={{ background: "rgba(0,0,0,0.08)" }} />
                )}
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
            Ready to talk?
          </h2>
          <p className="text-sm sm:text-base mb-8 leading-relaxed" style={{ color: "#6b6b6b" }}>
            Sponsor commitments confirmed by May 15, 2026. 30-minute call to
            walk through the village in detail, the sponsor agreement, and your
            specific recognition preferences.
          </p>
          <a
            href={`mailto:cooper@instaclaw.io,timour@edgecity.live?subject=${mailtoSubject}&body=${mailtoBody}`}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-full text-sm font-medium transition-all hover:opacity-90"
            style={{
              background: "#DC6743",
              color: "#ffffff",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.2), 0 1px 3px rgba(220,103,67,0.3)",
            }}
          >
            Email Cooper + Timour
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M5 3l4 4-4 4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
          <p className="text-xs mt-8" style={{ color: "#9a9a9a" }}>
            <Link href="/edge-city" className="underline hover:opacity-70">
              ← Back to /edge-city
            </Link>{" "}
            ·{" "}
            <a href="https://vendrov.ai" className="underline hover:opacity-70">
              Research lead: Ivan Vendrov
            </a>{" "}
            ·{" "}
            <Link href="/" className="underline hover:opacity-70">
              Powered by InstaClaw
            </Link>
          </p>
        </div>
      </section>
    </>
  );
}

function Cell({ on }: { on: boolean }) {
  return (
    <div className="flex items-center justify-center">
      {on ? (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M3 7l3 3 5-6"
            stroke="#DC6743"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <span style={{ color: "#cfcfcf" }}>—</span>
      )}
    </div>
  );
}
