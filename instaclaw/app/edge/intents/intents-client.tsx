"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IntentForm } from "../dashboard/intent-form";

/**
 * /edge/intents state machine — final-step onboarding gate.
 *
 * Two states: "initial" (form rendered) and "submitted" (page restructures
 * for the reveal moment). The shared IntentForm delegates its success UI
 * to us via `onSuccess`, so the form unmounts cleanly before its internal
 * "Sent" state ever renders — one visible animation, no double-step.
 *
 * Service-degradation escape hatch: if IntentForm reports a backend
 * `service_unavailable` (Yanek's create_intent MCP write-tool bug, per
 * /api/edge/express-intent's mapCreateIntentResultToResponse), we reveal
 * a soft "Continue to your dashboard" link. The gate temporarily lifts.
 * The dashboard's adaptive section (FUP-3b) will re-prompt them. Rationale:
 * a brief partner-API outage shouldn't permanently lock 500 attendees out
 * of their already-provisioned agents.
 *
 * Animations: same `gate-fade-rise` (600ms) for the page-level reveal +
 * `gate-continue-slide` (500ms with 400ms delay) for the Continue button
 * as /edge/claim's verified state. Keeps the onboarding aesthetic
 * coherent — same rhythm, same easing, same anticipation beats.
 */

type GateState =
  | { kind: "initial" }
  | { kind: "submitted" };

