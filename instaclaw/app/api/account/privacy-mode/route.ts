/**
 * GET/POST /api/account/privacy-mode
 *
 * User-facing toggle for Maximum Privacy Mode (Edge City attendees only).
 *
 * Hard partner gate: this endpoint is reachable only by users whose
 * `instaclaw_users.partner === "edge_city"`. Non-edge_city users get 403
 * even though the underlying DB column exists for everyone — the column
 * is added to all rows for schema simplicity, but the toggle is
 * functionally inert outside the edge_city cohort because the VM-side
 * SSH bridge is only deployed on edge_city VMs.
 *
 * Default state: NULL (privacy mode OFF — Cooper has normal operator
 * access). User opts INTO privacy mode; toggle ON sets the column to
 * NOW() + 24h. The expire-privacy-mode cron clears expired entries.
 *
 * See PRD § 6.1 for the full design + § 4.16 for operational resilience.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

const TOGGLE_TTL_HOURS = 24;

interface UserGate {
  id: string;
  partner: string | null;
  privacy_mode_until: string | null;
}

async function getEdgeCityUserOrError(userId: string): Promise<{ user: UserGate } | { error: NextResponse }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("instaclaw_users")
    .select("id, partner, privacy_mode_until")
    .eq("id", userId)
    .single();

  if (error || !data) {
    return { error: NextResponse.json({ error: "User lookup failed" }, { status: 500 }) };
  }
  if (data.partner !== "edge_city") {
    return {
      error: NextResponse.json(
        { error: "Maximum Privacy Mode is available for Edge City attendees only." },
        { status: 403 }
      ),
    };
  }
  return { user: data as UserGate };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await getEdgeCityUserOrError(session.user.id);
  if ("error" in result) return result.error;

  const until = result.user.privacy_mode_until;
  const active = until !== null && new Date(until).getTime() > Date.now();

  return NextResponse.json({
    available: true,
    active,
    until: active ? until : null,
    ttl_hours: TOGGLE_TTL_HOURS,
  });
}

// TODO(privacy-v0-followup): per QA-2026-05-02 #7, this POST relies on
// SameSite cookie defaults for CSRF defense. v1 should add an explicit
// CSRF token check on the toggle (defense in depth). Probably easiest via
// next-auth's built-in csrfToken() and a hidden field round-trip from the
// dashboard page; or a custom HMAC over the user_id + a short-lived
// timestamp. Toggling privacy mode without consent isn't catastrophic
// (24h auto-revert + the toggle is reversible), but a malicious site
// could induce a temporary lockout — annoying enough to fix.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let enable: boolean;
  try {
    const body = await req.json();
    enable = body?.enable === true || body?.enable === false ? body.enable : null;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof enable !== "boolean") {
    return NextResponse.json({ error: "Body must include { enable: boolean }" }, { status: 400 });
  }

  const result = await getEdgeCityUserOrError(session.user.id);
  if ("error" in result) return result.error;

  const supabase = getSupabase();
  const newUntil = enable
    ? new Date(Date.now() + TOGGLE_TTL_HOURS * 60 * 60 * 1000).toISOString()
    : null;

  const { error: updateErr } = await supabase
    .from("instaclaw_users")
    .update({ privacy_mode_until: newUntil })
    .eq("id", session.user.id);

  if (updateErr) {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  // Operational log for now — structured audit-log table comes with the
  // sample-email cron (component 6). The column itself is the source of
  // truth for active/inactive state.
  console.log("[privacy-mode]", {
    user_id: session.user.id,
    action: enable ? "enabled" : "disabled",
    until: newUntil,
  });

  return NextResponse.json({
    active: enable,
    until: newUntil,
  });
}
