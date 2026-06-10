/**
 * POST /api/auth/channel-confirm — completes channel onboarding AFTER the
 * user confirms "continuing as <email>" on /auth.
 *
 * 2026-06-10 identity-hardening pass. Previously /auth Branch 1 auto-bound
 * the pending row + fired VM provisioning the instant it saw an existing
 * NextAuth session — with zero confirmation of WHICH account. On a shared /
 * borrowed / stale-session device (the Edge Esmeralda conference scenario)
 * a new person silently bound their agent + phone number to the wrong
 * pre-existing account. The fix moves the bind + provision behind an explicit
 * "continuing as <email>" confirmation (rendered by continuing-as-client.tsx);
 * THIS route is what the confirm button calls. The binding does not fire
 * until past this moment.
 *
 * Auth model (Rule 13): session-protected — relies on auth() for the user.
 * The middleware session check is the first line; this re-check is defense in
 * depth. No allow-list entry needed (authenticated callers only).
 *
 * Mirrors the bind + provision + next-route logic that used to live inline in
 * app/(auth)/auth/page.tsx Branch 1. Re-validates server-side — never trusts
 * the client's sessionId.
 *
 * Per Rule 11, maxDuration=300: assignOrProvisionUserVm is fired via after()
 * so the response isn't blocked, but the function must outlive the response.
 */

import { NextRequest, NextResponse, after } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { assignOrProvisionUserVm } from "@/lib/createUserVM";
import { logger } from "@/lib/logger";

export const maxDuration = 300;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const authSession = await auth();
  if (!authSession?.user?.id) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = authSession.user.id;

  let body: { sessionId?: string };
  try {
    body = (await req.json()) as { sessionId?: string };
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const sessionId =
    typeof body.sessionId === "string" && UUID_REGEX.test(body.sessionId)
      ? body.sessionId
      : null;
  if (!sessionId) {
    // No valid session id — nothing to bind. Send them home; they're authed.
    return NextResponse.json({ next: "/dashboard" });
  }

  const supabase = getSupabase();

  // Re-validate the pending row server-side (never trust the client).
  const { data: pending, error: pendingErr } = await supabase
    .from("instaclaw_pending_users")
    .select("*")
    .eq("id", sessionId)
    .maybeSingle();

  if (pendingErr) {
    logger.error("[channel-confirm] pending lookup failed", {
      route: "auth/channel-confirm",
      userId,
      sessionId,
      error: pendingErr.message,
    });
    return NextResponse.json({ next: "/dashboard" });
  }

  // Stale, consumed, or bound to another user (hostile forward) → dashboard.
  if (
    !pending ||
    pending.consumed_at ||
    (pending.user_id && pending.user_id !== userId)
  ) {
    logger.info("[channel-confirm] pending stale/hostile/consumed → dashboard", {
      route: "auth/channel-confirm",
      userId,
      sessionId,
      consumed: !!pending?.consumed_at,
      userIdMatch: pending?.user_id === userId,
    });
    return NextResponse.json({ next: "/dashboard" });
  }

  // Bind pending row → this user (idempotent). Race-safe: only while still
  // unconsumed so Pass 6 can't race the bind.
  if (pending.user_id !== userId) {
    const { error: bindErr } = await supabase
      .from("instaclaw_pending_users")
      .update({ user_id: userId })
      .eq("id", sessionId)
      .is("consumed_at", null);
    if (bindErr) {
      logger.error("[channel-confirm] bind failed", {
        route: "auth/channel-confirm",
        userId,
        sessionId,
        error: bindErr.message,
      });
      return NextResponse.json({ next: "/dashboard" });
    }
  }

  // §6.5.2 — fire VM assignment now that the user has confirmed identity.
  // after() so the response isn't blocked; recovery via process-pending if it
  // throws. This is the same call the page used to make inline.
  after(async () => {
    try {
      await assignOrProvisionUserVm(userId, { supabase });
      logger.info("[channel-confirm] VM assignment fired on confirm", {
        route: "auth/channel-confirm",
        userId,
        sessionId,
      });
    } catch (err) {
      logger.error("[channel-confirm] assignOrProvisionUserVm threw in after()", {
        route: "auth/channel-confirm",
        userId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Next route: Edge users skip /plan (sponsored, no card).
  const { data: user } = await supabase
    .from("instaclaw_users")
    .select("partner")
    .eq("id", userId)
    .maybeSingle();

  const next =
    user?.partner === "edge_city"
      ? `/onboarding/done?session=${sessionId}`
      : `/plan?channel=1&session=${sessionId}`;

  return NextResponse.json({ next });
}
