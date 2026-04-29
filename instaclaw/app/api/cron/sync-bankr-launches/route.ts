import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { syncBankrLaunchForVm, type SyncResult } from "@/lib/bankr-launch-sync";

/**
 * Background safety net for chat-driven token launches.
 *
 * Every 5 minutes, scan VMs that have a Bankr wallet but no recorded token,
 * and ask Bankr's public API whether the wallet has launched anything. If it
 * has, write tokens[0] back into our DB so the dashboard, celebration card,
 * and viral share flow work for users who launched via chat without ever
 * loading the dashboard.
 *
 * Users who DO load the dashboard get the same sync inline via /api/vm/status
 * with much lower latency (next 30s poll). This cron exists for the case
 * where the user only ever talks to their bot in Telegram.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_NAME = "sync-bankr-launches";
const LOCK_TTL_SECONDS = 360;
const CONCURRENCY = 5;
const PER_RUN_LIMIT = 200;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("sync-bankr-launches: lock held, skipping", {
      route: "cron/sync-bankr-launches",
    });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();
  try {
    const supabase = getSupabase();

    const { data: candidates, error: queryErr } = await supabase
      .from("instaclaw_vms")
      .select("id, bankr_evm_address")
      .not("bankr_evm_address", "is", null)
      .is("bankr_token_address", null)
      .is("tokenization_platform", null)
      .limit(PER_RUN_LIMIT);

    if (queryErr) {
      logger.error("sync-bankr-launches: candidate query failed", {
        route: "cron/sync-bankr-launches",
        code: queryErr.code,
        error: queryErr.message,
      });
      return NextResponse.json(
        { error: "candidate_query_failed", details: queryErr.message },
        { status: 500 }
      );
    }

    const total = candidates?.length ?? 0;
    if (total === 0) {
      logger.info("sync-bankr-launches: no candidates", {
        route: "cron/sync-bankr-launches",
      });
      return NextResponse.json({ ok: true, scanned: 0, updated: 0, durationMs: Date.now() - startedAt });
    }

    const results: SyncResult[] = [];
    for (let i = 0; i < candidates!.length; i += CONCURRENCY) {
      const batch = candidates!.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((c) => syncBankrLaunchForVm(c.id))
      );
      for (const s of settled) {
        if (s.status === "fulfilled") {
          results.push(s.value);
        } else {
          logger.error("sync-bankr-launches: helper threw", {
            route: "cron/sync-bankr-launches",
            error: s.reason instanceof Error ? s.reason.message : String(s.reason),
          });
          results.push({ updated: false, reason: "fetch_failed" });
        }
      }
    }

    const updated = results.filter((r) => r.updated);
    const reasons = results.reduce<Record<string, number>>((acc, r) => {
      const key = r.updated ? "updated" : (r.reason ?? "unknown");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    logger.info("sync-bankr-launches: complete", {
      route: "cron/sync-bankr-launches",
      scanned: total,
      updated: updated.length,
      reasons,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json({
      ok: true,
      scanned: total,
      updated: updated.length,
      reasons,
      discoveredTokens: updated.map((u) => ({
        tokenAddress: u.tokenAddress,
        tokenSymbol: u.tokenSymbol,
      })),
      durationMs: Date.now() - startedAt,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
