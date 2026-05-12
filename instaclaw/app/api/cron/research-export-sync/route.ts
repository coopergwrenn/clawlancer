/**
 * Daily research-export sync.
 *
 * Pulls new/updated rows from public.matchpool_outcomes since the last
 * watermark, anonymizes them (hash agent IDs + PII-sweep reason_text
 * via lib/research-export/anonymize.ts), and upserts into
 * research.matchpool_outcomes via the public.research_matchpool_sync
 * RPC. Atomic — the upsert + watermark advance happen in one server-
 * side transaction.
 *
 * Schedule: 00:00 UTC daily (vercel.json).
 *
 * Auth: CRON_SECRET (Bearer or x-cron-secret header). Standard
 * /api/cron/* pattern per middleware.ts:51.
 *
 * Env required:
 *   - CRON_SECRET                       Vercel cron auth
 *   - EDGE_CITY_RESEARCH_SALT           32+ char hex, held only by InstaClaw
 *   - EDGE_CITY_RESEARCH_SALT_VERSION   short tag like "ee26-v1"
 *
 * Per CLAUDE.md Rule 11: maxDuration=300. Sync is fast at expected
 * village scale (~1000 rows/day max) but we want headroom.
 *
 * PRD: instaclaw/docs/prd/matching-engine-competitive-research-2026-05-11.md §5.2 step 6b
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { runMatchpoolBridgeSync } from "@/lib/research-export/matchpool-bridge";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;
  const xCron = req.headers.get("x-cron-secret");
  if (xCron === secret) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!isAuthed(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const salt = process.env.EDGE_CITY_RESEARCH_SALT;
  const saltVersion = process.env.EDGE_CITY_RESEARCH_SALT_VERSION ?? "ee26-v1";
  if (!salt || salt.length < 32) {
    return NextResponse.json(
      {
        error: "EDGE_CITY_RESEARCH_SALT missing or too short",
        guidance:
          "Set EDGE_CITY_RESEARCH_SALT to a 32+ char random hex value in Vercel env. Generate via: openssl rand -hex 32",
      },
      { status: 500 },
    );
  }

  try {
    const result = await runMatchpoolBridgeSync(getSupabase(), {
      salt,
      saltVersion,
    });
    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error("[research-export-sync] error:", msg);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 503 },
    );
  }
}
