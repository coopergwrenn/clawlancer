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
      // If gmail popup is still active, wait (done state — we'll re-check)
      if (action.gmailPopupActive) return { ...state, phase: "done" };
      // Sparkle button restart — skip welcome, go straight to tour
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
}

export default function OnboardingWizard({
  setMoreOpen,
  tourControllingMore,
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
