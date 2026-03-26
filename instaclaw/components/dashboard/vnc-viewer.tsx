"use client";

import { useEffect, useRef, useState } from "react";

interface VncViewerProps {
  wssUrl: string;
  viewOnly: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (msg: string) => void;
}

/**
 * Inline noVNC viewer. Dynamically imports @novnc/novnc (no SSR).
 * Renders the remote desktop inside a canvas within the parent container.
 */
export function VncViewer({ wssUrl, viewOnly, onConnect, onDisconnect, onError }: VncViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<any>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");

  useEffect(() => {
    if (!containerRef.current) return;

    let rfb: any = null;

    async function connect() {
      try {
        // Dynamic import — noVNC uses browser APIs, can't run on server
        // @ts-ignore — noVNC doesn't ship type declarations
        const { default: RFB } = await import("@novnc/novnc/lib/rfb.js");

        rfb = new RFB(containerRef.current!, wssUrl, {
          shared: true,
          wsProtocols: ["binary"],
        });

        rfb.viewOnly = viewOnly;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.qualityLevel = 6;
        rfb.compressionLevel = 2;

        rfb.addEventListener("connect", () => {
          setStatus("connected");
          onConnect?.();
        });

        rfb.addEventListener("disconnect", (e: any) => {
          setStatus("disconnected");
          if (!e.detail.clean) {
            onError?.("Connection lost");
          }
          onDisconnect?.();
        });

        rfb.addEventListener("credentialsrequired", () => {
          // No password — our websockify runs without VNC auth
          rfb.sendCredentials({ password: "" });
        });

        rfbRef.current = rfb;
      } catch (err) {
        setStatus("disconnected");
        onError?.(String(err));
      }
    }

    connect();

    return () => {
      if (rfbRef.current) {
        try { rfbRef.current.disconnect(); } catch {}
        rfbRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wssUrl]);

  // Update viewOnly dynamically
  useEffect(() => {
    if (rfbRef.current) {
      rfbRef.current.viewOnly = viewOnly;
    }
  }, [viewOnly]);

  return (
    <div ref={containerRef} className="w-full h-full">
      {status === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className="text-white/60 text-sm animate-pulse">Connecting to desktop...</div>
        </div>
      )}
      {status === "disconnected" && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className="text-white/50 text-sm">Disconnected</div>
        </div>
      )}
    </div>
  );
}
