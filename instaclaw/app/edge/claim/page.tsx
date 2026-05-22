import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { getEdgeUserState } from "../edge-user-state";
import { ClaimClient } from "./claim-client";
import { SupportFooter } from "@/components/marketing/support-footer";

/**
 * /edge/claim — the EdgeOS ticket-verification gate.
 *
 * Server component: fetches userState (Rule 33), renders page chrome,
 * mounts the client gate component for the verification state machine.
 *
 * The gate sits in front of the entire Edge Esmeralda 2026 onboarding
 * funnel. Email lookup against EdgeOS attendees directory → signed
 * cookie minted → user clicks Continue → /connect (or /dashboard for
 * already-logged-in users) → existing auth flow handles OAuth → signIn
 * callback writes `edge_verified_email` to the user row.
 *
 * Visual language: same Edge palette as /edge layer 1 (inherits from
 * /edge/layout.tsx). Mobile-first. Top bar minimal. Compact footer.
 * Hero content + state-aware reveal are owned by ClaimClient so the
 * "Reserved for the village." restructure can animate in place.
 */

export const metadata = createMetadata({
  title: "Claim your Edge Esmeralda 2026 agent",
  description:
    "Verify your Edge Esmeralda 2026 ticket to claim your personal AI agent for the 28-day village. Sponsor-funded through June 30.",
  path: "/edge/claim",
  ogTitle: "Claim your Edge Esmeralda 2026 agent",
  ogImage: "/edge/og-edge.png",
});

const eventJsonLd = {
  "@context": "https://schema.org",
  "@type": "Event",
  name: "Edge Esmeralda 2026 - Agent Village",
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
  const userState = await getEdgeUserState();

  return (
    <>
      <JsonLd data={eventJsonLd} />

      <main className="relative min-h-screen flex flex-col">
        {/* Top bar — minimal: wordmark + date strip */}
        <header
          className="relative z-10 px-4 sm:px-8 py-5 sm:py-6"
          style={{ borderBottom: "1px solid var(--edge-line-soft)" }}
        >
          <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
            <Link
              href="/edge"
              aria-label="Edge Esmeralda - back to landing"
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

        {/* Gate — client component owns headline, body, form, verified reveal */}
        <Suspense fallback={null}>
          <ClaimClient userState={userState} />
        </Suspense>

        {/* Compact footer */}
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
            <div className="flex items-center gap-4 sm:gap-5">
              <SupportFooter />
              <Link
                href="/edge"
                className="underline-offset-4 hover:underline"
                style={{ color: "var(--edge-ink)" }}
              >
                ← Back to /edge
              </Link>
            </div>
          </div>
        </footer>
      </main>
    </>
  );
}
