"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";

type StepStatus = "pending" | "active" | "done";
type Phase = "provisioning" | "complete" | "timeout";

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
  const [phase, setPhase] = useState<Phase>("provisioning");
  const [steps, setSteps] = useState<Step[]>([
    { id: "payment", label: "Payment confirmed", status: "done" },
    { id: "assign", label: "Assigning server", status: "active" },
    { id: "configure", label: "Configuring agent", status: "pending" },
    { id: "connect", label: "Connecting channels", status: "pending" },
    { id: "health", label: "Final health check", status: "pending" },
  ]);
  const [justCompleted, setJustCompleted] = useState<Set<string>>(new Set(["payment"]));
  const pollCount = useRef(0);
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;

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

    const finishAll = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      setSteps((prev) => prev.map((s) => ({ ...s, status: "done" as StepStatus })));
      setJustCompleted(new Set(["payment", "assign", "configure", "connect", "health"]));
      setTimeout(() => setPhase("complete"), 800);
      setTimeout(() => router.refresh(), 2500);
    };

    const poll = setInterval(async () => {
      pollCount.current++;
      const count = pollCount.current;

      // Timed step progression
      if (count === 3 && !doneRef.current) completeStep("assign", "configure");
      if (count === 8 && !doneRef.current) completeStep("configure", "connect");
      if (count === 12 && !doneRef.current) completeStep("connect", "health");
      if (count === 16 && !doneRef.current) completeStep("health");

      // Poll for real agent readiness
      try {
        const res = await fetch("/api/auth/me");
        const data = await res.json();
        if (data?.user?.hasAgent) {
          clearInterval(poll);
          finishAll();
          return;
        }
      } catch { /* keep polling */ }

      // After all timed steps done (18s), wait a beat then finish
      if (count >= 18 && !doneRef.current) {
        finishAll();
      }

      // Hard timeout at 60s
      if (count >= 60 && !doneRef.current) {
        clearInterval(poll);
        doneRef.current = true;
        setPhase("timeout");
      }
    }, 1000);

    return () => clearInterval(poll);
  }, [router]);

  const serif = { fontFamily: "'Instrument Serif', Georgia, serif" };
  const doneCount = steps.filter((s) => s.status === "done").length;

  // ── Complete: "All systems go!" then auto-navigate ──
  if (phase === "complete") {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 onboarding-light animate-fade-in" style={{ opacity: 0 }}>
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full" style={{ background: "radial-gradient(circle at 40% 35%, rgba(34,197,94,0.15), rgba(34,197,94,0.04) 70%)" }}>
          <Check size={32} strokeWidth={2} color="#22c55e" />
        </div>
        <h2 className="text-2xl tracking-[-0.5px]" style={{ ...serif, color: "#333334" }}>All systems go!</h2>
        <p className="mt-2 text-[14px]" style={{ color: "#6b6b6b" }}>Loading your dashboard...</p>
      </div>
    );
  }

  // ── Timeout fallback ──
  if (phase === "timeout") {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 onboarding-light">
        <h2 className="text-xl tracking-[-0.5px] mb-2" style={{ ...serif, color: "#333334" }}>Taking longer than expected</h2>
        <p className="max-w-[260px] text-center text-[13px] leading-relaxed mb-6" style={{ color: "#6b6b6b" }}>
          Your agent is almost ready. You can close this and come back, or go to the dashboard now.
        </p>
        <button
          onClick={() => router.refresh()}
          className="btn-primary rounded-[28px] px-8 py-3 text-sm font-semibold"
        >
          Go to dashboard
        </button>
      </div>
    );
  }

  // ── Provisioning in progress ──
  return (
    <div className="flex h-full flex-col items-center px-6 pt-[10vh] onboarding-light">
      <h2 className="text-2xl tracking-[-0.5px] mb-1" style={{ ...serif, color: "#333334" }}>
        Your agent is powering up
      </h2>
      <div className="h-5 mb-8">
        <RotatingMessage />
      </div>

      <div className="w-full max-w-[300px]">
        {steps.map((step, i) => (
          <div key={step.id} className="flex items-start gap-3 mb-1">
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

      <p className="mt-6 text-[12px] font-medium" style={{ color: "#6b6b6b" }}>
        Step {doneCount} of {steps.length}
      </p>

      <p className="mt-8 max-w-[240px] text-center text-[11px]" style={{ color: "#aaa" }}>
        Please don&apos;t close this screen. Your agent will be ready in about a minute.
      </p>
    </div>
  );
}
