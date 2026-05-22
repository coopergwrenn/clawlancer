import Link from "next/link";
import { createMetadata } from "@/lib/seo";
import { JsonLd } from "@/components/marketing/json-ld";
import { EdgeCityClient } from "./edge-city-client";
import { getEdgeUserState } from "./edge-user-state";
import { deriveHeaderCta } from "./header-cta";
import { SkyBackdrop } from "./components/sky-backdrop";
import { Nav } from "./components/nav";
import { HealdsburgMap } from "./components/healdsburg-map";
import { MapHeroOverlay } from "./components/map-hero-overlay";
import { HowItWorks } from "./components/how-it-works";
import { Features } from "./components/features";
import { PlazaSection } from "./components/plaza-section";
import { Research } from "./components/research";
import { TechPartners } from "./components/tech-partners";
import { Faq } from "./components/faq";
import { Claim } from "./components/claim";
import { Footer } from "./components/footer";

export const metadata = createMetadata({
  title: "Your personal Edge Esmeralda 2026 agent",
  description:
    "Every Edge Esmeralda 2026 attendee gets a personal AI agent for the 28-day village. Tell it what you're here for, and it finds the right people across the village while you stay present.",
  path: "/edge",
  ogTitle: "Your personal Edge Esmeralda 2026 agent",
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

// Hero overlay CTA — matches the edgeclaw-site design (single cream pill).
// Shape is derived from SSR-resolved userState; live users get a Telegram
// deep-link, in-progress get a "complete setup" pill, logged out get the
// "set up your agent" anchor down to the Claim form.
function HeroCta({
  href,
  label,
  external,
}: {
  href: string;
  label: string;
  external: boolean;
}) {
  const className =
    "inline-flex items-center gap-2.5 px-7 py-3.5 rounded-full text-sm font-bold uppercase whitespace-nowrap transition-colors";
  const style = {
    background: "var(--cream)",
    color: "var(--edge-ink)",
    border: "1px solid var(--cream)",
    letterSpacing: "0.06em",
  } as React.CSSProperties;

  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        style={style}
      >
        {label} <span aria-hidden>→</span>
      </a>
    );
  }
  return (
    <Link href={href} className={className} style={style}>
      {label} <span aria-hidden>→</span>
    </Link>
  );
}

export default async function EdgePage() {
  // Real Supabase-backed user-state lookup (see app/edge/edge-user-state.ts).
  // Returns one of three shapes: logged_out / in_progress / live. Drives
  // every CTA on the page so the visitor sees the right next-step on first
  // paint. Per Rule 33, leans on VM state rather than session.onboardingComplete
  // alone, because that flag can lag VM state by minutes on partial commits.
  const userState = await getEdgeUserState();
  const headerCta = deriveHeaderCta(userState);

  return (
    <>
      <JsonLd data={eventJsonLd} />
      <SkyBackdrop />

      <Nav
        ctaHref={headerCta.href}
        ctaLabel={headerCta.label}
        ctaExternal={headerCta.external}
      />

      <HealdsburgMap>
        <MapHeroOverlay
          userState={userState}
          cta={
            <HeroCta
              href={headerCta.href}
              label={
                userState.kind === "live"
                  ? "Open in Telegram"
                  : headerCta.label
              }
              external={headerCta.external}
            />
          }
        />
      </HealdsburgMap>

      <HowItWorks />
      <Features />
      <PlazaSection />
      <Research />
      <TechPartners />
      <Faq />

      {/* Claim section — full EdgeCityClient form widget lives here so the
          three user-state shapes (logged_out / in_progress / live) still
          drive the right CTA at the bottom of the page. */}
      <Claim ctaSlot={<EdgeCityClient state={userState} />} />

      <Footer />
    </>
  );
}
