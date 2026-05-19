/**
 * FAQ — ported from the previous /edge page ("Common questions.") and
 * restyled to match the edgeclaw-site palette + typography. Uses native
 * <details>/<summary> so accordion behavior works without JS.
 */

const faqs = [
  {
    q: "Do I need a ticket?",
    a: "Yes. Agents are reserved for verified Edge Esmeralda attendees. The claim flow validates your ticket against Edge's ticketing system. If you don't have a ticket yet, edgeesmeralda.com is the place to start.",
  },
  {
    q: "What does it cost me?",
    a: "Nothing for the duration of the village. Agent inference is sponsor-funded — every Edge attendee gets a fully ungated agent with no daily token caps for the full 28 days.",
  },
  {
    q: "Which weeks does it cover?",
    a: "All four. You tell your agent which weeks you're attending during onboarding (May 30–Jun 6, Jun 6–13, Jun 13–20, Jun 20–27). Matchmaking respects your dates — no introductions to people who've already left.",
  },
  {
    q: "Do I have to use it?",
    a: "No. Your agent is yours. You can talk to it as much or as little as you want, and you can shut down any feature (matchmaking, governance, briefings) with a single message.",
  },
  {
    q: "Can organizers read my conversations?",
    a: "No. Edge City organizers see only anonymized aggregate sentiment from a coordinator agent — never your individual conversations or matches. Same goes for sponsors and researchers.",
  },
  {
    q: "What happens after the village?",
    a: "You can keep your agent running through the hosted Instaclaw service after the village ends. If you choose not to continue, your agent data and memory will be deleted according to the standard lifecycle policy. You'll still be able to use lightweight social features even without an active hosted agent.",
  },
];

export function Faq() {
  return (
    <section
      id="faq"
      className="relative z-10 max-w-[1280px] mx-auto px-8 py-20"
    >
      <div
        className="flex flex-col gap-3.5 max-w-[760px] mb-10 pb-6"
        style={{ borderBottom: "1px solid rgba(26,24,20,0.14)" }}
      >
        <span className="eyebrow" style={{ color: "var(--edge-olive-hover)" }}>
          FAQ
        </span>
        <h2 className="section-title">Common questions.</h2>
      </div>

      <div className="max-w-[820px]">
        {faqs.map((f) => (
          <details
            key={f.q}
            className="group"
            style={{ borderBottom: "1px solid var(--rule)" }}
          >
            <summary className="flex items-start justify-between gap-6 cursor-pointer list-none py-6 sm:py-7">
              <h3
                className="font-[family-name:var(--font-display)] text-[18px] sm:text-[20px] font-semibold leading-snug m-0"
                style={{ color: "var(--ink)", letterSpacing: "-0.005em" }}
              >
                {f.q}
              </h3>
              <span
                aria-hidden
                className="shrink-0 w-7 h-7 rounded-full inline-flex items-center justify-center transition-transform duration-200 group-open:rotate-45 mt-0.5"
                style={{
                  background: "var(--sage)",
                  color: "var(--forest-deep)",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                  <path
                    d="M5.5 1v9M1 5.5h9"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </summary>
            <p
              className="font-sans text-[15px] sm:text-[16px] leading-[1.65] pb-7 max-w-[60ch] m-0"
              style={{ color: "var(--ink-soft)" }}
            >
              {f.a}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
