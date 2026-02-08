"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Check, AlertCircle, RotateCcw } from "lucide-react";

type StepStatus = "pending" | "active" | "done" | "error";

interface DeployStep {
  id: string;
  label: string;
  status: StepStatus;
}

const MAX_POLL_ATTEMPTS = 45; // 90 seconds at 2s intervals
const EARLY_CHECK_THRESHOLD = 15; // Check for issues at 30s
const MID_CHECK_THRESHOLD = 30; // Check for issues at 60s

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
// Main page
// ---------------------------------------------------------------------------
export default function DeployingPage() {
  const router = useRouter();
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

  // Track which steps just completed (for the bounce animation)
  const [justCompleted, setJustCompleted] = useState<Set<string>>(new Set());
  const completedRef = useRef<Set<string>>(new Set(["payment"]));

  // ---- Initial validation: Check for valid checkout/pending user ----
  useEffect(() => {
    if (validationChecked.current) return;
    validationChecked.current = true;

    async function validateCheckout() {
      try {
        const res = await fetch("/api/vm/status");
        const data = await res.json();

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
        if (data.status === "pending" && !data.stripeSessionId) {
          setValidationError("Payment session not found. Please restart from plan selection.");
          setErrorType("checkout");
          setPolling(false);
          setSteps((prev) =>
            prev.map((s) => (s.id === "payment" ? s : { ...s, status: "error" }))
          );
          return;
        }
      } catch (err) {
        console.error("Validation check failed:", err);
        // Don't block on validation errors, let polling handle it
      }
    }

    validateCheckout();
  }, []);

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

        // Timeout after MAX_POLL_ATTEMPTS
        if (next >= MAX_POLL_ATTEMPTS) {
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
        const data = await res.json();

        // Early check (30s): Still on "assign"? Might be no VMs available
        if (pollCount >= EARLY_CHECK_THRESHOLD && data.status === "pending") {
          // Check if there are VMs available
          const poolRes = await fetch("/api/vm/pool-status");
          const poolData = await poolRes.json();

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
            updateStep("configure", "done");
            updateStep("telegram", "done");

            if (data.vm.healthStatus === "healthy") {
              // Fully ready
              updateStep("health", "done");
              setPolling(false);
              clearInterval(interval);
              setTimeout(() => router.push("/dashboard"), 1500);
            } else {
              // "configuring" or "unknown" — health check in progress
              updateStep("health", "active");
            }
          } else {
            // No gateway URL yet — configure still running
            updateStep("configure", "active");

            // Auto-trigger retry if VM assigned but configure hasn't
            // produced a gateway_url after 30 polls (~60s).
            // This handles the case where the fire-and-forget from
            // the webhook never reached the configure endpoint.
            if (pollCount >= 30 && !autoRetryFired.current) {
              autoRetryFired.current = true;
              fetch("/api/vm/retry-configure", { method: "POST" }).catch(
                () => {}
              );
            }
          }
        } else if (data.status === "pending") {
          updateStep("assign", "active");
        }
      } catch {
        // Continue polling
      }
    }, 2000);

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
      const data = await res.json();

      if (res.ok && data.retried) {
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

  return (
    <>
      {/* ---- Styles ---- */}
      <style jsx global>{`
        /* ===== Claude Code shimmer — orange base with golden highlight sweep ===== */
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

        /* ===== Pulsing orange dot ===== */
        @keyframes pulse-dot {
          0%, 100% { opacity: 0.4; transform: scale(0.9); }
          50%      { opacity: 1;   transform: scale(1.1); }
        }
        .active-dot {
          animation: pulse-dot 2s ease-in-out infinite;
        }

        /* ===== Checkmark bounce ===== */
        @keyframes check-bounce {
          0%   { transform: scale(0);   opacity: 0; }
          60%  { transform: scale(1.2); opacity: 1; }
          100% { transform: scale(1);   opacity: 1; }
        }
        .check-bounce {
          animation: check-bounce 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }

        /* ===== Progress bar glow ===== */
        @keyframes bar-glow {
          0%, 100% { box-shadow: 0 0 8px rgba(220, 103, 67, 0.3); }
          50%      { box-shadow: 0 0 16px rgba(220, 103, 67, 0.5); }
        }
      `}</style>

      <div
        className="min-h-screen flex flex-col items-center justify-center px-6 py-16"
        style={{ background: "#f8f7f4" }}
      >
        {/* Title */}
        <div className="mb-12 text-center">
          <h1
            className="text-4xl font-normal tracking-[-0.5px] mb-3"
            style={{ fontFamily: "var(--font-serif)", color: "#333334" }}
          >
            Deploying Your Instance
          </h1>
          <p className="text-base" style={{ color: "#666666" }}>
            Setting up your dedicated OpenClaw VM
          </p>
        </div>

        {/* Progress bar container with clean white background */}
        <div
          className="w-full max-w-lg mb-12 p-8 rounded-lg"
          style={{
            background: "#ffffff",
            border: "1px solid rgba(0, 0, 0, 0.1)",
            boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
          }}
        >
          {/* Progress bar */}
          <div className="mb-8">
            <div
              className="h-1.5 rounded-full overflow-hidden"
              style={{ background: "rgba(220, 103, 67, 0.1)" }}
            >
              <div
                className="h-full rounded-full transition-all duration-700 ease-out"
                style={{
                  width: `${progress}%`,
                  background: "#DC6743",
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
                {/* Icon column */}
                <div className="w-8 h-8 flex items-center justify-center flex-shrink-0">
                  {step.status === "done" && (
                    <div className={justCompleted.has(step.id) ? "check-bounce" : ""}>
                      <Check
                        className="w-5 h-5"
                        style={{ color: "#22c55e" }}
                        strokeWidth={3}
                      />
                    </div>
                  )}
                  {step.status === "active" && (
                    <div
                      className="w-3 h-3 rounded-full active-dot"
                      style={{ background: "#DC6743" }}
                    />
                  )}
                  {step.status === "pending" && (
                    <div
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ background: "rgba(0, 0, 0, 0.15)" }}
                    />
                  )}
                  {step.status === "error" && (
                    <AlertCircle className="w-5 h-5" style={{ color: "#ef4444" }} />
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

        {/* ---- Error / Retry ---- */}
        {(configureFailed || validationError) && !retrying && (
          <div
            className="rounded-lg p-8 max-w-lg w-full space-y-4"
            style={{
              background: "#ffffff",
              border: "2px solid #ef4444",
              boxShadow: "0 4px 12px rgba(239, 68, 68, 0.1)",
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
                  style={{
                    background: "#DC6743",
                    color: "#ffffff",
                  }}
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
                  style={{
                    background: "#DC6743",
                    color: "#ffffff",
                  }}
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
                    href="mailto:cooper@clawlancer.com"
                    className="underline hover:opacity-80 transition-opacity"
                    style={{ color: "#DC6743" }}
                  >
                    cooper@clawlancer.com
                  </a>
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all cursor-pointer flex items-center justify-center gap-2"
                  style={{
                    background: "#DC6743",
                    color: "#ffffff",
                  }}
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
                        href="mailto:cooper@clawlancer.com"
                        className="underline hover:opacity-80 transition-opacity"
                        style={{ color: "#DC6743" }}
                      >
                        cooper@clawlancer.com
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
                      style={{
                        background: "#DC6743",
                        color: "#ffffff",
                      }}
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
                  Deployment took longer than expected (90 seconds). Please contact support at{" "}
                  <a
                    href="mailto:cooper@clawlancer.com"
                    className="underline hover:opacity-80 transition-opacity"
                    style={{ color: "#DC6743" }}
                  >
                    cooper@clawlancer.com
                  </a>
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="w-full px-6 py-4 rounded-lg text-base font-semibold transition-all cursor-pointer flex items-center justify-center gap-2"
                  style={{
                    background: "#DC6743",
                    color: "#ffffff",
                  }}
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
    </>
  );
}
