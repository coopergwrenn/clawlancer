"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, AlertCircle } from "lucide-react";

type StepStatus = "pending" | "active" | "done" | "error";

interface DeployStep {
  id: string;
  label: string;
  status: StepStatus;
}

export default function DeployingPage() {
  const router = useRouter();
  const [steps, setSteps] = useState<DeployStep[]>([
    { id: "payment", label: "Payment confirmed", status: "done" },
    { id: "assign", label: "Assigning server", status: "active" },
    { id: "configure", label: "Configuring OpenClaw", status: "pending" },
    { id: "telegram", label: "Connecting Telegram bot", status: "pending" },
    { id: "health", label: "Health check", status: "pending" },
  ]);
  const [showSlowMessage, setShowSlowMessage] = useState(false);
  const [pollCount, setPollCount] = useState(0);

  const updateStep = useCallback(
    (id: string, status: StepStatus) => {
      setSteps((prev) =>
        prev.map((s) => (s.id === id ? { ...s, status } : s))
      );
    },
    []
  );

  useEffect(() => {
    const timer = setTimeout(() => setShowSlowMessage(true), 120_000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      setPollCount((c) => c + 1);

      try {
        const res = await fetch("/api/vm/status");
        const data = await res.json();

        if (data.status === "assigned" && data.vm) {
          // VM is assigned
          updateStep("assign", "done");

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

            // All done — redirect
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
  }, [router, updateStep, pollCount]);

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
                    : "var(--muted)",
              }}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>

      {showSlowMessage && (
        <div
          className="glass rounded-xl p-4 text-sm"
          style={{ color: "var(--muted)" }}
        >
          Taking longer than usual. We&apos;ll email you when your instance is
          ready. You can safely close this page.
        </div>
      )}
    </div>
  );
}
