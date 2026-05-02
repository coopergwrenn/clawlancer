/**
 * POST /api/internal/wake-vm
 *
 * Cross-app bridge: instaclaw-mini's pay/confirm route calls this after a
 * successful WLD credit top-up. Mini app cannot import lib/ssh (no node-ssh
 * dependency, separate Next.js project), so it asks instaclaw to wake any
 * hibernating VM owned by the user.
 *
 * Auth: X-Mini-App-Token (JWT issued by mini-app's signProxyToken) OR
 *       X-Admin-Key (admin override with explicit user_id in body).
 *
 * Already allow-listed by middleware via /api/internal/* (added in
 * Cooper's edge-privacy commit 0b164436 for the SSH-bridge endpoint).
 *
 * Best-effort: returns 200 even if wake fails. The caller MUST NOT fail
 * its primary operation on a wake error — credits were already added.
 * The defensive reconciler cron (cron/wake-paid-hibernating, every 15 min)
 * heals stranded VMs as the safety net.
 *
 * Spec: docs/watchdog-v2-and-wake-reconciler-design.md
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { validateMiniAppToken, validateAdminKey } from "@/lib/security";
import { wakeIfHibernating } from "@/lib/wake-vm";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
// SSH startGateway takes ~6-10s per VM. 60s is plenty for the realistic
// max of 1-2 hibernating VMs per user.
// CLAUDE.md Rule 11: any route that does SSH or external API needs maxDuration set.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let userId: string | null = null;

  // Path 1: mini-app proxy token (JWT carrying userId)
  const miniAppUserId = await validateMiniAppToken(req);
  if (miniAppUserId) {
    userId = miniAppUserId;
  } else if (validateAdminKey(req)) {
    // Path 2: admin override — explicit user_id in body
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
    // Per the design contract, never fail callers on wake errors.
    logger.error("internal/wake-vm: threw", {
      route: "internal/wake-vm",
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: true, error: "wake_failed" });
  }
}
