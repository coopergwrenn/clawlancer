"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2, Check } from "lucide-react";
import { encodeAction, generateSignal } from "@worldcoin/idkit-core/hashing";
import { solidityEncode } from "@worldcoin/idkit-core/hashing";
import { VerificationLevel } from "@worldcoin/idkit-core";

type Phase = "loading" | "idle" | "verifying" | "submitting" | "registered" | "error";

const AGENTKIT_APP_ID = "app_a7c3e2b6b83927251a0db5345bd7146a";
const AGENTKIT_ACTION = "agentbook-registration";

// Feature flag: use native transport (sends verify directly to World App native layer)
// Set NEXT_PUBLIC_AGENTBOOK_NATIVE=true to enable, otherwise falls back to CLI bridge URL flow
const USE_NATIVE_TRANSPORT = process.env.NEXT_PUBLIC_AGENTBOOK_NATIVE === "true";

/**
 * AgentBook registration card — triggers World ID verification natively
 * inside World App using the same native bridge as MiniKit/IDKit.
 *
 * Flow:
 * 1. Fetch wallet + nonce from pre-register endpoint
 * 2. User taps "Register now"
 * 3. Send verify command directly to World App native layer with AgentKit's app_id
 * 4. Native World ID popup appears → user verifies
 * 5. Proof returned via postMessage → submit to backend for on-chain registration
 * 6. "Registered in AgentBook" badge
 */
export default function AgentBookCard() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [nonce, setNonce] = useState<string | null>(null);
  const [error, setError] = useState("");
  const cleanupRef = useRef<(() => void) | null>(null);

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
          setNonce(data.nonce || "0");
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

    return () => { cleanupRef.current?.(); };
  }, []);

  // ── Native transport: send verify command directly to World App native layer ──
  async function handleRegisterNative() {
    if (!walletAddress || nonce === null) return;

    // Build the signal matching agentkit-cli: solidityEncode(['address', 'uint256'], [wallet, nonce])
    const signal = solidityEncode(
      ["address", "uint256"],
      [walletAddress as `0x${string}`, BigInt(nonce)]
    );

    const verifyPayload = {
      command: "verify",
      version: 1,
      payload: {
        app_id: AGENTKIT_APP_ID,
        action: encodeAction(AGENTKIT_ACTION),
        signal: generateSignal(signal).digest,
        verification_level: VerificationLevel.Orb,
        timestamp: new Date().toISOString(),
      },
    };

    console.log("[AgentBook] Sending native verify:", JSON.stringify(verifyPayload));

    const proof = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error("Verification timed out")); }, 300000);

      function handleMessage(event: MessageEvent) {
        const data = event.data;
        if (data?.type === "miniapp-verify-action" || data?.command === "miniapp-verify-action") {
          cleanup();
          const p = data.payload ?? data;
          if (p?.status === "error" || p?.error_code) reject(new Error(p.error_code || "Verification failed"));
          else resolve(p);
        }
      }

      function cleanup() {
        clearTimeout(timeout);
        window.removeEventListener("message", handleMessage);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        try { (window as any).MiniKit?.unsubscribe?.("miniapp-verify-action"); } catch { /* */ }
      }
      cleanupRef.current = cleanup;
      window.addEventListener("message", handleMessage);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { const mk = (window as any).MiniKit; if (typeof mk?.subscribe === "function") mk.subscribe("miniapp-verify-action", (r: Record<string, unknown>) => { cleanup(); const p = (r as { payload?: Record<string, unknown> })?.payload ?? r; if ((p as { error_code?: string })?.error_code) reject(new Error((p as { error_code?: string }).error_code!)); else resolve(p); }); } catch { /* */ }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      if (w.webkit?.messageHandlers?.minikit) w.webkit.messageHandlers.minikit.postMessage(verifyPayload);
      else if (w.Android) w.Android.postMessage(JSON.stringify(verifyPayload));
      else { cleanup(); reject(new Error("Not running inside World App")); }
    });

    console.log("[AgentBook] Proof received:", JSON.stringify(proof));
    return proof;
  }

  // ── Bridge URL flow: start CLI on VM, get bridge URL, poll for registration ──
  async function handleRegisterBridge() {
    const startRes = await fetch("/api/proxy/agentbook/start-registration", { method: "POST" });
    if (!startRes.ok) {
      const d = await startRes.json().catch(() => ({}));
      throw new Error(d.error || "Failed to start registration");
    }

    // Poll for bridge URL
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const urlRes = await fetch("/api/proxy/agentbook/get-bridge-url");
        const urlData = await urlRes.json();
        if (urlData.bridgeUrl) {
          window.location.href = urlData.bridgeUrl;
          // Poll for on-chain confirmation after redirect
          return new Promise<void>((resolve) => {
            const poll = setInterval(async () => {
              try {
                const r = await fetch("/api/proxy/agentbook/check-registration");
                const d = await r.json();
                if (d.registered) { clearInterval(poll); resolve(); }
              } catch { /* keep polling */ }
            }, 3000);
            setTimeout(() => clearInterval(poll), 180000);
          });
        }
        if (urlData.status === "error") throw new Error(urlData.error || "CLI failed");
      } catch (e) { if (e instanceof Error && e.message !== "CLI failed") continue; throw e; }
    }
    throw new Error("Registration timed out");
  }

  // ── Main handler ──
  async function handleRegister() {
    if (phase === "verifying" || phase === "submitting") return;
    setError("");
    setPhase("verifying");

    try {
      if (USE_NATIVE_TRANSPORT) {
        const proof = await handleRegisterNative();

        // Submit proof to backend for on-chain registration
        setPhase("submitting");
        const regRes = await fetch("/api/agentbook/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(proof),
        });
        const regData = await regRes.json();
        if (regData.registered || regRes.ok) setPhase("registered");
        else { setError(regData.error || "Registration failed"); setPhase("idle"); }
      } else {
        await handleRegisterBridge();
        setPhase("registered");
      }
    } catch (err) {
      console.error("[AgentBook] Error:", err);
      setError(err instanceof Error ? err.message : "Something went wrong");
      setPhase("idle");
    }
  }

  // Loading — show nothing
  if (phase === "loading") return null;

  // Registered badge
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

  // Verifying / submitting
  if (phase === "verifying" || phase === "submitting") {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-4" style={{ opacity: 0 }}>
        <div className="flex items-center justify-center gap-2 py-4">
          <Loader2 size={16} className="animate-spin" style={{ color: "#4d8eff" }} />
          <p className="text-xs" style={{ color: "#999" }}>
            {phase === "verifying" ? "Verify in the popup..." : "Registering on-chain..."}
          </p>
        </div>
      </div>
    );
  }

  // Idle / error — register prompt
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
