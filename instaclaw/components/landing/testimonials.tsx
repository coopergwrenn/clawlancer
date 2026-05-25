import { MessageCircle } from "lucide-react";

// Pixel art avatar definitions — 8×8 grids
// h=hair, s=skin, e=eye, m=mouth, b=shirt, space=transparent
type AvatarDef = { grid: string[]; colors: Record<string, string>; bg: string };

const pixelAvatars: Record<string, AvatarDef> = {
  // Sarah M. — female, brown hair, light skin
  SM: {
    grid: [
      "  hhhh  ",
      " hhhhhh ",
      "hhsssshh",
      "h sese h",
      "h ssss h",
      "h smms h",
      "   ss   ",
      "  bbbb  ",
    ],
    colors: { h: "#5C3A1E", s: "#F5D0A9", e: "#1A1A1A", m: "#CC6666", b: "#6B8E9B" },
    bg: "#E8DDD3",
  },
  // James K. — male, dark brown hair, light skin
  JK: {
    grid: [
      "  hhhh  ",
      " hhhhhh ",
      " hssssh ",
      "  sese  ",
      "  ssss  ",
      "  smms  ",
      "   ss   ",
      "  bbbb  ",
    ],
    colors: { h: "#2C1810", s: "#FADDBA", e: "#1A1A1A", m: "#CC6666", b: "#4A6FA5" },
    bg: "#D5DDE5",
  },
  // Priya R. — female, black hair, medium-dark skin
  PR: {
    grid: [
      "  hhhh  ",
      " hhhhhh ",
      "hhsssshh",
      "h sese h",
      "h ssss h",
      "h smms h",
      "   ss   ",
      "  bbbb  ",
    ],
    colors: { h: "#1A1A2A", s: "#C68642", e: "#1A1A1A", m: "#B85C5C", b: "#B8860B" },
    bg: "#E5D8C3",
  },
  // Marcus T. — male, black hair (tall), dark skin
  MT: {
    grid: [
      " hhhhhh ",
      " hhhhhh ",
      " hssssh ",
      "  sese  ",
      "  ssss  ",
      "  smms  ",
      "   ss   ",
      "  bbbb  ",
    ],
    colors: { h: "#1A1A2A", s: "#8D6E4C", e: "#1A1A1A", m: "#A0522D", b: "#E8734A" },
    bg: "#E0D5CA",
  },
  // Ava L. — female, blonde hair (medium length), light skin
  AL: {
    grid: [
      "  hhhh  ",
      " hhhhhh ",
      "hhsssshh",
      "h sese h",
      "  ssss  ",
      "  smms  ",
      "   ss   ",
      "  bbbb  ",
    ],
    colors: { h: "#D4A017", s: "#FFE0BD", e: "#1A1A1A", m: "#E8888A", b: "#7CB68E" },
    bg: "#D8E5D5",
  },
  // Danny W. — male, brown hair, light skin, beard
  DW: {
    grid: [
      "  hhhh  ",
      " hhhhhh ",
      " hssssh ",
      "  sese  ",
      "  ssss  ",
      "  hmmh  ",
      "   hh   ",
      "  bbbb  ",
    ],
    colors: { h: "#6B4226", s: "#FADDBA", e: "#1A1A1A", m: "#CC6666", b: "#333333" },
    bg: "#D5D5D5",
  },
  // Rachel S. — female, auburn hair, light skin
  RS: {
    grid: [
      "  hhhh  ",
      " hhhhhh ",
      "hhsssshh",
      "h sese h",
      "h ssss h",
      "h smms h",
      "   ss   ",
      "  bbbb  ",
    ],
    colors: { h: "#A0522D", s: "#FFE0BD", e: "#1A1A1A", m: "#CC6666", b: "#9B6B8E" },
    bg: "#E5D5DE",
  },
  // Tom H. — male, brown hair, medium skin
  TH: {
    grid: [
      "  hhhh  ",
      " hhhhhh ",
      " hssssh ",
      "  sese  ",
      "  ssss  ",
      "  smms  ",
      "   ss   ",
      "  bbbb  ",
    ],
    colors: { h: "#4A3728", s: "#D4A574", e: "#1A1A1A", m: "#B85C5C", b: "#5B7553" },
    bg: "#D5E0D5",
  },
  // Nina P. — female, dark hair, medium skin
  NP: {
    grid: [
      "  hhhh  ",
      " hhhhhh ",
      "hhsssshh",
      "h sese h",
      "h ssss h",
      "h smms h",
      "   ss   ",
      "  bbbb  ",
    ],
    colors: { h: "#2C1810", s: "#D4A574", e: "#1A1A1A", m: "#B85C5C", b: "#4A4A6A" },
    bg: "#D8D5E0",
  },
  // Chris D. — male, light brown hair, light skin
  CD: {
    grid: [
      "  hhhh  ",
      " hhhhhh ",
      " hssssh ",
      "  sese  ",
      "  ssss  ",
      "  smms  ",
      "   ss   ",
      "  bbbb  ",
    ],
    colors: { h: "#C4A45A", s: "#FADDBA", e: "#1A1A1A", m: "#CC6666", b: "#5A8FA5" },
    bg: "#D5E0E5",
  },
};

function PixelAvatar({ initials }: { initials: string }) {
  const data = pixelAvatars[initials];
  if (!data) return null;

  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 8 8"
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="crispEdges"
    >
      <rect width="8" height="8" fill={data.bg} />
      {data.grid.map((row, y) =>
        [...row].map((char, x) => {
          if (char === " ") return null;
          const color = data.colors[char];
          if (!color) return null;
          return <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={color} />;
        })
      )}
    </svg>
  );
}

