"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Shield, ShieldOff, Loader2 } from "lucide-react";

interface PrivacyState {
  available: boolean;
  active: boolean;
  until: string | null;
  ttl_hours: number;
}

const HOUR_MS = 60 * 60 * 1000;

function formatRemaining(untilIso: string): string {
  const remainingMs = new Date(untilIso).getTime() - Date.now();
  if (remainingMs <= 0) return "expiring now";
  const hours = Math.floor(remainingMs / HOUR_MS);
  const minutes = Math.floor((remainingMs % HOUR_MS) / (60 * 1000));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function PrivacyPage() {
  const [state, setState] = useState<PrivacyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetch("/api/account/privacy-mode")
      .then(async (r) => {
        if (r.status === 403) {
          setError("Maximum Privacy Mode is available for Edge City attendees only.");
          setLoading(false);
          return;
        }
        if (!r.ok) {
          setError("Couldn't load privacy state. Try again.");
          setLoading(false);
          return;
        }
        const data: PrivacyState = await r.json();
        setState(data);
        setLoading(false);
      })
      .catch(() => {
        setError("Couldn't load privacy state. Try again.");
        setLoading(false);
      });
  }, []);

  // Refresh remaining-time display every minute when active
  useEffect(() => {
    if (!state?.active) return;
    const iv = setInterval(() => setTick((t) => t + 1), 60 * 1000);
    return () => clearInterval(iv);
  }, [state?.active]);

  async function toggle(enable: boolean) {
    setToggling(true);
    setError(null);
    try {
      const res = await fetch("/api/account/privacy-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enable }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Toggle failed.");
        return;
      }
      const data = await res.json();
      setState((prev) => (prev ? { ...prev, active: data.active, until: data.until } : prev));
      setConfirmOpen(false);
    } catch {
      setError("Toggle failed. Try again.");
    } finally {
      setToggling(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: "#6b6b6b" }} />
      </div>
    );
  }

  if (error && !state) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <Link href="/dashboard" className="inline-flex items-center gap-2 text-sm mb-6" style={{ color: "#6b6b6b" }}>
          <ArrowLeft className="w-4 h-4" /> Back to dashboard
        </Link>
        <div className="rounded-xl p-6" style={{ background: "#ffffff", border: "1px solid rgba(0,0,0,0.08)" }}>
          <p className="text-sm" style={{ color: "#333334" }}>{error}</p>
        </div>
      </div>
    );
  }

  if (!state) return null;

  const isActive = state.active;
  const remaining = state.until ? formatRemaining(state.until) : null;
  // tick is referenced so the remaining-time refresh re-renders
  void tick;

  return (
    <div className="max-w-2xl mx-auto p-6">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-2 text-sm mb-8 hover:opacity-70 transition-opacity"
        style={{ color: "#6b6b6b" }}
      >
        <ArrowLeft className="w-4 h-4" /> Back to dashboard
      </Link>

      <h1 className="text-3xl font-normal tracking-[-0.5px] mb-2" style={{ fontFamily: "var(--font-serif)" }}>
        Maximum Privacy Mode
      </h1>
      <p className="text-sm mb-8 leading-relaxed" style={{ color: "#6b6b6b" }}>
        When on, even our operators can&apos;t read your conversations or memory. Auto-reverts after {state.ttl_hours} hours so you don&apos;t accidentally lock out support.
      </p>

      <div
        className="rounded-2xl p-6 sm:p-8 mb-6"
        style={{
          background: isActive
            ? "linear-gradient(135deg, rgba(220,103,67,0.06), rgba(220,103,67,0.02))"
            : "#ffffff",
          border: isActive ? "1px solid rgba(220,103,67,0.25)" : "1px solid rgba(0,0,0,0.08)",
        }}
      >
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex items-center gap-3">
            {isActive ? (
              <Shield className="w-6 h-6" style={{ color: "#DC6743" }} />
            ) : (
              <ShieldOff className="w-6 h-6" style={{ color: "#9a9a9a" }} />
            )}
            <div>
              <div className="text-base font-medium" style={{ color: "#333334" }}>
                {isActive ? "Privacy Mode is ON" : "Privacy Mode is OFF"}
              </div>
              {isActive && remaining ? (
                <div className="text-xs mt-0.5" style={{ color: "#6b6b6b" }}>
                  Auto-reverts in {remaining}
                </div>
              ) : (
                <div className="text-xs mt-0.5" style={{ color: "#6b6b6b" }}>
                  Operators can read your data for support
                </div>
              )}
            </div>
          </div>
          {isActive ? (
            <button
              onClick={() => toggle(false)}
              disabled={toggling}
              className="px-5 py-2.5 rounded-full text-sm font-medium transition-all hover:opacity-90 disabled:opacity-60"
              style={{
                background: "rgba(220,103,67,0.08)",
                color: "#DC6743",
                border: "1px solid rgba(220,103,67,0.25)",
              }}
            >
              {toggling ? "Disabling…" : "Disable"}
            </button>
          ) : (
            <button
              onClick={() => setConfirmOpen(true)}
              disabled={toggling}
              className="px-5 py-2.5 rounded-full text-sm font-medium transition-all hover:opacity-90 disabled:opacity-60"
              style={{
                background: "#DC6743",
                color: "#ffffff",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2), 0 1px 3px rgba(220,103,67,0.3)",
              }}
            >
              Enable Privacy Mode
            </button>
          )}
        </div>

        <div className="text-sm leading-relaxed space-y-2" style={{ color: "#6b6b6b" }}>
          {isActive ? (
            <>
              <p>While ON, our operators can&apos;t read:</p>
              <ul className="list-disc list-inside space-y-1 pl-1">
                <li>Your conversation history (Telegram messages with your agent)</li>
                <li>Your agent&apos;s memory and notes</li>
                <li>Files your agent created in its workspace</li>
              </ul>
              <p className="pt-2">Infrastructure operations (system updates, gateway health, skill installs) continue normally.</p>
            </>
          ) : (
            <>
              <p>By default, our operators have access to your conversations and memory for support and debugging — same as regular InstaClaw.</p>
              <p>Enable Privacy Mode to remove that access for the next {state.ttl_hours} hours.</p>
            </>
          )}
        </div>
      </div>

      {error && (
        <p className="text-xs" style={{ color: "#c44" }}>{error}</p>
      )}

      {confirmOpen && (
        <div className="rounded-xl p-5 mb-6" style={{ background: "#ffffff", border: "1px solid rgba(0,0,0,0.08)" }}>
          <h3 className="text-base font-medium mb-2" style={{ color: "#333334" }}>Enable Privacy Mode?</h3>
          <p className="text-sm leading-relaxed mb-4" style={{ color: "#6b6b6b" }}>
            For the next {state.ttl_hours} hours, our operators won&apos;t be able to help you debug your agent — we won&apos;t see your conversations, memory, or workspace.
            You can disable it earlier from this page. It also auto-reverts after {state.ttl_hours} hours.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => toggle(true)}
              disabled={toggling}
              className="px-5 py-2.5 rounded-full text-sm font-medium transition-all hover:opacity-90 disabled:opacity-60"
              style={{
                background: "#DC6743",
                color: "#ffffff",
              }}
            >
              {toggling ? "Enabling…" : `Yes, enable for ${state.ttl_hours}h`}
            </button>
            <button
              onClick={() => setConfirmOpen(false)}
              disabled={toggling}
              className="px-5 py-2.5 rounded-full text-sm font-medium transition-all hover:opacity-70"
              style={{
                background: "transparent",
                color: "#6b6b6b",
                border: "1px solid rgba(0,0,0,0.1)",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="text-xs leading-relaxed mt-8 pt-6" style={{ color: "#9a9a9a", borderTop: "1px solid rgba(0,0,0,0.06)" }}>
        <p className="mb-2">
          <strong style={{ color: "#6b6b6b" }}>What this protects:</strong> operator reads via SSH or admin tooling. We don&apos;t read your conversations as a routine matter regardless; this enforces it in code.
        </p>
        <p>
          <strong style={{ color: "#6b6b6b" }}>What this doesn&apos;t change:</strong> the LLM provider (Anthropic) still processes your messages to respond to them. Researchers (per your separate consent) still receive anonymized aggregate data, never raw conversations.
        </p>
      </div>
    </div>
  );
}
