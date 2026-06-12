"use client";

/**
 * /trip-card-preview — DEV-ONLY render harness for the TripCard screenshots
 * (the announce shot + the empty state). Returns 404 outside development; never
 * reachable in prod. Mirrors the premium-hero-preview pattern.
 */
import { notFound } from "next/navigation";
import { TripCard } from "@/components/dashboard/trip-card";
import type { TripRow } from "@/lib/travala-trips-view";

const H = 3_600_000;
const base: TripRow = {
  id: "preview",
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
  freeCancellationUntilUtc: new Date(Date.now() + 36 * H + 12 * 60_000).toISOString(),
  isRefundable: true,
  refundAmount: null,
  cancellationFee: null,
  cancelRequestedAt: null,
  cancelledAt: null,
  createdAt: new Date().toISOString(),
};

export default function TripCardPreview() {
  if (process.env.NODE_ENV !== "development") notFound();
  return (
    <div className="min-h-screen bg-[#0b0b0c] px-6 py-10">
      <div className="mx-auto flex max-w-2xl flex-col gap-8">
        <section id="confirmed">
          <div className="mb-2 text-xs text-white/30">confirmed · the announce shot</div>
          <TripCard trip={base} agentName="timmy" />
        </section>
        <section id="ghost-empty">
          <div className="mb-2 text-xs text-white/30">empty state · the ghost receipt</div>
          <div className="space-y-4">
            <TripCard trip={base} agentName={null} ghost />
            <div className="text-center">
              <div className="text-sm text-white/60">no trips yet · your receipts will look like this</div>
              <div className="mt-1 text-xs text-white/40">
                booked autonomously by your agent, paid in usdc on base, cancellable from chat
              </div>
              <span className="mt-4 inline-flex h-9 items-center justify-center rounded-lg border border-[#13B5C9]/35 bg-[#13B5C9]/10 px-4 text-sm text-[#13B5C9]">
                ask your agent to find you a hotel
              </span>
            </div>
          </div>
        </section>
        <section id="pending">
          <div className="mb-2 text-xs text-white/30">cancel_requested</div>
          <TripCard trip={{ ...base, status: "cancel_requested", cancelRequestedAt: new Date().toISOString() }} agentName="timmy" />
        </section>
        <section id="cancelled-stub">
          <div className="mb-2 text-xs text-white/30">cancelled · canary-honest refund stub</div>
          <TripCard trip={{ ...base, status: "cancelled", cancelledAt: new Date().toISOString() }} agentName="timmy" />
        </section>
        <section id="failed">
          <div className="mb-2 text-xs text-white/30">cancel_failed</div>
          <TripCard trip={{ ...base, status: "cancel_failed" }} agentName="timmy" />
        </section>
      </div>
    </div>
  );
}
