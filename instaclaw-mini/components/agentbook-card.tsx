"use client";

import { useState, useEffect } from "react";
import { Loader2, Check } from "lucide-react";

type Phase = "loading" | "idle" | "verifying" | "submitting" | "registered" | "error";

const AGENTKIT_APP_ID = "app_a7c3e2b6b83927251a0db5345bd7146a";
const AGENTKIT_ACTION = "agentbook-registration";

/**
 * AgentBook registration card — uses IDKit v4 native transport
 * to trigger World ID verification with AgentKit's app_id directly
 * inside World App's WebView.
 */
export default function AgentBookCard() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [nonce, setNonce] = useState<string>("0");
  const [error, setError] = useState("");

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
  }, []);

  async function handleRegister() {
    if (phase === "verifying" || phase === "submitting" || !walletAddress) return;
    setError("");
    setPhase("verifying");

    try {
      // Step 1: Get rp_context from backend
      const rpRes = await fetch("/api/agentbook/sign-request");
      if (!rpRes.ok) {
        const d = await rpRes.json().catch(() => ({}));
        throw new Error(d.error || "Failed to get RP context");
      }
      const rpData = await rpRes.json();

      // Step 2: Use IDKit v4 with AgentKit's app_id + native transport
      const { IDKit, orbLegacy } = await import("@worldcoin/idkit-core");
      const { encodePacked, keccak256, pad, toHex } = await import("viem");

      // Build signal matching agentkit-cli: abi.encode(['address', 'uint256'], [wallet, nonce])
      const signal = encodePacked(
        ["address", "uint256"],
        [walletAddress as `0x${string}`, BigInt(nonce)]
      );

      console.log("[AgentBook] Creating IDKit request with app_id:", AGENTKIT_APP_ID);

      const request = await IDKit.request({
        app_id: AGENTKIT_APP_ID as `app_${string}`,
        action: AGENTKIT_ACTION,
        rp_context: {
          rp_id: rpData.rp_id,
          nonce: rpData.nonce,
          created_at: rpData.created_at,
          expires_at: rpData.expires_at,
          signature: rpData.signature,
        },
        allow_legacy_proofs: true,
        environment: "production",
      }).preset(orbLegacy({ signal }));

      console.log("[AgentBook] IDKit request created, polling for completion...");

      const completion = await request.pollUntilCompletion({
        pollInterval: 2000,
        timeout: 300000,
      });

      console.log("[AgentBook] IDKit completion:", JSON.stringify(completion));

      console.log("[AgentBook] Raw completion:", JSON.stringify(completion));

      if (!completion || !completion.success) {
        const errMsg = completion && !completion.success
          ? `Verification error: ${JSON.stringify(completion)}`
          : "Verification failed or timed out";
        throw new Error(errMsg);
      }

      const result = completion.result as unknown as Record<string, unknown>;
      console.log("[AgentBook] Result keys:", Object.keys(result));
      console.log("[AgentBook] Full result:", JSON.stringify(result));

      // IDKit v4 returns { protocol_version, nonce, action, responses, environment }
      // The proof is inside responses[0]
      const responses = (result.responses || result.response) as unknown[];
      if (!responses || !Array.isArray(responses) || responses.length === 0) {
        throw new Error(`No responses in IDKit result. Keys: ${Object.keys(result).join(", ")}`);
      }

      const response = responses[0] as Record<string, unknown>;
      console.log("[AgentBook] Response[0] keys:", Object.keys(response).join(", "));
      console.log("[AgentBook] Response[0]:", JSON.stringify(response).slice(0, 500));

      // Send the first response to the backend
      setPhase("submitting");
      const regRes = await fetch("/api/proxy/agentbook/register-direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response),
      });

      const regData = await regRes.json();
      console.log("[AgentBook] Register response:", regRes.status, JSON.stringify(regData));

      if (regData.registered) {
        setPhase("registered");
      } else {
        setError(regData.error || "Registration failed");
        setPhase("idle");
      }
    } catch (err) {
      console.error("[AgentBook] Error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg.slice(0, 300));
      setPhase("idle");
    }
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
