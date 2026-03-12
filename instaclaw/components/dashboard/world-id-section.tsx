"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { Loader2, Shield, Search, Globe, Award, CheckCircle2 } from "lucide-react";
import { WorldIDBadge } from "@/components/icons/world-id-badge";
import { WorldLogo } from "@/components/icons/world-logo";

// Dynamic import with ssr: false — IDKit 4.0 uses WASM that requires browser APIs
const IDKitRequestWidget = dynamic(
  () => import("@worldcoin/idkit").then((mod) => mod.IDKitRequestWidget),
  { ssr: false }
);

// Static imports for types and helpers (no WASM dependency)
import { orbLegacy, IDKitErrorCodes, type IDKitResult, type RpContext } from "@worldcoin/idkit";

/**
 * IDKit uses CSS @media (max-width: 1024px) to switch between QR (desktop)
 * and deep-link (mobile). On desktop browsers with narrow windows this shows
 * the deep-link instead of QR. Inject a style override into the shadow DOM
 * that uses pointer:fine (mouse) to always show QR on non-touch devices.
 */
function useForceDesktopQR() {
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const host = document.querySelector("[data-idkit-shadow-host]");
      if (!host?.shadowRoot) return;
      if (host.shadowRoot.querySelector("[data-idkit-qr-fix]")) return;

      const style = document.createElement("style");
      style.setAttribute("data-idkit-qr-fix", "true");
      style.textContent = `
        @media (pointer: fine) {
          .idkit-mobile-only { display: none !important; }
          .idkit-desktop-only { display: block !important; position: relative; }
          .idkit-modal {
            max-width: 400px;
            border-radius: 24px;
            animation: none;
          }
          .idkit-backdrop { align-items: center; padding: 16px; }
        }
      `;
      host.shadowRoot.appendChild(style);
    });
    observer.observe(document.body, { childList: true, subtree: false });
    return () => observer.disconnect();
  }, []);
}

interface WorldIDStatus {
  userId: string;
  verified: boolean;
  verification_level: string | null;
  verified_at: string | null;
  banner_dismissed: boolean;
  total_verified_count: number;
}

interface AgentBookData {
  walletAddress: string;
  nonce: string | null;
  alreadyRegistered: boolean;
}

