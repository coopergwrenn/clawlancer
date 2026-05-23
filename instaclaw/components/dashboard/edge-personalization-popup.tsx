"use client";

/**
 * /dashboard Edge personalization progress screen.
 *
 * The LAST moment of Edge onboarding before the user meets their agent
 * in Telegram. Replaces the generic Gmail-connect popup for
 * `partner === "edge_city"` users.
 *
 * DESIGN PHILOSOPHY
 * ─────────────────
 *
 * Edge cream + warm olive aesthetic — feels like a continuation of
 * /edge/claim → /edge/intents, not a generic dashboard overlay. Soft
 * pulse dots and ink-fade checks (no bouncy orbs — the deploying-page
 * orb language is for the orange InstaClaw brand; Edge is calmer).
 *
 * Per Cooper's design directive: this is the "apple unboxing" moment.
 * Beautiful by intent. Sequential reveal. Warm copy. Always reaches
 * the "your agent is ready" state, even when /citizens is down.
 *
 * GRACEFUL DEGRADATION LADDER
 * ───────────────────────────
 *
 * tier="full"     4 steps, ~4s — name + role + socials + intent ack
 * tier="partial"  3 steps, ~3s — name + (role OR social) + ready
 * tier="minimal"  2 steps, ~2s — generic village copy + ready
 *
 * Each step ≥800ms display time so the user feels something deliberate
 * happened, even when the API returns instantly.
 *
 * Steps adapt their copy based on whether /citizens data + intent
 * status are present:
 *   - Has role/org → step 2 reveals "Founder at Wild West Bots"
 *   - Has telegram → step 3 reveals "@cooperwrenn"
 *   - Has intent   → final step adds "we know what you're looking for"
 *   - Has neither  → generic copy that still feels personal
 *
 * COLOR SCOPING
 * ─────────────
 *
 * Modal renders on /dashboard which is NOT scoped to data-theme="edge".
 * We inject the Edge CSS variables locally on the modal wrapper (same
 * pattern ChatGPTConnectModal uses for its theme="edge" variant). Inner
 * styles reference var(--edge-*) and resolve to the cream/olive palette
 * within the modal's scope without polluting the dashboard.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";

interface EdgePersonalizationPopupProps {
  /** Mirrors `gmail_popup_dismissed` — the same DB flag gates both
   *  popups so a user who's seen ANY personalization screen doesn't
   *  see another one on next dashboard visit. */
  personalizationDismissed: boolean;
  /** Called after the modal auto-dismisses, lets the parent refetch
   *  VM status so dashboard renders with the latest state. */
  onComplete: () => void;
}

interface PersonalizationData {
  tier: "full" | "partial" | "minimal";
  firstName: string;
  fullName: string;
  role: string | null;
  organization: string | null;
  telegram: string | null;
  xUser: string | null;
  edgeIdentity: string;
  hasIntent: boolean;
}

type Phase = "loading" | "running" | "complete" | "dismissing";

// Each step ≥ 800ms minimum to feel deliberate (Cooper directive). The
// API runs in parallel with the animation; if it returns faster than
// the floor, we hold for the floor. If it returns slower, we wait
// (very rare — /citizens is sub-second typically).
const STEP_MIN_MS = 850;
// Hold the "ready" reveal a beat before fading so the user reads it.
const FINAL_HOLD_MS = 1200;
// Fade-out duration when dismissing.
const FADE_OUT_MS = 600;

// Edge palette — sourced from app/edge/layout.tsx. Scoped to the modal
// via cssVarOverrides so the dashboard's default theme stays untouched.
const EDGE_CSS_VARS: React.CSSProperties = {
  ["--edge-bg" as string]: "#f4ede0",
  ["--edge-ink" as string]: "#29311e",
  ["--edge-ink-soft" as string]: "rgba(26, 24, 20, 0.78)",
  ["--edge-olive" as string]: "#0f1a12",
  ["--edge-olive-hover" as string]: "#2d3f29",
  ["--edge-sage" as string]: "#dde5cc",
  ["--edge-sage-light" as string]: "#a8c0a1",
  ["--edge-line" as string]: "rgba(26, 24, 20, 0.18)",
  ["--edge-line-soft" as string]: "rgba(26, 24, 20, 0.08)",
};

interface Step {
  /** Pending copy — what the step says before it activates. */
  pending: string;
  /** Active copy — shown while the step is in progress. */
  active: string;
  /** Complete copy — shown after the step finishes. Receives the data
   *  payload so it can interpolate real values (name, role, etc). */
  complete: (data: PersonalizationData) => string;
}

/**
 * Build the step list adaptively based on the data tier + intent status.
 * Each step has pending / active / complete copy variants. The complete
 * variant interpolates real data so the user sees "Founder at Wild West
 * Bots" land as the check appears.
 */
