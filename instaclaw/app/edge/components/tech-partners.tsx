import Image from "next/image";
import type { ReactNode } from "react";

interface Partner {
  logo: ReactNode;
  sub: string;
  role: string;
  href: string;
}

const PARTNERS: Partner[] = [
  {
    logo: (
      <div className="flex items-center gap-2.5 h-9">
        <Image
          src="/edge/instaclaw-logo.png"
          alt="InstaClaw"
          width={36}
          height={36}
          className="object-contain"
          style={{ imageRendering: "pixelated" }}
        />
        <span
          className="font-[family-name:var(--font-serif)] text-[30px] leading-none"
          style={{ letterSpacing: "-0.01em", color: "var(--ink)" }}
        >
          InstaClaw
        </span>
      </div>
    ),
    sub: "OpenClaw provisioning",
    role: "A persistent agent instance, configured and running, for every resident on day one. The infrastructure that means you don't have to be technical to have an agent.",
    href: "https://instaclaw.io/",
  },
  {
    logo: (
      <div className="flex items-center gap-2.5 h-9">
        <Image
          src="/edge/geo-logo.png"
          alt="Geo"
          width={36}
          height={36}
          className="object-contain"
        />
        <svg
          viewBox="14 121 62 24"
          aria-label="GEO"
          style={{
            height: 22,
            width: "auto",
            flexShrink: 0,
            color: "var(--ink)",
          }}
          fill="currentColor"
        >
          <path d="M 75.578 133.272 C 75.578 139.779 71.311 144.543 65.231 144.543 C 59.151 144.543 54.919 139.779 54.919 133.272 C 54.919 126.729 59.151 122 65.231 122 C 71.311 122 75.578 126.729 75.578 133.272 Z M 70.991 133.272 C 70.991 129.005 68.716 126.054 65.231 126.054 C 61.781 126.054 59.541 129.005 59.541 133.272 C 59.541 137.539 61.781 140.49 65.231 140.49 C 68.716 140.49 70.991 137.539 70.991 133.272 Z M 37.652 122.355 L 52.479 122.355 L 52.479 126.338 L 42.132 126.338 L 42.132 131.103 L 51.519 131.103 L 51.519 134.978 L 42.132 134.978 L 42.132 140.17 L 52.479 140.17 L 52.479 144.188 L 37.652 144.188 Z M 30.075 136.365 L 25.915 136.365 L 25.915 132.738 L 34.519 132.738 L 34.519 134.658 C 34.519 140.703 30.537 144.543 25.025 144.543 C 18.945 144.543 14.5 139.957 14.5 133.272 C 14.5 126.587 18.98 122 24.919 122 C 30.181 122 33.346 125.022 34.164 129.396 L 29.577 129.396 C 28.794 127.334 27.443 126.054 24.919 126.054 C 21.327 126.054 19.123 129.076 19.123 133.272 C 19.123 137.503 21.363 140.525 25.025 140.525 C 27.835 140.525 29.577 138.854 30.075 136.365 Z" />
        </svg>
      </div>
    ),
    sub: "Community knowledge graph",
    role: "Local events, the schedule, what's happening across Esmeralda — so your agent knows the village, not just your profile.",
    href: "https://www.geobrowser.io/",
  },
  {
    logo: (
      <div className="flex items-center gap-2.5 h-9">
        <Image
          src="/edge/logo.png"
          alt="Index Network"
          width={239}
          height={20}
          className="object-contain"
        />
      </div>
    ),
    sub: "Social discovery protocol",
    role: "The layer that connects agents, allows for negotiations between them, and surfaces opportunities. When your agent finds someone worth meeting, Index is how it got there.",
    href: "https://index.network/",
  },
  {
    logo: (
      <div className="flex items-center gap-2.5 h-9">
        <Image
          src="/edge/simpleFi-logo.jpg"
          alt="SimpleFi"
          width={36}
          height={36}
          className="rounded-md object-contain"
        />
        <span
          className="font-[family-name:var(--font-serif)] text-[30px] leading-none"
          style={{ letterSpacing: "-0.01em", color: "var(--ink)" }}
        >
          SimpleFi
        </span>
      </div>
    ),
    sub: "Governance & coordination",
    role: "Governance and coordination tools for crypto-native communities building toward Network States. Co-created with Edge City. Open source.",
    href: "https://www.simplefi.tech/",
  },
];

export function TechPartners() {
  return (
    <section className="relative z-10 max-w-[1280px] mx-auto px-8 pt-24 pb-14">
      <div className="flex flex-col gap-3.5 mb-10 max-w-[760px]">
        <span className="eyebrow" style={{ color: "var(--edge-olive-hover)" }}>
          Tech partners
        </span>
        <h2 className="section-title">The stack under the village</h2>
        <p
          className="font-sans text-[18px] leading-[1.55] max-w-[640px] mt-1"
          style={{ color: "var(--ink-soft)" }}
        >
          The infrastructure layer is open-source and built with four teams
          already shipping in this space.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {PARTNERS.map((p) => (
          <div
            key={p.sub}
            className="flex flex-col gap-[18px] min-h-[200px] px-7 pt-7 pb-8"
            style={{
              background: "rgba(255,253,247,0.85)",
              border: "1px solid rgba(26,24,20,0.1)",
              borderRadius: 18,
            }}
          >
            <div
              className="flex flex-col gap-2.5 pb-4 min-h-[56px] justify-center"
              style={{ borderBottom: "1px solid rgba(26,24,20,0.08)" }}
            >
              <a
                href={p.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={p.sub}
                className="inline-flex self-start transition-opacity hover:opacity-70"
              >
                {p.logo}
              </a>
              <div
                className="font-sans text-xs"
                style={{
                  color: "var(--ink-faded)",
                  letterSpacing: "0.04em",
                }}
              >
                {p.sub}
              </div>
            </div>
            <div
              className="text-[14.5px] leading-[1.55]"
              style={{ color: "var(--ink-soft)" }}
            >
              {p.role}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
