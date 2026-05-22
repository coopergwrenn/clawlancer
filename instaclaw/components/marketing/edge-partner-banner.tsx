"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Renders a sticky dark-olive strip at the top of pages reached from /edge.
 *
 * Detection: reads the `instaclaw_partner` cookie client-side. Only renders
 * when the cookie value is exactly `edge_city`. The cookie is set by /edge's
 * CTA (and by `/api/partner/tag` for logged-in users); SSR renders nothing
 * to avoid a hydration flash for the 99% of visitors who didn't come from a
 * partner portal.
 *
 * Purpose: closes the brand seam between /edge and the auth/onboarding flow.
 * Without this banner, a user clicking "Claim your agent" on /edge lands on
 * InstaClaw-orange /signup and wonders if they're in the right place.
 *
 * Adding more partners: extend `PARTNER_THEMES` below. Each partner is
 * fully self-contained — wordmark asset, label, and color palette. The
 * partner-tag helper (`lib/partner-tag.ts`) is the source of truth for
 * VALID_PARTNERS; this component should mirror that allow-list.
 */

type PartnerTheme = {
  bg: string;
  fg: string;
  fgMuted: string;
  wordmarkSrc: string;
  wordmarkAlt: string;
  copy: string;
  backHref: string;
};

const PARTNER_THEMES: Record<string, PartnerTheme> = {
  edge_city: {
    bg: "#29311E",
    fg: "#FAFAF7",
    fgMuted: "rgba(250, 250, 247, 0.65)",
    wordmarkSrc: "/edge/edge-esmeralda-wordmark.svg",
    wordmarkAlt: "Edge Esmeralda",
    copy: "Claiming your Edge Esmeralda agent. Sponsor-funded through June 30.",
    backHref: "/edge",
  },
};

function readPartnerCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)instaclaw_partner=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Returns the active `instaclaw_partner` cookie value, or null if no
 * partner cookie is set (or we haven't hydrated yet on the client).
 *
 * Pages embedding `<EdgePartnerBanner />` typically also call this hook to
 * conditionally swap heading copy or accent colors. The banner and consumer
 * read the same cookie independently — there's no shared context — but
 * because `document.cookie` is synchronous and stable, both effects resolve
 * in the same microtask and the UI hydrates consistently.
 */
export function usePartnerCookie(): string | null {
  const [partner, setPartner] = useState<string | null>(null);
  useEffect(() => {
    setPartner(readPartnerCookie());
  }, []);
  return partner;
}

export function EdgePartnerBanner() {
  const [theme, setTheme] = useState<PartnerTheme | null>(null);

  useEffect(() => {
    const partner = readPartnerCookie();
    if (partner && PARTNER_THEMES[partner]) {
      setTheme(PARTNER_THEMES[partner]);
    }
  }, []);

  if (!theme) return null;

  return (
    <div
      role="region"
      aria-label="Partner context"
      className="w-full"
      style={{
        background: theme.bg,
        color: theme.fg,
        borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
      }}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-4">
        {/* Edge wordmark — small, publication-mast feel */}
        <img
          src={theme.wordmarkSrc}
          alt={theme.wordmarkAlt}
          className="h-5 sm:h-6 w-auto shrink-0"
          style={{
            // Edge wordmark ships as a dark-on-light SVG. Invert so it reads
            // on the olive bar without re-exporting the asset.
            filter: "invert(1) brightness(1.05)",
          }}
        />

        {/* Copy — center-aligned on mobile (wordmark + copy stack), left on desktop */}
        <p
          className="flex-1 text-[11px] sm:text-xs font-medium tracking-[0.06em] uppercase"
          style={{ color: theme.fg }}
        >
          <span className="hidden sm:inline">{theme.copy}</span>
          {/* Mobile: shorter copy keeps it on one line at 375px */}
          <span className="sm:hidden">Claiming your Edge agent</span>
        </p>

        {/* Back to /edge — discrete escape hatch for users who landed here by mistake */}
        <Link
          href={theme.backHref}
          className="text-[11px] sm:text-xs font-medium tracking-[0.06em] uppercase shrink-0 transition-opacity hover:opacity-100"
          style={{ color: theme.fgMuted }}
        >
          ← Back
        </Link>
      </div>
    </div>
  );
}
