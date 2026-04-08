"use client";

import { useState, useEffect, useRef } from "react";
import { MiniKit } from "@worldcoin/minikit-js";
import { Loader2 } from "lucide-react";

type Phase = "loading" | "idle" | "starting" | "waiting-url" | "verify" | "registered" | "not-eligible";

/**
 * Full-screen modal that prompts new users to register in AgentBook immediately
 * after onboarding. NOT skippable unless the user doesn't have World ID.
 *
 * Flow:
 * 1. Check pre-register status
 * 2. If not registered → show modal with "Register your agent"
 * 3. User taps → CLI generates bridge URL on VM
 * 4. "Verify with World ID" button appears → <a href> triggers drawer
 * 5. closeMiniapp() → user approves → push notification → reopens → badge shows
 */
export default function AgentBookOnboardModal({
  onComplete,
}: {
  onComplete: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [bridgeUrl, setBridgeUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/proxy/agentbook/pre-register");
        const data = await res.json();
        if (data.alreadyRegistered) {
          // Already done — dismiss immediately
          onComplete();
        } else if (data.walletAddress) {
          setPhase("idle");
        } else {
          // Not eligible (no World ID, no wallet) — let them skip
          setPhase("not-eligible");
        }
      } catch {
        setPhase("not-eligible");
      }
    })();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [onComplete]);

  async function handleRegister() {
    if (phase !== "idle") return;
    setError("");
    setPhase("starting");

    try {
      const startRes = await fetch("/api/proxy/agentbook/start-registration", { method: "POST" });
      if (!startRes.ok) {
        const d = await startRes.json().catch(() => ({}));
        throw new Error(d.error || "Failed to start");
      }

      setPhase("waiting-url");
      let url: string | null = null;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const urlRes = await fetch("/api/proxy/agentbook/get-bridge-url");
        const urlData = await urlRes.json();
        if (urlData.bridgeUrl) {
          url = urlData.bridgeUrl;
          break;
        }
        if (urlData.status === "error") throw new Error(urlData.error || "CLI failed");
      }
      if (!url) throw new Error("Timed out waiting for verification link");

      setBridgeUrl(url);
      setPhase("verify");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPhase("idle");
    }
  }

  function handleVerifyTap() {
    // Close mini app IMMEDIATELY — no delay. This fires before the <a href>
    // navigation, so the mini app closes cleanly and World App shows the
    // AgentKit drawer on its home screen.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mk = MiniKit as any;
      if (typeof mk.closeMiniApp === "function") {
        mk.closeMiniApp();
      } else if (typeof mk.close === "function") {
        mk.close();
      } else if (typeof mk.commands?.closeMiniApp === "function") {
        mk.commands.closeMiniApp();
      }
    } catch {
      // closeMiniApp not available — <a href> will still navigate
    }
  }

  // Not eligible (no World ID) — skippable
  if (phase === "not-eligible") {
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-6"
        style={{
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          background: "rgba(0,0,0,0.7)",
        }}
      >
        <div
          className="animate-fade-in-up w-full max-w-[340px] rounded-3xl p-6"
          style={{
            opacity: 0,
            background: "linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))",
            border: "1px solid rgba(255,255,255,0.1)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)",
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
          }}
        >
          <p className="text-center text-sm mb-4" style={{ color: "#888" }}>
            AgentBook registration requires World ID verification. You can register later from your dashboard.
          </p>
          <button
            onClick={onComplete}
            className="w-full rounded-xl py-3 text-[13px] font-semibold"
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "#aaa",
            }}
          >
            Continue to dashboard
          </button>
        </div>
      </div>
    );
  }

  // Loading
  if (phase === "loading") return null;

  // Verify step — show the <a href> button
  if (phase === "verify" && bridgeUrl) {
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-6"
        style={{
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          background: "rgba(0,0,0,0.7)",
        }}
      >
        <div
          className="animate-fade-in-up w-full max-w-[340px] rounded-3xl p-6 text-center"
          style={{
            opacity: 0,
            background: "linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))",
            border: "1px solid rgba(255,255,255,0.1)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)",
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
          }}
        >
          {/* Icon */}
          <div
            className="mx-auto mb-4"
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: "radial-gradient(circle at 35% 30%, rgba(59,130,246,0.5), rgba(59,130,246,0.15) 60%)",
              boxShadow: "0 4px 16px rgba(59,130,246,0.2), inset 0 1px 2px rgba(255,255,255,0.2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M17.3711 10.9277L13 12.6758V17.999H11V12.6758L6.62891 10.9277L7.37109 9.07031L12 10.9219L16.6289 9.07031L17.3711 10.9277Z" fill="white" />
              <path d="M12.0389 9.31641C12.7293 9.31641 13.2891 8.75676 13.2891 8.0664C13.2891 7.37605 12.7293 6.81641 12.0389 6.81641C11.3484 6.81641 10.7887 7.37605 10.7887 8.0664C10.7887 8.75676 11.3484 9.31641 12.0389 9.31641Z" fill="white" />
            </svg>
          </div>

          <h2 className="text-lg font-bold mb-1">One last step</h2>
          <p className="text-[12px] mb-5" style={{ color: "#888", lineHeight: 1.6 }}>
            Tap below to verify your agent with World ID. You&apos;ll approve on the next screen and be right back.
          </p>

          <a
            href={bridgeUrl}
            onClick={handleVerifyTap}
            className="flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-[14px] font-bold transition-all active:scale-[0.97]"
            style={{
              background: "linear-gradient(170deg, #2563eb, #1d4ed8)",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "#fff",
              boxShadow: "0 4px 16px rgba(37,99,235,0.35), inset 0 1px 0 rgba(255,255,255,0.2)",
              textDecoration: "none",
            }}
          >
            Verify with World ID
          </a>
        </div>
      </div>
    );
  }

  // Starting / waiting for bridge URL
  if (phase === "starting" || phase === "waiting-url") {
    return (
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-6"
        style={{
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          background: "rgba(0,0,0,0.7)",
        }}
      >
        <div
          className="animate-fade-in-up w-full max-w-[340px] rounded-3xl p-6 text-center"
          style={{
            opacity: 0,
            background: "linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))",
            border: "1px solid rgba(255,255,255,0.1)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)",
            backdropFilter: "blur(24px)",
            WebkitBackdropFilter: "blur(24px)",
          }}
        >
          <Loader2 size={24} className="animate-spin mx-auto mb-3" style={{ color: "#3b82f6" }} />
          <p className="text-sm font-medium mb-1">Preparing verification</p>
          <p className="text-[11px]" style={{ color: "#666" }}>
            {phase === "starting" ? "Setting up your agent..." : "Generating verification link..."}
          </p>
        </div>
      </div>
    );
  }

  // Main prompt — idle state
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6"
      style={{
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        background: "rgba(0,0,0,0.7)",
      }}
    >
      <div
        className="animate-fade-in-up w-full max-w-[340px] rounded-3xl p-6 text-center"
        style={{
          opacity: 0,
          background: "linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03))",
          border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
        }}
      >
        {/* Icon */}
        <div
          className="mx-auto mb-4"
          style={{
            width: 64,
            height: 64,
            borderRadius: 20,
            background: "radial-gradient(circle at 35% 30%, rgba(59,130,246,0.5), rgba(59,130,246,0.15) 60%)",
            boxShadow: "0 4px 16px rgba(59,130,246,0.2), inset 0 1px 2px rgba(255,255,255,0.2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path d="M17.3711 10.9277L13 12.6758V17.999H11V12.6758L6.62891 10.9277L7.37109 9.07031L12 10.9219L16.6289 9.07031L17.3711 10.9277Z" fill="white" />
            <path d="M12.0389 9.31641C12.7293 9.31641 13.2891 8.75676 13.2891 8.0664C13.2891 7.37605 12.7293 6.81641 12.0389 6.81641C11.3484 6.81641 10.7887 7.37605 10.7887 8.0664C10.7887 8.75676 11.3484 9.31641 12.0389 9.31641Z" fill="white" />
          </svg>
        </div>

        <h2 className="text-xl font-bold mb-1" style={{ letterSpacing: "-0.3px" }}>
          Register your agent
        </h2>
        <p className="text-[12px] mb-2" style={{ color: "#888", lineHeight: 1.6 }}>
          Prove a verified human runs your agent. This registers your agent on-chain in the global AgentBook registry.
        </p>
        <p className="text-[11px] mb-5" style={{ color: "#555", lineHeight: 1.5 }}>
          On-chain verified agents get priority access to services, earn trust with other agents, and unlock future features.
        </p>

        {error && (
          <p className="text-[11px] mb-3 text-left" style={{ color: "#f87171" }}>{error}</p>
        )}

        <button
          onClick={handleRegister}
          className="w-full rounded-xl py-3.5 text-[14px] font-bold transition-all active:scale-[0.97]"
          style={{
            background: "linear-gradient(170deg, #2563eb, #1d4ed8)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#fff",
            boxShadow: "0 4px 16px rgba(37,99,235,0.35), inset 0 1px 0 rgba(255,255,255,0.2)",
          }}
        >
          Register now
        </button>
      </div>
    </div>
  );
}
