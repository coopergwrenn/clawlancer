/**
 * GET /api/cron/expire-privacy-mode
 *
 * Clears expired Maximum Privacy Mode entries — sets privacy_mode_until = NULL
 * for any user whose timestamp is in the past. Runs every 15 minutes; the 24h
 * TTL means a 15-minute lag at expiry is acceptable.
 *
 * Auth: Bearer CRON_SECRET (consistent with every other cron in this app).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const nowIso = new Date().toISOString();

  const { data: expired, error: selectErr } = await supabase
    .from("instaclaw_users")
    .select("id")
    .lt("privacy_mode_until", nowIso)
    .not("privacy_mode_until", "is", null);

  if (selectErr) {
    logger.error("expire-privacy-mode select failed", { error: selectErr.message });
    return NextResponse.json({ error: "Select failed" }, { status: 500 });
  }

  const count = expired?.length ?? 0;
  if (count === 0) {
    return NextResponse.json({ cleared: 0 });
  }

  const { error: updateErr } = await supabase
    .from("instaclaw_users")
    .update({ privacy_mode_until: null })
    .lt("privacy_mode_until", nowIso)
    .not("privacy_mode_until", "is", null);

  if (updateErr) {
    logger.error("expire-privacy-mode update failed", { error: updateErr.message });
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  logger.info("expire-privacy-mode cleared entries", { count });
  return NextResponse.json({ cleared: count });
}
