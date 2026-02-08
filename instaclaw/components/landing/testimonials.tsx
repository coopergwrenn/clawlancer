const testimonials = {
  row1: [
    {
      quote:
        "I had my AI handling customer emails within 10 minutes of signing up. No joke.",
      name: "Sarah M.",
      role: "Freelancer",
      initials: "SM",
    },
    {
      quote:
        "I'm not technical at all and I set this up on my lunch break. It just works.",
      name: "James K.",
      role: "Small Business Owner",
      initials: "JK",
    },
    {
      quote:
        "My AI remembers everything about my clients. It's like having a personal assistant that never forgets.",
      name: "Priya R.",
      role: "Real Estate Agent",
      initials: "PR",
    },
    {
      quote:
        "I was skeptical but the free trial sold me. Now I can't imagine working without it.",
      name: "Marcus T.",
      role: "Content Creator",
      initials: "MT",
    },
    {
      quote:
        "Finally something that actually does the work instead of just telling me what to do.",
      name: "Ava L.",
      role: "Student",
      initials: "AL",
    },
  ],
  row2: [
    {
      quote:
        "Set it up before bed. Woke up to 30 emails sorted and replied to. Wild.",
      name: "Danny W.",
      role: "Startup Founder",
      initials: "DW",
    },
    {
      quote:
        "The fact that it browses the web and handles tasks on its own is a game changer.",
      name: "Rachel S.",
      role: "Marketing Manager",
      initials: "RS",
    },
    {
      quote:
        "I switched from trying to self-host and saved myself weeks of headaches.",
      name: "Tom H.",
      role: "Developer",
      initials: "TH",
    },
    {
      quote:
        "Worth every penny of $29/mo. I've tried tools 10x the price that do less.",
      name: "Nina P.",
      role: "Consultant",
      initials: "NP",
    },
    {
      quote: "My mom uses it. That's how easy it is.",
      name: "Chris D.",
      role: "Product Designer",
      initials: "CD",
    },
  ],
};

const glassStyle = {
  background:
    "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  boxShadow: `
    rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,
    rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,
    rgba(0, 0, 0, 0.1) 0px 2px 4px 0px,
    rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset
  `,
};

function TestimonialCard({
  quote,
  name,
  role,
  initials,
}: {
  quote: string;
  name: string;
  role: string;
  initials: string;
}) {
  return (
    <div
      className="w-[320px] shrink-0 rounded-xl p-5"
      style={glassStyle}
    >
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold shrink-0"
          style={{ background: "var(--accent)", color: "#ffffff" }}
        >
          {initials}
        </div>
        <div>
          <p className="font-medium text-sm" style={{ color: "var(--foreground)" }}>
            {name}
          </p>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            {role}
          </p>
        </div>
      </div>
      <p
        className="text-sm leading-relaxed"
        style={{ color: "var(--foreground)" }}
      >
        &ldquo;{quote}&rdquo;
      </p>
    </div>
  );
}

function MarqueeRow({
  items,
  direction,
}: {
  items: typeof testimonials.row1;
  direction: "left" | "right";
}) {
  const animClass =
    direction === "left" ? "animate-marquee-left" : "animate-marquee-right";

  const repeated = [...items, ...items, ...items, ...items];

  return (
    <div className="overflow-hidden w-full py-2">
      <div className={`flex gap-4 w-max ${animClass}`}>
        {repeated.map((item, i) => (
          <TestimonialCard key={`${item.name}-${i}`} {...item} />
        ))}
      </div>
    </div>
  );
}

export function Testimonials() {
  return (
    <section className="py-16 sm:py-[12vh] overflow-x-clip">
      <div className="text-center mb-12 px-4">
        <h2
          className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          What People Are Saying
        </h2>
      </div>

      <div className="relative pause-on-hover">
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
          <MarqueeRow items={testimonials.row1} direction="left" />
          <MarqueeRow items={testimonials.row2} direction="right" />
        </div>
      </div>
    </section>
  );
}
