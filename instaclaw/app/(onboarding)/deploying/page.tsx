"use client";

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Check, AlertCircle, RotateCcw } from "lucide-react";

type StepStatus = "pending" | "active" | "done" | "error";

interface DeployStep {
  id: string;
  label: string;
  status: StepStatus;
}

const MAX_POLL_ATTEMPTS = 180; // 180 seconds at 1s intervals
const EARLY_CHECK_THRESHOLD = 30; // Check for issues at 30s
const MID_CHECK_THRESHOLD = 90; // Check for issues at 90s
const SOFT_TIMEOUT_THRESHOLD = 90; // Show recovery UI at 90s

/** Safely parse JSON from a fetch response. Returns null if response is not JSON
 *  (e.g. Vercel timeout returning HTML). Prevents "Unexpected token" crashes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function safeJson(res: Response): Promise<any | null> {
  try {
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Rotating subtitle phrases while deploying
const SUBTITLE_MESSAGES = [
  "Hang tight, your AI is coming to life",
  "Your AI is being born...",
  "Warming up the neurons...",
  "Loading personality...",
  "Teaching it everything you love...",
  "Almost sentient...",
  "Brewing digital consciousness...",
  "Giving it a name tag...",
];

// Rotating cowboy messages for longer-running steps
const ROTATING_MESSAGES: Record<string, string[]> = {
  configure: [
    "Taming the claw...",
    "Herding containers...",
    "Teaching your bot manners...",
    "Canoodling with configs...",
    "Wrangling dependencies...",
  ],
  telegram: [
    "Whispering to Telegram...",
    "Sending smoke signals...",
    "Tipping the hat...",
    "Establishing contact...",
  ],
  health: [
    "Kicking the tires...",
    "Checking vitals...",
    "Almost there, partner...",
    "Poking the server...",
  ],
};

// ---------------------------------------------------------------------------
// RotatingSubtitle — crossfades subtitle phrases with gray shimmer
// ---------------------------------------------------------------------------
function RotatingSubtitle({ messages }: { messages: string[] }) {
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<"active" | "exit" | "enter">("active");

  useEffect(() => {
    const cycle = setInterval(() => {
      setPhase("exit");
      setTimeout(() => {
        setIndex((i) => (i + 1) % messages.length);
        setPhase("enter");
        requestAnimationFrame(() => {
          setTimeout(() => setPhase("active"), 20);
        });
      }, 400);
    }, 3500);
    return () => clearInterval(cycle);
  }, [messages.length]);

  const style: React.CSSProperties =
    phase === "exit"
      ? { opacity: 0, transform: "translateY(-4px)", transition: "all 0.4s ease" }
      : phase === "enter"
      ? { opacity: 0, transform: "translateY(4px)" }
      : { opacity: 1, transform: "translateY(0)", transition: "all 0.4s ease" };

  return (
    <span className="shimmer-text-gray" style={style}>
      {messages[index]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// RotatingMessage — crossfades between cowboy phrases every 3s
// ---------------------------------------------------------------------------
function RotatingMessage({ messages }: { messages: string[] }) {
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<"active" | "exit" | "enter">("active");

  useEffect(() => {
    const cycle = setInterval(() => {
      // Start exit
      setPhase("exit");

      // After exit animation, swap text and enter
      setTimeout(() => {
        setIndex((i) => (i + 1) % messages.length);
        setPhase("enter");

        // Settle into active
        requestAnimationFrame(() => {
          setTimeout(() => setPhase("active"), 20);
        });
      }, 400);
    }, 3000);

    return () => clearInterval(cycle);
  }, [messages.length]);

  const style: React.CSSProperties =
    phase === "exit"
      ? { opacity: 0, transform: "translateY(-4px)", transition: "all 0.4s ease" }
      : phase === "enter"
      ? { opacity: 0, transform: "translateY(4px)" }
      : { opacity: 1, transform: "translateY(0)", transition: "all 0.4s ease" };

  return (
    <span className="shimmer-text" style={style}>
      {messages[index]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main page content (wrapped in Suspense below)
// ---------------------------------------------------------------------------
function DeployingPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [steps, setSteps] = useState<DeployStep[]>([
    { id: "payment", label: "Payment confirmed", status: "done" },
    { id: "assign", label: "Assigning server", status: "active" },
    { id: "configure", label: "Configuring OpenClaw", status: "pending" },
    { id: "telegram", label: "Connecting Telegram bot", status: "pending" },
    { id: "health", label: "Health check", status: "pending" },
  ]);
  const [configureFailed, setConfigureFailed] = useState(false);
  const [configureAttempts, setConfigureAttempts] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const [polling, setPolling] = useState(true);
  const [validationError, setValidationError] = useState<string>("");
  const [errorType, setErrorType] = useState<"checkout" | "no_vms" | "assignment" | "config" | "timeout" | null>(null);
  const autoRetryFired = useRef(false);
  const validationChecked = useRef(false);
  const configuredRef = useRef(false);
  const softTimeoutFired = useRef(false);
  const [softTimeout, setSoftTimeout] = useState(false);
  const [recoveryChecking, setRecoveryChecking] = useState(false);

  // Track which steps just completed (for the bounce animation)
  const [justCompleted, setJustCompleted] = useState<Set<string>>(new Set());
  const completedRef = useRef<Set<string>>(new Set(["payment"]));

  // ---- Immediate checkout verification and VM assignment ----
  useEffect(() => {
    if (validationChecked.current) return;
    validationChecked.current = true;

    async function verifyAndAssign() {
      try {
        const sessionId = searchParams.get("session_id");

        // If there's a session_id, verify it immediately
        if (sessionId) {
          const verifyRes = await fetch("/api/checkout/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId }),
          });

          if (verifyRes.ok) {
            const verifyData = await safeJson(verifyRes);
            if (!verifyData) return; // Non-JSON — let polling handle it

            if (verifyData.verified && verifyData.status === "paid") {
              // Payment confirmed, VM assignment triggered
              if (verifyData.vmAssigned) {
                // VM assigned successfully via instant verification
              } else if (verifyData.error === "no_vms") {
                setValidationError("No servers available. All instances are currently in use.");
                setErrorType("no_vms");
                setPolling(false);
                setSteps((prev) =>
                  prev.map((s) => (s.id === "assign" ? { ...s, status: "error" } : s))
                );
                return;
              } else if (verifyData.error === "assignment_failed") {
                setValidationError("Server assignment failed. Please contact support.");
                setErrorType("assignment");
                setPolling(false);
                setSteps((prev) =>
                  prev.map((s) => (s.id === "assign" ? { ...s, status: "error" } : s))
                );
                return;
              }
              // Continue with normal polling to track progress
              return;
            } else {
              // Payment not completed
              setValidationError("Payment not completed. Please try again.");
              setErrorType("checkout");
              setPolling(false);
              setSteps((prev) =>
                prev.map((s) => (s.id === "payment" ? s : { ...s, status: "error" }))
              );
              return;
            }
          }
        }

        // Fallback: Check VM status if no session_id or verification failed
        const res = await fetch("/api/vm/status");
        const data = await safeJson(res);
        if (!data) return; // Non-JSON response (e.g. timeout) — let polling handle it

        // Check if there's no pending user at all
        if (data.status === "no_user") {
          setValidationError("Checkout incomplete. No pending signup found.");
          setErrorType("checkout");
          setPolling(false);
          setSteps((prev) =>
            prev.map((s) => (s.id === "payment" ? s : { ...s, status: "error" }))
          );
          return;
        }

        // Check if pending user exists but has no stripe session
        if (data.status === "pending" && !data.stripeSessionId && !sessionId) {
          setValidationError("Payment session not found. Please restart from plan selection.");
          setErrorType("checkout");
          setPolling(false);
          setSteps((prev) =>
            prev.map((s) => (s.id === "payment" ? s : { ...s, status: "error" }))
          );
          return;
        }
      } catch (err) {
        // Verification failed non-fatally, let polling handle it
      }
    }

    verifyAndAssign();
  }, [searchParams]);

  const updateStep = useCallback((id: string, status: StepStatus) => {
    setSteps((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status } : s))
    );
    if (status === "done" && !completedRef.current.has(id)) {
      completedRef.current.add(id);
      setJustCompleted((prev) => new Set(prev).add(id));
      setTimeout(() => {
        setJustCompleted((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 600);
    }
  }, []);

  const doneCount = steps.filter((s) => s.status === "done").length;
  const progress = (doneCount / steps.length) * 100;

  // ---- Polling ----
  useEffect(() => {
    if (!polling) return;

    const interval = setInterval(async () => {
      setPollCount((c) => {
        const next = c + 1;

        // Timeout after MAX_POLL_ATTEMPTS — but NOT if config already
        // succeeded (gateway URL present). In that case the health check
        // cron will mark it healthy shortly.
        if (next >= MAX_POLL_ATTEMPTS && !configuredRef.current) {
          setPolling(false);
          setConfigureFailed(true);
          setErrorType("timeout");
          setSteps((prev) =>
            prev.map((s) =>
              s.status === "active" || s.status === "pending"
                ? { ...s, status: "error" }
                : s
            )
          );
        }

        return next;
      });

      try {
        const res = await fetch("/api/vm/status");
        const data = await safeJson(res);
        if (!data) return; // Non-JSON response (timeout/error) — skip this poll cycle

        // Early check (30s): Still on "assign"? Might be no VMs available
        if (pollCount >= EARLY_CHECK_THRESHOLD && data.status === "pending") {
          // Check if there are VMs available
          const poolRes = await fetch("/api/vm/pool-status");
          const poolData = await safeJson(poolRes);
          if (!poolData) return; // Non-JSON — skip this check

          if (poolData.availableVMs === 0) {
            setPolling(false);
            setConfigureFailed(true);
            setErrorType("no_vms");
            setValidationError("No servers available. All instances are currently in use.");
            setSteps((prev) =>
              prev.map((s) => (s.id === "assign" ? { ...s, status: "error" } : s))
            );
            return;
          }
        }

        // Mid check (60s): Still pending? Something's wrong with assignment
        if (pollCount >= MID_CHECK_THRESHOLD && data.status === "pending") {
          setPolling(false);
          setConfigureFailed(true);
          setErrorType("assignment");
          setValidationError("Server assignment taking longer than expected. Please contact support.");
          setSteps((prev) =>
            prev.map((s) =>
              s.status === "active" || s.status === "pending"
                ? { ...s, status: "error" }
                : s
            )
          );
          return;
        }

        if (data.status === "assigned" && data.vm) {
          updateStep("assign", "done");

          if (data.vm.healthStatus === "configure_failed") {
            setConfigureFailed(true);
            setConfigureAttempts(data.vm.configureAttempts ?? 0);
            setErrorType("config");
            setPolling(false);
            updateStep("configure", "error");
            return;
          }

          if (data.vm.gatewayUrl) {
            // Gateway URL set → configure script completed
            configuredRef.current = true;
            updateStep("configure", "done");
            updateStep("telegram", "done");

            if (data.vm.healthStatus === "healthy") {
              // Fully ready — redirect to dashboard
              updateStep("health", "done");
              setPolling(false);
              setSoftTimeout(false);
              clearInterval(interval);
              // Full page navigation (not router.push) so the NextAuth
              // session is re-fetched with the updated onboardingComplete flag.
              setTimeout(() => { window.location.href = "/dashboard"; }, 1500);
            } else {
              // "configuring" or "unknown" — configure route will mark healthy
              updateStep("health", "active");
            }
          } else {
            // No gateway URL yet — configure still running
            updateStep("configure", "active");

            // Auto-trigger retry if VM assigned but configure hasn't
            // produced a gateway_url after 60 polls (~60s at 1s interval).
            // This handles the case where the fire-and-forget from
            // the webhook never reached the configure endpoint.
            if (pollCount >= 60 && !autoRetryFired.current) {
              autoRetryFired.current = true;
              fetch("/api/vm/retry-configure", { method: "POST" }).catch(
                () => {}
              );
            }
          }

          // ── Soft timeout at 90s: show recovery UI ──
          if (pollCount >= SOFT_TIMEOUT_THRESHOLD && !softTimeoutFired.current && data.vm?.healthStatus !== "healthy") {
            softTimeoutFired.current = true;
            setSoftTimeout(true);

            // Fire one final health check to see if the agent is actually ready
            setRecoveryChecking(true);
            fetch("/api/vm/health-check-now", { method: "POST" })
              .then((r) => safeJson(r))
              .then((d) => {
                setRecoveryChecking(false);
                if (d?.healthy) {
                  updateStep("health", "done");
                  setPolling(false);
                  setSoftTimeout(false);
                  setTimeout(() => { window.location.href = "/dashboard"; }, 1500);
                }
              })
              .catch(() => setRecoveryChecking(false));
          }
        } else if (data.status === "pending") {
          updateStep("assign", "active");
        }
      } catch {
        // Continue polling
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [router, updateStep, polling]);

  // ---- Retry handler ----
  async function handleRetry() {
    setRetrying(true);
    setConfigureFailed(false);

    setSteps([
      { id: "payment", label: "Payment confirmed", status: "done" },
      { id: "assign", label: "Assigning server", status: "done" },
      { id: "configure", label: "Configuring OpenClaw", status: "active" },
      { id: "telegram", label: "Connecting Telegram bot", status: "pending" },
      { id: "health", label: "Health check", status: "pending" },
    ]);

    try {
      const res = await fetch("/api/vm/retry-configure", { method: "POST" });
      const data = await safeJson(res);

      if (res.ok && data?.retried) {
        setPollCount(0);
        setPolling(true);
      } else {
        setConfigureFailed(true);
        setConfigureAttempts((prev) => prev + 1);
        updateStep("configure", "error");
      }
    } catch {
      setConfigureFailed(true);
      updateStep("configure", "error");
    } finally {
      setRetrying(false);
    }
  }

  const maxAttemptsReached = configureAttempts >= 3;

  // ---- Render helper: what text to show for a step ----
  function renderStepContent(step: DeployStep) {
    if (step.status === "active") {
      // Steps with rotating messages get the crossfade
      const messages = ROTATING_MESSAGES[step.id];
      if (messages) {
        return <RotatingMessage messages={messages} />;
      }
      // Fast steps (payment, assign) just show static shimmer label
      return <span className="shimmer-text">{step.label}</span>;
    }

    // Done / pending / error — static text
    let color = "#999999";
    if (step.status === "done") color = "#22c55e";
    if (step.status === "error") color = "#ef4444";

    return (
      <span
        className="transition-colors duration-500"
        style={{ color }}
      >
        {step.label}
      </span>
    );
  }

  const glassStyle = {
    background:
      "linear-gradient(-75deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05))",
    backdropFilter: "blur(2px)",
    WebkitBackdropFilter: "blur(2px)",
    boxShadow: `
      rgba(0, 0, 0, 0.05) 0px 2px 2px 0px inset,
      rgba(255, 255, 255, 0.5) 0px -2px 2px 0px inset,
      rgba(0, 0, 0, 0.1) 0px 2px 4px 0px,
      rgba(255, 255, 255, 0.2) 0px 0px 1.6px 4px inset
    `,
  } as const;

  const orangeGlassButton = {
    background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
    backdropFilter: "blur(2px)",
    WebkitBackdropFilter: "blur(2px)",
    boxShadow: `
      rgba(255,255,255,0.2) 0px 2px 2px 0px inset,
      rgba(255,255,255,0.3) 0px -1px 1px 0px inset,
      rgba(220,103,67,0.35) 0px 4px 16px 0px,
      rgba(255,255,255,0.08) 0px 0px 1.6px 4px inset
    `,
    color: "#ffffff",
  } as const;

  return (
    <>
      {/* ---- Styles ---- */}
      <style jsx global>{`
        .shimmer-text-gray {
          color: transparent;
          background: linear-gradient(
            90deg,
            #999999 0%,
            #999999 35%,
            #d4d4d4 50%,
            #999999 65%,
            #999999 100%
          );
          background-size: 300% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: shimmer-gray 3s ease-in-out infinite;
        }

        @keyframes shimmer-gray {
          0%   { background-position: 100% 0; }
          100% { background-position: -100% 0; }
        }

        .shimmer-text {
          color: transparent;
          background: linear-gradient(
            90deg,
            #f97316 0%,
            #f97316 35%,
            #fde68a 50%,
            #f97316 65%,
            #f97316 100%
          );
          background-size: 300% 100%;
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: shimmer 2.5s ease-in-out infinite;
          font-weight: 600;
          font-size: 1.125rem;
          line-height: 1.75rem;
          letter-spacing: -0.01em;
        }

        @keyframes shimmer {
          0%   { background-position: 100% 0; }
          100% { background-position: -100% 0; }
        }

        @keyframes pulse-dot {
          0%, 100% { opacity: 0.4; transform: scale(0.9); }
          50%      { opacity: 1;   transform: scale(1.1); }
        }
        .active-dot {
          animation: pulse-dot 2s ease-in-out infinite;
        }

        @keyframes check-bounce {
          0%   { transform: scale(0);   opacity: 0; }
          60%  { transform: scale(1.2); opacity: 1; }
          100% { transform: scale(1);   opacity: 1; }
        }
        .check-bounce {
          animation: check-bounce 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }

        @keyframes bar-glow {
          0%, 100% { box-shadow: 0 0 8px rgba(220, 103, 67, 0.3); }
          50%      { box-shadow: 0 0 16px rgba(220, 103, 67, 0.5); }
        }
      `}</style>

      <div
        className="min-h-screen flex flex-col"
        style={{ background: "#f8f7f4" }}
      >
        {/* Step Indicator */}
        <div
          className="sticky top-0 z-10 py-4"
          style={{
            background: "linear-gradient(-75deg, rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0.85), rgba(255, 255, 255, 0.6))",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            borderBottom: "1px solid rgba(0, 0, 0, 0.06)",
          }}
        >
          <div className="max-w-5xl mx-auto px-6">
            <div className="flex items-center justify-center gap-2">
              {[
                { num: 1, label: "Connect" },
                { num: 2, label: "Plan" },
                { num: 3, label: "Deploy" },
              ].map((step, i) => (
                <div key={step.num} className="flex items-center">
                  <div className="flex flex-col items-center">
                    {step.num === 3 ? (
                      /* Active step — glowing glass orb */
                      <span
                        className="relative flex items-center justify-center w-10 h-10 rounded-full overflow-hidden shrink-0"
                        style={{
                          background: "radial-gradient(circle at 35% 30%, rgba(220,103,67,0.7), rgba(220,103,67,0.4) 50%, rgba(180,70,40,0.75) 100%)",
                          boxShadow: `
                            inset 0 -2px 4px rgba(0,0,0,0.3),
                            inset 0 2px 4px rgba(255,255,255,0.5),
                            inset 0 0 3px rgba(0,0,0,0.15),
                            0 1px 4px rgba(0,0,0,0.15)
                          `,
                        }}
                      >
                        <span
                          className="absolute inset-0 rounded-full"
                          style={{
                            background: "linear-gradient(105deg, transparent 20%, rgba(255,255,255,0.4) 45%, rgba(255,255,255,0.55) 50%, rgba(255,255,255,0.4) 55%, transparent 80%)",
                            backgroundSize: "300% 100%",
                            animation: "globe-shimmer 4s linear infinite",
                          }}
                        />
                        <span
                          className="absolute top-[3px] left-[5px] w-[14px] h-[8px] rounded-full pointer-events-none"
                          style={{
                            background: "linear-gradient(180deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 100%)",
                          }}
                        />
                        <span
                          className="absolute inset-[-3px] rounded-full"
                          style={{
                            background: "radial-gradient(circle, rgba(220,103,67,0.4) 0%, transparent 70%)",
                            animation: "globe-glow 4s ease-in-out infinite",
                          }}
                        />
                        <span className="relative text-sm font-semibold" style={{ color: "#ffffff" }}>
                          {step.num}
                        </span>
                      </span>
                    ) : (
                      /* Completed steps — green glass orb */
                      <span
                        className="relative flex items-center justify-center w-10 h-10 rounded-full text-sm font-semibold overflow-hidden"
                        style={{
                          background: "radial-gradient(circle at 35% 30%, rgba(34,197,94,0.6), rgba(34,197,94,0.35) 50%, rgba(22,163,74,0.7) 100%)",
                          boxShadow: "rgba(34,197,94,0.3) 0px 2px 8px 0px, rgba(255,255,255,0.25) 0px -1px 1px 0px inset",
                          color: "#ffffff",
                        }}
                      >
                        <span
                          className="absolute inset-0 rounded-full pointer-events-none"
                          style={{
                            background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)",
                          }}
                        />
                        <span className="relative">&#10003;</span>
                      </span>
                    )}
                    <span
                      className="text-xs mt-1.5 font-medium"
                      style={{ color: step.num === 3 ? "#333334" : "#999999" }}
                    >
                      {step.label}
                    </span>
                  </div>
                  {i < 2 && (
                    <div
                      className="w-16 mx-3 mb-5 rounded-full overflow-hidden"
                      style={{
                        height: "2px",
                        background: "#22c55e",
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-6 py-16">
          {/* Title */}
          <div className="mb-12 text-center">
            <h1
              className="text-4xl font-normal tracking-[-0.5px] mb-3"
              style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
            >
              Deploying Your Instance
            </h1>
            <p className="text-base">
              <RotatingSubtitle messages={SUBTITLE_MESSAGES} />
            </p>
          </div>

          {/* Progress bar container — glass card */}
          <div
            className="w-full max-w-lg mb-12 p-8 rounded-lg"
            style={glassStyle}
          >
            {/* Progress bar */}
            <div className="mb-8">
              <div
                className="h-2 rounded-full overflow-hidden"
                style={{
                  ...glassStyle,
                  padding: 0,
                }}
              >
                <div
                  className="h-full rounded-full transition-all duration-700 ease-out"
                  style={{
                    width: `${progress}%`,
                    background: "linear-gradient(90deg, #c75a34, #DC6743, #e8845e)",
                    animation:
                      progress > 0 && progress < 100
                        ? "bar-glow 2s ease-in-out infinite"
                        : "none",
                  }}
                />
              </div>
            </div>

            {/* Steps */}
            <div className="space-y-7">
              {steps.map((step) => (
                <div
                  key={step.id}
                  className="flex items-center gap-4"
                  style={{ minHeight: "40px" }}
                >
                  {/* Icon column — glass orbs */}
                  <div className="w-8 h-8 flex items-center justify-center flex-shrink-0">
                    {step.status === "done" && (
                      <div className={justCompleted.has(step.id) ? "check-bounce" : ""}>
                        <span
                          className="relative flex items-center justify-center w-7 h-7 rounded-full overflow-hidden"
                          style={{
                            background: "radial-gradient(circle at 35% 30%, rgba(34,197,94,0.6), rgba(34,197,94,0.35) 50%, rgba(22,163,74,0.7) 100%)",
                            boxShadow: "rgba(34,197,94,0.3) 0px 2px 6px 0px, rgba(255,255,255,0.25) 0px -1px 1px 0px inset",
                          }}
                        >
                          <span
                            className="absolute inset-0 rounded-full pointer-events-none"
                            style={{
                              background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)",
                            }}
                          />
                          <Check
                            className="relative w-3.5 h-3.5"
                            style={{ color: "#ffffff" }}
                            strokeWidth={3}
                          />
                        </span>
                      </div>
                    )}
                    {step.status === "active" && (
                      <span
                        className="relative flex items-center justify-center w-7 h-7 rounded-full overflow-hidden active-dot"
                        style={{
                          background: "radial-gradient(circle at 35% 30%, rgba(220,103,67,0.7), rgba(220,103,67,0.4) 50%, rgba(180,70,40,0.75) 100%)",
                          boxShadow: "rgba(220,103,67,0.3) 0px 2px 6px 0px, rgba(255,255,255,0.25) 0px -1px 1px 0px inset",
                        }}
                      >
                        <span
                          className="absolute inset-0 rounded-full pointer-events-none"
                          style={{
                            background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)",
                          }}
                        />
                      </span>
                    )}
                    {step.status === "pending" && (
                      <span
                        className="flex items-center justify-center w-7 h-7 rounded-full"
                        style={{
                          ...glassStyle,
                          opacity: 0.5,
                        }}
                      />
                    )}
                    {step.status === "error" && (
                      <span
                        className="relative flex items-center justify-center w-7 h-7 rounded-full overflow-hidden"
                        style={{
                          background: "radial-gradient(circle at 35% 30%, rgba(239,68,68,0.6), rgba(239,68,68,0.35) 50%, rgba(220,38,38,0.7) 100%)",
                          boxShadow: "rgba(239,68,68,0.3) 0px 2px 6px 0px, rgba(255,255,255,0.25) 0px -1px 1px 0px inset",
                        }}
                      >
                        <span
                          className="absolute inset-0 rounded-full pointer-events-none"
                          style={{
                            background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)",
                          }}
                        />
                        <AlertCircle className="relative w-3.5 h-3.5" style={{ color: "#ffffff" }} />
                      </span>
                    )}
                  </div>

                  {/* Text column */}
                  <div className="flex-1 text-lg font-medium">
                    {renderStepContent(step)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ---- Soft timeout recovery (90s) ---- */}
          {softTimeout && !configureFailed && !retrying && (
            <div
              className="rounded-lg p-8 max-w-lg w-full space-y-4 mb-6"
              style={{
                ...glassStyle,
                border: "1.5px solid rgba(220, 103, 67, 0.3)",
              }}
            >
              <p className="text-base font-semibold" style={{ color: "#DC6743" }}>
                Taking longer than expected
              </p>
              {recoveryChecking ? (
                <p className="text-sm" style={{ color: "#666666" }}>
                  Checking your agent...
                </p>
              ) : (
                <>
                  <p className="text-sm" style={{ color: "#666666" }}>
                    Your agent is still setting up. You can refresh in a minute or go to your dashboard — it&apos;ll be ready when you get there.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => window.location.reload()}
                      className="flex-1 px-4 py-3 rounded-lg text-sm font-semibold transition-all cursor-pointer flex items-center justify-center gap-2"
                      style={glassStyle}
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Refresh
                    </button>
                    <button
                      onClick={() => { window.location.href = "/dashboard"; }}
                      className="flex-1 px-4 py-3 rounded-lg text-sm font-semibold transition-all cursor-pointer"
                      style={orangeGlassButton}
                    >
                      Go to Dashboard
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ---- Error / Retry ---- */}
          {(configureFailed || validationError) && !retrying && (
            <div
              className="rounded-lg p-8 max-w-lg w-full space-y-4"
              style={{
                ...glassStyle,
                border: "1.5px solid rgba(239, 68, 68, 0.3)",
              }}
            >
              {/* Checkout incomplete error */}
              {errorType === "checkout" && (
                <>
                  <p className="text-base font-semibold" style={{ color: "#ef4444" }}>
                    Checkout Incomplete
                  </p>
                  <p className="text-sm" style={{ color: "#666666" }}>
                    {validationError || "Payment session not found. Please restart from plan selection."}
                  </p>
                  <button
                    onClick={() => router.push("/plan")}
                    className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all cursor-pointer"
                    style={orangeGlassButton}
                  >
                    Return to Plan Selection
                  </button>
                </>
              )}

              {/* No VMs available */}
              {errorType === "no_vms" && (
                <>
                  <p className="text-base font-semibold" style={{ color: "#ef4444" }}>
                    No Servers Available
                  </p>
                  <p className="text-sm" style={{ color: "#666666" }}>
                    All instances are currently in use. We&apos;re provisioning more servers. Please try again in a few minutes or contact support.
                  </p>
                  <button
                    onClick={() => window.location.reload()}
                    className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all cursor-pointer flex items-center justify-center gap-2"
                    style={orangeGlassButton}
                  >
                    <RotateCcw className="w-4 h-4" />
                    Check Again
                  </button>
                </>
              )}

              {/* Assignment failed */}
              {errorType === "assignment" && (
                <>
                  <p className="text-base font-semibold" style={{ color: "#ef4444" }}>
                    Server Assignment Delayed
                  </p>
                  <p className="text-sm" style={{ color: "#666666" }}>
                    {validationError || "Server assignment is taking longer than expected. This is unusual."} Please contact support at{" "}
                    <a
                      href="mailto:support@instaclaw.io"
                      className="underline hover:opacity-80 transition-opacity"
                      style={{ color: "#DC6743" }}
                    >
                      support@instaclaw.io
                    </a>
                  </p>
                  <button
                    onClick={() => window.location.reload()}
                    className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all cursor-pointer flex items-center justify-center gap-2"
                    style={orangeGlassButton}
                  >
                    <RotateCcw className="w-4 h-4" />
                    Try Again
                  </button>
                </>
              )}

              {/* Configuration failed */}
              {errorType === "config" && (
                <>
                  {maxAttemptsReached ? (
                    <>
                      <p className="text-base font-semibold" style={{ color: "#ef4444" }}>
                        Configuration failed after multiple attempts.
                      </p>
                      <p className="text-sm" style={{ color: "#666666" }}>
                        Please contact support at{" "}
                        <a
                          href="mailto:support@instaclaw.io"
                          className="underline hover:opacity-80 transition-opacity"
                          style={{ color: "#DC6743" }}
                        >
                          support@instaclaw.io
                        </a>{" "}
                        and we&apos;ll get your instance running.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-base font-semibold" style={{ color: "#ef4444" }}>
                        Configuration Hit a Snag
                      </p>
                      <p className="text-sm" style={{ color: "#666666" }}>
                        The server setup encountered an issue. Retrying usually fixes it.
                      </p>
                      <button
                        onClick={handleRetry}
                        className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all cursor-pointer flex items-center justify-center gap-2"
                        style={orangeGlassButton}
                      >
                        <RotateCcw className="w-4 h-4" />
                        Retry Configuration
                      </button>
                    </>
                  )}
                </>
              )}

              {/* Timeout (generic fallback) */}
              {errorType === "timeout" && (
                <>
                  <p className="text-base font-semibold" style={{ color: "#ef4444" }}>
                    Deployment Timeout
                  </p>
                  <p className="text-sm" style={{ color: "#666666" }}>
                    Deployment took longer than expected. Please contact support at{" "}
                    <a
                      href="mailto:support@instaclaw.io"
                      className="underline hover:opacity-80 transition-opacity"
                      style={{ color: "#DC6743" }}
                    >
                      support@instaclaw.io
                    </a>
                  </p>
                  <button
                    onClick={() => window.location.reload()}
                    className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all cursor-pointer flex items-center justify-center gap-2"
                    style={orangeGlassButton}
                  >
                    <RotateCcw className="w-4 h-4" />
                    Try Again
                  </button>
                </>
              )}
            </div>
          )}

          {/* Retrying spinner */}
          {retrying && (
            <div className="mt-10">
              <span className="shimmer-text">Retrying configuration...</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// Wrap in Suspense for useSearchParams
export default function DeployingPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center" style={{ background: "#f8f7f4" }}>
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 mx-auto mb-4" style={{ borderColor: "#DC6743" }}></div>
            <p className="text-base" style={{ color: "#666666" }}>Loading...</p>
          </div>
        </div>
      }
    >
      <DeployingPageContent />
    </Suspense>
  );
}
