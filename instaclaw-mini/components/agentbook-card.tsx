"use client";

import { useState, useEffect, useRef } from "react";
import { MiniKit } from "@worldcoin/minikit-js";
import { Loader2, Check } from "lucide-react";

type Phase = "loading" | "idle" | "starting" | "waiting-url" | "verify" | "registered" | "error";

/**
 * AgentBook registration card — CLI bridge URL flow with closeMiniapp().
 *
 * Flow:
 * 1. CLI generates bridge URL on VM
 * 2. User taps "Verify with World ID" (<a href> triggers drawer)
 * 3. closeMiniapp() closes mini app cleanly
 * 4. User approves in World App drawer
 * 5. CLI submits to relay → on-chain registration
 * 6. Push notification: "Agent Registered!"
 * 7. User taps notification → reopens mini app → badge shows
 */
export default function AgentBookCard() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [bridgeUrl, setBridgeUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const pollRef = useRef<NodeJS.Timeout | null>(null);

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
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

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
        await new Promise(r => setTimeout(r, 2000));
        const urlRes = await fetch("/api/proxy/agentbook/get-bridge-url");
        const urlData = await urlRes.json();
        if (urlData.bridgeUrl) { url = urlData.bridgeUrl; break; }
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
    // Close the mini app after a brief delay to allow the <a href> navigation to fire
    setTimeout(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (typeof (MiniKit as any).closeMiniApp === "function") {
          (MiniKit as any).closeMiniApp();
        } else if (typeof (MiniKit as any).close === "function") {
          (MiniKit as any).close();
        }
      } catch {
        // closeMiniapp not available — that's ok, <a href> already navigated away
      }
    }, 500);
  }

  if (phase === "loading") return null;

  if (phase === "registered") {
    return (
      <div className="animate-fade-in-up glass-card flex items-center gap-3 rounded-2xl p-4" style={{ opacity: 0 }}>
        <div className="relative flex h-8 w-8 items-center justify-center rounded-full overflow-hidden" style={{ background: "radial-gradient(circle at 35% 30%, rgba(59,130,246,0.7), rgba(59,130,246,0.3) 50%, rgba(29,78,216,0.6) 100%)", boxShadow: "0 2px 8px rgba(59,130,246,0.3), inset 0 1px 2px rgba(255,255,255,0.2)" }}>
          <div className="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)" }} />
          <svg className="relative z-10 w-4 h-4" viewBox="0 0 24 24" fill="none">
            <path d="M17.3711 10.9277L13 12.6758V17.999H11V12.6758L6.62891 10.9277L7.37109 9.07031L12 10.9219L16.6289 9.07031L17.3711 10.9277Z" fill="white"/>
            <path d="M12.0389 9.31641C12.7293 9.31641 13.2891 8.75676 13.2891 8.0664C13.2891 7.37605 12.7293 6.81641 12.0389 6.81641C11.3484 6.81641 10.7887 7.37605 10.7887 8.0664C10.7887 8.75676 11.3484 9.31641 12.0389 9.31641Z" fill="white"/>
          </svg>
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold">Registered in AgentBook</p>
          <p className="text-[10px]" style={{ color: "#888" }}>On-chain verified human agent</p>
        </div>
        <Check size={16} style={{ color: "#22c55e" }} />
      </div>
    );
  }

  if (phase === "verify" && bridgeUrl) {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
        <div className="flex items-start gap-3 mb-3">
          <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full overflow-hidden" style={{ background: "radial-gradient(circle at 35% 30%, rgba(59,130,246,0.7), rgba(59,130,246,0.3) 50%, rgba(29,78,216,0.6) 100%)", boxShadow: "0 2px 8px rgba(59,130,246,0.3), inset 0 1px 2px rgba(255,255,255,0.2)" }}>
            <div className="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)" }} />
            <svg className="relative z-10 w-4 h-4" viewBox="0 0 24 24" fill="none">
              <path d="M17.3711 10.9277L13 12.6758V17.999H11V12.6758L6.62891 10.9277L7.37109 9.07031L12 10.9219L16.6289 9.07031L17.3711 10.9277Z" fill="white"/>
              <path d="M12.0389 9.31641C12.7293 9.31641 13.2891 8.75676 13.2891 8.0664C13.2891 7.37605 12.7293 6.81641 12.0389 6.81641C11.3484 6.81641 10.7887 7.37605 10.7887 8.0664C10.7887 8.75676 11.3484 9.31641 12.0389 9.31641Z" fill="white"/>
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold mb-0.5">Verify with World ID</p>
            <p className="text-[10px]" style={{ color: "#888" }}>
              Tap below to verify. The app will close briefly — you&apos;ll get a notification when done.
            </p>
          </div>
        </div>

        <a
          href={bridgeUrl}
          onClick={handleVerifyTap}
          className="w-full rounded-xl py-3 text-[13px] font-bold transition-all active:scale-[0.97] flex items-center justify-center gap-2"
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
    );
  }

  if (phase === "starting" || phase === "waiting-url") {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
        <div className="flex items-center justify-center gap-2 py-4">
          <Loader2 size={16} className="animate-spin" style={{ color: "#4d8eff" }} />
          <p className="text-xs" style={{ color: "#999" }}>
            {phase === "starting" ? "Starting registration..." : "Preparing verification..."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
      <div className="flex items-start gap-3 mb-3">
        <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full overflow-hidden" style={{ background: "radial-gradient(circle at 35% 30%, rgba(59,130,246,0.7), rgba(59,130,246,0.3) 50%, rgba(29,78,216,0.6) 100%)", boxShadow: "0 2px 8px rgba(59,130,246,0.3), inset 0 1px 2px rgba(255,255,255,0.2)" }}>
          <div className="absolute inset-0 rounded-full" style={{ background: "radial-gradient(circle at 30% 25%, rgba(255,255,255,0.45) 0%, transparent 50%)" }} />
          <svg className="relative z-10 w-4 h-4" viewBox="0 0 24 24" fill="none">
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
        <p className="text-[10px] mb-2 text-left whitespace-pre-wrap break-all" style={{ color: "#f87171" }}>{error}</p>
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
