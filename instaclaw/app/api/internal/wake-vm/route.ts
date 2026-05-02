import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { validateMiniAppToken, validateAdminKey } from "@/lib/security";
import { wakeIfHibernating } from "@/lib/wake-vm";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
// SSH operation in wakeIfHibernating can take ~10-15s per VM. 60s is plenty
// for the realistic max of 1-2 hibernating VMs per user.
export const maxDuration = 60;

/**
 * POST /api/internal/wake-vm
 *
 * Wakes any hibernating VM owned by the caller's user. Used by
 * instaclaw-mini after a successful WLD credit top-up — the mini app's
 * payment confirm route can't import lib/ssh (no node-ssh dependency,
 * separate Next.js project), so it calls this endpoint instead.
 *
 * Auth: X-Mini-App-Token (JWT issued by mini-app proxy) OR X-Admin-Key.
 *   - Mini-app token carries userId → wake VMs assigned to that userId.
 *   - Admin key requires explicit { user_id } in the body.
 *
 * Listed in middleware.ts selfAuthAPIs because it provides its own auth
 * (per CLAUDE.md Rule 13 — non-allow-listed routes get 401'd by middleware).
 *
 * Best-effort: returns 200 even if wake fails. The caller (mini-app
 * pay/confirm) MUST NOT block on this — credits were already added; the
 * defensive reconciler cron (Fix D) will heal stranded VMs within 15 min
 * if the SSH wake here fails for any reason.
 */
export async function POST(req: NextRequest) {
  let userId: string | null = null;

  // Auth path 1: mini-app token
  const miniAppUserId = await validateMiniAppToken(req);
  if (miniAppUserId) {
    userId = miniAppUserId;
  } else if (validateAdminKey(req)) {
    // Auth path 2: admin key with explicit user_id in body
    const body = await req.json().catch(() => ({}));
    if (typeof body.user_id === "string") userId = body.user_id;
  }

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabase();
    const results = await wakeIfHibernating(supabase, userId, "internal/wake-vm");
    const woke = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);
    logger.info("internal/wake-vm: completed", {
      route: "internal/wake-vm",
      userId,
      total: results.length,
      woke,
      failed: failed.length,
    });
    return NextResponse.json({ ok: true, total: results.length, woke, failed });
  } catch (err) {
    // Per the design contract, we don't fail callers on wake errors.
    logger.error("internal/wake-vm: threw", {
      route: "internal/wake-vm",
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: true, error: "wake_failed" });
  }
}
