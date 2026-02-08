const useCases = [
  "Customer Support",
  "Personal Assistant",
  "Community Manager",
  "Study Buddy",
  "Writing Coach",
  "Code Reviewer",
  "Sales Outreach",
  "Content Creator",
  "Language Tutor",
  "Scheduling Bot",
  "Health Coach",
  "Travel Planner",
  "Recipe Helper",
  "Fitness Trainer",
  "Legal Q&A",
  "Research Assistant",
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

  return (
    <div className="overflow-hidden w-full">
      <div className={`flex gap-3 w-max ${animClass}`}>
        {repeated.map((item, i) => (
          <span
            key={`${item}-${i}`}
            className="whitespace-nowrap px-6 py-2 rounded-full text-sm shrink-0"
            style={{
              background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
              backdropFilter: "blur(2px)",
              WebkitBackdropFilter: "blur(2px)",
              boxShadow: `
                rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,
                rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,
                rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset
              `,
              color: "var(--foreground)",
            }}
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function UseCases() {
  const firstHalf = useCases.slice(0, 8);
  const secondHalf = useCases.slice(8);

  return (
    <section className="py-16 sm:py-[12vh] overflow-x-clip">
      <div className="text-center mb-12 px-4">
        <h2
          className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05] mb-6"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          Endless Possibilities
        </h2>
        <p style={{ color: "var(--muted)" }}>
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

        <div className="space-y-3">
          <MarqueeRow items={firstHalf} direction="left" />
          <MarqueeRow items={secondHalf} direction="right" />
        </div>
      </div>
    </section>
  );
}
