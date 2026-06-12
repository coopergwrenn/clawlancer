"use client";

/**
 * TripsPresenceLink — the skills-grid entry point to /trips (presence option (c),
 * trips spec ruled 2026-06-12). Renders NOTHING when the user has zero bookings;
 * a quiet one-line "view trips" affordance when they have any.
 *
 * DELIBERATELY a separate component, NOT a change to travel-agent-skill-card.tsx:
 * that card has a held Phase-4 replacement (interactive → informational swap), so
 * this link lives beside it in the skills page and survives the swap untouched
 * (the collision-safe approach Cooper approved).
 *
 * Shares the sidebar's sessionStorage presence cache (one fetch per session
 * between them, whichever runs first).
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Luggage, ChevronRight } from "lucide-react";

export function TripsPresenceLink() {
  const [hasTrips, setHasTrips] = useState(false);

  useEffect(() => {
    try {
      const cached = sessionStorage.getItem("ic_trips_presence");
      if (cached !== null) {
        setHasTrips(cached === "1");
        return;
      }
    } catch { /* storage unavailable — fall through */ }
    let alive = true;
    fetch("/api/skills/travala-trips?presence=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { count?: number } | null) => {
        if (!alive) return;
        const has = !!j && typeof j.count === "number" && j.count > 0;
        setHasTrips(has);
        try { sessionStorage.setItem("ic_trips_presence", has ? "1" : "0"); } catch { /* best-effort */ }
      })
      .catch(() => { /* fail-quiet: no trips link is the safe default */ });
    return () => { alive = false; };
  }, []);

  if (!hasTrips) return null;
  return (
    <Link
      href="/trips"
      className="group -mt-2 mb-2 inline-flex items-center gap-1.5 px-1 text-xs text-[#13B5C9]/80 transition-colors hover:text-[#13B5C9]"
    >
      <Luggage size={13} />
      view trips
      <ChevronRight size={12} className="transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
