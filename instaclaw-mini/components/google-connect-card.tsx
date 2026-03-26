"use client";

import { useState } from "react";
import { ShieldAlert, X, ExternalLink } from "lucide-react";

function GoogleGIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09A6.97 6.97 0 0 1 5.47 12c0-.72.13-1.43.37-2.09V7.07H2.18A11.96 11.96 0 0 0 .96 12c0 1.94.46 3.77 1.22 5.33l3.66-2.84z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.09 14.97 0 12 0 7.7 0 3.99 2.47 2.18 6.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

interface GoogleConnectCardProps {
  onConnectStart: () => void;
  onDismiss: () => void;
  variant?: "home" | "settings";
}

/**
 * Dismissible card prompting the user to connect Google.
 * Shows on the Home tab (prominent) and Settings tab (compact).
 */
export default function GoogleConnectCard({
  onConnectStart,
  onDismiss,
  variant = "home",
}: GoogleConnectCardProps) {
  const [showWarning, setShowWarning] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleConnect() {
    setLoading(true);
    try {
      const res = await fetch("/api/google/connect-url");
      const data = await res.json();
      if (data.url) {
        window.open(data.url, "_blank");
        onConnectStart();
      }
    } catch {
      console.error("Failed to get connect URL");
    }
    setLoading(false);
  }

  // ── Pre-OAuth warning screen ──
  if (showWarning) {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-5" style={{ opacity: 0 }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold">Before you connect</h3>
          <button onClick={() => setShowWarning(false)} className="text-muted">
            <X size={16} />
          </button>
        </div>

        {/* Warning explanation */}
        <div
          className="rounded-xl p-4 mb-4"
          style={{
            background: "rgba(234,179,8,0.08)",
            border: "1px solid rgba(234,179,8,0.2)",
          }}
        >
          <div className="flex items-start gap-3">
            <ShieldAlert size={18} className="shrink-0 mt-0.5" style={{ color: "#ca8a04" }} />
            <div>
              <p className="text-xs font-semibold mb-1.5" style={{ color: "#92400e" }}>
                Google will show a security warning
              </p>
              <p className="text-[11px] leading-relaxed mb-2" style={{ color: "#78716c" }}>
                This is normal. We are completing Google&apos;s verification
                process (CASA assessment). Your data is encrypted and never
                shared.
              </p>
            </div>
          </div>
        </div>

        {/* Step-by-step instructions */}
        <div className="rounded-xl p-4 mb-4" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <p className="text-[11px] font-semibold mb-2 text-muted">When you see the warning:</p>
          <ol className="text-[11px] leading-relaxed space-y-1.5" style={{ color: "#999", listStyle: "none", paddingLeft: 0 }}>
            <li className="flex gap-2">
              <span className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold" style={{ background: "rgba(220,103,67,0.15)", color: "#DC6743" }}>1</span>
              <span>Tap <strong>&quot;Advanced&quot;</strong> at the bottom left</span>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold" style={{ background: "rgba(220,103,67,0.15)", color: "#DC6743" }}>2</span>
              <span>Tap <strong>&quot;Go to instaclaw.io (unsafe)&quot;</strong></span>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold" style={{ background: "rgba(220,103,67,0.15)", color: "#DC6743" }}>3</span>
              <span>Grant read-only Gmail access</span>
            </li>
            <li className="flex gap-2">
              <span className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold" style={{ background: "rgba(220,103,67,0.15)", color: "#DC6743" }}>4</span>
              <span>Return to World App when done</span>
            </li>
          </ol>
        </div>

        <p className="text-[10px] text-center mb-4" style={{ color: "#888" }}>
          Opens instaclaw.io in your browser. Come back here when done.
        </p>

        <button
          onClick={handleConnect}
          disabled={loading}
          className="w-full rounded-xl py-3 text-sm font-bold transition-all disabled:opacity-50"
          style={{
            background: "linear-gradient(-75deg, #c75a34, #DC6743, #e8845e, #DC6743, #c75a34)",
            boxShadow: "rgba(255,255,255,0.2) 0px 2px 2px 0px inset, rgba(220,103,67,0.35) 0px 4px 16px 0px",
            color: "#fff",
          }}
        >
          <span className="flex items-center justify-center gap-2">
            {loading ? "Opening..." : "Continue to Google"}
            {!loading && <ExternalLink size={14} />}
          </span>
        </button>
      </div>
    );
  }

  // ── Compact card (home or settings) ──
  if (variant === "settings") {
    return (
      <div className="flex items-center gap-3 rounded-xl bg-white/[0.03] p-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
          <GoogleGIcon size={16} />
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">Google</p>
          <p className="text-[10px] text-muted">Not connected</p>
        </div>
        <button
          onClick={() => setShowWarning(true)}
          className="rounded-lg px-3 py-1.5 text-[11px] font-semibold"
          style={{
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.1)",
            color: "#ddd",
          }}
        >
          Connect
        </button>
      </div>
    );
  }

  // ── Prominent home card ──
  return (
    <div className="animate-fade-in-up glass-card rounded-2xl p-5" style={{ opacity: 0 }}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <GoogleGIcon size={20} />
          </div>
          <div>
            <h3 className="text-sm font-bold">Connect Google</h3>
            <p className="text-[11px] text-muted">Unlock personalized suggestions</p>
          </div>
        </div>
        <button onClick={onDismiss} className="text-muted p-1">
          <X size={14} />
        </button>
      </div>

      <p className="text-xs leading-relaxed text-muted mb-4">
        Your agent can learn your writing style, schedule patterns, and
        interests from your inbox to give better, more personal responses.
      </p>

      <button
        onClick={() => setShowWarning(true)}
        className="w-full rounded-xl py-3 text-sm font-semibold transition-all flex items-center justify-center gap-2.5"
        style={{
          background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.1)",
          backdropFilter: "blur(12px)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.04)",
          color: "#ddd",
        }}
      >
        <GoogleGIcon size={16} />
        Connect Google
      </button>

      <p className="text-[10px] text-center mt-3" style={{ color: "#888" }}>
        Only reads email metadata. Never full emails.
      </p>
    </div>
  );
}
