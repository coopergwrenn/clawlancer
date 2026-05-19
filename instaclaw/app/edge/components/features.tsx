const MODES = [
  {
    mode: "Actively",
    kicker: "It finds your people before you know to look",
    body: "Your agent knows what you're working on, who you'd want to meet, and who is actually around this week. It surfaces the connection, drafts a one-line frame for why it matters, and makes it easy for you to start the conversation. Think of it like your talent manager.",
    accent: "#d4a89c",
    glyph: (
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      </svg>
    ),
  },
  {
    mode: "Ambiently",
    kicker: "Know the village inside-out",
    body: "Sessions, residents, venues, side-quests, the bus from SFO — your agent read every page of Edge Esmeralda before you landed. Think of it like a concierge.",
    accent: "#92b1bd",
    glyph: (
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M3 14a4 4 0 0 1 4-4 6 6 0 0 1 11.5 1.5A3.5 3.5 0 0 1 18 18H7a4 4 0 0 1-4-4z" />
        <path d="M9 14h6" />
      </svg>
    ),
  },
];

export function Features() {
  return (
    <section
      id="features"
      className="relative z-10 max-w-[1280px] mx-auto px-8 py-20"
    >
      <div
        className="flex flex-col gap-3.5 max-w-[760px] mb-10 pb-6"
        style={{ borderBottom: "1px solid rgba(26,24,20,0.14)" }}
      >
        <span className="eyebrow" style={{ color: "var(--edge-olive-hover)" }}>
          Two modes, always on
        </span>
        <h2 className="section-title">
          Your agent works both actively and ambiently
        </h2>
        <p
          className="font-sans text-[18px] leading-[1.55] max-w-[620px]"
          style={{ color: "var(--ink-soft)" }}
        >
          Your agent isn&apos;t waiting to be asked. It&apos;s finding your
          people and learning the village, so every day there is denser than
          the last.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {MODES.map((m) => (
          <div
            key={m.mode}
            className="flex flex-col gap-[18px] min-h-[280px] backdrop-blur-md"
            style={{
              background: "rgba(255,253,247,0.78)",
              border: "1px solid rgba(26,24,20,0.1)",
              borderRadius: 18,
              padding: "clamp(28px,3.2vw,40px)",
            }}
          >
            <div
              className="inline-flex items-center self-start gap-2 py-1.5 pl-2.5 pr-3.5 rounded-full text-xs font-bold uppercase border"
              style={{
                color: m.accent,
                borderColor: m.accent,
                letterSpacing: "0.16em",
                background: "rgba(255,253,247,0.6)",
              }}
            >
              <span className="inline-flex items-center justify-center">
                {m.glyph}
              </span>
              <span>{m.mode}</span>
            </div>
            <h3
              className="font-[family-name:var(--font-display)] text-[28px] font-bold leading-[1.15]"
              style={{ color: "var(--ink)", letterSpacing: "-0.01em" }}
            >
              {m.kicker}
            </h3>
            <p
              className="font-sans text-[17px] leading-[1.55]"
              style={{ color: "var(--ink-soft)" }}
            >
              {m.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
