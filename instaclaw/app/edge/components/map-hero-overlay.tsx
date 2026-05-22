import type { ReactNode } from "react";
import Link from "next/link";
import type { EdgeUserState } from "../edge-user-state";

/**
 * Glass card layered over the Healdsburg hero map. Hero copy + the primary
 * CTA (or live-agent widget) live here. The CTA itself is rendered by the
 * parent so SSR-resolved userState can drive its shape.
 *
 * When userState.kind === "live" we swap the entire glass card to a status
 * acknowledgement instead of the marketing pitch — the visitor already has
 * an agent and the "Set up your agent" copy reads as a sales pitch to someone
 * who's already a user. The rest of the marketing page below the hero stays
 * intact (per audit finding #33 — these visitors might want to reference or
 * share the page).
 */
export function MapHeroOverlay({
  cta,
  userState,
}: {
  cta: ReactNode;
  userState: EdgeUserState;
}) {
  const isLive = userState.kind === "live";

  return (
    <div
      className="absolute z-10 left-[clamp(20px,4vw,56px)] top-1/2 -translate-y-1/2 max-w-[500px] w-[calc(100vw-40px)] flex flex-col items-start text-left p-5 lg:p-8 lg:pr-6 rounded-2xl backdrop-blur-[15px] border border-white/20 shadow-[0_2px_6px_0_rgba(0,0,0,0.15)] bg-gradient-to-r from-black/12 via-black/7 to-black/7 bg-clip-padding text-white"
      data-screen-label="map-hero"
    >
      <div
        className="font-[family-name:var(--font-display)] text-[18px] font-bold mb-6"
        style={{ letterSpacing: "0.01em" }}
      >
        May 30 – June 27, 2026 · Healdsburg, California
      </div>

      {isLive ? (
        <>
          <h1
            className="section-title mb-7 text-[clamp(26px,2.6vw,36px)] leading-[1.12]"
            style={{ color: "#fff" }}
          >
            Your agent is live.
          </h1>

          <p className="font-sans text-[18px] leading-[1.55] font-normal mt-4 mb-9 max-w-[520px]">
            Message{" "}
            <span style={{ fontWeight: 600 }}>@{userState.botUsername}</span>{" "}
            anytime, or{" "}
            <Link
              href="/dashboard"
              className="underline underline-offset-4 decoration-1"
              style={{ textDecorationColor: "rgba(255,255,255,0.6)" }}
            >
              open the dashboard
            </Link>
            .
          </p>

          <div className="flex flex-wrap gap-3 items-center w-full">{cta}</div>
        </>
      ) : (
        <>
          <h1
            className="section-title mb-7 text-[clamp(26px,2.6vw,36px)] leading-[1.12]"
            style={{ color: "#fff" }}
          >
            Meet your personal Edge Esmeralda agent
          </h1>

          <p className="font-sans text-[18px] leading-[1.55] font-normal mt-4 mb-9 max-w-[520px]">
            Part of a village-wide network of agents working together to
            surface the right people for you to meet, in real time.
          </p>

          <div className="flex flex-wrap gap-3 items-center w-full">{cta}</div>

          <p className="font-sans text-sm mt-5 inline-flex items-center flex-wrap gap-2 leading-[1.4]">
            <span style={{ opacity: 0.7 }}>Not attending yet?</span>
            <a
              href="https://edgeesmeralda.simplefi.tech/auth"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold underline underline-offset-4 decoration-1"
              style={{ textDecorationColor: "rgba(255,255,255,0.45)" }}
            >
              Apply to Edge Esmeralda
            </a>
          </p>
        </>
      )}
    </div>
  );
}
