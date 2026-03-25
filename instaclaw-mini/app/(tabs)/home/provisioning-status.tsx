"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";

type StepStatus = "pending" | "active" | "done";

interface Step {
  id: string;
  label: string;
  status: StepStatus;
}

const ROTATING_MESSAGES = [
  "Warming up the neurons...",
  "Teaching it everything you love...",
  "Loading personality...",
  "Taming the claw...",
  "Herding containers...",
  "Wrangling dependencies...",
  "Almost sentient...",
  "Brewing digital consciousness...",
];

function RotatingMessage() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const cycle = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex((i) => (i + 1) % ROTATING_MESSAGES.length);
        setVisible(true);
      }, 400);
    }, 3000);
    return () => clearInterval(cycle);
  }, []);

  return (
    <span
      className="shimmer-text text-[13px]"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(-4px)",
        transition: "all 0.4s ease",
      }}
    >
      {ROTATING_MESSAGES[index]}
    </span>
  );
}

function StepIcon({ status, justDone }: { status: StepStatus; justDone: boolean }) {
  if (status === "done") {
    return (
      <div
        className="flex h-7 w-7 items-center justify-center rounded-full"
        style={{
          background: "radial-gradient(circle at 40% 35%, rgba(34,197,94,0.7), rgba(34,197,94,0.3) 70%)",
          boxShadow: "inset 0 -1px 3px rgba(0,0,0,0.2), inset 0 1px 2px rgba(255,255,255,0.4), 0 1px 3px rgba(0,0,0,0.1)",
          animation: justDone ? "check-bounce 0.3s ease" : undefined,
        }}
      >
        <Check size={14} strokeWidth={3} color="#fff" />
      </div>
    );
  }

  if (status === "active") {
    return (
      <div
        className="flex h-7 w-7 items-center justify-center rounded-full"
        style={{
          background: "radial-gradient(circle at 40% 35%, rgba(220,103,67,0.7), rgba(220,103,67,0.3) 70%)",
          boxShadow: "inset 0 -1px 3px rgba(0,0,0,0.2), inset 0 1px 2px rgba(255,255,255,0.4), 0 1px 3px rgba(0,0,0,0.1)",
          animation: "pulse-dot 2s ease-in-out infinite",
        }}
      >
        <div className="h-2 w-2 rounded-full bg-white" />
      </div>
    );
  }

  return (
    <div
      className="flex h-7 w-7 items-center justify-center rounded-full"
      style={{
        background: "radial-gradient(circle at 40% 35%, rgba(0,0,0,0.06), rgba(0,0,0,0.02) 70%)",
        boxShadow: "inset 0 -1px 2px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      <div className="h-1.5 w-1.5 rounded-full" style={{ background: "rgba(0,0,0,0.15)" }} />
    </div>
  );
}

export default function ProvisioningStatus() {
  const router = useRouter();
  const [steps, setSteps] = useState<Step[]>([
    { id: "payment", label: "Payment confirmed", status: "done" },
    { id: "assign", label: "Assigning server", status: "active" },
    { id: "configure", label: "Configuring agent", status: "pending" },
    { id: "connect", label: "Connecting channels", status: "pending" },
    { id: "health", label: "Final health check", status: "pending" },
  ]);
  const [justCompleted, setJustCompleted] = useState<Set<string>>(new Set(["payment"]));
  const pollCount = useRef(0);
  const configuredRef = useRef(false);

  useEffect(() => {
    const completeStep = (id: string, nextId?: string) => {
      setSteps((prev) =>
        prev.map((s) => {
          if (s.id === id) return { ...s, status: "done" };
          if (s.id === nextId) return { ...s, status: "active" };
          return s;
        })
      );
      setJustCompleted((prev) => new Set([...prev, id]));
    };

    // Simulate progress based on polling
    const poll = setInterval(async () => {
      pollCount.current++;
      const count = pollCount.current;

      // Step 1: assign (done after ~3s)
      if (count === 3) completeStep("assign", "configure");

      // Step 2: configure (done after ~8s)
      if (count === 8) completeStep("configure", "connect");

      // Step 3: connect (done after ~12s)
      if (count === 12) completeStep("connect", "health");

      // Check actual agent status
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        if (data?.user?.hasAgent && !configuredRef.current) {
          configuredRef.current = true;
          // Complete all remaining steps
          setSteps((prev) => prev.map((s) => ({ ...s, status: "done" as StepStatus })));
          setJustCompleted(new Set(["payment", "assign", "configure", "connect", "health"]));
          setTimeout(() => {
            clearInterval(poll);
            router.refresh();
          }, 1500);
          return;
        }
      } catch { /* keep polling */ }

      // Step 4: health check (done after ~15s even if VM not ready yet)
      if (count === 15 && !configuredRef.current) {
        completeStep("health");
      }

      // After 20s, redirect to dashboard regardless (it has its own provisioning handling)
      if (count >= 20 && !configuredRef.current) {
        clearInterval(poll);
        router.refresh();
      }
    }, 1000);

    return () => clearInterval(poll);
  }, [router]);

  const serif = { fontFamily: "'Instrument Serif', Georgia, serif" };
  const doneCount = steps.filter((s) => s.status === "done").length;

  return (
    <div className="flex h-full flex-col items-center px-6 pt-[10vh] onboarding-light">
      {/* Header */}
      <h2 className="text-2xl tracking-[-0.5px] mb-1" style={{ ...serif, color: "#333334" }}>
        Your agent is powering up
      </h2>
      <div className="h-5 mb-8">
        <RotatingMessage />
      </div>

      {/* Step progress */}
      <div className="w-full max-w-[300px]">
        {steps.map((step, i) => (
          <div key={step.id} className="flex items-start gap-3 mb-1">
            {/* Icon + connector line */}
            <div className="flex flex-col items-center">
              <StepIcon status={step.status} justDone={justCompleted.has(step.id)} />
              {i < steps.length - 1 && (
                <div
                  className="w-[2px] my-1"
                  style={{
                    height: "20px",
                    background: step.status === "done" ? "rgba(34,197,94,0.3)" : "rgba(0,0,0,0.06)",
                    borderRadius: "1px",
                    transition: "background 0.5s ease",
                  }}
                />
              )}
            </div>
            {/* Label */}
            <div className="pt-1">
              <p
                className="text-[14px] font-medium"
                style={{
                  color: step.status === "done" ? "#333334" : step.status === "active" ? "#DC6743" : "#aaa",
                  transition: "color 0.3s ease",
                }}
              >
                {step.label}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Progress count */}
      <p className="mt-6 text-[12px] font-medium" style={{ color: "#6b6b6b" }}>
        Step {doneCount} of {steps.length}
      </p>

      {/* Don't leave message */}
      <p className="mt-8 max-w-[240px] text-center text-[11px]" style={{ color: "#aaa" }}>
        Please don&apos;t close this screen. Your agent will be ready in about a minute.
      </p>
    </div>
  );
}