export function IntentsClient() {
  const router = useRouter();
  const [gateState, setGateState] = useState<GateState>({ kind: "initial" });
  const [serviceUnavailable, setServiceUnavailable] = useState(false);

  function handleSubmitted() {
    setGateState({ kind: "submitted" });
  }

  function handleError(errorStatus: string) {
    if (errorStatus === "service_unavailable") {
      setServiceUnavailable(true);
    }
  }

  function handleContinue() {
    router.push("/dashboard");
  }

  // Service-degradation escape: when Yanek's MCP is down, we let the user
  // through to /dashboard, but the dashboard layout's intent gate would
  // immediately bounce them back here in an infinite loop. Solution: a
  // localStorage flag with a 30-minute TTL that the dashboard layout
  // honors. After 30 minutes the gate re-fires (giving MCP time to recover
  // and the user a chance to actually submit). The flag is intentionally
  // ephemeral — a permanent skip would mean some users never seed an
  // intent into the matching network, which is the whole point of the
  // gate. Localstorage (not cookie) because this is purely a client-side
  // UX concern; the DB state (index_last_intent_at) stays the source of
  // truth.
  function handleContinueDegraded() {
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("edge_intent_skipped_at", Date.now().toString());
      } catch {
        // Localstorage can fail in private-browsing or quota-exceeded
        // modes. Acceptable: the user just won't have the 30-min grace
        // and will be re-redirected to this page immediately. Not great
        // UX in that edge case but not a security or data issue.
      }
    }
    router.push("/dashboard");
  }

  const isSubmitted = gateState.kind === "submitted";

  return (
    <section className="relative z-10 flex-1 px-4 sm:px-8 pt-12 sm:pt-20 pb-16 sm:pb-24">
      <div className="max-w-[680px] mx-auto">
        {/* ─── Eyebrow ticker — morphs ● READY → ✓ SENT ─── */}
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-[0.18em] mb-8 sm:mb-10 reveal-anim"
          style={{ color: "var(--edge-ink-soft)" }}
          key={isSubmitted ? "ticker-submitted" : "ticker-initial"}
        >
          {isSubmitted ? (
            <span style={{ color: "var(--edge-olive)" }}>
              ✓ Sent · Edge Esmeralda 2026
            </span>
          ) : (
            <span style={{ color: "var(--edge-olive)" }}>
              ● Ready · Edge Esmeralda 2026
            </span>
          )}
        </div>

        {/* ─── Headline — morphs ─── */}
        <h1
          className="font-bold uppercase tracking-[-0.02em] leading-[0.92] text-[clamp(44px,11vw,96px)] mb-7 sm:mb-9 reveal-anim"
          style={{ color: "var(--edge-ink)" }}
          key={isSubmitted ? "h1-submitted" : "h1-initial"}
        >
          {isSubmitted ? (
            <>
              Your agent
              <br />
              knows.
            </>
          ) : (
            <>
              Tell your
              <br />
              agent.
            </>
          )}
        </h1>

        {/* ─── Body — morphs ─── */}
        <p
          className="text-[17px] sm:text-[19px] leading-[1.55] max-w-[42ch] mb-10 sm:mb-12 reveal-anim"
          style={{ color: "var(--edge-ink-soft)" }}
          key={isSubmitted ? "body-submitted" : "body-initial"}
        >
          {isSubmitted ? (
            <>
              It&apos;s listening for overlaps now. The first matches land in
              your dashboard overnight.
            </>
          ) : (
            <>
              Your village agent just came online. It works overnight, finding
              people who overlap with you. To do that well, it needs to hear
              from you once.{" "}
              <span style={{ color: "var(--edge-ink)" }}>
                In your own words.
              </span>
            </>
          )}
        </p>

        {/* ─── Submitted reveal: Continue button ─── */}
        {isSubmitted ? (
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
              Open your dashboard <span aria-hidden>→</span>
            </button>
            <p
              className="continue-anim mt-5 text-[12px] leading-[1.6]"
              style={{ color: "var(--edge-ink-soft)" }}
            >
              You can update or add intents anytime from the dashboard.
            </p>
          </div>
        ) : (
          <>
            {/* ─── Initial: IntentForm (caller-owned success/error) ─── */}
            <div className="max-w-md mb-7">
              <IntentForm onSuccess={handleSubmitted} onError={handleError} />
            </div>

            {/* ─── Service-degradation escape hatch ─── */}
            {serviceUnavailable && (
              <div
                className="reveal-anim mb-7 max-w-md p-5 rounded-md"
                style={{
                  background: "var(--edge-sage)",
                  border: "1px solid var(--edge-line)",
                  color: "var(--edge-ink-soft)",
                }}
              >
                <p className="text-[13px] leading-[1.6]">
                  Intent registration is briefly unavailable. We&apos;re
                  working with the Index team to bring it back online. You can
                  continue to your dashboard and try again from there in a few
                  minutes.
                </p>
                <button
                  type="button"
                  onClick={handleContinueDegraded}
                  className="mt-4 px-5 py-2.5 rounded-full text-[12px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] inline-flex items-center gap-2"
                  style={{
                    background: "var(--edge-olive)",
                    color: "#FFFFFF",
                    letterSpacing: "0.12em",
                  }}
                >
                  Continue to dashboard <span aria-hidden>→</span>
                </button>
              </div>
            )}

            {/* ─── Footnote: dashboard pathway ─── */}
            <p
              className="text-[12px] leading-[1.55] mb-5 max-w-md"
              style={{ color: "var(--edge-ink-soft)" }}
            >
              You can update or add more intents anytime from your dashboard.
              The more specific you are, the better the matches.
            </p>

            {/* ─── Trust band — single line, matches /edge/claim ─── */}
            <div
              className="pt-5 mt-3 text-[11px] uppercase tracking-[0.16em] max-w-md"
              style={{
                color: "var(--edge-ink-soft)",
                borderTop: "1px solid var(--edge-line-soft)",
              }}
            >
              Last step before your dashboard.
            </div>
          </>
        )}
      </div>

      {/* Animations — same keyframes + timing as /edge/claim's verified reveal */}
      <style jsx>{`
        :global(.reveal-anim) {
          animation: gate-fade-rise 600ms cubic-bezier(0.16, 1, 0.3, 1) both;
        }
        :global(.continue-anim) {
          animation: gate-continue-slide 500ms cubic-bezier(0.16, 1, 0.3, 1)
            400ms both;
        }
        @keyframes gate-fade-rise {
          0% {
            opacity: 0;
            transform: translateY(8px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes gate-continue-slide {
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
