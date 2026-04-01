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
      className="shimmer-text text-[15px]"
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
  const size = "h-11 w-11"; // 44px — comfortable touch target

  if (status === "done") {
    return (
      <div
        className={`flex ${size} items-center justify-center rounded-full`}
        style={{
          background: "radial-gradient(circle at 40% 35%, rgba(34,197,94,0.7), rgba(34,197,94,0.3) 70%)",
          boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.25), inset 0 2px 3px rgba(255,255,255,0.4), 0 2px 6px rgba(0,0,0,0.12)",
          animation: justDone ? "check-bounce 0.3s ease" : undefined,
        }}
      >
        <Check size={20} strokeWidth={3} color="#fff" />
      </div>
    );
  }

  if (status === "active") {
    return (
      <div
        className={`flex ${size} items-center justify-center rounded-full`}
        style={{
          background: "radial-gradient(circle at 40% 35%, rgba(218,119,86,0.7), rgba(218,119,86,0.3) 70%)",
          boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.25), inset 0 2px 3px rgba(255,255,255,0.4), 0 2px 6px rgba(0,0,0,0.12)",
          animation: "pulse-dot 2s ease-in-out infinite",
        }}
      >
        <div className="h-3 w-3 rounded-full bg-white" />
      </div>
    );
  }

  return (
    <div
      className={`flex ${size} items-center justify-center rounded-full`}
      style={{
        background: "radial-gradient(circle at 40% 35%, rgba(0,0,0,0.06), rgba(0,0,0,0.02) 70%)",
        boxShadow: "inset 0 -1px 2px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      <div className="h-2 w-2 rounded-full" style={{ background: "rgba(0,0,0,0.12)" }} />
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

      // Hard timeout at 90s — only finish if agent actually exists
      if (count >= 90 && !doneRef.current) {
        clearInterval(poll);
        doneRef.current = true;
        setPhase("timeout");
      }
    }, 1000);

    return () => clearInterval(poll);
  }, [router]);

  const serif = { fontFamily: "'Instrument Serif', Georgia, serif" };
  const doneCount = steps.filter((s) => s.status === "done").length;

  // ── Complete: "All systems go!" with dashboard content ──
  if (phase === "complete") {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 onboarding-light animate-fade-in" style={{ opacity: 0 }}>
        <div className="mb-8 flex h-20 w-20 items-center justify-center rounded-full" style={{ background: "radial-gradient(circle at 40% 35%, rgba(34,197,94,0.15), rgba(34,197,94,0.04) 70%)" }}>
          <Check size={40} strokeWidth={2} color="#22c55e" />
        </div>
        <h2 className="text-[32px] tracking-[-0.5px]" style={{ ...serif, color: "#333334" }}>All systems go!</h2>
        <p className="mt-3 max-w-[280px] text-center text-[15px] leading-relaxed" style={{ color: "#6b6b6b" }}>
          Your agent is ready. Start chatting or explore your dashboard.
        </p>
        <div className="mt-8 flex flex-col gap-3 w-full max-w-[300px]">
          <button
            onClick={() => window.location.href = "/home?t=" + Date.now()}
            className="btn-primary w-full rounded-[28px] text-base font-semibold"
            style={{ height: "56px" }}
          >
            Go to my dashboard
          </button>
        </div>
      </div>
    );
  }

  // ── Timeout fallback with retry ──
  if (phase === "timeout") {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 onboarding-light">
        <h2 className="text-[28px] tracking-[-0.5px] mb-3" style={{ ...serif, color: "#333334" }}>Taking longer than expected</h2>
        <p className="max-w-[300px] text-center text-[15px] leading-relaxed mb-6" style={{ color: "#6b6b6b" }}>
          Setup hit a snag. Tap retry to try again — this usually fixes it.
        </p>
        <div className="flex flex-col gap-3 w-full max-w-[300px]">
          <button
            onClick={async () => {
              setPhase("provisioning");
              doneRef.current = false;
              pollCount.current = 0;
              setSteps([
                { id: "payment", label: "Payment confirmed", status: "done" },
                { id: "assign", label: "Assigning server", status: "active" },
                { id: "configure", label: "Configuring agent", status: "pending" },
                { id: "connect", label: "Connecting channels", status: "pending" },
                { id: "health", label: "Final health check", status: "pending" },
              ]);
              // Re-trigger configure
              try {
                await fetch("/api/agent/retry-configure", { method: "POST" });
              } catch { /* fire-and-forget */ }
            }}
            className="btn-primary w-full rounded-[28px] text-base font-semibold"
            style={{ height: "56px" }}
          >
            Retry setup
          </button>
          <button
            onClick={() => window.location.href = "/home?t=" + Date.now()}
            className="w-full rounded-[28px] text-base font-medium"
            style={{ height: "48px", color: "#6b6b6b", background: "rgba(0,0,0,0.04)", border: "1px solid rgba(0,0,0,0.08)" }}
          >
            Go to dashboard anyway
          </button>
        </div>
      </div>
    );
  }

  // ── Provisioning in progress ──
  return (
    <div className="flex h-full flex-col items-center px-8 pt-[8vh] onboarding-light">
      <h2 className="text-[32px] tracking-[-0.5px] mb-2" style={{ ...serif, color: "#333334" }}>
        Your agent is powering up
      </h2>
      <div className="h-6 mb-10">
        <RotatingMessage />
      </div>

      <div className="w-full max-w-[320px]">
        {steps.map((step, i) => (
          <div key={step.id} className="flex items-start gap-4 mb-1">
            <div className="flex flex-col items-center">
              <StepIcon status={step.status} justDone={justCompleted.has(step.id)} />
              {i < steps.length - 1 && (
                <div
                  className="my-1.5"
                  style={{
                    width: "3px",
                    height: "24px",
                    background: step.status === "done" ? "rgba(34,197,94,0.3)" : "rgba(0,0,0,0.06)",
                    borderRadius: "2px",
                    transition: "background 0.5s ease",
                  }}
                />
              )}
            </div>
            <div className="pt-2.5">
              <p
                className="text-[17px] font-medium"
                style={{
                  color: step.status === "done" ? "#333334" : step.status === "active" ? "#da7756" : "#aaa",
                  transition: "color 0.3s ease",
                }}
              >
                {step.label}
              </p>
            </div>
          </div>
        ))}
      </div>

      <p className="mt-8 text-[14px] font-medium" style={{ color: "#6b6b6b" }}>
        Step {doneCount} of {steps.length}
      </p>

      <p className="mt-8 max-w-[280px] text-center text-[13px] leading-relaxed" style={{ color: "#aaa" }}>
        Please don&apos;t close this screen. Your agent will be ready in about a minute.
      </p>
    </div>
  );
}
