/**
 * /api/skills/travala-trips — the session-authed READ for the Trips surface.
 *
 * Session-authed (auth()): a user reads THEIR OWN VM's booking rows. Deliberately
 * under /api/skills/ and NOT /api/travala/ (trips spec departure D4): /api/travala
 * is in the middleware selfAuthAPIs allow-list (gateway-token auth), so a
 * session route there would silently bypass the middleware session check — a
 * Rule 13 footgun. Here the middleware session gate applies AND the route
 * double-checks (defense in depth, same shape as /api/skills/travala-booking).
 *
 * READ-ONLY by construction — this route (and the whole Trips surface) never
 * acts. The agent stays the actor; the page is a window into the system of
 * record (instaclaw_travala_bookings).
 *
 * Shapes:
 *   GET                → { ok:true, trips: TripRow[], agent_name }
 *   GET ?presence=1    → { ok:true, count }   (the sidebar's conditional gate —
 *                         cheapest possible: head-count only, no rows)
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { toTripRow } from "@/lib/travala-trips-view";
import { TRAVALA_BOOKINGS_TABLE } from "@/lib/travala-bookings";

export const maxDuration = 30; // DB reads only (Rule 11 margin)
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const supabase = getSupabase();

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("*") // Rule 19 — mirror the travala-booking route's read
    .eq("assigned_to", userId)
    .single();
  if (!vm) return NextResponse.json({ error: "No VM assigned" }, { status: 404 });

  const presence = req.nextUrl.searchParams.get("presence") === "1";
  if (presence) {
    const { count } = await supabase
      .from(TRAVALA_BOOKINGS_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("vm_id", vm.id as string);
    return NextResponse.json({ ok: true, count: count ?? 0 });
  }

  const { data: rows, error } = await supabase
    .from(TRAVALA_BOOKINGS_TABLE)
    .select(
      // display columns only — email/last_name (PII) and hold_id/request_id
      // (internal linkage) deliberately NOT exposed to the page.
      "id, booking_id, hotel_name, check_in, check_out, room, display_price, currency, amount_usd_paid, tx_hash, status, cancellation_policy_string, free_cancellation_until_utc, is_refundable, refund_amount, cancellation_fee, cancel_requested_at, cancelled_at, created_at",
    )
    .eq("vm_id", vm.id as string)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: "trips_read_failed" }, { status: 500 });

  return NextResponse.json({
    ok: true,
    trips: (rows ?? []).map((r) => toTripRow(r as Record<string, unknown>)),
    // same derivation as the approve surface (approve/route.ts:97)
    agent_name: ((vm.telegram_bot_username as string | null) ?? (vm.name as string | null) ?? null),
  });
}
