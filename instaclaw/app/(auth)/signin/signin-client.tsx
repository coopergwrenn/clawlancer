"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { ChatGPTConnectModal } from "@/components/dashboard/chatgpt-connect-modal";
import { EdgePartnerBanner } from "@/components/marketing/edge-partner-banner";

// Brand constants — copied from /channels to keep the two pages
// visually paired. /channels is the design-language reference for the
// entire onboarding funnel (2026-05 polish pass). If these values
// change there, change here too.
const CORAL = "#E96F4D";
const CREAM_BG = "#f8f7f4";
const CARD_INK = "#333334";
const MUTED_INK = "#6b6b6b";
const SUBTLE_INK = "#9a9892";

/**
 * /signin client view.
 *
 * Receives `callbackUrl` as a prop from the server component wrapper.
 * The wrapper parses + validates ?callbackUrl=, checks the NextAuth
 * session, and redirects authenticated users to callbackUrl BEFORE
 * this component ever renders. By the time we mount, we know:
 *
 *   - User is NOT authenticated (server redirected if they were)
 *   - callbackUrl is safe (relative path, not /signin itself)
 *
 * No useSearchParams here; no Suspense boundary needed. The previous
 * client-only implementation used useSearchParams + Suspense; W5
 * (2026-05-22 audit fix) moved the session check + URL parsing to
 * the server, which also dropped the suspended-on-mount flicker.
 */
