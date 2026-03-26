"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Monitor, Eye, Hand, Maximize2, Minimize2, RefreshCw, WifiOff } from "lucide-react";

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export default function LiveDesktopPage() {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [viewOnly, setViewOnly] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [vmInfo, setVmInfo] = useState<{ vmName: string; vmIp: string; port: number; vncUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Fetch VM live session info
  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch("/api/vm/live-session");
        const data = await res.json();
        if (data.error) {
          setError(data.error);
          return;
        }
        setVmInfo(data);
      } catch {
        setError("Failed to fetch live session");
      }
    }
    fetchSession();
  }, []);

  const connect = useCallback(() => {
    if (!vmInfo) return;
    setConnectionState("connecting");
    setError(null);
    // Use the noVNC URL directly in an iframe — simplest approach
    // The noVNC page handles the WebSocket connection internally
    setConnectionState("connected");
  }, [vmInfo]);

  useEffect(() => {
    if (vmInfo) connect();
  }, [vmInfo, connect]);

  const toggleViewOnly = () => {
    setViewOnly(!viewOnly);
    // In iframe mode, we'd need to post a message to the noVNC page
    // For the MVP, the user can interact directly in the noVNC iframe
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
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
        <WifiOff className="w-12 h-12 text-[var(--muted)] mb-4" />
        <h2 className="text-xl font-semibold mb-2">Can&apos;t connect to live view</h2>
        <p className="text-[var(--muted)] mb-4">{error}</p>
        <button
          onClick={() => { setError(null); window.location.reload(); }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium"
        >
          <RefreshCw className="w-4 h-4" /> Retry
        </button>
      </div>
    );
  }

  if (!vmInfo) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-pulse text-[var(--muted)]">Loading live view...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center gap-3">
          <Monitor className="w-5 h-5 text-[var(--accent)]" />
          <h1 className="text-lg font-semibold">Live Desktop</h1>
          <span className="text-sm text-[var(--muted)]">{vmInfo.vmName}</span>

          {/* Connection indicator */}
          <div className="flex items-center gap-1.5 ml-2">
            <div className={`w-2 h-2 rounded-full ${
              connectionState === "connected" ? "bg-emerald-500 animate-pulse" :
              connectionState === "connecting" ? "bg-yellow-500 animate-pulse" :
              "bg-red-500"
            }`} />
            <span className="text-xs text-[var(--muted)]">
              {connectionState === "connected" ? "Live" :
               connectionState === "connecting" ? "Connecting..." :
               "Disconnected"}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Watch / Takeover toggle */}
          <button
            onClick={toggleViewOnly}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              viewOnly
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                : "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
            }`}
          >
            {viewOnly ? (
              <><Eye className="w-4 h-4" /> Watching</>
            ) : (
              <><Hand className="w-4 h-4" /> Controlling</>
            )}
          </button>

          {/* Fullscreen */}
          <button
            onClick={toggleFullscreen}
            className="p-1.5 rounded-lg hover:bg-black/5 transition-colors"
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {fullscreen ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>

      {/* noVNC iframe */}
      <div ref={containerRef} className="flex-1 bg-black relative">
        <iframe
          ref={iframeRef}
          src={`${vmInfo.vncUrl}&view_only=${viewOnly ? "true" : "false"}`}
          className="w-full h-full border-0"
          allow="clipboard-read; clipboard-write"
          title="Agent Desktop Live View"
        />

        {/* Overlay hint when watching */}
        {viewOnly && connectionState === "connected" && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 text-white text-xs px-3 py-1.5 rounded-full backdrop-blur-sm">
            Watching agent work — click &quot;Controlling&quot; to take over
          </div>
        )}
      </div>
    </div>
  );
}
