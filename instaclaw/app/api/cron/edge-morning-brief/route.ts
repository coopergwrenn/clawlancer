/**
 * GET /api/cron/edge-morning-brief — daily 9 AM PT (16:00 UTC) cron.
 *
 * The primary touchpoint between the Edge attendee and their agent
 * across the 28-day village. Every assigned + healthy edge_city VM
 * receives one Telegram message composed by lib/edge-morning-brief.
 *
 * Schedule: `0 16 * * *` — see vercel.json. Locked to 16:00 UTC because
 * the village runs in PDT (UTC-7) across May 30 → Jun 27 2026.
 *
 * Defensive window check: the lib's `isWithinVillageWindow` short-circuits
 * sends outside [May 30, Jun 28) PDT, so even if the cron remains
 * registered post-launch the route will no-op cleanly.
 *
 * Per-user fan-out is parallelized via Promise.allSettled with a small
 * concurrency cap (CONCURRENCY = 5) to stay polite to Telegram's
 * per-bot rate limits. Each VM has its OWN bot token, so the rate
 * limit is per-bot, not global — but parallelizing 500 calls at once
 * can still hammer our outbound network capacity. 5-wide is enough to
 * finish in ~30s for a 200-VM fleet.
 *
 * Auth: Bearer CRON_SECRET header — Vercel cron sets this automatically.
 *
 * Allow-list: `/api/cron` is in middleware.ts:selfAuthAPIs (existing
 * prefix match), so no new entry needed.
 *
 * Telemetry: structured log + JSON response summarizing per-shape
 * counts (rich/thin/lean) and skip reasons. Helps spot regressions —
 * a sudden dip in "rich" briefs = matching engine is broken.
 *
 * Rule 11: maxDuration = 300 — composing + sending up to 500 briefs
 * sequentially-with-concurrency could take 2-3 min on a slow day.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import {
  sendBriefToUser,
  isWithinVillageWindow,
  type SendBriefResult,
} from "@/lib/edge-morning-brief";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CONCURRENCY = 5;

interface PerVmResult {
  vmName: string;
  userIdPrefix: string;
  outcome: SendBriefResult;
}

interface RouteResponse {
  ok: boolean;
  reason?: "outside_village_window" | "unauthorized" | "db_error" | "no_eligible";
  total?: number;
  sent?: number;
  skipped?: number;
  failed?: number;
  byShape?: { rich: number; thin: number; lean: number };
  bySkipReason?: Record<string, number>;
  durationMs?: number;
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();

  // ── Auth ──────────────────────────────────────────────────────
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json<RouteResponse>(
      { ok: false, reason: "unauthorized" },
      { status: 401 },
    );
  }

  // ── Defensive window check ────────────────────────────────────
  const now = new Date();
  if (!isWithinVillageWindow(now)) {
    logger.info("[cron:edge-morning-brief] outside village window — no-op", {
      nowIso: now.toISOString(),
    });
    return NextResponse.json<RouteResponse>(
      { ok: true, reason: "outside_village_window", total: 0 },
      { status: 200 },
    );
  }

  // ── Query eligible VMs ────────────────────────────────────────
  const supabase = getSupabase();
  const { data: vms, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("id, name, assigned_to, partner, health_status")
    .eq("partner", "edge_city")
    .eq("status", "assigned")
    .in("health_status", ["healthy", "hibernating", "suspended"])
    .not("assigned_to", "is", null);

  if (vmErr) {
    logger.error("[cron:edge-morning-brief] vm query failed", {
      error: vmErr.message,
    });
    return NextResponse.json<RouteResponse>(
      { ok: false, reason: "db_error" },
      { status: 500 },
    );
  }
  if (!vms || vms.length === 0) {
    return NextResponse.json<RouteResponse>(
      { ok: true, reason: "no_eligible", total: 0 },
      { status: 200 },
    );
  }

  // ── Parallel fan-out with concurrency cap ─────────────────────
  // Simple in-flight gating: process the queue in chunks of CONCURRENCY.
  // Promise.allSettled inside each chunk so one VM's failure doesn't
  // block others. No external p-limit dep — keeps the route surface small.
  const results: PerVmResult[] = [];
  for (let i = 0; i < vms.length; i += CONCURRENCY) {
    const chunk = vms.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.allSettled(
      chunk.map(async (vm) => {
        const userId = vm.assigned_to as string;
        try {
          const outcome = await sendBriefToUser(supabase, userId, { now });
          return {
            vmName: vm.name as string,
            userIdPrefix: userId.slice(0, 8),
            outcome,
          };
        } catch (err) {
          // sendBriefToUser already catches inside; this only fires on
          // a truly unexpected throw (e.g., Supabase client init crash).
          // Categorize as "exception" so the per-shape totals stay clean.
          return {
            vmName: vm.name as string,
            userIdPrefix: userId.slice(0, 8),
            outcome: {
              sent: false,
              reason: "exception",
              detail:
                err instanceof Error
                  ? err.message.slice(0, 200)
                  : String(err).slice(0, 200),
            } satisfies SendBriefResult,
          };
        }
      }),
    );
    for (const settled of chunkResults) {
      if (settled.status === "fulfilled") {
        results.push(settled.value);
      } else {
        // Promise.allSettled fulfillment shouldn't reach here given the
        // per-task try/catch above — but defensive.
        results.push({
          vmName: "unknown",
          userIdPrefix: "?",
          outcome: {
            sent: false,
            reason: "exception",
            detail: String(settled.reason).slice(0, 200),
          },
        });
      }
    }
  }

  // ── Roll up telemetry ─────────────────────────────────────────
  const byShape = { rich: 0, thin: 0, lean: 0 };
  const bySkipReason: Record<string, number> = {};
  let sent = 0;
  let failed = 0;

  for (const r of results) {
    if (r.outcome.sent) {
      sent++;
      byShape[r.outcome.shape]++;
    } else {
      failed++;
      const reason = r.outcome.reason;
      bySkipReason[reason] = (bySkipReason[reason] ?? 0) + 1;
      // telegram_error + db_error + exception are the only ones that
      // surface as alertable when fleet-wide. Log them with detail.
      if (
        reason === "telegram_error" ||
        reason === "db_error" ||
        reason === "exception"
      ) {
        logger.warn("[cron:edge-morning-brief] send failure", {
          vmName: r.vmName,
          userIdPrefix: r.userIdPrefix,
          reason,
          detail: r.outcome.detail,
        });
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  logger.info("[cron:edge-morning-brief] cycle complete", {
    total: vms.length,
    sent,
    failed,
    byShape,
    bySkipReason,
    durationMs,
  });

  return NextResponse.json<RouteResponse>(
    {
      ok: true,
      total: vms.length,
      sent,
      skipped: failed - (bySkipReason.telegram_error ?? 0) - (bySkipReason.exception ?? 0),
      failed: (bySkipReason.telegram_error ?? 0) + (bySkipReason.exception ?? 0),
      byShape,
      bySkipReason,
      durationMs,
    },
    { status: 200 },
  );
}
