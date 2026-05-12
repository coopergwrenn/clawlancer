/**
 * GET /api/edge/verify-attendee
 *
 * Checks whether the session user's email appears in instaclaw_edge_attendees.
 * Used by the claim flow to decide whether to skip /plan (verified Edge
 * attendees get the free tier and shouldn't be sent through Stripe checkout).
 *
 * Session-protected — relies on auth() for the user identity. Per Rule 13,
 * session-protected routes do NOT need an entry in middleware.ts
 * `selfAuthAPIs` allow-list. Anonymous requests get 401 from the route's
 * own check (middleware also blocks them by default).
 *
 * Returns:
 *   200 { verified: false } — session valid but no attendee row matches
 *   200 { verified: true, ticket_id, claimed_at } — attendee row exists
 *   400 { error } — session user has no email (shouldn't happen for Google OAuth)
 *   401 { error } — no valid session
 *   500 { error } — DB error
 *
 * No mutations. Safe to call repeatedly. The attendees table is the source
 * of truth; this route does NOT consult users.is_edge_attendee — the cache
 * could be stale relative to a freshly-ingested CSV.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const email = session.user.email?.trim().toLowerCase();
  if (!email) {
    return NextResponse.json(
      { error: "Session user has no email" },
      { status: 400 }
    );
  }

  const supabase = getSupabase();

  // .select("*") per Rule 19 — safety-critical read (downstream decisions
  // skip Stripe checkout based on this result).
  const { data: attendee, error } = await supabase
    .from("instaclaw_edge_attendees")
    .select("*")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    logger.error("verify-attendee lookup failed", {
      route: "edge/verify-attendee",
      email,
      error: error.message,
    });
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }

  if (!attendee) {
    return NextResponse.json({ verified: false });
  }

  return NextResponse.json({
    verified: true,
    ticket_id: (attendee.ticket_id as string | null) ?? null,
    claimed_at: (attendee.claimed_at as string | null) ?? null,
  });
}
