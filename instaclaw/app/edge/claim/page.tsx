import Image from "next/image";
import Link from "next/link";
import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { EdgeCityClient } from "../edge-city-client";
import { getEdgeUserState } from "../edge-user-state";

/**
 * /edge/claim — the tactical Layer 2 setup page.
 *
 * Layer 1 (/edge) is the cinematic marketing page. Its single CTA points
 * here. This page exists to convert: one big headline, one form, one trust
 * line, one BYO branch for users with an existing InstaClaw agent.
 *
 * Page reuses EdgeCityClient — the same component that drives the in-page
 * Claim section on Layer 1 — so all three user-state branches (logged_out,
 * in_progress, live) get the right shape from the same logic.
 *
 * Visual language adopted from /edge-v1-backup hero: massive uppercase
 * display headline, tracked-out caps eyebrow ticker, dark-olive primary
 * pill, cream background (inherited from /edge/layout.tsx). No marketing
 * sections — overnight loop, features, FAQ, sponsors all live on Layer 1.
 *
 * BYO branch ("Already have an InstaClaw agent?") routes through a new
 * /api/partner/tag-redirect GET handler that mirrors POST /api/partner/tag
 * but issues a 302. Used as the NextAuth callbackUrl so a returning user
 * with an existing account can sign in, get tagged as edge_city, and land
 * on /dashboard — closes the Rule 9 gap for the existing-account path.
 */

export const metadata = createMetadata({
  title: "Claim your Edge Esmeralda 2026 agent",
  description:
    "Your personal AI agent for the 28-day Edge Esmeralda village. Free for verified ticket holders. Inference sponsor-funded.",
  path: "/edge/claim",
  ogTitle: "Claim your Edge Esmeralda 2026 agent",
  ogImage: "/edge/og-edge.png",
});

const eventJsonLd = {
  "@context": "https://schema.org",
  "@type": "Event",
  name: "Edge Esmeralda 2026 — Agent Village",
  description:
    "Personal AI agents for every Edge Esmeralda resident. A longitudinal field study in human–AI collective intelligence.",
  startDate: "2026-05-30",
  endDate: "2026-06-27",
  eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
  eventStatus: "https://schema.org/EventScheduled",
  location: {
    "@type": "Place",
    name: "Edge Esmeralda",
    address: {
      "@type": "PostalAddress",
      addressLocality: "Healdsburg",
      addressRegion: "CA",
      addressCountry: "US",
    },
  },
  organizer: {
    "@type": "Organization",
    name: "Edge City",
    url: "https://edgeesmeralda.com",
  },
};

