import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Consent brief — Edge Esmeralda 2026 research",
  description:
    "Exactly what data we collect for the Edge Esmeralda 2026 agent research program, how it's anonymized, and how to opt out at any time.",
};

const principles = [
  {
    title: "Your agent runs on its own VM.",
    body: "Each agent runs on a dedicated VM in its own filesystem boundary. Conversations, memory, and intros stay on your machine — never shared between agents, never aggregated server-side.",
  },
  {
    title: "Maximum Privacy Mode — opt in anytime.",
    body: "Toggle Maximum Privacy Mode in your dashboard and even our operators lose read access to your conversations and memory. A cron auto-reverts the lock after 24 hours so support can still reach you if something breaks.",
  },
  {
    title: "Researchers never see your raw data.",
    body: "The pre-registered research dataset is anonymized at source — your wallet hashes one-way with a salt rotated post-village. Free-text fields run through a PII sweep. The pipeline ships in code, not promises.",
  },
  {
    title: "You opt in, granularly.",
    body: "Onboarding asks what your agent shares with other agents — name, interests, goals. The default is conservative. Upgrades require explicit opt-in. Override at any time by just telling your agent.",
  },
];

const dataPoints = [
  {
    kind: "Account",
    body: "Email, World ID hash, billing handle (Stripe holds the card).",
  },
  {
    kind: "Agent",
    body: "A dedicated VM with your conversation history, agent memory, and Telegram bot token. Encrypted at rest.",
  },
  {
    kind: "Network",
    body: "Agent-to-agent messages travel over XMTP with end-to-end encryption — Edge City, sponsors, and we can never read them.",
  },
  {
    kind: "Research",
    body: "Anonymized aggregate signal: matches made, intros accepted, sentiment summaries. Never your raw text.",
  },
];

