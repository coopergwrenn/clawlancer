"use client";

import { useState, useEffect, useRef } from "react";
import { ShieldAlert, X, Copy, Check, ExternalLink, Loader2 } from "lucide-react";

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
 * Google connect card with TV-style pairing code flow.
 * User never leaves the mini app — opens the link in their phone browser.
 */
export default function GoogleConnectCard({
  onConnectStart,
  onDismiss,
  variant = "home",
}: GoogleConnectCardProps) {
  const [step, setStep] = useState<"idle" | "warning" | "pairing" | "connected">("idle");
  const [loading, setLoading] = useState(false);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(600);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll for Google connection status
  useEffect(() => {
    if (step !== "pairing") return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/google/status");
        if (res.ok) {
          const data = await res.json();
          if (data.connected) {
            setStep("connected");
            onConnectStart(); // triggers parent refresh
          }
        }
      } catch {}
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [step, onConnectStart]);

  // Countdown timer
  useEffect(() => {
    if (step !== "pairing") return;
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          setStep("idle");
          return 600;
        }
        return s - 1;
      });
    }, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [step]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Generate pairing code and navigate to the trampoline page.
  // The trampoline opens Google in Chrome and auto-returns to the mini app.
  async function handleConnectGoogle() {
    setLoading(true);
    try {
      const res = await fetch("/api/google/pair", { method: "POST" });
      const data = await res.json();
      if (data.code && data.url) {
        setPairCode(data.code);
        setPairUrl(data.url);
        setSecondsLeft(data.expiresIn || 600);
        // Navigate WebView to trampoline — it opens Chrome for Google,
        // then auto-returns to mini app when user comes back.
        window.location.href = data.url;
        return;
      }
    } catch {
      console.error("Failed to generate pairing code");
    }
    setLoading(false);
  }

  async function copyLink() {
    if (!pairUrl) return;
    try {
      await navigator.clipboard.writeText(pairUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for WebView
      const input = document.createElement("input");
      input.value = pairUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;

  // ── Connected state ──
  if (step === "connected") {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-5" style={{ opacity: 0, border: "1px solid rgba(34,197,94,0.2)" }}>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: "rgba(34,197,94,0.15)" }}>
            <Check size={20} style={{ color: "#22c55e" }} />
          </div>
          <div>
            <h3 className="text-sm font-bold" style={{ color: "#22c55e" }}>Google connected!</h3>
            <p className="text-[11px] text-muted">Your agent is personalizing itself now.</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Pairing code screen — user stays in mini app ──
  if (step === "pairing" && pairCode) {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-5" style={{ opacity: 0 }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold">Connect Google</h3>
          <button onClick={() => setStep("idle")} className="text-muted">
            <X size={16} />
          </button>
        </div>

        {/* Pairing code display */}
        <div
          className="rounded-xl p-4 mb-4 text-center"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <p className="text-[10px] text-muted mb-2 uppercase tracking-wider font-semibold">Your pairing code</p>
          <p
            className="text-3xl font-mono font-bold tracking-[0.3em] mb-2"
            style={{ color: "#fff", letterSpacing: "0.3em" }}
          >
            {pairCode}
          </p>
          <p className="text-[10px] text-muted">
            Expires in {minutes}:{seconds.toString().padStart(2, "0")}
          </p>
        </div>

        {/* Instructions */}
        <div className="rounded-xl p-4 mb-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <ol className="text-[12px] leading-relaxed space-y-2" style={{ color: "#bbb", listStyle: "none", paddingLeft: 0 }}>
            <li className="flex gap-2.5">
              <span className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ background: "rgba(218,119,86,0.15)", color: "#da7756" }}>1</span>
              <span>Open your phone&apos;s browser (Safari/Chrome)</span>
            </li>
            <li className="flex gap-2.5">
              <span className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ background: "rgba(218,119,86,0.15)", color: "#da7756" }}>2</span>
              <span>Go to the link below or type <strong style={{ color: "#fff" }}>instaclaw.io/g/{pairCode}</strong></span>
            </li>
            <li className="flex gap-2.5">
              <span className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold" style={{ background: "rgba(218,119,86,0.15)", color: "#da7756" }}>3</span>
              <span>Grant Gmail access, then come back here</span>
            </li>
          </ol>
        </div>

        {/* Copy link button */}
        <button
          onClick={copyLink}
          className="w-full rounded-xl py-3 text-sm font-bold transition-all flex items-center justify-center gap-2"
          style={{
            background: copied ? "rgba(34,197,94,0.15)" : "linear-gradient(170deg, #c97856, #b45e3a)",
            border: copied ? "1px solid rgba(34,197,94,0.3)" : "1px solid rgba(255,255,255,0.15)",
            color: copied ? "#22c55e" : "#fff",
            boxShadow: copied ? "none" : "0 4px 16px rgba(200,105,60,0.35), inset 0 1px 0 rgba(255,255,255,0.25)",
          }}
        >
          {copied ? <><Check size={16} /> Copied!</> : <><Copy size={14} /> Copy link</>}
        </button>

        {/* Polling indicator */}
        <div className="flex items-center justify-center gap-2 mt-4">
          <Loader2 size={12} className="animate-spin" style={{ color: "#666" }} />
          <p className="text-[11px]" style={{ color: "#666" }}>
            Waiting for Google connection...
          </p>
        </div>

        {/* Security warning - collapsed */}
        <div className="mt-4 rounded-lg p-3" style={{ background: "rgba(234,179,8,0.06)", border: "1px solid rgba(234,179,8,0.12)" }}>
          <div className="flex items-start gap-2">
            <ShieldAlert size={13} className="shrink-0 mt-0.5" style={{ color: "#ca8a04" }} />
            <p className="text-[10px] leading-relaxed" style={{ color: "#a08050" }}>
              Google may show a security warning — tap &quot;Advanced&quot; then &quot;Go to instaclaw.io (unsafe)&quot;. We&apos;re completing Google&apos;s CASA verification.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── Warning screen (before generating code) ──
  if (step === "warning") {
    return (
      <div className="animate-fade-in-up glass-card rounded-2xl p-5" style={{ opacity: 0 }}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold">Connect Google</h3>
          <button onClick={() => setStep("idle")} className="text-muted">
            <X size={16} />
          </button>
        </div>

        <p className="text-xs leading-relaxed text-muted mb-4">
          Your agent will learn your writing style and schedule from Gmail metadata.
          You&apos;ll be briefly redirected to Google to grant access, then brought right back.
        </p>

        <div className="rounded-xl p-3 mb-4" style={{ background: "rgba(234,179,8,0.06)", border: "1px solid rgba(234,179,8,0.12)" }}>
          <div className="flex items-start gap-2">
            <ShieldAlert size={14} className="shrink-0 mt-0.5" style={{ color: "#ca8a04" }} />
            <p className="text-[11px] leading-relaxed" style={{ color: "#a08050" }}>
              Google may show a security warning — this is normal. Tap &quot;Advanced&quot; then &quot;Go to instaclaw.io&quot; to continue.
            </p>
          </div>
        </div>

        <button
          onClick={handleConnectGoogle}
          disabled={loading}
          className="w-full rounded-xl py-3 text-sm font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-2"
          style={{
            background: "linear-gradient(170deg, #c97856, #b45e3a)",
            border: "1px solid rgba(255,255,255,0.15)",
            boxShadow: "0 4px 16px rgba(200,105,60,0.35), inset 0 1px 0 rgba(255,255,255,0.25)",
            color: "#fff",
          }}
        >
          {loading ? <><Loader2 size={14} className="animate-spin" /> Connecting...</> : "Connect Google"}
        </button>

        <p className="text-[10px] text-center mt-3" style={{ color: "#666" }}>
          Only reads email metadata. Never full emails.
        </p>
      </div>
    );
  }

  // ── Compact card (settings) ──
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
          onClick={() => setStep("warning")}
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

  // ── Prominent home card (idle) ──
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
        onClick={() => setStep("warning")}
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
