"use client";

import { useState, useEffect } from "react";
import { MiniKit, VerificationLevel } from "@worldcoin/minikit-js";
import { Loader2, Check } from "lucide-react";

type Phase = "loading" | "idle" | "verifying" | "submitting" | "registered" | "error";

/**
 * AgentBook registration card — one-tap flow using MiniKit native verification.
 *
 * 1. User taps "Register now"
 * 2. MiniKit.verify() triggers native World ID verification (in-app, no browser)
 * 3. Proof submitted to our backend → gasless relay → on-chain
 * 4. "Registered in AgentBook" badge
 */
export default function AgentBookCard() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [error, setError] = useState("");

  // Check status on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/proxy/agentbook/pre-register");
        const data = await res.json();
        if (data.alreadyRegistered) {
          setPhase("registered");
          setWalletAddress(data.walletAddress);
        } else if (data.walletAddress) {
          setWalletAddress(data.walletAddress);
          setPhase("idle");
        } else {
          setPhase("error");
          setError(data.error || "Not eligible");
        }
      } catch {
        setPhase("error");
        setError("Failed to check status");
      }
    })();
  }, []);

  async function handleRegister() {
    if (phase === "verifying" || phase === "submitting") return;
    setPhase("verifying");
    setError("");

    try {
      // Step 1: Native World ID verification via MiniKit
      const verifyResult = await MiniKit.commandsAsync.verify({
        action: "verify-instaclaw-agent",
        signal: walletAddress || undefined,
        verification_level: VerificationLevel.Orb,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = verifyResult.finalPayload as any;

      if (payload.status !== "success") {
        setError(payload.error_code === "user_rejected" ? "Verification cancelled" : "Verification failed");
        setPhase("idle");
        return;
      }

      // Step 2: Submit proof to our backend → gasless relay
      setPhase("submitting");

      const res = await fetch("/api/agentbook/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof: payload.proof,
          merkle_root: payload.merkle_root,
          nullifier_hash: payload.nullifier_hash,
          verification_level: payload.verification_level,
        }),
      });

      const data = await res.json();

      if (data.registered) {
        setPhase("registered");
      } else {
        setError(data.error || "Registration failed");
        setPhase("idle");
      }
    } catch (err) {
      console.error("[AgentBook] Registration error:", err);
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPhase("idle");
    }
  }

  // Show badge if registered, hide if not ready or not registered
  if (phase === "loading") return null;
  if (phase !== "registered" && phase !== "idle") return null;
  if (phase === "idle") return null; // User can register via web dashboard

  // Registered badge
  if (phase === "registered") {
    return (
      <div className="animate-fade-in-up glass-card flex items-center gap-3 rounded-2xl p-4" style={{ opacity: 0 }}>
        <div className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: "rgba(0,92,255,0.12)" }}>
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" fill="#005CFF"/>
            <path d="M17.3711 10.9277L13 12.6758V17.999H11V12.6758L6.62891 10.9277L7.37109 9.07031L12 10.9219L16.6289 9.07031L17.3711 10.9277Z" fill="white"/>
            <path d="M12.0389 9.31641C12.7293 9.31641 13.2891 8.75676 13.2891 8.0664C13.2891 7.37605 12.7293 6.81641 12.0389 6.81641C11.3484 6.81641 10.7887 7.37605 10.7887 8.0664C10.7887 8.75676 11.3484 9.31641 12.0389 9.31641Z" fill="white"/>
          </svg>
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold">Registered in AgentBook</p>
          <p className="text-[10px]" style={{ color: "#888" }}>On-chain verified human agent</p>
        </div>
        <Check size={16} style={{ color: "#005CFF" }} />
      </div>
    );
  }

  // Idle — register prompt
  if (phase === "idle" || phase === "error") {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
        <div className="flex items-start gap-3 mb-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: "rgba(0,92,255,0.1)" }}>
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" fill="#005CFF"/>
              <path d="M17.3711 10.9277L13 12.6758V17.999H11V12.6758L6.62891 10.9277L7.37109 9.07031L12 10.9219L16.6289 9.07031L17.3711 10.9277Z" fill="white"/>
              <path d="M12.0389 9.31641C12.7293 9.31641 13.2891 8.75676 13.2891 8.0664C13.2891 7.37605 12.7293 6.81641 12.0389 6.81641C11.3484 6.81641 10.7887 7.37605 10.7887 8.0664C10.7887 8.75676 11.3484 9.31641 12.0389 9.31641Z" fill="white"/>
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold mb-0.5">Register in AgentBook</p>
            <p className="text-[10px]" style={{ color: "#888" }}>
              Prove a real human runs your agent. On-chain, free, one tap.
            </p>
          </div>
        </div>
        {error && (
          <p className="text-[11px] mb-2 text-center" style={{ color: "#f87171" }}>{error}</p>
        )}
        <button
          onClick={handleRegister}
          className="w-full rounded-xl py-3 text-[13px] font-bold transition-all active:scale-[0.97] flex items-center justify-center gap-2"
          style={{
            background: "linear-gradient(170deg, #2563eb, #1d4ed8)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#fff",
            boxShadow: "0 4px 16px rgba(37,99,235,0.35), inset 0 1px 0 rgba(255,255,255,0.2)",
          }}
        >
          Register now
        </button>
        {walletAddress && (
          <p className="text-[9px] text-center mt-2" style={{ color: "#555" }}>
            Agent wallet: {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
          </p>
        )}
      </div>
    );
  }

  // Verifying / submitting
  return (
    <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
      <div className="flex items-center justify-center gap-2 py-4">
        <Loader2 size={16} className="animate-spin" style={{ color: "#4d8eff" }} />
        <p className="text-xs" style={{ color: "#999" }}>
          {phase === "verifying" ? "Verifying with World ID..." : "Registering on-chain..."}
        </p>
      </div>
    </div>
  );
}
