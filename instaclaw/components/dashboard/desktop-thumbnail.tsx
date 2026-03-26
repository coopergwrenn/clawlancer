"use client";

import { useState, useEffect, useRef } from "react";
import { Monitor } from "lucide-react";
import Link from "next/link";

export function DesktopThumbnail() {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const tickRef = useRef(0);

  // Refresh thumbnail every 15 seconds
  useEffect(() => {
    function refresh() {
      tickRef.current++;
      if (imgRef.current) {
        imgRef.current.src = `/api/vm/desktop-thumbnail?t=${Date.now()}`;
      }
    }

    // Initial load
    refresh();

    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Link href="/live" className="block">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card,#fff)] overflow-hidden hover:border-[var(--accent)] transition-colors group">
        {/* Thumbnail area */}
        <div className="relative bg-[#1a1a1a]" style={{ aspectRatio: "5/3" }}>
          {/* The image */}
          <img
            ref={imgRef}
            alt="Agent desktop"
            className={`w-full h-full object-cover transition-opacity duration-500 ${loaded ? "opacity-100" : "opacity-0"}`}
            onLoad={() => { setLoaded(true); setError(false); }}
            onError={() => setError(true)}
          />

          {/* Placeholder when no image */}
          {(!loaded || error) && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Monitor className="w-6 h-6 text-white/20" />
            </div>
          )}

          {/* LIVE badge */}
          {loaded && !error && (
            <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-black/60 backdrop-blur-sm">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[9px] font-semibold text-emerald-400 uppercase tracking-wider">Live</span>
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
            {loaded && !error ? "Live preview" : "Click to watch"}
          </p>
        </div>
      </div>
    </Link>
  );
}
