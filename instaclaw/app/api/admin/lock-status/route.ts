/**
 * GET /api/admin/lock-status — Public read-only endpoint for cron lock state.
 *
 * Rule 13 / CLAUDE.md: this route is in middleware.ts:selfAuthAPIs because
 * the response is operational metadata (cron lock state) that partner
 * integrators need to self-serve without API keys. Specifically the
 * use-case from Timour feedback item #4: "when our reconcile-fleet lock is
 * held, my diagnostic scripts can't tell who's holding it." Polling this
 * endpoint lets partners coordinate around in-flight maintenance.
 *
 * Response shape (per PRD P1-6):
 *   {
 *     locks: [
 *       {
 *         name: "reconcile-fleet",
 *         holder: "vercel-cron",
 *         acquired_at: "2026-05-14T15:54:13.345Z",
 *         expires_at: "2026-05-14T16:00:13.345Z",
 *         ttl_seconds_remaining: 247  // Math.max(0, ...) — never negative
 *       },
 *       ...
 *     ]
 *   }
 *
 * Security review: holder is a free-text field set by the lock acquirer
 * (e.g. "vercel-cron", "manual-fleet-recovery", "catch-up-stuck-cohort").
 * Operator names CAN end up here when a human-driven script holds the
 * lock, which leaks operational metadata. We accept this trade-off per
 * Cooper's PRD spec — the value to partner integrators outweighs the
 * surface-area concern, and the data is no more sensitive than the
 * publicly-visible cron schedule in vercel.json.
 */
import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

interface LockRow {
  name: string;
  holder: string;
  acquired_at: string;
  expires_at: string;
}

export async function GET(): Promise<NextResponse> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("instaclaw_cron_locks")
    .select("name, holder, acquired_at, expires_at")
    .order("acquired_at", { ascending: false });

  if (error) {
    logger.error("lock-status: query failed", {
      route: "admin/lock-status",
      code: error.code,
      error: error.message,
    });
    return NextResponse.json({ error: "db_query_failed" }, { status: 500 });
  }

  const now = Date.now();
  const locks = ((data ?? []) as LockRow[]).map((row) => {
    const expiresAtMs = new Date(row.expires_at).getTime();
    const ttlSec = Number.isFinite(expiresAtMs)
      ? Math.max(0, Math.round((expiresAtMs - now) / 1000))
      : 0;
    return {
      name: row.name,
      holder: row.holder,
      acquired_at: row.acquired_at,
      expires_at: row.expires_at,
      ttl_seconds_remaining: ttlSec,
    };
  });

  return NextResponse.json({ locks });
}
