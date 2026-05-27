/**
 * POST /api/onboarding/dismiss-channel-nudge — set the user's
 * dismissed_channel_nudge_at to NOW(), hiding the /dashboard banner
 * for 14 days.
 *
 * Auth: session-protected via lib/auth. Middleware enforces session on
 * /api/* by default; per Rule 13 this route does NOT need a
 * selfAuthAPIs allow-list entry because it uses NextAuth session auth.
 *
 * Idempotent: callable repeatedly without harm. Each call just bumps
 * the timestamp.
 *
 * Best-effort callers: the banner fires this in the background and
 * doesn't await the response. Failures are silent on the client (per
 * Rule 39 — non-critical UX surface). The banner reappears on next
 * session-refresh if the POST didn't land, which is the right
 * degraded behavior.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const maxDuration = 60;

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  const supabase = getSupabase();
  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from("instaclaw_users")
    .update({ dismissed_channel_nudge_at: nowIso })
    .eq("id", userId);

  if (error) {
    logger.error("[/api/onboarding/dismiss-channel-nudge] update failed", {
      route: "onboarding/dismiss-channel-nudge",
      userId,
      error: error.message,
    });
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  logger.info("[/api/onboarding/dismiss-channel-nudge] banner dismissed", {
    route: "onboarding/dismiss-channel-nudge",
    userId,
    dismissedAt: nowIso,
  });

  return NextResponse.json({ ok: true, dismissedAt: nowIso });
}