export default function ConsentPage() {
  return (
    <main className="min-h-screen pt-12 pb-24 sm:pt-20 sm:pb-32">
      <div className="max-w-[680px] mx-auto px-6 sm:px-8">
        <Link
          href="/edge"
          className="inline-flex items-center gap-1.5 text-sm mb-12 sm:mb-16 transition-opacity hover:opacity-70"
          style={{ color: "var(--edge-ink-soft)" }}
        >
          <span aria-hidden>←</span>
          <span>Edge Esmeralda</span>
        </Link>

        <header className="mb-14 sm:mb-20">
          <span className="eyebrow" style={{ color: "var(--edge-olive-hover)" }}>
            Consent Brief · EE26 Research
          </span>
          <h1 className="section-title mt-4">Your data, your terms.</h1>
          <p
            className="font-sans text-[17px] sm:text-[18px] leading-[1.6] mt-6"
            style={{ color: "var(--edge-ink-soft)" }}
          >
            Edge Esmeralda 2026 is the first longitudinal field deployment of
            personal AI agents tethered to real humans living together for 28
            days. The principles below are how we run the data side honestly.
            Each one ships in code, not just on this page.
          </p>
        </header>

        <section className="mb-16 sm:mb-20" aria-labelledby="principles-heading">
          <h2 id="principles-heading" className="sr-only">
            Privacy principles
          </h2>
          <ul className="flex flex-col gap-10">
            {principles.map((p, i) => (
              <li key={p.title} className="flex gap-5 items-start">
                <span
                  aria-hidden
                  className="shrink-0 inline-flex items-center justify-center text-[12px] font-semibold"
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 999,
                    background: "var(--edge-sage)",
                    color: "var(--edge-olive)",
                    letterSpacing: "0.06em",
                  }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="flex flex-col gap-2 min-w-0">
                  <h3
                    className="text-[20px] sm:text-[22px] leading-[1.25] font-semibold"
                    style={{
                      color: "var(--edge-ink)",
                      letterSpacing: "-0.01em",
                      fontFamily: "var(--font-display)",
                    }}
                  >
                    {p.title}
                  </h3>
                  <p
                    className="font-sans text-[16px] sm:text-[17px] leading-[1.6]"
                    style={{ color: "var(--edge-ink-soft)" }}
                  >
                    {p.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-14 sm:mb-20" aria-labelledby="collect-heading">
          <span className="eyebrow" style={{ color: "var(--edge-olive-hover)" }}>
            What we actually collect
          </span>
          <h2
            id="collect-heading"
            className="text-[26px] sm:text-[32px] leading-[1.1] font-bold mt-3"
            style={{
              color: "var(--edge-ink)",
              letterSpacing: "-0.02em",
              fontFamily: "var(--font-display)",
            }}
          >
            Nothing dressed up.
          </h2>
          <ul className="mt-8 flex flex-col gap-6">
            {dataPoints.map((d) => (
              <li
                key={d.kind}
                className="pl-5"
                style={{ borderLeft: "2px solid var(--edge-sage)" }}
              >
                <div
                  className="font-sans text-[12px] font-semibold uppercase tracking-[0.14em] mb-1"
                  style={{ color: "var(--edge-olive)" }}
                >
                  {d.kind}
                </div>
                <p
                  className="font-sans text-[16px] leading-[1.55]"
                  style={{ color: "var(--edge-ink-soft)" }}
                >
                  {d.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-14 sm:mb-20" aria-labelledby="control-heading">
          <span className="eyebrow" style={{ color: "var(--edge-olive-hover)" }}>
            What you control
          </span>
          <h2
            id="control-heading"
            className="text-[26px] sm:text-[32px] leading-[1.1] font-bold mt-3"
            style={{
              color: "var(--edge-ink)",
              letterSpacing: "-0.02em",
              fontFamily: "var(--font-display)",
            }}
          >
            All of it.
          </h2>
          <div
            className="mt-8 flex flex-col gap-5 font-sans text-[16px] leading-[1.6]"
            style={{ color: "var(--edge-ink-soft)" }}
          >
            <p>
              <strong style={{ color: "var(--edge-ink)" }}>
                Lock the operator.
              </strong>{" "}
              Toggle Maximum Privacy Mode from your{" "}
              <Link
                href="/dashboard/privacy"
                className="underline underline-offset-2"
                style={{ color: "var(--edge-ink)" }}
              >
                privacy panel
              </Link>
              . Auto-reverts after 24 hours.
            </p>
            <p>
              <strong style={{ color: "var(--edge-ink)" }}>
                Limit your sharing surface.
              </strong>{" "}
              Tell your agent which fields it can share with other agents.
              Onboarding sets a conservative default.
            </p>
            <p>
              <strong style={{ color: "var(--edge-ink)" }}>
                Leave entirely.
              </strong>{" "}
              Delete your account from{" "}
              <Link
                href="/dashboard/settings"
                className="underline underline-offset-2"
                style={{ color: "var(--edge-ink)" }}
              >
                settings
              </Link>{" "}
              and your VM, your memory, and your row in the research dataset
              are wiped.
            </p>
            <p>
              <strong style={{ color: "var(--edge-ink)" }}>
                Ask us anything.
              </strong>{" "}
              <a
                href="mailto:coop@valtlabs.com"
                className="underline underline-offset-2"
                style={{ color: "var(--edge-ink)" }}
              >
                coop@valtlabs.com
              </a>
              . Cooper reads every message.
            </p>
          </div>
        </section>

        <footer
          className="mt-20 pt-8 font-sans text-[14px] leading-[1.65]"
          style={{
            color: "var(--edge-ink-soft)",
            borderTop: "1px solid var(--edge-line-soft)",
          }}
        >
          <p>
            Anonymized dataset published September 2026. Research paper October
            2026. Open-sourced deployment playbook so other communities can run
            their own agent villages. Research led by Ivan Vendrov in
            partnership with Edge City and InstaClaw.
          </p>
          <p className="mt-5">
            <Link
              href="/edge"
              className="inline-flex items-center gap-1.5 underline underline-offset-2"
              style={{ color: "var(--edge-ink)" }}
            >
              <span aria-hidden>←</span> Back to Edge Esmeralda
            </Link>
          </p>
        </footer>
      </div>
    </main>
  );
}
