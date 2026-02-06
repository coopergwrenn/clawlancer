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

  return (
    <div className="flex overflow-hidden">
      <div className={`flex gap-3 ${animClass}`}>
        {[...items, ...items].map((item, i) => (
          <span
            key={`${item}-${i}`}
            className="glass whitespace-nowrap px-4 py-2 rounded-full text-sm shrink-0"
            style={{ color: "var(--muted)" }}
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
    <section className="py-24 overflow-hidden">
      <div className="text-center mb-12 px-4">
        <h2 className="text-3xl sm:text-4xl font-bold mb-4">
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
