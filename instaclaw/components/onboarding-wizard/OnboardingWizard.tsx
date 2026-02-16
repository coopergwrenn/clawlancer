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
  | { type: "LOADED"; shouldShow: boolean; currentStep: number; botUsername: string | null; botConnected: boolean; gmailPopupActive: boolean; gmailConnected: boolean }
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
      // If gmail popup is still active, wait (done state — we'll re-check)
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
}

export default function OnboardingWizard({
  setMoreOpen,
  tourControllingMore,
}: OnboardingWizardProps) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const router = useRouter();
  const fetchedRef = useRef(false);
  const [restartTrigger, setRestartTrigger] = useState(0);

  // Listen for restart-wizard events (from the sparkle button in nav)
  useEffect(() => {
    const handler = () => {
      fetchedRef.current = false;
      setRestartTrigger((t) => t + 1);
    };
    window.addEventListener("instaclaw:restart-wizard", handler);
    return () => window.removeEventListener("instaclaw:restart-wizard", handler);
  }, []);

  // Fetch wizard status on mount or restart
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    (async () => {
      try {
        const res = await fetch("/api/onboarding/wizard-status");
        if (!res.ok) {
          dispatch({ type: "LOADED", shouldShow: false, currentStep: 0, botUsername: null, botConnected: false, gmailPopupActive: false, gmailConnected: false });
          return;
        }
        const data = await res.json();
        dispatch({
          type: "LOADED",
          shouldShow: data.shouldShow,
          currentStep: data.currentStep ?? 0,
          botUsername: data.telegramBotUsername ?? null,
          botConnected: data.botConnected ?? false,
          gmailPopupActive: !data.gmailPopupDismissed,
          gmailConnected: data.gmailConnected ?? false,
        });
      } catch {
        dispatch({ type: "LOADED", shouldShow: false, currentStep: 0, botUsername: null, botConnected: false, gmailPopupActive: false, gmailConnected: false });
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
          onSkip={() => dispatch({ type: "SKIP_BOT_VERIFY" })}
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
          onStepChange={(step) => {
            dispatch({ type: "TOUR_STEP", step });
            saveStep(step);
          }}
          onComplete={() => {
            dispatch({ type: "TOUR_COMPLETE" });
            completeWizard();
          }}
          onClose={() => {
            dispatch({ type: "TOUR_CLOSE" });
            completeWizard();
          }}
          setMoreOpen={setMoreOpen}
          navigateTo={handleNavigate}
        />
      )}

      {state.phase === "complete" && (
        <CompletionModal
          key="complete"
          gmailConnected={state.gmailConnected}
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
