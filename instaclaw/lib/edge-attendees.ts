import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Edge Esmeralda 2026 attendee linking.
 *
 * Two writers maintain the invariant
 *   "users.is_edge_attendee = true iff an instaclaw_edge_attendees row
 *    with the same email exists":
 *
 *   1. `linkEdgeAttendeeByEmail` below — called from lib/auth.ts signIn
 *      callback when a user signs up (or signs back in) under an Edge
 *      partner cookie. Per-user; idempotent; non-blocking on failure.
 *
 *   2. scripts/_ingest-edge-attendees.ts — runs when Timour ships a new
 *      attendees CSV. Bulk-links every existing user whose email matches
 *      a freshly-ingested attendee row, so users who signed up BEFORE
 *      the CSV landed get the flag too. The ingest script uses its own
 *      batched UPDATE for speed — it does not call this helper N times.
 *
 * The attendees table is the source of truth. `users.is_edge_attendee`
 * is the denormalized cache. If they ever drift, re-running the ingest
 * with the canonical CSV rebuilds the cache.
 */

export type EdgeAttendeeLinkResult =
  | { ok: true; linked: true; ticket_id: string | null }
  | { ok: true; linked: false }
  | { ok: false; error: string };

/**
 * Look up `email` in instaclaw_edge_attendees. If matched:
 *   - stamp the attendees row with user_id + claimed_at (idempotent —
 *     only updates if not already linked, preserving the original
 *     claimed_at on retries)
 *   - flip users.is_edge_attendee to true
 *
 * Returns `{ ok: true, linked: false }` if the email isn't in the
 * attendees table. Never throws — callers should log on `ok: false` and
 * continue (signin must never block on this).
 */
export async function linkEdgeAttendeeByEmail(
  supabase: SupabaseClient,
  userId: string,
  email: string
): Promise<EdgeAttendeeLinkResult> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return { ok: false, error: "email is empty" };

  try {
    // .select("*") per Rule 19 — column-grant misconfig on a partial
    // select can silently return null and break detection.
    const { data: attendee, error: lookupErr } = await supabase
      .from("instaclaw_edge_attendees")
      .select("*")
      .eq("email", normalized)
      .maybeSingle();

    if (lookupErr) {
      return { ok: false, error: `lookup: ${lookupErr.message}` };
    }

    if (!attendee) {
      return { ok: true, linked: false };
    }

    // Stamp the attendees row only if not already linked. Preserves the
    // original claimed_at across retries — first-write wins.
    if (!attendee.user_id) {
      const { error: stampErr } = await supabase
        .from("instaclaw_edge_attendees")
        .update({
          user_id: userId,
          claimed_at: new Date().toISOString(),
        })
        .eq("email", normalized)
        .is("user_id", null); // race-safe: a concurrent linker can't double-write

      if (stampErr) {
        return { ok: false, error: `stamp: ${stampErr.message}` };
      }
    }

    // Flip the cache. Idempotent — no-op if already true.
    const { error: userErr } = await supabase
      .from("instaclaw_users")
      .update({ is_edge_attendee: true })
      .eq("id", userId);

    if (userErr) {
      return { ok: false, error: `user-update: ${userErr.message}` };
    }

    return {
      ok: true,
      linked: true,
      ticket_id: (attendee.ticket_id as string | null) ?? null,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
