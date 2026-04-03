"use client";

import { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import {
  Play, Eye, Hand, Maximize2, Minimize2, RefreshCw, WifiOff, Monitor,
} from "lucide-react";
import { DispatchRelaySection } from "@/components/dashboard/dispatch-relay-section";
import { ClipRecorder } from "@/components/dashboard/clip-recorder";

// Dynamic import — noVNC uses browser APIs
const VncViewer = dynamic(
  () => import("@/components/dashboard/vnc-viewer").then((m) => ({ default: m.VncViewer })),
  { ssr: false }
);

type ViewerState = "idle" | "connecting" | "live" | "error";

export default function LiveDesktopPage() {
  const [viewerState, setViewerState] = useState<ViewerState>("idle");
  const [viewOnly, setViewOnly] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [vmInfo, setVmInfo] = useState<{
    vmName: string; vmIp: string; wssUrl: string; fallbackVncUrl: string; caddyDomain: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch("/api/vm/live-session");
        const data = await res.json();
        if (data.error) { setError(data.error); return; }
        setVmInfo(data);
      } catch { setError("Failed to load live session"); }
    }
    fetchSession();
  }, []);

  const startViewing = () => {
    setViewerState("connecting");
  };

  const toggleViewOnly = async () => {
    const newMode = !viewOnly;
    setViewOnly(newMode);
    try {
      await fetch("/api/vm/takeover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: newMode ? "stop" : "start" }),
      });
    } catch {}
  };

  const toggleFullscreen = () => {
    if (!viewerRef.current) return;
    if (!document.fullscreenElement) {
      viewerRef.current.requestFullscreen();
      setFullscreen(true);
    } else {
      document.exitFullscreen();
      setFullscreen(false);
    }
  };

  // Error state
  if (error) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-normal tracking-[-0.5px] mb-8" style={{ fontFamily: "var(--font-serif)" }}>
          Live Desktop
        </h1>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card,#fff)] p-8 text-center">
          <WifiOff className="w-10 h-10 text-[var(--muted)] mx-auto mb-3" />
          <h2 className="text-lg font-semibold mb-2">Can&apos;t connect</h2>
          <p className="text-sm text-[var(--muted)] mb-4">{error}</p>
          <button
            onClick={() => { setError(null); window.location.reload(); }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
            style={{ background: "var(--accent)", color: "#fff" }}
          >
            <RefreshCw className="w-4 h-4" /> Retry
          </button>
        </div>
      </div>
    );
  }

  // Loading state
  if (!vmInfo) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-normal tracking-[-0.5px] mb-8" style={{ fontFamily: "var(--font-serif)" }}>
          Live Desktop
        </h1>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card,#fff)] p-12 text-center">
          <div className="animate-pulse text-[var(--muted)]">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-normal tracking-[-0.5px]" style={{ fontFamily: "var(--font-serif)" }}>
            Live Desktop
          </h1>
          <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-black/5 text-[var(--muted)]">
            {vmInfo.vmName}
          </span>
          {viewerState === "live" && (
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-medium text-emerald-600">Live</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {viewerState === "live" && (
            <>
              <ClipRecorder targetRef={viewerRef} />
              <div className="flex rounded-full p-0.5 bg-black/5">
                <button
                  onClick={() => { if (!viewOnly) toggleViewOnly(); }}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                    viewOnly ? "bg-emerald-500 text-white shadow-sm" : "text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  <Eye className="w-3 h-3 inline mr-1" />Watch
                </button>
                <button
                  onClick={() => { if (viewOnly) toggleViewOnly(); }}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                    !viewOnly ? "bg-orange-500 text-white shadow-sm" : "text-[var(--muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  <Hand className="w-3 h-3 inline mr-1" />Control
                </button>
              </div>
            </>
          )}
          <button onClick={toggleFullscreen} className="p-1.5 rounded-lg hover:bg-black/5 transition-colors">
            {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Main layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Viewer */}
        <div className="lg:col-span-2" ref={viewerRef}>
          <div
            className="relative rounded-xl overflow-hidden border border-[var(--border)]"
            style={{
              background: "#1a1a1a",
              boxShadow: viewerState === "live"
                ? "0 0 20px rgba(16, 185, 129, 0.1), 0 2px 8px rgba(0,0,0,0.1)"
                : "0 2px 8px rgba(0,0,0,0.08)",
              aspectRatio: "16/10",
            }}
          >
            {viewerState === "idle" && (
              <>
                {/* Dot grid background */}
                <div
                  className="absolute inset-0 opacity-[0.06]"
                  style={{
                    backgroundImage: "radial-gradient(circle, #888 1px, transparent 1px)",
                    backgroundSize: "24px 24px",
                  }}
                />

                {/* Play button */}
                <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
                  <button
                    onClick={startViewing}
                    className="group flex flex-col items-center gap-3 transition-transform hover:scale-105"
                  >
                    <div className="relative">
                      <div
                        className="absolute inset-0 rounded-full animate-ping opacity-20"
                        style={{ background: "rgba(220, 103, 67, 0.4)" }}
                      />
                      <div
                        className="relative w-16 h-16 rounded-full flex items-center justify-center transition-all group-hover:shadow-[0_0_24px_rgba(220,103,67,0.4)]"
                        style={{
                          background: "rgba(220, 103, 67, 0.12)",
                          border: "2px solid rgba(220, 103, 67, 0.25)",
                        }}
                      >
                        <Play className="w-6 h-6 text-[#DC6743] ml-0.5" fill="currentColor" />
                      </div>
                    </div>
                    <p className="text-white/80 font-medium text-sm">Watch your agent work</p>
                    <p className="text-white/30 text-[11px] -mt-2">Click to start</p>
                  </button>
                </div>
              </>
            )}

            {(viewerState === "connecting" || viewerState === "live") && (
              <VncViewer
                wssUrl={vmInfo.wssUrl}
                viewOnly={viewOnly}
                onConnect={() => setViewerState("live")}
                onDisconnect={() => setViewerState("idle")}
                onError={(msg) => {
                  console.warn("VNC error:", msg);
                  // Fall back to new-tab noVNC
                  setViewerState("error");
                }}
              />
            )}

            {viewerState === "error" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center z-10 gap-3">
                <p className="text-white/60 text-sm">Connection dropped — retrying may help</p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setViewerState("connecting")}
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 text-white/80 hover:bg-white/20 transition-colors flex items-center gap-2"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Retry
                  </button>
                  <a
                    href={vmInfo.fallbackVncUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-4 py-2 rounded-lg text-sm font-medium bg-white/10 text-white/80 hover:bg-white/20 transition-colors"
                  >
                    Open in new tab
                  </a>
                </div>
              </div>
            )}

            {/* Status bar */}
            <div className="absolute bottom-0 left-0 right-0 z-30 px-4 py-1.5 bg-black/50 pointer-events-none">
              <div className="flex items-center justify-center gap-2 text-[10px] text-white/50">
                <span>1280×720</span>
                <span className="text-white/20">·</span>
                <span>{viewOnly ? "View only" : "Interactive"}</span>
                <span className="text-white/20">·</span>
                <div className="flex items-center gap-1 text-emerald-400/80">
                  <div className="w-1 h-1 rounded-full bg-emerald-400" />
                  {viewerState === "live" ? "Live" : viewerState === "connecting" ? "Connecting..." : "Ready"}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <DispatchRelaySection />

          <div className="glass rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-3">Activity</h3>
            <div className="space-y-2">
              <ActivityItem label="Status" value="Active" color="emerald" />
              <ActivityItem label="Display" value="1280×720" />
              <ActivityItem label="Last activity" value="Just now" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ActivityItem({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-[var(--muted)]">{label}</span>
      <span className={color === "emerald" ? "text-emerald-600 font-medium" : "text-[var(--foreground)]"}>
        {color === "emerald" && <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1" />}
        {value}
      </span>
    </div>
  );
}
