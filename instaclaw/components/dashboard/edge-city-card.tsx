"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MapPin, Eye, EyeOff, ArrowRight } from "lucide-react";

interface RenderedOverlay {
  display_name: string;
  spectator_visible: boolean;
}

export function EdgeCityCard() {
  const [rendered, setRendered] = useState<RenderedOverlay | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/village/overlay", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.rendered) return;
        setRendered({
          display_name: data.rendered.display_name ?? "Agent",
          spectator_visible: data.rendered.spectator_visible ?? true,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Link
      href="/edge/dashboard"
      className="glass rounded-xl p-5 flex items-center gap-4 hover:bg-black/[0.02] transition-colors group"
      style={{ border: "1px solid var(--border)" }}
    >
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: "rgba(124, 138, 90, 0.12)" }}
      >
        <MapPin className="w-5 h-5" style={{ color: "#7c8a5a" }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold">Edge City</h3>
          <span className="text-xs" style={{ color: "var(--muted)" }}>
            Edge Esmeralda 2026
          </span>
        </div>
        <div className="text-xs mt-0.5 flex items-center gap-2" style={{ color: "var(--muted)" }}>
          {loading ? (
            <span>Loading your village presence…</span>
          ) : rendered ? (
            <>
              <span className="truncate">
                <span style={{ color: "var(--foreground)" }}>{rendered.display_name}</span>
              </span>
              <span>·</span>
              <span className="inline-flex items-center gap-1 shrink-0">
                {rendered.spectator_visible ? (
                  <>
                    <Eye className="w-3 h-3" />
                    Visible in village
                  </>
                ) : (
                  <>
                    <EyeOff className="w-3 h-3" />
                    Hidden
                  </>
                )}
              </span>
            </>
          ) : (
            <span>Manage your village presence</span>
          )}
        </div>
      </div>
      <span
        className="text-xs font-medium inline-flex items-center gap-1 shrink-0 group-hover:translate-x-0.5 transition-transform"
        style={{ color: "#7c8a5a" }}
      >
        Go to Edge City
        <ArrowRight className="w-3 h-3" />
      </span>
    </Link>
  );
}
