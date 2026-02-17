"use client";

import { useState, useEffect, useCallback } from "react";
import { IDKitWidget, ISuccessResult, VerificationLevel } from "@worldcoin/idkit";
import { Loader2, Shield, Search, Globe, Award } from "lucide-react";
import { WorldIDBadge } from "@/components/icons/world-id-badge";
import { WorldLogo } from "@/components/icons/world-logo";

interface WorldIDStatus {
  userId: string;
  verified: boolean;
  verification_level: string | null;
  verified_at: string | null;
  banner_dismissed: boolean;
  total_verified_count: number;
}

export function WorldIDSection() {
  const appId = process.env.NEXT_PUBLIC_WORLD_APP_ID;
  const [status, setStatus] = useState<WorldIDStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/world-id/status");
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

  useEffect(() => {
    if (!appId) {
      setLoading(false);
      return;
    }
    fetchStatus();
  }, [appId, fetchStatus]);

  // Hide entirely if env var is not set
  if (!appId) return null;
  if (loading) return null;

  async function handleVerify(result: ISuccessResult) {
    setVerifying(true);
    setError("");
    try {
      const res = await fetch("/api/auth/world-id/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merkle_root: result.merkle_root,
          nullifier_hash: result.nullifier_hash,
          proof: result.proof,
          verification_level: result.verification_level,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Verification failed");
        return;
      }

      // Refetch status to update UI
      await fetchStatus();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  // Verified state
  if (status?.verified) {
    const isOrb = status.verification_level === "orb";
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
          border: "1px solid rgba(234,179,8,0.3)",
          background: "rgba(234,179,8,0.03)",
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
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            {status.total_verified_count} agent owner{status.total_verified_count !== 1 ? "s have" : " has"} already verified
          </p>
        )}

        <div>
          {verifying ? (
            <div className="flex items-center gap-2 text-sm" style={{ color: "var(--muted)" }}>
              <Loader2 className="w-4 h-4 animate-spin" />
              Verifying with World ID...
            </div>
          ) : (
            <IDKitWidget
              app_id={appId as `app_${string}`}
              action="verify-instaclaw-agent"
              signal={status?.userId}
              verification_level={VerificationLevel.Orb}
              onSuccess={handleVerify}
            >
              {({ open }) => (
                <button
                  onClick={open}
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
              )}
            </IDKitWidget>
          )}

          {error && (
            <p className="text-xs mt-2" style={{ color: "var(--error)" }}>
              {error}
            </p>
          )}
        </div>

        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Don&apos;t have World App?{" "}
          <a
            href="https://worldcoin.org/download"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            Download it here
          </a>
        </p>
      </div>
    </div>
  );
}
