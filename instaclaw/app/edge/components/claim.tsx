import Image from "next/image";
import type { ReactNode } from "react";

/**
 * "Meet your EdgeClaw agent" — claim card with copy on the left and the
 * village illustration on the right. The CTA / form widget is provided by
 * the parent (so the SSR-resolved userState drives the right shape).
 */
export function Claim({ ctaSlot }: { ctaSlot: ReactNode }) {
  return (
    <section
      id="claim"
      className="relative z-10 max-w-[1280px] mx-auto px-8 pt-20 pb-30 sm:pb-32"
    >
      <div
        className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] overflow-hidden backdrop-blur-md"
        style={{
          background: "rgba(255,253,247,0.85)",
          border: "1px solid rgba(26,24,20,0.1)",
          borderRadius: 28,
          boxShadow: "0 30px 60px rgba(15,26,18,0.12)",
        }}
      >
        <div className="flex flex-col gap-5 p-10 sm:p-14">
          <span
            className="eyebrow"
            style={{ color: "var(--edge-olive-hover)" }}
          >
            Meet your agent
          </span>
          <h2 className="section-title">Meet your EdgeClaw agent</h2>
          <p
            className="font-sans text-[18px] leading-[1.55] max-w-[520px]"
            style={{ color: "var(--ink-soft)" }}
          >
            We&apos;ll set up your OpenClaw a week before the village opens.
            Onboarding takes ~10 minutes with voice or chat. Bring your own
            goals.
          </p>

          <div className="max-w-md">{ctaSlot}</div>

          <div
            className="text-xs max-w-[520px]"
            style={{ color: "var(--ink-faded)" }}
          >
            By setting up your agent you agree to participate in the EE26
            research program.{" "}
            <a href="#" className="underline">
              Read the consent brief.
            </a>
          </div>
          <div
            className="text-sm max-w-[520px]"
            style={{ color: "var(--ink-soft)" }}
          >
            Not attending yet?{" "}
            <a
              href="https://edgeesmeralda.simplefi.tech/auth"
              className="underline"
              style={{ color: "var(--ink)" }}
            >
              Apply to Edge Esmeralda
            </a>
          </div>
        </div>

        <div
          className="relative min-h-[380px] hidden lg:block"
          style={{
            background:
              "linear-gradient(180deg, rgba(244,237,224,0.4), rgba(221,229,204,0.4))",
            borderLeft: "1px solid rgba(26,24,20,0.08)",
          }}
        >
          <Image
            src="/edge/village-island.png"
            alt="Edge Esmeralda village"
            fill
            sizes="(min-width: 1024px) 50vw, 100vw"
            className="object-cover object-center"
            style={{ filter: "saturate(0.95) contrast(0.98)" }}
          />
        </div>
      </div>
    </section>
  );
}
