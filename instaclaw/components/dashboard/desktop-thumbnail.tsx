"use client";

import { useState, useEffect, useRef } from "react";
import { Monitor, Moon } from "lucide-react";
import Link from "next/link";

export function DesktopThumbnail() {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [idle, setIdle] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Refresh thumbnail every 15 seconds
  useEffect(() => {
    function refresh() {
      if (imgRef.current) {
        imgRef.current.src = `/api/vm/desktop-thumbnail?t=${Date.now()}`;
      }
    }
    refresh();
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, []);

  function checkIfIdle() {
    // Sample the loaded image — if mostly dark, agent is idle
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas || !img.naturalWidth) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = 20;
    canvas.height = 12;
    ctx.drawImage(img, 0, 0, 20, 12);

    const data = ctx.getImageData(0, 0, 20, 12).data;
    let brightPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (brightness > 30) brightPixels++;
    }

    // If less than 10% of pixels are non-dark, it's idle
    setIdle(brightPixels < (20 * 12) * 0.1);
  }

  return (
    <Link href="/live" className="block">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card,#fff)] overflow-hidden hover:border-[var(--accent)] transition-colors group">
        {/* Hidden canvas for pixel sampling */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Thumbnail area */}
        <div className="relative bg-[#1a1a1a]" style={{ aspectRatio: "5/3" }}>
          {/* The image */}
          <img
            ref={imgRef}
            alt="Agent desktop"
            crossOrigin="anonymous"
            className={`w-full h-full object-cover transition-opacity duration-500 ${loaded ? "opacity-100" : "opacity-0"}`}
            onLoad={() => { setLoaded(true); setError(false); checkIfIdle(); }}
            onError={() => setError(true)}
          />

          {/* Placeholder when no image */}
          {(!loaded || error) && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Monitor className="w-6 h-6 text-white/20" />
            </div>
          )}

          {/* Idle/resting overlay */}
          {loaded && !error && idle && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/30">
              <Moon className="w-5 h-5 text-white/40 animate-[pulse_3s_ease-in-out_infinite]" />
              <span className="text-[10px] text-white/40 mt-1.5 font-medium">Agent is dreaming</span>
            </div>
          )}

          {/* LIVE badge — always visible when loaded */}
          {loaded && !error && (
            <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-black/60 backdrop-blur-sm">
              <div className={`w-1.5 h-1.5 rounded-full ${idle ? "bg-amber-400" : "bg-emerald-400"} animate-pulse`} />
              <span className={`text-[9px] font-semibold uppercase tracking-wider ${idle ? "text-amber-400" : "text-emerald-400"}`}>
                {idle ? "Idle" : "Live"}
              </span>
            </div>
          )}

          {/* Hover overlay */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
            <span className="text-white/0 group-hover:text-white/80 text-xs font-medium transition-colors">
              Open Live View
            </span>
          </div>
        </div>

        {/* Label */}
        <div className="px-3 py-2">
          <p className="text-xs font-medium text-[var(--foreground)]">Agent Desktop</p>
          <p className="text-[10px] text-[var(--muted)]">
            {!loaded || error ? "Click to watch" : idle ? "Resting — tap to peek" : "Live preview"}
          </p>
        </div>
      </div>
    </Link>
  );
}