function buildSteps(data: PersonalizationData | null): Step[] {
  // While data is loading, show a single generic "pulling profile" step.
  // It gets replaced once data lands.
  if (!data) {
    return [
      {
        pending: "pulling your profile from Edge City…",
        active: "pulling your profile from Edge City…",
        complete: () => "your profile is here.",
      },
    ];
  }

  const fullName = data.fullName;
  const firstName = data.firstName;
  const workLine = (() => {
    if (data.role && data.organization) return `${data.role} at ${data.organization}`;
    if (data.role) return data.role;
    if (data.organization) return data.organization;
    return null;
  })();
  const handleLine = (() => {
    if (data.telegram && data.xUser) return `@${data.telegram} · @${data.xUser}`;
    if (data.telegram) return `@${data.telegram}`;
    if (data.xUser) return `@${data.xUser}`;
    return null;
  })();

  // Step 1 is ALWAYS present — the village context anchor.
  const steps: Step[] = [
    {
      pending: "pulling your profile from Edge City…",
      active: "pulling your profile from Edge City…",
      complete: () => `you are ${fullName}.`,
    },
  ];

  // Step 2 — work context (only if we have role or organization)
  if (workLine) {
    steps.push({
      pending: "learning about your work…",
      active: "learning about your work…",
      complete: () => workLine,
    });
  }

  // Step 3 — social handles (only if we have telegram or x)
  if (handleLine) {
    steps.push({
      pending: "noting how to reach you…",
      active: "noting how to reach you…",
      complete: () => handleLine,
    });
  }

  // Final step — adapts to whether the user submitted an intent. The
  // intent text itself isn't yet plumbed through (P1 follow-up); for
  // tonight we use a generic "we know what you're looking for" when
  // hasIntent is true.
  if (data.hasIntent) {
    steps.push({
      pending: "personalizing your agent about you…",
      active: "personalizing your agent about you…",
      complete: () =>
        `${firstName}, your village agent knows what you're looking for.`,
    });
  } else {
    steps.push({
      pending: "personalizing your agent about you…",
      active: "personalizing your agent about you…",
      complete: () => `${firstName}, your village agent is ready to meet you.`,
    });
  }

  return steps;
}

