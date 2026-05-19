const STEPS = [
  {
    n: "1",
    titleLead: "Get your",
    titleItalic: "agent",
    body: "Every resident gets a personal agent pre-loaded with the schedule, wiki, and attendee directory before the village opens. It already knows Esmeralda before you walk in.",
    accent: "#c9a961",
  },
  {
    n: "2",
    titleLead: "Tell it what",
    titleItalic: "you're here for",
    body: "Short voice or chat onboarding in under 5 minutes. Share your goals and the people you want to meet, the raw edition.",
    accent: "#a8c0a1",
  },
  {
    n: "3",
    titleLead: "Let it",
    titleItalic: "work",
    body: "Your agent starts communicating with other agents across the village — gossiping, negotiating, and surfacing the connections that serve you best. You decide whether it's a go or no-go.",
    accent: "#d4a89c",
  },
  {
    n: "4",
    titleLead: "Stay in",
    titleItalic: "the loop",
    body: "Stay updated even when you're not looking, with morning briefs and evening digests. Keep your agent updated on your conversations to improve how it works for you.",
    accent: "#92b1bd",
  },
];

export function HowItWorks() {
  return (
    <section
      id="how"
      className="relative z-10 max-w-[1280px] mx-auto px-8 pt-14 pb-18"
    >
      <div
        className="flex items-end justify-between gap-12 pb-6 mb-8"
        style={{ borderBottom: "1px solid rgba(26,24,20,0.14)" }}
      >
        <div className="flex flex-col gap-3 max-w-[620px]">
          <span
            className="eyebrow"
            style={{ color: "var(--edge-olive-hover)" }}
          >
            How it works
          </span>
          <h2 className="section-title whitespace-normal md:whitespace-nowrap">
            Set up your agent in minutes.
          </h2>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-7 lg:gap-0">
        {STEPS.map((s, i) => (
          <div
            key={s.n}
            className={`flex flex-col gap-2.5 py-1 ${
              i > 0 ? "lg:pl-6 lg:border-l lg:border-[rgba(26,24,20,0.1)]" : ""
            } ${i < 3 ? "lg:pr-6" : ""}`}
          >
            <div className="flex items-center gap-2.5 mb-1">
              <span
                className="w-2 h-2 rounded-full"
                style={{
                  background: s.accent,
                  boxShadow: "0 0 0 4px rgba(255,253,247,0.6)",
                }}
              />
              <span
                className="font-sans text-sm"
                style={{ color: "var(--ink-soft)", letterSpacing: "0.05em" }}
              >
                {s.n}
              </span>
            </div>
            <h3
              className="font-[family-name:var(--font-display)] text-2xl font-bold leading-snug"
              style={{ color: "var(--ink)", letterSpacing: "-0.01em" }}
            >
              {s.titleLead} {s.titleItalic}
            </h3>
            <p
              className="font-sans text-[18px] leading-[1.55]"
              style={{ color: "var(--ink-soft)" }}
            >
              {s.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
