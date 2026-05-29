"use client";

import { useRouter } from "next/navigation";

/**
 * /edge/setup hero content.
 *
 * Single-state page (no state machine like /edge/claim). The verified
 * cookie was set on /edge/claim; we trust it and present the trial
 * terms. Continue routes to /connect — the existing OAuth + bot-pair
 * path. /connect handles both logged-out (forces sign-in) and logged-in
 * (proceeds to bot pairing).
 *
 * Why a client component: the Continue button uses router.push, and the
 * page uses scoped CSS keyframes via <style jsx>. Both require client
 * runtime. The content is otherwise static.
 *
 * Animation timing matches /edge/claim's verified reveal (gate-fade-rise
 * + gate-continue-slide). The Continue button is delayed 400ms after the
 * content fades in, so it feels earned rather than auto-presented.
 */
export function SetupClient() {
  const router = useRouter();

  function handleContinue() {
    // Route to /signin with callbackUrl=/plan.
    //
    // /signin shows both auth options (Google + ChatGPT). After
    // successful auth, NextAuth honors the callbackUrl and redirects
    // to /plan (Edge variant — sponsor framing, $0 today copy, olive
    // CTA). 2026-05-29 routing-bug fix: previously callbackUrl was
    // /connect (BYOB Telegram bot creation step). Cooper's new
    // onboarding flow makes /connect a power-user opt-in path only;
    // standard Edge flow goes /edge/claim → /signin → /plan directly.
    // Users who want their own Telegram bot still reach /connect via
    // the "use the legacy setup" footnote on /plan + /channels.
    //
    // The callbackUrl is read by /signin and forwarded to both the
    // Google signIn() call and the ChatGPT modal's signupCallbackUrl
    // prop, ensuring identical post-auth redirect behavior for both
    // providers.
    router.push("/signin?callbackUrl=/plan");
  }

  return (
    <section className="relative z-10 flex-1 px-4 sm:px-8 pt-12 sm:pt-20 pb-16 sm:pb-24">
      <div className="max-w-[680px] mx-auto">
        {/* ─── Eyebrow ─── */}
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-[0.18em] mb-8 sm:mb-10 reveal-anim"
          style={{ color: "var(--edge-ink-soft)" }}
        >
          <span style={{ color: "var(--edge-olive)" }}>
            ✓ Verified · Edge Esmeralda 2026
          </span>
          <span aria-hidden style={{ color: "var(--edge-ink-soft)" }}>
            ·
          </span>
          <span>Sponsored agent</span>
        </div>

        {/* ─── Headline ─── */}
        <h1
          className="font-bold uppercase tracking-[-0.02em] leading-[0.92] text-[clamp(44px,11vw,96px)] mb-7 sm:mb-9 reveal-anim"
          style={{ color: "var(--edge-ink)" }}
        >
          The village
          <br />
          covers you.
        </h1>

        {/* ─── Body ─── */}
        <p
          className="text-[17px] sm:text-[19px] leading-[1.55] max-w-[42ch] mb-5 sm:mb-6 reveal-anim"
          style={{ color: "var(--edge-ink-soft)" }}
        >
          Your agent is sponsor-funded for the 28-day village.{" "}
          <span style={{ color: "var(--edge-ink)" }}>$0 today.</span>
        </p>

        <p
          className="text-[17px] sm:text-[19px] leading-[1.55] max-w-[42ch] mb-7 sm:mb-8 reveal-anim"
          style={{ color: "var(--edge-ink-soft)" }}
        >
          If you keep your agent after the village ends, it&apos;s $99/month
          starting June 30. Cancel anytime, no questions.
        </p>

        {/* ─── Auth-choice label ─── */}
        {/*
         * Tells the user what happens when they click Continue: they'll
         * see two equal sign-in options on the next page. The wording
         * gives them agency ("your pick") rather than implying we've
         * pre-selected one — important per Cooper's "make it clear users
         * have a real choice" directive.
         *
         * Visual treatment: between the trust-receipt body and the
         * Continue button. Smaller than body (14px), same ink-soft as
         * fine print, BUT with no underline / no decoration — it's a
         * label, not an action. The actual choice happens on /signin.
         *
         * Why not in the body p1/p2: those paragraphs are billing-focused
         * (sponsorship, charge timing). Mixing auth detail with billing
         * detail dilutes both. Placement here keeps the auth fact close
         * to the Continue button it labels.
         */}
        <p
          className="text-[14px] leading-[1.5] max-w-[42ch] mb-10 sm:mb-12 reveal-anim"
          style={{ color: "var(--edge-ink-soft)" }}
        >
          Sign in with Google or ChatGPT. Your pick.
        </p>

        {/* ─── Continue ─── */}
        <div className="max-w-md">
          <button
            type="button"
            onClick={handleContinue}
            className="continue-anim w-full px-6 py-4 rounded-full text-[13px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] inline-flex items-center justify-center gap-2"
            style={{
              background: "var(--edge-olive)",
              color: "#FFFFFF",
              letterSpacing: "0.12em",
            }}
          >
            Continue <span aria-hidden>→</span>
          </button>

          {/* ─── Fine print — explicit billing recap ─── */}
          {/*
           * The trust receipt. Three concrete facts in plain language:
           *   1. When the card is collected (next step)
           *   2. What's charged today ($0)
           *   3. When the first real charge fires (June 30, 2026)
           * Plus the cancel-anytime escape hatch repeated for emphasis.
           *
           * This is the part attendees screenshot to show their friends
           * "see, it's actually free for the village." If anything in
           * the funnel ends up in a group chat, it's this paragraph —
           * it has to read as clearly to a stranger as to the signed-in
           * user.
           */}
          <p
            className="continue-anim mt-6 text-[12px] leading-[1.6]"
            style={{ color: "var(--edge-ink-soft)" }}
          >
            We collect your card at the next step.{" "}
            <span style={{ color: "var(--edge-ink)" }}>
              $0 is charged today.
            </span>{" "}
            First charge: June 30, 2026. Three days after the village ends.
            Cancel anytime from your dashboard.
          </p>
        </div>
      </div>

      {/* Animations — same keyframes + timing as /edge/claim verified reveal */}
      <style jsx>{`
        :global(.reveal-anim) {
          animation: setup-fade-rise 600ms cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        :global(.continue-anim) {
          animation: setup-continue-slide 500ms cubic-bezier(0.16, 1, 0.3, 1)
            400ms both;
        }
        @keyframes setup-fade-rise {
          0% {
            opacity: 0;
            transform: translateY(8px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes setup-continue-slide {
          0% {
            opacity: 0;
            transform: translateY(12px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </section>
  );
}