export function EdgePersonalizationPopup({
  personalizationDismissed,
  onComplete,
}: EdgePersonalizationPopupProps) {
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [data, setData] = useState<PersonalizationData | null>(null);
  const [activeStepIdx, setActiveStepIdx] = useState(0);
  const [completedStepIdx, setCompletedStepIdx] = useState(-1);
  // Track whether we've kicked off the animation timer chain (avoids
  // re-firing if React re-renders during the animation).
  const animationStartedRef = useRef(false);

  // ── Decide whether to render at all ─────────────────────────────────
  //
  // Same trigger semantics as the Gmail popup: render only if the user
  // hasn't dismissed already. Once dismissed (in DB), don't show again
  // on subsequent dashboard visits.
  useEffect(() => {
    if (!personalizationDismissed) {
      setVisible(true);
    }
  }, [personalizationDismissed]);

  // ── Fetch personalization data on mount ─────────────────────────────
  //
  // Fires immediately when visible. The API is best-effort with internal
  // 5s timeout against /citizens — by the time it returns we have either
  // real data or `tier: "minimal"` with the OAuth-name fallback.
  useEffect(() => {
    if (!visible) return;
    if (data !== null) return; // Already loaded
    (async () => {
      try {
        const res = await fetch("/api/edge/personalize-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // 10s client-side ceiling — covers the 5s /citizens budget
          // plus DB roundtrips with comfortable headroom. If we exceed
          // this, fall through to minimal fake data so the animation
          // still completes gracefully.
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as PersonalizationData;
        setData(json);
      } catch {
        // Worst-case fallback: synthesize minimal data so the animation
        // still runs to completion. Two steps, generic copy, ~2s. User
        // never sees an error.
        setData({
          tier: "minimal",
          firstName: "there",
          fullName: "there",
          role: null,
          organization: null,
          telegram: null,
          xUser: null,
          edgeIdentity: "",
          hasIntent: false,
        });
      }
    })();
  }, [visible, data]);

  // ── Start the animation timeline once data lands ────────────────────
  //
  // Each step holds for STEP_MIN_MS, then increments completed/active.
  // Once all steps complete, hold for FINAL_HOLD_MS, then dismiss.
  const advance = useCallback(() => {
    if (!data) return;
    const steps = buildSteps(data);

    // Step N done, advance to step N+1.
    setCompletedStepIdx((idx) => {
      const newCompleted = idx + 1;
      if (newCompleted >= steps.length) {
        // All steps done — transition to complete phase, then dismiss.
        setPhase("complete");
        setTimeout(() => {
          setPhase("dismissing");
          // Best-effort dismiss-write to DB so future dashboard visits
          // don't re-show. Fire-and-forget; the local state has already
          // moved on regardless of whether the write succeeds.
          // Persist dismissed flag + notify the OnboardingWizard
          // (components/onboarding-wizard/OnboardingWizard.tsx:154 listens
          // for this event). Without dispatch, the wizard's `gmailPopup-
          // Active` gate stays true from its initial fetch and the wizard
          // never re-runs to discover the popup has completed — meaning
          // Edge users never see the wizard tour after their personalization
          // moment. The wizard's existing event-driven re-fetch path
          // (gmailDismissedRef → setRestartTrigger) handles the rest.
          //
          // Order matters: fire the dismiss POST first so the DB flag is
          // (eventually) consistent, then dispatch the event. The wizard's
          // re-fetch will read fresh `gmailPopupDismissed=true` and
          // proceed cleanly.
          fetch("/api/gmail/dismiss", { method: "POST" }).catch(() => {});
          try {
            window.dispatchEvent(new Event("instaclaw:gmail-popup-closed"));
          } catch {
            // SSR / no-window — wizard won't auto-restart, will pick up
            // on next page navigation. Non-fatal.
          }
          setTimeout(() => {
            setVisible(false);
            onComplete();
          }, FADE_OUT_MS);
        }, FINAL_HOLD_MS);
        return newCompleted;
      }
      setActiveStepIdx(newCompleted);
      // Schedule the next advance.
      setTimeout(advance, STEP_MIN_MS);
      return newCompleted;
    });
  }, [data, onComplete]);

  useEffect(() => {
    if (!data) return;
    if (animationStartedRef.current) return;
    animationStartedRef.current = true;

    // Transition from loading to running. Activate step 0 immediately,
    // then start the advance chain after STEP_MIN_MS.
    setPhase("running");
    setActiveStepIdx(0);
    const timer = setTimeout(advance, STEP_MIN_MS);
    return () => clearTimeout(timer);
  }, [data, advance]);

  if (!visible) return null;

  const steps = buildSteps(data);

  return (
    <AnimatePresence>
      {phase !== "dismissing" && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center px-4"
          style={EDGE_CSS_VARS}
        >
          {/* ── Backdrop — warm cream tint, not pure black ──
            *
            * Soft warm overlay (var(--edge-ink) at 30% opacity) instead
            * of the standard black-with-blur. Matches the Edge cream-
            * paper aesthetic — the modal feels printed on, not floating
            * above a void.
            */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className="absolute inset-0"
            style={{
              background: "rgba(41, 49, 30, 0.32)",
              backdropFilter: "blur(6px)",
            }}
          />

          {/* ── Modal card ──
            *
            * Cream paper-card aesthetic — soft hairline border, generous
            * padding, EB Garamond serif for the headline matching the
            * Edge brand voice. No close button — the modal auto-dismisses
            * after the final reveal (Cooper directive).
            */}
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            // AnimatePresence's exit prop owns the fade-out when phase
            // flips to "dismissing" — the outer guard removes this
            // motion.div from the tree, AnimatePresence runs exit on the
            // way out. FADE_OUT_MS matches the outer setTimeout window.
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{
              duration: FADE_OUT_MS / 1000,
              ease: [0.16, 1, 0.3, 1],
            }}
            className="relative w-full max-w-md rounded-2xl overflow-hidden"
            style={{
              background: "var(--edge-bg)",
              border: "1px solid var(--edge-line-soft)",
              boxShadow: "0 32px 80px rgba(41, 49, 30, 0.22)",
            }}
          >
            <div className="px-7 py-8 sm:px-9 sm:py-10">
              {/* ── Eyebrow ── */}
              <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1, duration: 0.5 }}
                className="text-[11px] uppercase tracking-[0.18em] mb-4"
                style={{ color: "var(--edge-ink-soft)" }}
              >
                <span style={{ color: "var(--edge-olive)" }}>
                  ✓ Edge Esmeralda 2026
                </span>
              </motion.div>

              {/* ── Headline — morphs after final step ── */}
              <AnimatePresence mode="wait">
                <motion.h1
                  key={
                    phase === "complete"
                      ? "h1-complete"
                      : "h1-pending"
                  }
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  className="text-[26px] sm:text-[30px] leading-[1.1] mb-3"
                  style={{
                    fontFamily:
                      "var(--font-display), 'EB Garamond', Georgia, serif",
                    fontWeight: 500,
                    color: "var(--edge-ink)",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {phase === "complete"
                    ? `Hey ${data?.firstName ?? "there"}.`
                    : "Welcome to the village."}
                </motion.h1>
              </AnimatePresence>

              {/* ── Body ── */}
              <AnimatePresence mode="wait">
                <motion.p
                  key={
                    phase === "complete" ? "body-complete" : "body-pending"
                  }
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4 }}
                  className="text-[14px] sm:text-[15px] leading-[1.55] mb-7"
                  style={{ color: "var(--edge-ink-soft)" }}
                >
                  {phase === "complete"
                    ? "your agent is ready in telegram. say hi when you're ready."
                    : "your village agent is getting ready to meet you."}
                </motion.p>
              </AnimatePresence>

              {/* ── Step list ── */}
              <ol className="space-y-3.5">
                {steps.map((step, i) => {
                  const isComplete = i <= completedStepIdx;
                  const isActive = !isComplete && i === activeStepIdx;
                  return (
                    <StepRow
                      key={i}
                      step={step}
                      isComplete={isComplete}
                      isActive={isActive}
                      data={data}
                    />
                  );
                })}
              </ol>

              {/* ── Final-state breathing-dot CTA ──
                *
                * Subtle "your agent is waiting" affordance that breathes
                * in after the final step lands. Not a button — the modal
                * auto-dismisses regardless. Pure visual cue.
                */}
              <AnimatePresence>
                {phase === "complete" && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{
                      delay: 0.25,
                      duration: 0.5,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                    className="mt-7 pt-5 flex items-center gap-2.5"
                    style={{ borderTop: "1px solid var(--edge-line-soft)" }}
                  >
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{
                        background: "var(--edge-olive)",
                        animation: "edge-breath 2.4s ease-in-out infinite",
                      }}
                    />
                    <span
                      className="text-[12px] uppercase tracking-[0.18em]"
                      style={{ color: "var(--edge-ink-soft)" }}
                    >
                      meet your agent in telegram
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>

          {/* ── Local keyframes — scoped to this modal ── */}
          <style jsx global>{`
            @keyframes edge-pulse-dot {
              0%, 100% {
                opacity: 0.45;
                transform: scale(0.9);
              }
              50% {
                opacity: 1;
                transform: scale(1.1);
              }
            }
            @keyframes edge-check-fade {
              0% {
                opacity: 0;
                transform: scale(0.6);
              }
              60% {
                opacity: 1;
                transform: scale(1.1);
              }
              100% {
                opacity: 1;
                transform: scale(1);
              }
            }
            @keyframes edge-breath {
              0%, 100% {
                opacity: 0.55;
                transform: scale(0.85);
              }
              50% {
                opacity: 1;
                transform: scale(1);
              }
            }
            @keyframes edge-text-fade {
              0% {
                opacity: 0;
                transform: translateY(2px);
              }
              100% {
                opacity: 1;
                transform: translateY(0);
              }
            }
          `}</style>
        </div>
      )}
    </AnimatePresence>
  );
}

