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
  // Capture the description the user typed on any failed submit so the
  // escape-hatch skip endpoint can queue it for back-fill. Persisted in
  // component state (not localStorage) — the IntentForm is mounted in
  // the parent's "initial" branch, so the state survives as long as the
  // user is on this page.
  const [queuedDescription, setQueuedDescription] = useState<string>("");
  const [skipping, setSkipping] = useState(false);

  function handleSubmitted() {
    setGateState({ kind: "submitted" });
  }

  /**
   * Reveal the escape-hatch panel for ANY failure that means the user
   * cannot complete the intent submission right now — not just the
   * narrow "service_unavailable" case shipped originally. 2026-05-22
   * Cooper hit Index Network /signup returning 403 Forbidden (Yanek-
   * side outage). The express-intent route's JIT-provision path catches
   * the 403 and returns `not_eligible` (matched downstream by
   * `mapCreateIntentResultToResponse`). Pre-fix, "not_eligible" did NOT
   * trigger the escape hatch — the user saw a hard error with no way out.
   *
   * Now: every non-rate-limit failure reveals the escape hatch. Hard
   * rate-limited responses still surface the form-internal error UI
   * (the user retries in a few minutes; the gate doesn't need lifting).
   */
  function handleError(errorStatus: string, description: string) {
    setQueuedDescription(description);
    const escapeHatchStatuses = [
      "service_unavailable",
      "not_eligible",
      "error",
      "network",
      "server_error",
    ];
    if (escapeHatchStatuses.includes(errorStatus)) {
      setServiceUnavailable(true);
    }
    // For "rate_limited" + "validation_error" we deliberately do NOT
    // show the escape hatch — those are user-actionable, not API-down.
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
  /**
   * Server-side skip: queue the user's intent text (if any) for back-fill,
   * mark `index_last_intent_at` so the dashboard layout's gate lets them
   * through to /dashboard. Replaces the prior localStorage-only escape
   * hatch — that gave a 30-min grace but left the user's text on the
   * floor and pinned the gate-skip to one specific browser.
   *
   * 2026-05-22 Cooper hotfix: when Index Network /signup returns 403,
   * the user should never be hard-blocked from /dashboard. The intent
   * text they typed gets persisted via structured logger.info in the
   * skip endpoint (greppable for replay when Index is restored). The
   * gate write means the user can navigate freely afterward — no
   * 30-min cliff, no per-browser pinning.
   *
   * Localstorage write is preserved as a belt-and-suspenders safety —
   * if the API call fails for any reason (network blip on top of the
   * Index outage), the existing 30-min grace still applies.
   */
  async function handleContinueDegraded() {
    setSkipping(true);
    // Fire-and-await the skip endpoint. We want the DB write to land
    // before the redirect — otherwise the dashboard layout would see
    // index_last_intent_at=null and bounce the user right back to
    // /edge/intents.
    try {
      await fetch("/api/edge/intents/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: queuedDescription,
          reason: "index_network_degraded",
        }),
      });
    } catch {
      // Network blip on the skip endpoint itself. Fall through — the
      // localStorage grace below still gives 30 min of access. The
      // user lands on /dashboard either way.
    }
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem("edge_intent_skipped_at", Date.now().toString());
      } catch {
        // Same private-browsing/quota tolerance as before.
      }
    }
    setSkipping(false);
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
                  Intent registration is briefly unavailable. We&apos;ve saved
                  what you wrote and will queue it as soon as the matching
                  service comes back online. Continue to your dashboard —
                  nothing else is blocked.
                </p>
                <button
                  type="button"
                  onClick={handleContinueDegraded}
                  disabled={skipping}
                  aria-busy={skipping}
                  className="mt-4 px-5 py-2.5 rounded-full text-[12px] uppercase tracking-[0.14em] font-medium transition-colors hover:bg-[var(--edge-olive-hover)] inline-flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
                  style={{
                    background: "var(--edge-olive)",
                    color: "#FFFFFF",
                    letterSpacing: "0.12em",
                  }}
                >
                  {skipping ? (
                    <>Saving…</>
                  ) : (
                    <>
                      Continue to dashboard <span aria-hidden>→</span>
                    </>
                  )}
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
