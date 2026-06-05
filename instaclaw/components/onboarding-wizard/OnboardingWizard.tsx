"use client";

import { useReducer, useEffect, useCallback, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { useRouter } from "next/navigation";
import WelcomeModal from "./WelcomeModal";
import BotVerification from "./BotVerification";
import SpotlightTour from "./SpotlightTour";
import CompletionModal from "./CompletionModal";

/* ─── State machine ─────────────────────────────────────── */

type Phase = "loading" | "welcome" | "bot-verify" | "tour" | "complete" | "done";

interface WizardState {
  phase: Phase;
  tourStep: number;
  botUsername: string | null;
  botConnected: boolean;
  gmailConnected: boolean;
}

type WizardAction =
  | { type: "LOADED"; shouldShow: boolean; currentStep: number; botUsername: string | null; botConnected: boolean; gmailPopupActive: boolean; gmailConnected: boolean; isRestart: boolean }
  | { type: "GO_TO_BOT_VERIFY" }
  | { type: "SKIP_BOT_VERIFY" }
  | { type: "BOT_VERIFIED" }
  | { type: "TOUR_STEP"; step: number }
  | { type: "TOUR_COMPLETE" }
  | { type: "TOUR_CLOSE" }
  | { type: "DONE" };

function reducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "LOADED":
      if (!action.shouldShow) return { ...state, phase: "done" };
      // Sparkle "take the tour again" — an explicit restart goes straight to the
      // tour. Checked BEFORE the gmail-popup-wait below: that wait is a FIRST-RUN
      // concern (don't start the tour while the gmail insights popup is up), but a
      // restart from the account row never re-triggers that popup, so gating the
      // restart on a stale `gmail_popup_dismissed=false` flag silently dropped it
      // (dead restart button for any user in that gmail-flag state, both navs).
      // isRestart is false for first-run, so the gmail-popup-wait stays intact for
      // new users (the moved-up check is skipped when isRestart is false).
      if (action.isRestart) {
        return {
          ...state,
          phase: "tour",
          tourStep: 0,
          botUsername: action.botUsername,
          botConnected: action.botConnected,
          gmailConnected: action.gmailConnected,
        };
      }
      // If gmail popup is still active, wait (done state — we'll re-check).
      // FIRST-RUN only now; the restart path is handled above.
      if (action.gmailPopupActive) return { ...state, phase: "done" };
      // Resume from saved step
      if (action.currentStep > 0) {
        return {
          ...state,
          phase: "tour",
          tourStep: action.currentStep,
          botUsername: action.botUsername,
          botConnected: action.botConnected,
          gmailConnected: action.gmailConnected,
        };
      }
      // First-time: show welcome (with "Activate My Bot" or "Show Me Around")
      return {
        ...state,
        phase: "welcome",
        botUsername: action.botUsername,
        botConnected: action.botConnected,
        gmailConnected: action.gmailConnected,
      };

    case "GO_TO_BOT_VERIFY":
      return { ...state, phase: "bot-verify" };

    case "SKIP_BOT_VERIFY":
      return { ...state, phase: "tour", tourStep: 0 };

    case "BOT_VERIFIED":
      return { ...state, phase: "tour", tourStep: 0, botConnected: true };

    case "TOUR_STEP":
      return { ...state, tourStep: action.step };

    case "TOUR_COMPLETE":
      return { ...state, phase: "complete" };

    case "TOUR_CLOSE":
      // Close mid-tour — step is already saved
      return { ...state, phase: "done" };

    case "DONE":
      return { ...state, phase: "done" };

    default:
      return state;
  }
}

const initialState: WizardState = {
  phase: "loading",
  tourStep: 0,
  botUsername: null,
  botConnected: false,
  gmailConnected: false,
};

/* ─── Component ─────────────────────────────────────────── */

interface OnboardingWizardProps {
  setMoreOpen: (open: boolean) => void;
  tourControllingMore: React.MutableRefObject<boolean>;
  // Phase 1 sidebar restructure — threaded through to SpotlightTour. Default
  // keeps the top-nav tour byte-identical when the sidebar flag is off.
  navMode?: "topnav" | "sidebar";
  // B2 (mobile drawer) — threaded to SpotlightTour so sidebar nav-item steps
  // open the off-canvas drawer on mobile. Optional; topnav never uses it.
  setDrawerOpen?: (open: boolean) => void;
}