export function WorldIDSection() {
  useForceDesktopQR();

  const appId = process.env.NEXT_PUBLIC_WORLD_APP_ID;
  const rpId = process.env.NEXT_PUBLIC_RP_ID;
  const agentbookAppId = process.env.NEXT_PUBLIC_AGENTBOOK_APP_ID;
  const worldInviteCode = process.env.NEXT_PUBLIC_WORLD_INVITE_CODE;
  const [status, setStatus] = useState<WorldIDStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");

  // World ID 4.0: RP context for signed requests
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [widgetOpen, setWidgetOpen] = useState(false);

  // Phase 2: AgentBook registration
  const [agentbook, setAgentbook] = useState<AgentBookData | null>(null);
  const [abWidgetOpen, setAbWidgetOpen] = useState(false);
  const [abRegistering, setAbRegistering] = useState(false);
  const [abError, setAbError] = useState("");
  const [abRegistered, setAbRegistered] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/world-id/status", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch {
      // Silently handle
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch fresh RP context — called on button click, not on mount (TTL = 5 min)
  const fetchRpContext = useCallback(async (): Promise<RpContext | null> => {
    try {
      const res = await fetch("/api/auth/world-id/sign-request");
      if (res.ok) {
        const data = await res.json();
        setRpContext(data.rp_context);
        return data.rp_context;
      } else {
        const data = await res.json().catch(() => ({}));
        console.error("[WorldID] sign-request failed:", res.status, data);
        setError(`Sign request failed: ${data.error || res.status}`);
        return null;
      }
    } catch (err) {
      console.error("[WorldID] sign-request fetch error:", err);
      return null;
    }
  }, []);

  // Fetch AgentBook pre-registration data for returning verified users
  const fetchAgentBookData = useCallback(async () => {
    try {
      const res = await fetch("/api/agentbook/pre-register");
      if (res.ok) {
        const data = await res.json();
        setAgentbook(data);
        if (data.alreadyRegistered) setAbRegistered(true);
      }
    } catch {
      // Non-fatal
    }
  }, []);

  useEffect(() => {
    if (!appId) {
      setLoading(false);
      return;
    }
    fetchStatus();
  }, [appId, fetchStatus]);

  // For verified users, check if they still need AgentBook registration
  useEffect(() => {
    if (status?.verified && agentbookAppId) {
      fetchAgentBookData();
    }
  }, [status, agentbookAppId, fetchAgentBookData]);

  // Hide entirely if env var is not set
  if (!appId) return null;
  if (loading) return null;

  function handleWidgetError(errorCode: IDKitErrorCodes) {
    console.error("[WorldID] Widget error:", errorCode);
    setError(`World ID error code: ${errorCode}`);
  }

  // Fetch fresh rp_context then open the World ID widget
  async function handleVerifyClick() {
    setError("");
    // Enable IDKit debug logging
    if (typeof window !== "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).IDKIT_DEBUG = true;
    }
    const ctx = await fetchRpContext();
    if (ctx) {
      console.log("[WorldID] rp_context:", JSON.stringify(ctx));
      console.log("[WorldID] app_id:", appId);
      console.log("[WorldID] action: verify-instaclaw-agent");
      setWidgetOpen(true);
    }
  }

  // Fetch fresh rp_context then open the AgentBook widget
  async function handleAgentBookClick() {
    setAbError("");
    const ctx = await fetchRpContext();
    if (ctx) {
      setAbWidgetOpen(true);
    }
  }

  async function handleVerify(result: IDKitResult) {
    setVerifying(true);
    setError("");
    try {
      const res = await fetch("/api/auth/world-id/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Verification failed");
      }

      const data = await res.json();

      // Store AgentBook data from verify response
      if (data.agentbook) {
        setAgentbook(data.agentbook);
        if (data.agentbook.alreadyRegistered) setAbRegistered(true);
      }

      // Refetch status to update UI
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleAgentBookVerify(result: IDKitResult) {
    setAbRegistering(true);
    setAbError("");
    try {
      const res = await fetch("/api/agentbook/register-proof", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proof: result,
          walletAddress: agentbook?.walletAddress,
          nonce: agentbook?.nonce,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Registration failed");
      }

      setAbRegistered(true);
    } catch (err) {
      setAbError(err instanceof Error ? err.message : "Registration failed. Please try again.");
    } finally {
      setAbRegistering(false);
    }
  }

  // Verified state
  if (status?.verified) {
    const isOrb = status.verification_level === "orb";
    const showAgentBook = agentbookAppId && agentbook && !abRegistered;

    return (
      <div id="world-id">
        <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
          <Shield className="w-5 h-5" /> Human Verification
        </h2>
        <div
          className="glass rounded-xl p-5"
          style={{
            border: "1px solid rgba(34,197,94,0.3)",
            background: "rgba(34,197,94,0.05)",
          }}
        >
          <div className="flex items-center gap-2 mb-3">
            <WorldIDBadge className="w-5 h-5" />
            <span className="text-sm font-semibold" style={{ color: "#22c55e" }}>
              Human Verified
            </span>
          </div>

          <div className="flex items-center gap-2 mb-2">
            <span
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
              style={{
                background: isOrb ? "rgba(34,197,94,0.15)" : "rgba(59,130,246,0.15)",
                color: isOrb ? "#22c55e" : "#3b82f6",
              }}
            >
              {isOrb ? "Orb Verified — Highest Level" : "Device Verified"}
            </span>
          </div>

          {status.verified_at && (
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Verified on {new Date(status.verified_at).toLocaleDateString()}
            </p>
          )}
        </div>

        {/* Phase 2: AgentBook Registration */}
        {abRegistered && (
          <div
            className="glass rounded-xl p-5 mt-4"
            style={{
              border: "1px solid rgba(59,130,246,0.3)",
              background: "rgba(59,130,246,0.05)",
            }}
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" style={{ color: "#3b82f6" }} />
              <span className="text-sm font-semibold" style={{ color: "#3b82f6" }}>
                Registered in AgentBook
              </span>
            </div>
            <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
              Your agent is on-chain verified in the World AgentBook registry.
            </p>
          </div>
        )}

        {showAgentBook && (
          <div
            className="glass rounded-xl p-5 mt-4 space-y-3"
            style={{ border: "1px solid var(--border)" }}
          >
            <div>
              <p className="text-sm font-semibold mb-1">Register in AgentBook</p>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Add your agent to the on-chain World AgentBook registry. Other agents and services can verify a real human operates your agent. Free — no gas fees.
              </p>
            </div>

            <div>
              {abRegistering ? (
                <div className="flex items-center gap-2 text-sm" style={{ color: "var(--muted)" }}>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Registering in AgentBook...
                </div>
              ) : (
                <>
                  {rpContext && (
                    <IDKitRequestWidget
                      app_id={agentbookAppId as `app_${string}`}
                      action="agentbook-registration"
                      rp_context={rpContext}
                      preset={orbLegacy({ signal: agentbook.walletAddress })}
                      allow_legacy_proofs={true}
                      open={abWidgetOpen}
                      onOpenChange={setAbWidgetOpen}
                      handleVerify={handleAgentBookVerify}
                      onSuccess={() => {}}
                      onError={handleWidgetError}
                    />
                  )}
                  <button
                    onClick={handleAgentBookClick}
                    className="px-5 py-2.5 rounded-full text-sm font-semibold cursor-pointer transition-all active:scale-95 flex items-center gap-2"
                    style={{
                      background: "linear-gradient(135deg, rgba(59,130,246,0.9), rgba(37,99,235,0.85))",
                      color: "#ffffff",
                      boxShadow: "0 0 0 1px rgba(59,130,246,0.3), 0 2px 8px rgba(59,130,246,0.2)",
                    }}
                  >
                    <WorldLogo className="w-4 h-4" />
                    Register in AgentBook
                  </button>
                </>
              )}

              {abError && (
                <p className="text-xs mt-2" style={{ color: "var(--error)" }}>
                  {abError}
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Unverified state
  return (
    <div id="world-id">
      <h2 className="text-2xl font-normal tracking-[-0.5px] mb-5 flex items-center gap-2" style={{ fontFamily: "var(--font-serif)" }}>
        <Shield className="w-5 h-5" /> Human Verification
      </h2>
      <div
        className="glass rounded-xl p-5 space-y-4"
        style={{
          border: "1px solid var(--border)",
        }}
      >
        <div>
          <p className="text-sm font-semibold mb-1">Prove you&apos;re human, unlock more business.</p>
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Agents backed by World ID verified humans get more trust, more visibility, and more opportunities.
          </p>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs flex items-center gap-2">
            <Shield className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--muted)" }} />
            <span style={{ color: "var(--muted)" }}>Higher trust scores on the marketplace</span>
          </p>
          <p className="text-xs flex items-center gap-2">
            <Search className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--muted)" }} />
            <span style={{ color: "var(--muted)" }}>Priority visibility in search results</span>
          </p>
          <p className="text-xs flex items-center gap-2">
            <Award className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--muted)" }} />
            <span style={{ color: "var(--muted)" }}>Access to premium bounties that require verified agents</span>
          </p>
          <p className="text-xs flex items-center gap-2">
            <Globe className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--muted)" }} />
            <span style={{ color: "var(--muted)" }}>A verified badge on your agent&apos;s public profile</span>
          </p>
        </div>

        <p className="text-xs" style={{ color: "var(--muted)" }}>
          World ID uses zero-knowledge proofs — we never see your personal data. You just prove you&apos;re a unique human.
        </p>

        {status && status.total_verified_count > 0 && (
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full"
              style={{
                background: "linear-gradient(135deg, rgba(34,197,94,0.2), rgba(22,163,74,0.15))",
                color: "rgb(34,197,94)",
                boxShadow: "0 0 0 1px rgba(34,197,94,0.2), inset 0 1px 0 rgba(255,255,255,0.1)",
                backdropFilter: "blur(6px)",
              }}
            >
              {status.total_verified_count} verified
            </span>
            <span className="text-[11px]" style={{ color: "var(--muted)" }}>
              agent owner{status.total_verified_count !== 1 ? "s" : ""}
            </span>
          </div>
        )}

        <div>
          {verifying ? (
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--muted)" }}>
              <Loader2 className="w-4 h-4 animate-spin" />
              Verifying with World ID...
            </div>
          ) : (
            <>
              {rpContext && (
                <IDKitRequestWidget
                  app_id={appId as `app_${string}`}
                  action="verify-instaclaw-agent"
                  rp_context={rpContext}
                  preset={orbLegacy({ signal: status?.userId })}
                  allow_legacy_proofs={true}
                  open={widgetOpen}
                  onOpenChange={setWidgetOpen}
                  handleVerify={handleVerify}
                  onSuccess={() => {}}
                  onError={handleWidgetError}
                />
              )}
              <button
                onClick={handleVerifyClick}
                className="px-5 py-2.5 rounded-full text-sm font-semibold cursor-pointer transition-all active:scale-95 flex items-center gap-2"
                style={{
                  background: "linear-gradient(135deg, rgba(255,255,255,0.92), rgba(240,240,240,0.88))",
                  color: "#000000",
                  boxShadow: "0 0 0 1px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.6)",
                  backdropFilter: "blur(8px)",
                }}
              >
                <WorldLogo className="w-4 h-4" style={{ color: "#000000" }} />
                Verify with World ID
              </button>
            </>
          )}

          {error && (
            <div className="mt-3 p-3 rounded-lg text-sm" style={{
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              color: "#ef4444",
            }}>
              <p className="font-semibold">{error}</p>
            </div>
          )}
        </div>

        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Don&apos;t have World App?{" "}
          <a
            href={worldInviteCode ? `https://world.org/join/${worldInviteCode}` : "https://worldcoin.org/download"}
            target="_blank"
            rel="noopener noreferrer"
            className="underline transition-colors"
            style={{ textUnderlineOffset: "2px" }}
          >
            Download it here
          </a>
        </p>
      </div>
    </div>
  );
}