// ─── StepRow — individual step with pending / active / complete states ───
//
// Three visual states:
//   - pending  — small open circle, ink-soft 40% opacity, copy at 50% opacity
//   - active   — pulsing olive dot, copy at full opacity
//   - complete — olive ✓ (fade-in), copy interpolated with data, full opacity
//
// Copy changes between active (process verb) and complete (real value
// reveal) so the user sees "Founder at Wild West Bots" land at the
// exact moment the check appears. That's the magic moment per step.

function StepRow({
  step,
  isComplete,
  isActive,
  data,
}: {
  step: Step;
  isComplete: boolean;
  isActive: boolean;
  data: PersonalizationData | null;
}) {
  const text = (() => {
    if (isComplete && data) return step.complete(data);
    if (isActive) return step.active;
    return step.pending;
  })();

  return (
    <li className="flex items-start gap-3">
      <span
        className="shrink-0 flex items-center justify-center"
        style={{ width: 18, height: 18, marginTop: 2 }}
      >
        {isComplete ? (
          <span
            style={{
              color: "var(--edge-olive)",
              fontSize: 14,
              lineHeight: 1,
              animation: "edge-check-fade 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards",
            }}
            aria-hidden
          >
            ✓
          </span>
        ) : isActive ? (
          <span
            className="rounded-full"
            style={{
              width: 6,
              height: 6,
              background: "var(--edge-olive)",
              animation: "edge-pulse-dot 1.8s ease-in-out infinite",
            }}
            aria-hidden
          />
        ) : (
          <span
            className="rounded-full"
            style={{
              width: 6,
              height: 6,
              border: "1.25px solid var(--edge-ink-soft)",
              opacity: 0.4,
            }}
            aria-hidden
          />
        )}
      </span>
      <AnimatePresence mode="wait">
        <motion.span
          key={text}
          initial={{ opacity: 0, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -2 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="text-[14px] leading-[1.45]"
          style={{
            color: isComplete
              ? "var(--edge-ink)"
              : isActive
                ? "var(--edge-ink)"
                : "var(--edge-ink-soft)",
            opacity: isComplete ? 1 : isActive ? 0.95 : 0.55,
            fontWeight: isComplete ? 500 : 400,
          }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </li>
  );
}
