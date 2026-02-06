"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, AlertCircle, RotateCcw } from "lucide-react";

type StepStatus = "pending" | "active" | "done" | "error";

interface DeployStep {
  id: string;
  label: string;
  status: StepStatus;
}

const MAX_POLL_ATTEMPTS = 90; // 3 minutes at 2s intervals

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

  const updateStep = useCallback(
    (id: string, status: StepStatus) => {
      setSteps((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status } : s))
      );
    },
    []
  );

  // Polling effect
  useEffect(() => {
    if (!polling) return;

    const interval = setInterval(async () => {
      setPollCount((c) => {
        const next = c + 1;
        if (next >= MAX_POLL_ATTEMPTS) {
          setPolling(false);
          setConfigureFailed(true);
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

        if (data.status === "assigned" && data.vm) {
          updateStep("assign", "done");

          // Check for configure failure
          if (data.vm.healthStatus === "configure_failed") {
            setConfigureFailed(true);
            setConfigureAttempts(data.vm.configureAttempts ?? 0);
            setPolling(false);
            updateStep("configure", "error");
            return;
          }

          if (data.vm.gatewayUrl) {
            updateStep("configure", "done");
            updateStep("telegram", "done");
          } else {
            updateStep("configure", "active");
          }

          if (data.vm.healthStatus === "healthy") {
            updateStep("configure", "done");
            updateStep("telegram", "done");
            updateStep("health", "done");
            setPolling(false);
            clearInterval(interval);
            setTimeout(() => router.push("/dashboard"), 1500);
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

  async function handleRetry() {
    setRetrying(true);
    setConfigureFailed(false);

    // Reset step statuses
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
        // Retry succeeded — resume polling to wait for health check
        setPollCount(0);
        setPolling(true);
      } else {
        // Retry failed
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

  return (
    <div className="space-y-8 text-center">
      <div>
        <h1 className="text-2xl font-bold">Deploying Your Instance</h1>
        <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>
          Setting up your dedicated OpenClaw VM...
        </p>
      </div>

      <div className="space-y-4 text-left max-w-sm mx-auto">
        {steps.map((step) => (
          <div key={step.id} className="flex items-center gap-3">
            <div className="w-6 h-6 flex items-center justify-center">
              {step.status === "done" && (
                <Check className="w-5 h-5" style={{ color: "var(--success)" }} />
              )}
              {step.status === "active" && (
                <Loader2 className="w-5 h-5 animate-spin text-white" />
              )}
              {step.status === "pending" && (
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: "var(--muted)" }}
                />
              )}
              {step.status === "error" && (
                <AlertCircle
                  className="w-5 h-5"
                  style={{ color: "var(--error)" }}
                />
              )}
            </div>
            <span
              className="text-sm"
              style={{
                color:
                  step.status === "done"
                    ? "var(--success)"
                    : step.status === "active"
                    ? "#ffffff"
                    : step.status === "error"
                    ? "var(--error)"
                    : "var(--muted)",
              }}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>

      {/* Error state with retry */}
      {configureFailed && !retrying && (
        <div className="glass rounded-xl p-6 max-w-sm mx-auto space-y-4">
          {maxAttemptsReached ? (
            <>
              <p className="text-sm font-medium" style={{ color: "var(--error)" }}>
                Configuration failed after multiple attempts.
              </p>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                Please contact support at{" "}
                <a
                  href="mailto:cooper@clawlancer.com"
                  className="underline text-white hover:opacity-80 transition-opacity"
                >
                  cooper@clawlancer.com
                </a>
                {" "}and we&apos;ll get your instance running.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium" style={{ color: "var(--error)" }}>
                Configuration hit a snag.
              </p>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                This sometimes happens during initial setup. Retrying usually
                fixes it.
              </p>
              <button
                onClick={handleRetry}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-semibold transition-all cursor-pointer flex items-center justify-center gap-2 hover:shadow-[0_0_20px_rgba(255,255,255,0.2)]"
                style={{ background: "#ffffff", color: "#000000" }}
              >
                <RotateCcw className="w-4 h-4" />
                Retry Configuration
              </button>
            </>
          )}
        </div>
      )}

      {/* Retrying spinner */}
      {retrying && (
        <div
          className="glass rounded-xl p-4 text-sm flex items-center justify-center gap-2"
          style={{ color: "var(--muted)" }}
        >
          <Loader2 className="w-4 h-4 animate-spin" />
          Retrying configuration...
        </div>
      )}
    </div>
  );
}