export function SignInClient({ callbackUrl }: { callbackUrl: string }) {
  // ChatGPT-as-signin opens the device-code modal in signup mode. The
  // modal handles the full polling + identity-resolution + signIn() flow
  // (chatgpt-connect-modal.tsx + lib/openai-signup-*). On success the
  // modal calls signIn("openai-device-code", {signupToken, callbackUrl})
  // which establishes a NextAuth session via the Credentials provider
  // and redirects to callbackUrl.
  const [chatgptModalOpen, setChatgptModalOpen] = useState(false);

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        color: CARD_INK,
        /* Warm-sand atmosphere — verbatim from /channels (lines 58-64
         * of channels-client.tsx). Layered radial gradients (coral 18%
         * top / blue 14% bottom-left / faint green 8% top-right) over
         * the cream linear base. Establishes the funnel's identity
         * before the user reads a word. Pairs /signin visually with
         * /channels so the OAuth bounce mid-skip-flow doesn't feel
         * like a context switch. */
        background: `
          radial-gradient(1200px 700px at 50% -10%, rgba(233, 111, 77, 0.18), transparent 65%),
          radial-gradient(900px 600px at 8% 95%, rgba(34, 158, 217, 0.14), transparent 70%),
          radial-gradient(700px 500px at 95% 25%, rgba(31, 173, 62, 0.08), transparent 75%),
          linear-gradient(180deg, #f5f3ee 0%, #f8f7f4 60%, #f9f7f2 100%),
          ${CREAM_BG}
        `,
      }}
    >
      {/* EdgePartnerBanner. Closes the brand seam between /edge/setup
          (olive Edge palette) and /signin. Renders nothing for non-Edge
          visitors (no partner cookie) — invisible to 99% of /signin
          traffic and load-bearing for the 1% who came through Edge. */}
      <EdgePartnerBanner />

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        {/* Vertical hierarchy is deliberate. space-y-12 (48px) puts
            breathing room between the four major sections (wordmark,
            heading, OAuth, footer trio) so the eye rests between
            decisions. Within each section the gap is tighter — see
            inner space-y values. Spacious even on mobile. */}
        <div className="w-full max-w-md space-y-12">
        {/* Logo */}
        <Link href="/" className="flex items-center justify-center gap-2">
          <Image src="/logo.png" alt="Instaclaw" width={40} height={40} unoptimized style={{ imageRendering: "pixelated" }} />
          <span
            className="text-2xl tracking-[-0.5px]"
            style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
          >
            Instaclaw
          </span>
        </Link>

        {/* Heading + subtitle. Voice mirrors /channels exactly: lowercase,
            sentence case, period at end. The subtitle's two-beat
            ("welcome back. or come in for the first time.") covers both
            sign-in and signup intents without making either feel like
            the secondary option. Typography spec is copied verbatim
            from /channels' "pick a channel." headline (serif clamp,
            line-height 1.0, letter-spacing -1.8px) so the two pages
            feel like spread pages of one book rather than separate
            screens. */}
        <div className="text-center space-y-4">
          <h1
            className="font-normal"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "clamp(44px, 12vw, 60px)",
              lineHeight: 1.0,
              letterSpacing: "-1.8px",
              color: CARD_INK,
            }}
          >
            sign in.
          </h1>
          <p
            className="mx-auto"
            style={{
              fontSize: 17,
              lineHeight: 1.5,
              color: MUTED_INK,
              maxWidth: 380,
            }}
          >
            welcome back. or come in for the first time.
          </p>
        </div>

        {/* Auth choices. Google and ChatGPT are equal-weight options.
            Outlined glass pills (not flat white rectangles) — translucent
            white at 35% over the cream-gradient gives a frosted look
            that catches the coral/blue/green ambient layers underneath
            without dimming them. backdrop-blur-md (12px) is the same
            blur depth /channels uses on its disclosure pills, so the
            glass material feels consistent across the funnel. Border
            is a 6%-black hairline (softer than the 10% from v1 — too
            dark against cream) and the inset top-highlight shadow
            (255/255/255 at 0.5, 1px) gives each pill a subtle convex
            curl like light catching the top of a glass bead. Hover
            preserves the inset highlight AND adds a 5px coral ring —
            warmth gathering on a cold-glass surface rather than
            replacing it. Tailwind's hover:shadow REPLACES the base
            box-shadow, so the inset highlight is bundled into the
            hover shadow's value to avoid losing it. active:scale-[0.98]
            keeps press feedback. Brand icons retain canonical colors. */}
        <div className="space-y-3">
          {/* Google sign-in */}
          <button
            onClick={() => signIn("google", { callbackUrl })}
            className="w-full px-6 py-4 rounded-full text-base font-medium transition-all duration-200 cursor-pointer flex items-center justify-center gap-3 border border-black/[0.06] bg-white/35 backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] hover:border-[#E96F4D] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_0_0_5px_rgba(233,111,77,0.07)] active:scale-[0.98]"
            style={{ color: CARD_INK }}
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" aria-hidden>
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.10z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            sign in with Google
          </button>

          {/* ChatGPT sign-in + Plus nudge bundled as one logical unit.
              The outer space-y-3 (12px) applies between the Google
              pill and this <div>; inside the unit the nudge sits 8px
              (mt-2) below the button so it feels attached to the
              ChatGPT path rather than as a third equal option. */}
          <div>
            <button
              onClick={() => setChatgptModalOpen(true)}
              className="w-full px-6 py-4 rounded-full text-base font-medium transition-all duration-200 cursor-pointer flex items-center justify-center gap-3 border border-black/[0.06] bg-white/35 backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] hover:border-[#E96F4D] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_0_0_5px_rgba(233,111,77,0.07)] active:scale-[0.98]"
              style={{ color: CARD_INK }}
            >
              <Sparkles className="w-5 h-5" style={{ color: "#10a37f" }} aria-hidden />
              sign in with ChatGPT
            </button>
            {/* ChatGPT Plus nudge. Informational, no link — just a
                gentle aside for the audience who already pays $20/mo
                for ChatGPT Plus and qualifies for a lower Instaclaw
                plan price under BYOK billing. Voice mirrors /channels'
                question-then-benefit shape ("prefer the web?", "have
                an invite code?"): the rhetorical question primes
                self-identification; the comma-period rhythm lands the
                benefit. 12px subtle-ink — one step quieter than the
                13px footer footnotes below, so this reads as a
                button-aside rather than a third action. */}
            <p
              className="mt-2 text-center"
              style={{ fontSize: 12, color: SUBTLE_INK, lineHeight: 1.4 }}
            >
              have ChatGPT Plus? get a lower plan price.
            </p>
          </div>
        </div>

        {/* Invite + support footers, paired as one unit. Both mirror
            /channels' footnote zone exactly: 13px subtle-ink, lowercase,
            single inline link in muted-ink underlined. Wrapped in a
            space-y-2 div so they share consistent 8px internal spacing
            and ONE 48px gap above (from the outer space-y-12) rather
            than two competing margin sources. Reads as a paired
            escape-hatch (broader option first — invite code — then
            narrower — help). Replaces the SupportFooter component
            inline because Cooper-voice on this page means lowercase
            ("need help?") while SupportFooter ships the legacy
            Title-case copy used by 5 other surfaces; flipping the
            shared component would cascade visual changes we don't
            want today. */}
        <div className="space-y-2">
          <p
            className="text-center"
            style={{ fontSize: 13, color: SUBTLE_INK, lineHeight: 1.5 }}
          >
            have an invite code?{" "}
            <Link
              href="/signup"
              className="transition-opacity hover:opacity-70"
              style={{
                color: MUTED_INK,
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              use it here
            </Link>
            .
          </p>
          <p
            className="text-center"
            style={{ fontSize: 13, color: SUBTLE_INK, lineHeight: 1.5 }}
          >
            need help?{" "}
            <a
              href="mailto:help@instaclaw.io"
              className="transition-opacity hover:opacity-70"
              style={{
                color: MUTED_INK,
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              help@instaclaw.io
            </a>
          </p>
        </div>
        </div>
      </div>

      {/* ChatGPT signup-mode modal. Mounted at this level so it can
          render over the entire /signin viewport (its own backdrop +
          focus trap handle modal etiquette). Closed initially; opened
          by the ChatGPT button above. */}
      <ChatGPTConnectModal
        isOpen={chatgptModalOpen}
        onClose={() => setChatgptModalOpen(false)}
        mode="signup"
        signupCallbackUrl={callbackUrl}
      />
    </div>
  );
}
