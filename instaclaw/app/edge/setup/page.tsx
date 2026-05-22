import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { createMetadata } from "@/lib/seo";
import { SetupClient } from "./setup-client";
import { SupportFooter } from "@/components/marketing/support-footer";

/**
 * /edge/setup — the Edge trial-terms interstitial.
 *
 * Sits between /edge/claim (ticket verification) and /connect (OAuth +
 * bot pairing). The trust moment of Edge onboarding: this is where the
 * attendee learns "your card is collected here; $0 today; $99/month
 * starting June 30 unless you cancel."
 *
 * Why this exists as its own page:
 *
 *  - Stripe Checkout collects the card transparently, but doesn't
 *    explain the timing of the first charge in plain language. Without
 *    this surface, the attendee meets the billing reality for the
 *    first time on the Stripe-hosted form, with no platform context.
 *  - Edge attendees are sponsor-funded for the village (May 30 – Jun
 *    27) but auto-billed three days after (June 30). That window
 *    deserves an explicit explanation, not buried in TOS.
 *  - The page is screenshottable — attendees frequently share what
 *    they signed up for in their group chat. Clear terms surface =
 *    less support burden = less reputational risk.
 *
 * Voice register: matches /edge/claim. Lowercase comfortable, declarative,
 * no exclamation marks, agent-first-person where natural. Source casing
 * is sentence case; CSS transforms the h1 to uppercase for display
 * (same pattern as /edge/claim's headline).
 *
 * Auth state: no gate. Anyone can hit this page. Logged-out users came
 * from /edge/claim's Continue button. Logged-in users hitting this URL
 * directly see the same content; their Continue still routes to /connect
 * which dispatches based on their actual state.
 *
 * Billing logic lives in app/api/billing/checkout/route.ts — that route
 * reads user.partner=edge_city and passes subscription_data.trial_end =
 * 1782802800 to Stripe. This page is the explainer; that route is the
 * mechanism.
 */

export const metadata = createMetadata({
  title: "Your Edge Esmeralda 2026 agent — trial terms",
  description:
    "$0 today. Your Edge Esmeralda agent is sponsor-funded for the 28-day village. If you keep your agent after the village ends, it's $99/month starting June 30, 2026.",
  path: "/edge/setup",
  ogTitle: "Your Edge Esmeralda 2026 agent — trial terms",
  ogImage: "/edge/og-edge.png",
});

export default function EdgeSetupPage() {
  return (
    <main className="relative min-h-screen flex flex-col">
      {/* Top bar — minimal: wordmark + date strip (matches /edge/claim) */}
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

      {/* Hero — client component owns the Continue button + animations */}
      <Suspense fallback={null}>
        <SetupClient />
      </Suspense>

      {/* Compact footer — matches /edge/claim */}
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
              href="/edge/claim"
              className="underline-offset-4 hover:underline"
              style={{ color: "var(--edge-ink)" }}
            >
              ← Back
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