export default async function EdgeClaimPage() {
  // Per Rule 33 — VM state is the source of truth, not session.onboardingComplete.
  // EdgeCityClient renders one of three shapes based on this:
  //   logged_out  → claim CTA + notify-me fallback
  //   in_progress → "Complete setup" pill routing to resumePath
  //   live        → sage card with @botUsername + Open in Telegram
  const userState = await getEdgeUserState();
  const isLive = userState.kind === "live";

  return (
    <>
      <JsonLd data={eventJsonLd} />

      <main className="relative min-h-screen flex flex-col">
        {/* ── Top bar — minimal: wordmark + date strip ── */}
        <header
          className="relative z-10 px-4 sm:px-8 py-5 sm:py-6"
          style={{ borderBottom: "1px solid var(--edge-line-soft)" }}
        >
          <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
            <Link
              href="/edge"
              aria-label="Edge Esmeralda — back to landing"
              className="flex items-center"
            >
              <Image
                src="/edge/edge-esmeralda-wordmark.svg"
                alt="Edge Esmeralda"
                width={180}
                height={58}
                priority
                style={{ height: "32px", width: "auto" }}
              />
            </Link>

            <span
              className="hidden sm:inline text-[11px] uppercase tracking-[0.18em]"
              style={{ color: "var(--edge-ink-soft)" }}
            >
              May 30 – Jun 27, 2026
            </span>
          </div>
        </header>

        {/* ── Hero / action card ── */}
        <section className="relative z-10 flex-1 px-4 sm:px-8 pt-12 sm:pt-20 pb-16 sm:pb-24">
          <div className="max-w-[680px] mx-auto">
            {/* Live ticker — small tracked caps, mirrors v1-backup */}
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-[0.18em] mb-8 sm:mb-10"
              style={{ color: "var(--edge-ink-soft)" }}
            >
              <span style={{ color: "var(--edge-olive)" }}>● Live</span>
              <span aria-hidden style={{ opacity: 0.35 }}>
                /
              </span>
              <span>May 30 – Jun 27, 2026</span>
              <span aria-hidden style={{ opacity: 0.35 }}>
                /
              </span>
              <span>Healdsburg, CA</span>
            </div>

            {/* Massive uppercase headline — mirrors v1-backup "Agent Village." pattern */}
            <h1
              className="font-bold uppercase tracking-[-0.02em] leading-[0.92] text-[clamp(44px,11vw,96px)] mb-7 sm:mb-9"
              style={{ color: "var(--edge-ink)" }}
            >
              {isLive ? (
                <>
                  Your agent
                  <br />
                  is live.
                </>
              ) : (
                <>
                  Claim your
                  <br />
                  agent.
                </>
              )}
            </h1>

            {/* Body — adapts to user state */}
            {isLive ? (
              <p
                className="text-[17px] sm:text-[19px] leading-[1.55] max-w-[40ch] mb-10 sm:mb-12"
                style={{ color: "var(--edge-ink-soft)" }}
              >
                Already claimed. Message it any time, or check the dashboard
                for memory, settings, and what it&apos;s been up to.
              </p>
            ) : (
              <p
                className="text-[17px] sm:text-[19px] leading-[1.55] max-w-[36ch] mb-10 sm:mb-12"
                style={{ color: "var(--edge-ink-soft)" }}
              >
                Your personal agent for the 28-day village.{" "}
                <span style={{ color: "var(--edge-ink)" }}>
                  One Telegram message every morning.
                </span>{" "}
                Yours for the full village.
              </p>
            )}

            {/* The form — EdgeCityClient handles all 3 states */}
            <div className="max-w-md mb-7">
              <EdgeCityClient state={userState} />
            </div>

            {/* Consent — non-live only */}
            {!isLive && (
              <p
                className="text-[12px] leading-[1.55] mb-5 max-w-md"
                style={{ color: "var(--edge-ink-soft)" }}
              >
                By claiming you agree to participate in the EE26 research
                program.{" "}
                <Link
                  href="/edge/consent"
                  className="underline underline-offset-2"
                  style={{ color: "var(--edge-ink)" }}
                >
                  Read the consent brief.
                </Link>
              </p>
            )}

            {/* BYO branch — logged_out only (logged-in already lands on dashboard via tag) */}
            {userState.kind === "logged_out" && (
              <p
                className="text-[14px] leading-[1.55] mb-7 max-w-md"
                style={{ color: "var(--edge-ink-soft)" }}
              >
                Already have an InstaClaw agent?{" "}
                <Link
                  href="/signin?callbackUrl=%2Fapi%2Fpartner%2Ftag-redirect"
                  className="underline underline-offset-2 font-medium"
                  style={{ color: "var(--edge-ink)" }}
                >
                  Sign in to claim it for Edge →
                </Link>
              </p>
            )}

            {/* Trust band — single line per Cooper's directive */}
            {!isLive && (
              <div
                className="pt-5 mt-3 text-[11px] uppercase tracking-[0.16em] max-w-md"
                style={{
                  color: "var(--edge-ink-soft)",
                  borderTop: "1px solid var(--edge-line-soft)",
                }}
              >
                Free for verified ticket holders.
              </div>
            )}
          </div>
        </section>

        {/* ── Compact footer ── */}
        <footer
          className="relative z-10 px-4 sm:px-8 py-7 sm:py-8"
          style={{ borderTop: "1px solid var(--edge-line-soft)" }}
        >
          <div
            className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-[11px] uppercase tracking-[0.16em]"
            style={{ color: "var(--edge-ink-soft)" }}
          >
            <span>
              Edge Esmeralda · May 30 – Jun 27 · Powered by{" "}
              <Link
                href="/"
                className="underline-offset-4 hover:underline"
                style={{ color: "var(--edge-ink)" }}
              >
                InstaClaw
              </Link>
            </span>
            <Link
              href="/edge"
              className="underline-offset-4 hover:underline"
              style={{ color: "var(--edge-ink)" }}
            >
              ← Back to /edge
            </Link>
          </div>
        </footer>
      </main>
    </>
  );
}
