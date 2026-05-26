"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { ChatGPTConnectModal } from "@/components/dashboard/chatgpt-connect-modal";

/**
 * /auth client view — the OAuth picker for channel-onboarding users.
 *
 * Design intent (per docs/prd/onboarding-redesign-2026-05-26.md §14
 * "The design quality bar"):
 *
 *   - Agent-voice headline: lowercase, period-terminated, serif.
 *     "let's get you set up." continues the v122 voice that brought
 *     the user here (Welcome 1+2+3 → "i genuinely cannot wait to meet
 *     you" → arrive at /auth → "let's get you set up.").
 *
 *   - Primary action: ChatGPT card. Coral accent. Larger visual weight.
 *     Two-line subtitle covers the two ChatGPT differentiators:
 *     cost benefit (BYOK routes through user's plan) + instant context
 *     (knows their preferences from chat history).
 *
 *   - Secondary action: Google card. No coral. Smaller. Same shape so
 *     the choice feels equal-effort, just visually subordinated.
 *
 *   - One primary action per screen — coral lives ONLY on the ChatGPT
 *     card's accent line + arrow. Nothing else competes.
 *
 *   - Glass design: cards have backdrop-blur, gentle inner highlight,
 *     soft outer shadow. Feel: lifted off the cream background, not
 *     stamped onto it.
 *
 *   - Mobile-first: layout works on iPhone 12 mini (375px viewport)
 *     without horizontal scroll. All gaps + padding tested at that
 *     width.
 *
 *   - No spinner. The ChatGPT card transforms (opens modal) and the
 *     Google card hands off to NextAuth's own redirect — neither
 *     needs a "Loading..." state on this page.
 */

const CORAL = "#E96F4D";
const CREAM_BG = "#f8f7f4";
const CARD_INK = "#333334";
const MUTED_INK = "#6b6b6b";
const SUBTLE_INK = "#9a9892";
const CARD_BORDER = "rgba(51, 51, 52, 0.08)";

interface AuthClientProps {
  /** pending_users.id from the /go/:code redirect. Preserved on
   *  callback URL so the server component picks it up post-OAuth. */
  sessionId: string | null;
}

