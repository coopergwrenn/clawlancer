"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Play, Eye, Hand, Maximize2, Minimize2, RefreshCw, WifiOff, Wifi,
  Camera, Globe, Copy, CheckCircle2, ChevronDown, Download, Monitor,
} from "lucide-react";
import { DispatchRelaySection } from "@/components/dashboard/dispatch-relay-section";

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export default function LiveDesktopPage() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [viewOnly, setViewOnly] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [vmInfo, setVmInfo] = useState<{
    vmName: string; vmIp: string; port: number; vncUrl: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch("/api/vm/live-session");
        const data = await res.json();
        if (data.error) { setError(data.error); return; }
        setVmInfo(data);
        setConnectionState("connected");
      } catch { setError("Failed to load live session"); }
    }
    fetchSession();
  }, []);

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
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen();
      setFullscreen(true);
    } else {
      document.exitFullscreen();
      setFullscreen(false);
    }
  };

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
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs font-medium text-emerald-600">Live</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Watch / Control pill toggle */}
          <div className="flex rounded-full p-0.5 bg-black/5">
            <button
              onClick={() => { if (!viewOnly) toggleViewOnly(); }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                viewOnly
                  ? "bg-emerald-500 text-white shadow-sm"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              <Eye className="w-3 h-3 inline mr-1" />Watch
            </button>
            <button
              onClick={() => { if (viewOnly) toggleViewOnly(); }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                !viewOnly
                  ? "bg-orange-500 text-white shadow-sm"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              <Hand className="w-3 h-3 inline mr-1" />Control
            </button>
          </div>
          <button
            onClick={toggleFullscreen}
            className="p-1.5 rounded-lg hover:bg-black/5 transition-colors"
          >
            {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Main layout: viewer + sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT: Live Viewer Area */}
        <div className="lg:col-span-2" ref={containerRef}>
          <div
            className="relative rounded-xl overflow-hidden border border-[var(--border)]"
            style={{
              background: "#1a1a1a",
              boxShadow: connectionState === "connected"
                ? "0 0 20px rgba(16, 185, 129, 0.1), 0 2px 8px rgba(0,0,0,0.1)"
                : "0 2px 8px rgba(0,0,0,0.08)",
              aspectRatio: "16/10",
            }}
          >
            {/* Dot grid pattern background */}
            <div
              className="absolute inset-0 opacity-10"
              style={{
                backgroundImage: "radial-gradient(circle, #555 1px, transparent 1px)",
                backgroundSize: "20px 20px",
              }}
            />

            {/* Content */}
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
              <a
                href={`${vmInfo.vncUrl}&view_only=${viewOnly ? "true" : "false"}`}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex flex-col items-center gap-4 transition-transform hover:scale-105"
              >
                <div
                  className="w-16 h-16 rounded-full flex items-center justify-center transition-all group-hover:scale-110"
                  style={{
                    background: "rgba(220, 103, 67, 0.15)",
                    border: "2px solid rgba(220, 103, 67, 0.3)",
                  }}
                >
                  <Play className="w-7 h-7 text-[#DC6743] ml-0.5" fill="currentColor" />
                </div>
                <div className="text-center">
                  <p className="text-white/90 font-medium text-sm">
                    {viewOnly ? "Watch your agent work" : "Take control of the desktop"}
                  </p>
                  <p className="text-white/40 text-xs mt-1">Click to open live view</p>
                </div>
              </a>
            </div>

            {/* Status bar at bottom */}
            <div className="absolute bottom-0 left-0 right-0 z-20 px-4 py-2 bg-gradient-to-t from-black/60 to-transparent">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 text-white/60">
                  <Monitor className="w-3 h-3" />
                  <span>1280×720</span>
                  <span>•</span>
                  <span>{viewOnly ? "View only" : "Interactive"}</span>
                </div>
                <div className="flex items-center gap-1.5 text-emerald-400">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>Connected</span>
                </div>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="flex gap-2 mt-3">
            <QuickAction icon={<Camera className="w-3.5 h-3.5" />} label="Screenshot" />
            <QuickAction icon={<Globe className="w-3.5 h-3.5" />} label="Open Browser" />
          </div>
        </div>

        {/* RIGHT: Remote Control */}
        <div className="space-y-4">
          <DispatchRelaySection />

          {/* Activity */}
          <div className="glass rounded-xl p-4">
            <h3 className="text-sm font-semibold mb-3">Activity</h3>
            <div className="space-y-2">
              <ActivityItem label="Agent status" value="Active" color="emerald" />
              <ActivityItem label="Display" value="1280×720 (Xvfb)" />
              <ActivityItem label="Window manager" value="Openbox" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickAction({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-black/5 border border-[var(--border)] transition-colors">
      {icon}
      {label}
    </button>
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
