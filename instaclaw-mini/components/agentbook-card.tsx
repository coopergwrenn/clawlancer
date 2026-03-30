"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Check, Copy } from "lucide-react";

type Phase = "idle" | "loading" | "starting" | "waiting-bridge" | "bridge-ready" | "confirming" | "registered" | "error";

/**
 * AgentBook registration card for the mini app home page.
 * Matches the web app's WorldIDSection Phase 2 flow.
 *
 * Flow: check status → start CLI on VM → poll for bridge URL → show link → poll for on-chain confirmation → done
 */
export default function AgentBookCard() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [bridgeUrl, setBridgeUrl] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copiedBridge, setCopiedBridge] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check initial status on mount
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
          // No wallet or not verified — hide card
          setPhase("error");
          setError(data.error || "Not eligible yet");
        }
      } catch {
        setPhase("error");
        setError("Failed to check status");
      }
    })();
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function startRegistration() {
    if (phase === "starting" || phase === "waiting-bridge") return; // prevent double-tap
    setPhase("starting");
    setError("");
    try {
      const res = await fetch("/api/proxy/agentbook/start-registration", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to start registration");
      }
      // Start polling for bridge URL (timeout after 90s)
      setPhase("waiting-bridge");
      const bridgeStart = Date.now();
      pollRef.current = setInterval(async () => {
        if (Date.now() - bridgeStart > 90000) {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase("error");
          setError("Took too long. Please try again.");
          return;
        }
        try {
          const urlRes = await fetch("/api/proxy/agentbook/get-bridge-url");
          const urlData = await urlRes.json();
          if (urlData.status === "ready" && urlData.bridgeUrl) {
            setBridgeUrl(urlData.bridgeUrl);
            setPhase("bridge-ready");
            if (pollRef.current) clearInterval(pollRef.current);
            // Start polling for on-chain confirmation (timeout after 5min)
            const confirmStart = Date.now();
            pollRef.current = setInterval(async () => {
              if (Date.now() - confirmStart > 300000) {
                if (pollRef.current) clearInterval(pollRef.current);
                setPhase("error");
                setError("Confirmation timed out. Check again later.");
                return;
              }
              try {
                const checkRes = await fetch("/api/proxy/agentbook/check-registration");
                const checkData = await checkRes.json();
                if (checkData.registered) {
                  setPhase("registered");
                  if (pollRef.current) clearInterval(pollRef.current);
                }
              } catch {}
            }, 5000);
          } else if (urlData.status === "error") {
            setPhase("error");
            setError(urlData.error || "Registration failed");
            if (pollRef.current) clearInterval(pollRef.current);
          }
        } catch {}
      }, 2000);
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : "Failed to start");
    }
  }

  // Don't render if loading, not eligible, or pre-register failed (wallet not ready, not verified, etc.)
  if (phase === "loading") return null;
  // Hide card for any pre-register error — only show when wallet is ready or during active registration
  if (phase === "error" && !error.includes("Registration failed") && !error.includes("Took too long") && !error.includes("Confirmation timed out")) return null;

  // Already registered — show success badge
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

  // Idle — show register prompt
  if (phase === "idle") {
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
              Prove a real human runs your agent. On-chain, free, takes 30 seconds.
            </p>
          </div>
        </div>
        <button
          onClick={startRegistration}
          className="w-full rounded-xl py-3 text-[13px] font-bold transition-all active:scale-[0.97] flex items-center justify-center gap-2"
          style={{
            background: "linear-gradient(170deg, #2563eb, #1d4ed8)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#fff",
            boxShadow: "0 4px 16px rgba(37,99,235,0.35), inset 0 1px 0 rgba(255,255,255,0.2), 0 1px 3px rgba(0,0,0,0.15)",
            textShadow: "0 1px 2px rgba(0,0,0,0.2)",
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

  // Starting / waiting for bridge URL
  if (phase === "starting" || phase === "waiting-bridge") {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
        <div className="flex items-center justify-center gap-2 py-4">
          <Loader2 size={16} className="animate-spin" style={{ color: "#4d8eff" }} />
          <p className="text-xs" style={{ color: "#999" }}>
            {phase === "starting" ? "Starting registration..." : "Waiting for verification link..."}
          </p>
        </div>
      </div>
    );
  }

  // Bridge URL ready — show copyable link (WebView can't open World ID natively)
  if (phase === "bridge-ready" && bridgeUrl) {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
        <p className="text-sm font-semibold mb-2 text-center">Almost there!</p>
        <p className="text-[11px] text-center mb-4" style={{ color: "#888" }}>
          Open this link in your phone&apos;s browser to complete on-chain verification.
        </p>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(bridgeUrl);
              setCopiedBridge(true);
              setTimeout(() => setCopiedBridge(false), 2000);
            } catch {
              const input = document.createElement("input");
              input.value = bridgeUrl;
              document.body.appendChild(input);
              input.select();
              document.execCommand("copy");
              document.body.removeChild(input);
              setCopiedBridge(true);
              setTimeout(() => setCopiedBridge(false), 2000);
            }
          }}
          className="w-full rounded-xl py-3 text-sm font-bold flex items-center justify-center gap-2 active:scale-[0.97] transition-all"
          style={{
            background: copiedBridge ? "rgba(34,197,94,0.15)" : "linear-gradient(170deg, #2563eb, #1d4ed8)",
            color: copiedBridge ? "#22c55e" : "#fff",
            border: copiedBridge ? "1px solid rgba(34,197,94,0.3)" : "1px solid rgba(255,255,255,0.12)",
            boxShadow: copiedBridge ? "none" : "0 4px 16px rgba(37,99,235,0.35), inset 0 1px 0 rgba(255,255,255,0.2)",
          }}
        >
          {copiedBridge ? <><Check size={14} /> Link copied!</> : <><Copy size={14} /> Copy verification link</>}
        </button>
        <div className="flex items-center justify-center gap-2 mt-3">
          <Loader2 size={12} className="animate-spin" style={{ color: "#666" }} />
          <p className="text-[10px]" style={{ color: "#666" }}>Waiting for on-chain confirmation...</p>
        </div>
      </div>
    );
  }

  // Confirming on-chain
  if (phase === "confirming") {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
        <div className="flex items-center justify-center gap-2 py-4">
          <Loader2 size={16} className="animate-spin" style={{ color: "#4d8eff" }} />
          <p className="text-xs" style={{ color: "#999" }}>Confirming on-chain...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (phase === "error") {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
        <p className="text-xs text-center mb-2" style={{ color: "#f87171" }}>{error}</p>
        <button
          onClick={() => { setError(""); setPhase("idle"); }}
          className="w-full text-center text-[11px] font-medium"
          style={{ color: "#4d8eff" }}
        >
          Try again
        </button>
      </div>
    );
  }

  return null;
}