export default function OnboardingWizard({
  setMoreOpen,
  tourControllingMore,
  navMode = "topnav",
  setDrawerOpen,
}: OnboardingWizardProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const router = useRouter();
  const fetchedRef = useRef(false);
  const [restartTrigger, setRestartTrigger] = useState(0);

  // Detect Gmail OAuth return during render (before effects replace the URL).
  // If the user just came back from Google OAuth, the Gmail insights popup
  // will be showing — the wizard must wait for it to finish.
  const [gmailOAuthReturn] = useState(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    return params.get("gmail_ready") === "1" || !!params.get("gmail_error");
  });

  // Track whether the current fetch is a sparkle-button restart vs initial load
  const isRestartRef = useRef(false);

  // Listen for restart-wizard events (from the sparkle button in nav)
  useEffect(() => {
    const handler = () => {
      fetchedRef.current = false;
      isRestartRef.current = true;
      setRestartTrigger((t) => t + 1);
    };
    window.addEventListener("instaclaw:restart-wizard", handler);
    return () => window.removeEventListener("instaclaw:restart-wizard", handler);
  }, []);

  // Re-check wizard status after Gmail popup is dismissed.
  // We use a ref to skip the gmailPopupActive gate on re-fetch since the
  // /api/gmail/dismiss DB write may not have completed yet (race condition).
  const gmailDismissedRef = useRef(false);
  useEffect(() => {
    const handler = () => {
      gmailDismissedRef.current = true;
      fetchedRef.current = false;
      setRestartTrigger((t) => t + 1);
    };
    window.addEventListener("instaclaw:gmail-popup-closed", handler);
    return () => window.removeEventListener("instaclaw:gmail-popup-closed", handler);
  }, []);

  // Fetch wizard status on mount or restart
  useEffect(() => {
    if (fetchedRef.current) return;
    // Gmail OAuth return in progress — wait for insights flow to finish
    if (gmailOAuthReturn && !gmailDismissedRef.current) return;
    fetchedRef.current = true;

    const restart = isRestartRef.current;
    isRestartRef.current = false;

    (async () => {
      try {
        const res = await fetch("/api/onboarding/wizard-status");
        if (!res.ok) {
          dispatch({ type: "LOADED", shouldShow: false, currentStep: 0, botUsername: null, botConnected: false, gmailPopupActive: false, gmailConnected: false, isRestart: restart });
          return;
        }
        const data = await res.json();
        dispatch({
          type: "LOADED",
          shouldShow: data.shouldShow,
          currentStep: data.currentStep ?? 0,
          botUsername: data.telegramBotUsername ?? null,
          botConnected: data.botConnected ?? false,
          gmailPopupActive: gmailDismissedRef.current ? false : (!data.gmailPopupDismissed && !data.gmailConnected),
          gmailConnected: data.gmailConnected ?? false,
          isRestart: restart,
        });
      } catch {
        dispatch({ type: "LOADED", shouldShow: false, currentStep: 0, botUsername: null, botConnected: false, gmailPopupActive: false, gmailConnected: false, isRestart: restart });
      }
    })();
  }, [restartTrigger]);

  // Persist step changes
  const saveStep = useCallback(async (step: number) => {
    try {
      await fetch("/api/onboarding/update-wizard-step", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step }),
      });
    } catch {
      // non-fatal
    }
  }, []);

  // Mark wizard complete
  const completeWizard = useCallback(async () => {
    try {
      await fetch("/api/onboarding/complete-wizard", { method: "PATCH" });
    } catch {
      // non-fatal
    }
  }, []);

  // STABLE tour callbacks. These MUST be memoized: SpotlightTour's setup
  // useEffect depends on onStepChange/onComplete, so inline arrows (new ref every
  // render) made the effect re-fire on every parent re-render — and since the
  // effect calls setDrawerOpen/navigate (which re-render the layout), that was a
  // feedback loop that left the sidebar tour stuck on a dim, blank step 1.
  // dispatch is stable (useReducer); saveStep/completeWizard are useCallback.
  const handleTourStepChange = useCallback(
    (step: number) => {
      dispatch({ type: "TOUR_STEP", step });
      saveStep(step);
    },
    [saveStep]
  );
  const handleTourComplete = useCallback(() => {
    dispatch({ type: "TOUR_COMPLETE" });
    completeWizard();
  }, [completeWizard]);
  const handleTourClose = useCallback(() => {
    dispatch({ type: "TOUR_CLOSE" });
    completeWizard();
  }, [completeWizard]);

  // Tour controlling More dropdown
  useEffect(() => {
    const isTourPhase = state.phase === "tour";
    tourControllingMore.current = isTourPhase;
  }, [state.phase, tourControllingMore]);

  // Navigation helper for tour
  const handleNavigate = useCallback(
    (path: string) => {
      router.push(path);
    },
    [router]
  );

  // Handle suggestion click from completion modal
  const handleSuggestion = useCallback(
    (action: string) => {
      completeWizard();
      dispatch({ type: "DONE" });

      // Navigate to tasks and pre-fill input
      router.push("/tasks");

      // Dispatch a custom event so the tasks page can pick up the prefill
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent("instaclaw:prefill-input", { detail: action })
        );
      }, 500);
    },
    [completeWizard, router]
  );

  // Don't render anything in loading or done state
  if (state.phase === "loading" || state.phase === "done") return null;

  return (
    <AnimatePresence mode="wait">
      {state.phase === "welcome" && (
        <WelcomeModal
          key="welcome"
          botConnected={state.botConnected}
          onActivateBot={() => {
            if (state.botConnected) {
              // Already connected — skip verification
              dispatch({ type: "BOT_VERIFIED" });
            } else {
              dispatch({ type: "GO_TO_BOT_VERIFY" });
            }
          }}
          onSkip={() => {
            completeWizard();
            dispatch({ type: "DONE" });
          }}
        />
      )}

      {state.phase === "bot-verify" && (
        <BotVerification
          key="bot-verify"
          botUsername={state.botUsername}
          onVerified={() => dispatch({ type: "BOT_VERIFIED" })}
          onSkip={() => dispatch({ type: "SKIP_BOT_VERIFY" })}
        />
      )}

      {state.phase === "tour" && (
        <SpotlightTour
          key="tour"
          startStep={state.tourStep}
          onStepChange={handleTourStepChange}
          onComplete={handleTourComplete}
          onClose={handleTourClose}
          setMoreOpen={setMoreOpen}
          setDrawerOpen={setDrawerOpen}
          navigateTo={handleNavigate}
          navMode={navMode}
        />
      )}

      {state.phase === "complete" && (
        <CompletionModal
          key="complete"
          gmailConnected={state.gmailConnected}
          telegramBotUsername={state.botUsername}
          onDone={() => {
            completeWizard();
            dispatch({ type: "DONE" });
          }}
          onSuggestion={handleSuggestion}
        />
      )}
    </AnimatePresence>
  );
}
