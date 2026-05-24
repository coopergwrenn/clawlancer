const useCases = [
  "Personal Assistant",
  "Email Manager",
  "Scheduling Bot",
  "Content Creator",
  "Social Media Manager",
  "Customer Support",
  "Writing Coach",
  "Research Assistant",
  "CEO",
  "Your New Best Friend",
  "Community Manager",
  "Sales Outreach",
  "Lead Generation",
  "Travel Planner",
  "Language Tutor",
  "Health Coach",
  "Meeting Notes",
  "Your New Employee",
  "The Intern That Never Sleeps",
  "Data Entry & Reports",
];

function MarqueeRow({
  items,
  direction,
}: {
  items: string[];
  direction: "left" | "right";
}) {
  const animClass =
    direction === "left" ? "animate-marquee-left" : "animate-marquee-right";

  // Duplicate enough to fill wide screens seamlessly
  const repeated = [...items, ...items, ...items, ...items];

  // Vertical padding bumped from py-2 → py-4 so the .liquid-glass-pill-shadow
  // sibling div (inset: -10px relative to pill, filter:blur(2px)) isn't
  // clipped by the row container's `overflow-hidden`. Hero work source of
  // truth: the masked-ring shadow needs ~12px of breathing room below the pill.
  return (
    <div className="overflow-hidden w-full py-4">
      <div className={`flex gap-3 w-max ${animClass}`}>
        {repeated.map((item, i) => (
          // 3-element architecture, reusing the same classes from
          // .liquid-glass-pill (globals.css). Same shape/depth as the
          // SpotsCounter glass pill in the hero — the whole reason the
          // pill class system was built. Continuous transform on the
          // .animate-marquee-* ancestor creates a stacking context but
          // there's no entrance "snap" because the transform is always
          // non-identity; backdrop-filter samples cleanly every frame.
          <div key={`${item}-${i}`} className="liquid-glass-pill-root shrink-0">
            <span className="liquid-glass-pill">{item}</span>
            <div aria-hidden="true" className="liquid-glass-pill-shadow"></div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function UseCases() {
  const firstHalf = useCases.slice(0, 10);
  const secondHalf = useCases.slice(10);

  return (
    <section className="py-16 sm:py-[12vh] overflow-x-clip">
      <div className="text-center mb-12 px-4">
        <h2
          className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Everything You Need for Superpowers
        </h2>
        <p className="max-w-xs sm:max-w-none mx-auto" style={{ color: "var(--muted)" }}>
          Whatever you can imagine, your AI assistant can handle.
        </p>
      </div>

      <div className="relative pause-on-hover">
        {/* Gradient fade edges */}
        <div
          className="absolute left-0 top-0 bottom-0 w-24 z-10 pointer-events-none"
          style={{
            background:
              "linear-gradient(to right, var(--background), transparent)",
          }}
        />
        <div
          className="absolute right-0 top-0 bottom-0 w-24 z-10 pointer-events-none"
          style={{
            background:
              "linear-gradient(to left, var(--background), transparent)",
          }}
        />

        <div className="space-y-1">
          <MarqueeRow items={firstHalf} direction="left" />
          <MarqueeRow items={secondHalf} direction="right" />
        </div>
      </div>
    </section>
  );
}
