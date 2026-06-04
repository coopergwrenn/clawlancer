import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

// Per-user data — never CDN-cache.
export const dynamic = "force-dynamic";

/**
 * /api/sessions/pins — server-backed pin store for the dashboard sidebar
 * Sessions index (Stage 2). Backs components/dashboard/use-pins.ts, which used
 * to keep pins in localStorage (Stage 1, per-device) and now mirrors them here
 * so a user's pins follow them across devices.
 *
 * AUTHORIZATION — READ THIS. RLS on instaclaw_session_pins is defense-in-depth
 * ONLY; it is NOT the gate. We authenticate via NextAuth (Google OAuth), not
 * Supabase Auth, and getSupabase() is the SERVICE-ROLE client, which BYPASSES
 * RLS — under it auth.uid() is NULL. The real authorization is right here: every
 * query below is scoped to the auth()-resolved session.user.id. A bug that drops
 * that .eq("user_id", …) would expose every user's pins regardless of the RLS
 * policies. The handler is the gate. (See the migration's RLS comment + Rule 60.)
 *
 * A pin key is `${type}:${id}` — type ∈ {chat, task}, id a conversation/task
 * UUID. This is exactly the PinKey shape the client already uses, so GET returns
 * keys verbatim and POST/DELETE accept them verbatim.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ParsedKey = { sessionType: "chat" | "task"; sessionId: string };

/** Parse + validate a `type:uuid` pin key. Returns null on any malformed input. */
function parseKey(raw: unknown): ParsedKey | null {
  if (typeof raw !== "string") return null;
  const sep = raw.indexOf(":");
  if (sep <= 0) return null;
  const type = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (type !== "chat" && type !== "task") return null;
  if (!UUID_RE.test(id)) return null;
  return { sessionType: type, sessionId: id };
}

/**
 * GET /api/sessions/pins
 * → { pins: PinKey[] }  — the user's pins, newest-pinned first.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("instaclaw_session_pins")
    .select("session_type, session_id")
    .eq("user_id", session.user.id) // ← the authz gate (see file header)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch pins" }, { status: 500 });
  }

  const pins = (data ?? []).map((r) => `${r.session_type}:${r.session_id}`);
  return NextResponse.json({ pins });
}

/**
 * POST /api/sessions/pins   body: { key: "chat:<uuid>" | "task:<uuid>" }
 * Idempotent — ON CONFLICT DO NOTHING on (user_id, session_type, session_id).
 * → { ok: true }
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let key: unknown;
  try {
    key = (await req.json())?.key;
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const parsed = parseKey(key);
  if (!parsed) {
    return NextResponse.json({ error: "Invalid pin key" }, { status: 400 });
  }

  const supabase = getSupabase();
  const { error } = await supabase.from("instaclaw_session_pins").upsert(
    {
      user_id: session.user.id, // ← the authz gate (see file header)
      session_type: parsed.sessionType,
      session_id: parsed.sessionId,
    },
    { onConflict: "user_id,session_type,session_id", ignoreDuplicates: true },
  );

  if (error) {
    return NextResponse.json({ error: "Failed to add pin" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/sessions/pins?key=chat:<uuid>
 * Scoped delete — only ever removes the calling user's own pin.
 * → { ok: true }  (idempotent: deleting a non-existent pin still succeeds)
 */
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = parseKey(req.nextUrl.searchParams.get("key"));
  if (!parsed) {
    return NextResponse.json({ error: "Invalid pin key" }, { status: 400 });
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from("instaclaw_session_pins")
    .delete()
    .eq("user_id", session.user.id) // ← the authz gate (see file header)
    .eq("session_type", parsed.sessionType)
    .eq("session_id", parsed.sessionId);

  if (error) {
    return NextResponse.json({ error: "Failed to remove pin" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
