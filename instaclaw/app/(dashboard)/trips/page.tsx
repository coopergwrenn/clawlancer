"use client";

/**
 * /trips — the travel lane's artifact page (trips spec, ruled 2026-06-12).
 *
 * Chat is the interface for ACTIONS; this page is the interface for ARTIFACTS:
 * booking refs, cancellation windows, on-chain receipts — the things a user
 * needs at unpredictable future moments (the check-in desk) where "scroll back
 * through telegram" is the wrong answer.
 *
 * READ-ONLY always: renders what the system recorded (instaclaw_travala_bookings
 * via the session-authed /api/skills/travala-trips). The one action per card
 * deep-links into chat with the composer seeded — the agent stays the actor.
 *
 * Presence-based: the sidebar item appears only when bookings exist; this page
 * still renders a quiet empty state for direct-URL visits.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Luggage } from "lucide-react";
import { TripCard } from "@/components/dashboard/trip-card";
import type { TripRow } from "@/lib/travala-trips-view";

// The ghost receipt's example data — obviously-sample content rendered through
// the REAL TripCard so the empty state shows exactly what the user will get.
// The countdown is computed at render (+36h) so the ticking clock reads live.
const GHOST_TRIP: TripRow = {
  id: "ghost",
  bookingId: "MN5V9DWQ",
  hotelName: "memmo alfama · lisbon",
  checkIn: "2026-06-24",
  checkOut: "2026-06-26",
  room: "deluxe double",
  displayPrice: 84.5,
  currency: "USD",
  amountUsdPaid: 84.5,
  txHash: "0x4f7a2c9e8b1d6f3a5c0e7d2b9a4f6c1e8d3b5a7f2c9e4b6d1a8f3c5e7b2d9a4f",
  status: "confirmed",
  cancellationPolicy: "free cancellation until jun 24, 3:00 pm",
  freeCancellationUntilUtc: new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString(),
  isRefundable: true,
  refundAmount: null,
  cancellationFee: null,
  cancelRequestedAt: null,
  cancelledAt: null,
  createdAt: new Date().toISOString(),
};

interface TripsResponse {
  ok?: boolean;
  trips?: TripRow[];
  agent_name?: string | null;
  error?: string;
}

export default function TripsPage() {
  const [trips, setTrips] = useState<TripRow[] | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/skills/travala-trips", { cache: "no-store" });
        const j = (await res.json().catch(() => ({}))) as TripsResponse;
        if (!alive) return;
        if (!res.ok || !j.ok) {
          setError("couldn't load your trips · refresh to try again");
          setTrips([]);
          return;
        }
        setTrips(j.trips ?? []);
        setAgentName(j.agent_name ?? null);
      } catch {
        if (alive) {
          setError("couldn't load your trips · refresh to try again");
          setTrips([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5">
          <Luggage size={18} className="text-[#13B5C9]" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-white">trips</h1>
          <p className="text-xs text-white/45">
            what the system recorded · refs, deadlines, on-chain receipts
          </p>
        </div>
      </div>

      {trips === null && (
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <div key={i} className="h-56 w-full animate-pulse rounded-2xl border border-white/10 bg-[#161617]" />
          ))}
        </div>
      )}

      {trips !== null && error && (
        <div className="rounded-2xl border border-white/10 bg-[#161617] p-6 text-sm text-white/55">{error}</div>
      )}

      {trips !== null && !error && trips.length === 0 && (
        // Empty state (north-star ruling 2026-06-12): no verification steps, no
        // setup checklist, no nagging about funding or toggles — those asks live
        // in CHAT, made by the agent at the moment they matter. The ghost receipt
        // sells by showing the real thing; one CTA, zero learning curve.
        <div className="space-y-4">
          <TripCard trip={GHOST_TRIP} agentName={null} ghost />
          <div className="text-center">
            <div className="text-sm text-white/60">no trips yet · your receipts will look like this</div>
            <div className="mt-1 text-xs text-white/40">
              booked autonomously by your agent, paid in usdc on base, cancellable from chat
            </div>
            <Link
              href={`/tasks?prefill=${encodeURIComponent("find me a hotel in lisbon")}`}
              className="mt-4 inline-flex h-9 items-center justify-center rounded-lg border border-[#13B5C9]/35 bg-[#13B5C9]/10 px-4 text-sm text-[#13B5C9] transition-colors hover:bg-[#13B5C9]/20 outline-none focus-visible:ring-2 focus-visible:ring-[#13B5C9]/40"
            >
              ask your agent to find you a hotel
            </Link>
          </div>
        </div>
      )}

      {trips !== null && !error && trips.length > 0 && (
        <div className="space-y-4">
          {trips.map((t) => (
            <TripCard key={t.id} trip={t} agentName={agentName} />
          ))}
        </div>
      )}
    </div>
  );
}
