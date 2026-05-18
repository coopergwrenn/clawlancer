/**
 * GET/POST /api/village/overlay
 *
 * Edge City attendee self-service for the village_attendee_overlay row:
 *   - display_name (1-30 chars) — the label rendered above the user's
 *     sprite on edgeclaw-village.vercel.app/spectator
 *   - spectator_visible — opt out of the public spectator view entirely
 *
 * Hard partner gate: only `instaclaw_users.partner === "edge_city"`. The
 * underlying table allows other partners (Eclipse, Devcon, future events)
 * but this endpoint is scoped to the Edge Esmeralda cohort.
 *
 * Auth pattern mirrors app/api/account/privacy-mode/route.ts — NextAuth
 * session via `auth()`, server-side ownership assertion (`session.user.id`
 * is the only id that can ever be written), service-role Supabase write.
 *
 * Phase 3.5 also shipped RLS policies on village_attendee_overlay
 * (self_insert + self_update gated on auth.uid() = user_id). Those are
 * useful for direct-PostgREST clients (e.g., the village SPA or a future
 * Telegram skill); this route is the instaclaw.io path that uses
 * service-role + an explicit ownership check before writing.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

interface OverlayRow {
  user_id: string;
  display_name: string | null;
  spectator_visible: boolean;
  larry_atlas_index: number;
  home_tile_x: number;
  home_tile_y: number;
  description: string | null;
  updated_at: string;
}

async function getEdgeCityUserOrError(
  userId: string,
): Promise<{ ok: true; partner: string } | { ok: false; error: NextResponse }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("instaclaw_users")
    .select("id, partner")
    .eq("id", userId)
    .single();

  if (error || !data) {
    return {
      ok: false,
      error: NextResponse.json({ error: "user lookup failed" }, { status: 500 }),
    };
  }
  if (data.partner !== "edge_city") {
    return {
      ok: false,
      error: NextResponse.json(
        { error: "village settings are available for Edge City attendees only" },
        { status: 403 },
      ),
    };
  }
  return { ok: true, partner: data.partner as string };
}

// ─── GET ─────────────────────────────────────────────────────────────────
// Returns the user's current overlay row, plus the canonical display_name
// the spectator view will render (overlay.display_name → instaclaw_users.name
// → "Agent"). Defensive on a missing overlay row — view's COALESCE handles
// it, but the dashboard UI wants to know "is this a custom nickname or the
// fallback to my real name".
export async function GET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const gate = await getEdgeCityUserOrError(session.user.id);
  if (!gate.ok) return gate.error;

  const supabase = getSupabase();

  // Overlay row (may be absent — user hasn't customized yet).
  const { data: overlay } = await supabase
    .from("village_attendee_overlay")
    .select("*")
    .eq("user_id", session.user.id)
    .maybeSingle();

  // Canonical name from village_attendees view — already applies the
  // COALESCE chain (overlay.display_name → instaclaw_users.name → "Agent").
  // Use this as the "what the spectator actually sees" value.
  const { data: viewRow } = await supabase
    .from("village_attendees")
    .select("display_name, full_name, spectator_visible")
    .eq("user_id", session.user.id)
    .maybeSingle();

  return NextResponse.json({
    overlay: overlay as OverlayRow | null,
    rendered: {
      display_name: viewRow?.display_name ?? "Agent",
      full_name: viewRow?.full_name ?? null,
      spectator_visible: viewRow?.spectator_visible ?? true,
    },
  });
}

// ─── POST ────────────────────────────────────────────────────────────────
// Upserts display_name and/or spectator_visible on the caller's overlay
// row. Both fields are optional; only the keys present in the body get
// written. user_id is ALWAYS session.user.id — body cannot override.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const gate = await getEdgeCityUserOrError(session.user.id);
  if (!gate.ok) return gate.error;

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  // Validate display_name (matches the CHECK constraint
  // village_attendee_overlay_display_name_length: NULL OR 1..30 chars).
  const update: Partial<OverlayRow> = {};

  if ("display_name" in body) {
    const v = body.display_name;
    if (v === null || v === "") {
      // Explicit clear → fall back to instaclaw_users.name via COALESCE
      update.display_name = null;
    } else if (typeof v !== "string") {
      return NextResponse.json(
        { error: "display_name must be a string or null" },
        { status: 400 },
      );
    } else {
      const trimmed = v.trim();
      if (trimmed.length < 1 || trimmed.length > 30) {
        return NextResponse.json(
          { error: "display_name must be 1-30 characters after trimming" },
          { status: 400 },
        );
      }
      update.display_name = trimmed;
    }
  }

  if ("spectator_visible" in body) {
    const v = body.spectator_visible;
    if (typeof v !== "boolean") {
      return NextResponse.json(
        { error: "spectator_visible must be a boolean" },
        { status: 400 },
      );
    }
    update.spectator_visible = v;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "request body must include display_name or spectator_visible" },
      { status: 400 },
    );
  }

  const supabase = getSupabase();

  // Upsert via INSERT … ON CONFLICT — covers both "first edit" (no row yet,
  // hash defaults supply sprite/spawn) and "subsequent edit" (row exists,
  // update only the requested fields).
  const { error: upsertErr } = await supabase
    .from("village_attendee_overlay")
    .upsert(
      {
        user_id: session.user.id,
        ...update,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

  if (upsertErr) {
    // CHECK constraint violations come back here too (defense in depth
    // against a missed validation above).
    return NextResponse.json(
      { error: "overlay write failed", detail: upsertErr.message },
      { status: 500 },
    );
  }

  // Re-fetch the canonical rendered state to return.
  const { data: viewRow } = await supabase
    .from("village_attendees")
    .select("display_name, full_name, spectator_visible")
    .eq("user_id", session.user.id)
    .maybeSingle();

  return NextResponse.json({
    ok: true,
    rendered: {
      display_name: viewRow?.display_name ?? "Agent",
      full_name: viewRow?.full_name ?? null,
      spectator_visible: viewRow?.spectator_visible ?? true,
    },
  });
}