export function AuthClient({ sessionId }: AuthClientProps) {
  const [chatgptModalOpen, setChatgptModalOpen] = useState(false);

  // Post-OAuth, both providers route back here with the same session
  // id. The server component re-runs, sees an active session, binds
  // the pending row, fires VM assignment, and redirects to /plan or
  // /onboarding/done. The callbackUrl is the SAME for both providers.
  const callbackUrl = sessionId
    ? `/auth?session=${encodeURIComponent(sessionId)}`
    : "/dashboard";

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background: CREAM_BG,
        color: CARD_INK,
      }}
    >
      <main className="flex-1 flex flex-col items-center justify-center px-5 py-12">
        <div className="w-full" style={{ maxWidth: 420 }}>
          {/* Wordmark — small, top-left positioned via flex-start of
              this column. Coral so the brand cue is the SAME color
              as the primary CTA accent; reinforces "this product
              has one voice." */}
          <Link
            href="/"
            className="inline-block mb-12"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 22,
              letterSpacing: "-0.5px",
              color: CORAL,
              textDecoration: "none",
            }}
          >
            instaclaw
          </Link>

          {/* Agent-voice headline. Lowercase, period-terminated, serif.
              Continues the welcome-burst voice the user just experienced. */}
          <h1
            className="font-normal mb-3"
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: "clamp(34px, 9vw, 44px)",
              lineHeight: 1.05,
              letterSpacing: "-1px",
              color: CARD_INK,
            }}
          >
            let&apos;s get you set up.
          </h1>

          {/* Subtitle — short, declarative. Tells them what's after this. */}
          <p
            className="mb-10"
            style={{
              fontSize: 16,
              lineHeight: 1.45,
              color: MUTED_INK,
            }}
          >
            just one step, then back to messages.
          </p>

          {/* PRIMARY: ChatGPT card. Coral left-edge accent. Larger
              padding. Two-line subtitle covers both differentiators. */}
          <button
            type="button"
            onClick={() => setChatgptModalOpen(true)}
            className="group relative w-full text-left rounded-2xl mb-3 transition-all duration-150 ease-out active:scale-[0.995] cursor-pointer"
            style={{
              background: "rgba(255, 255, 255, 0.85)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              border: `1px solid ${CARD_BORDER}`,
              boxShadow: `inset 0 1px 0 rgba(255, 255, 255, 0.6), 0 1px 2px rgba(51, 51, 52, 0.04), 0 4px 12px rgba(51, 51, 52, 0.04)`,
              padding: "22px 24px 22px 28px",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = `inset 0 1px 0 rgba(255, 255, 255, 0.6), 0 1px 2px rgba(51, 51, 52, 0.06), 0 8px 24px rgba(233, 111, 77, 0.10)`;
              e.currentTarget.style.transform = "translateY(-1px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = `inset 0 1px 0 rgba(255, 255, 255, 0.6), 0 1px 2px rgba(51, 51, 52, 0.04), 0 4px 12px rgba(51, 51, 52, 0.04)`;
              e.currentTarget.style.transform = "translateY(0)";
            }}
          >
            {/* Coral left accent — 3px bar inset from the card edge.
                The only coral on the secondary card is absent, which
                is what makes THIS card primary. */}
            <span
              aria-hidden
              className="absolute left-0 top-4 bottom-4 rounded-full"
              style={{ width: 3, background: CORAL }}
            />

            <div className="flex items-start gap-4">
              <Sparkles
                className="shrink-0 mt-0.5"
                style={{ width: 22, height: 22, color: CORAL }}
              />
              <div className="flex-1 min-w-0">
                <div
                  className="font-normal mb-1.5"
                  style={{
                    fontFamily: "var(--font-serif)",
                    fontSize: 20,
                    letterSpacing: "-0.3px",
                    color: CARD_INK,
                  }}
                >
                  continue with ChatGPT
                </div>
                <div
                  style={{
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: MUTED_INK,
                  }}
                >
                  uses your plan. costs less. knows you already.
                </div>
              </div>

              {/* Arrow — coral, indicates primary action. Subtle
                  motion: nudges right on hover via group-hover. */}
              <span
                aria-hidden
                className="shrink-0 transition-transform duration-150 ease-out group-hover:translate-x-0.5"
                style={{
                  fontSize: 18,
                  color: CORAL,
                  marginTop: 2,
                }}
              >
                →
              </span>
            </div>
          </button>

          {/* SECONDARY: Google card. Same shape, smaller, no coral,
              quieter typography. Equal-effort to tap, visually
              subordinated. */}
          <button
            type="button"
            onClick={() => signIn("google", { callbackUrl })}
            className="group w-full text-left rounded-2xl transition-all duration-150 ease-out active:scale-[0.995] cursor-pointer"
            style={{
              background: "rgba(255, 255, 255, 0.7)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
              border: `1px solid ${CARD_BORDER}`,
              boxShadow: `inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 1px 2px rgba(51, 51, 52, 0.03)`,
              padding: "18px 24px",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.9)";
              e.currentTarget.style.transform = "translateY(-1px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.7)";
              e.currentTarget.style.transform = "translateY(0)";
            }}
          >
            <div className="flex items-center gap-3">
              <svg
                className="shrink-0"
                style={{ width: 20, height: 20 }}
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.10z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              <span
                className="flex-1"
                style={{
                  fontSize: 15,
                  color: CARD_INK,
                }}
              >
                or continue with Google
              </span>
              <span
                aria-hidden
                className="shrink-0 transition-transform duration-150 ease-out group-hover:translate-x-0.5"
                style={{
                  fontSize: 15,
                  color: SUBTLE_INK,
                }}
              >
                →
              </span>
            </div>
          </button>

          {/* Footer copy — tiny, agent-voice tone. Tells the user this
              is private (no privacy modal flash). */}
          <p
            className="mt-10 text-center"
            style={{
              fontSize: 12,
              color: SUBTLE_INK,
              lineHeight: 1.5,
            }}
          >
            by signing in you agree to our{" "}
            <Link
              href="/terms"
              style={{ color: MUTED_INK, textDecoration: "underline", textUnderlineOffset: 2 }}
            >
              terms
            </Link>{" "}
            and{" "}
            <Link
              href="/privacy"
              style={{ color: MUTED_INK, textDecoration: "underline", textUnderlineOffset: 2 }}
            >
              privacy
            </Link>
            .
          </p>
        </div>
      </main>

      {/* ChatGPT device-code modal. Same component /signin uses —
          reusing maximizes the chance the existing OAuth flow works
          end-to-end without surprises. The modal handles the full
          polling + signIn() sequence; on success it routes to
          callbackUrl (our /auth?session=<id>), which re-runs the
          server component above. */}
      <ChatGPTConnectModal
        isOpen={chatgptModalOpen}
        onClose={() => setChatgptModalOpen(false)}
        mode="signup"
        signupCallbackUrl={callbackUrl}
      />
    </div>
  );
}