const testimonials = {
  row1: [
    {
      quote:
        "I asked it to plan my entire vacation, book restaurants, and draft packing lists. It did all of it. I just sat there.",
      name: "Sarah M.",
      role: "Freelancer",
      initials: "SM",
    },
    {
      quote:
        "I just talk to it like a person. No setup guide, no tutorials. I told it what I needed and it figured out the rest. A week later it was doing things I didn't even ask for yet.",
      name: "James K.",
      role: "Small Business Owner",
      initials: "JK",
    },
    {
      quote:
        "It remembered every single detail about 200+ clients and followed up with each one personally. I feel like I have superpowers.",
      name: "Priya R.",
      role: "Real Estate Agent",
      initials: "PR",
    },
    {
      quote:
        "I gave it one task as a test. An hour later it had done that plus five other things I didn't even think to ask for.",
      name: "Marcus T.",
      role: "Content Creator",
      initials: "MT",
    },
    {
      quote:
        "It wrote my cover letters, prepped me for interviews, and tracked every application. I literally got the job because of this.",
      name: "Ava L.",
      role: "College Student",
      initials: "AL",
    },
  ],
  row2: [
    {
      quote:
        "I went to sleep. Woke up to 30 emails answered, my calendar organized, and a summary waiting for me. It never stops working.",
      name: "Danny W.",
      role: "Startup Founder",
      initials: "DW",
    },
    {
      quote:
        "It literally gets smarter every week. I taught it how I like my reports done and now it just does them perfectly without me saying anything. It learns your style.",
      name: "Rachel S.",
      role: "Marketing Manager",
      initials: "RS",
    },
    {
      quote:
        "The InstaClaw dashboard makes everything so simple. I can see what my bot learned, what it's working on, and tweak anything in seconds. I'm not technical at all and I manage it myself.",
      name: "Tom H.",
      role: "Teacher",
      initials: "TH",
    },
    {
      quote:
        "There is nothing I've thrown at it that it couldn't do. Emails, research, scheduling, writing. Literally anything.",
      name: "Nina P.",
      role: "Consultant",
      initials: "NP",
    },
    {
      quote:
        "My 68-year-old mom set it up by herself and now she won't stop telling her friends about it. That's all you need to know.",
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
  // Reverted from the .liquid-glass-card class system on 2026-05-24 —
  // Cooper preferred the lighter inline styling on these large cards.
  // The full wabi recipe (root + surface + shadow + conic rim + halo
  // substrate) reads as too heavy at card scale, and the equal-height
  // fix needed for the 3-element architecture changed the marquee row
  // padding in ways that disrupted the section's vertical rhythm.
  // The .liquid-glass-card class definition is preserved in globals.css
  // for potential future use on a different element where the full
  // recipe is desired.
  return (
    <div
      className="w-[320px] shrink-0 rounded-xl p-5"
      style={glassStyle}
    >
      <div className="flex items-center gap-3 mb-3">
        <div
          className="w-11 h-11 rounded-full shrink-0 relative flex items-center justify-center"
          style={{
            background: `radial-gradient(circle at 35% 35%, ${pixelAvatars[initials]?.bg ?? "#ddd"}dd, ${pixelAvatars[initials]?.bg ?? "#ddd"}88 40%, rgba(0,0,0,0.3) 100%)`,
            boxShadow: `
              inset 0 -3px 6px rgba(0,0,0,0.25),
              inset 0 3px 6px rgba(255,255,255,0.4),
              inset 0 0 4px rgba(0,0,0,0.15),
              0 2px 8px rgba(0,0,0,0.2),
              0 1px 3px rgba(0,0,0,0.15)
            `,
          }}
        >
          {/* Glass highlight reflection */}
          <div
            className="absolute top-[3px] left-[6px] w-[18px] h-[10px] rounded-full pointer-events-none z-10"
            style={{
              background: "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 100%)",
            }}
          />
          <div className="w-8 h-8 rounded-full overflow-hidden relative z-[1]">
            <PixelAvatar initials={initials} />
          </div>
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
      <div className="relative text-center mb-12 px-4">
        <h2
          className="text-4xl sm:text-5xl lg:text-6xl font-normal tracking-[-1px] leading-[1.05]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          What People Are Saying
        </h2>

        {/* Discord community pill. Uses the .liquid-glass-pill recipe
            from globals.css (same as the SpotsCounter pill in the
            hero) so it reads as part of the existing design system.
            On mobile: sits centered below the H2 (mt-6 flex
            justify-center). On sm+ screens: absolute-positioned to
            the right edge, vertically centered with the H2. */}
        <div className="mt-6 flex justify-center sm:mt-0 sm:absolute sm:top-1/2 sm:right-6 sm:-translate-y-1/2 lg:right-12">
          <a
            href="https://discord.gg/EymJzdFK9t"
            target="_blank"
            rel="noopener noreferrer"
            className="liquid-glass-pill-root transition-opacity hover:opacity-80"
            style={{
              transitionDuration: "300ms",
              transitionTimingFunction: "cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
            <span className="liquid-glass-pill">
              <MessageCircle
                className="w-3.5 h-3.5 shrink-0"
                strokeWidth={1.75}
              />
              <span>
                Discord
                <span style={{ opacity: 0.4, margin: "0 6px" }}>·</span>
                1k+ members
              </span>
            </span>
            <div aria-hidden="true" className="liquid-glass-pill-shadow"></div>
          </a>
        </div>
      </div>

      <div className="relative">
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
