/**
 * GET /api/cron/m-return-sweep
 *
 * Per spec §6.5.7 invariant 4 + §6.5.8 dispatch trigger #2.
 *
 * Catches two distinct M_RETURN dispatch failure modes:
 *
 *   1. RETRY: form submit happened (consumed_at set) but the inline
 *      dispatch failed (m_return_sent_at still NULL). The submit
 *      handler rolls back its CAS on send failure; sweep retries.
 *
 *   2. CLOSED-TAB: user OAuth'd, came to /onboarding/done, but closed
 *      the tab without submitting. consumed_at is still NULL but VM
 *      is ready (gateway_url populated). Sweep claims consumed_at +
 *      dispatches. Bounded between 5min (gave user time to fill form)
 *      and 10min (Pass 6 claim threshold — Pass 6 takes over after
 *      that as a hostile-abandonment recovery rather than a happy-path
 *      catch-up).
 *
 * Runs every minute. Cron-lock-protected. Bounded batch size so a
 * single tick is never longer than ~20s of wall time.
 *
 * Race-safety: dispatchMReturn does the heavy lifting with its own
 * compare-and-swap on m_return_sent_at. Sweep can fire concurrently
 * with the form-submit handler; whoever wins the CAS owns the send.
 *
 * Why two predicates in one cron (not separate crons):
 *   Both classes need the same dispatchMReturn call. Splitting into
 *   two crons doubles the operational surface for no win. The
 *   processed-row sets are disjoint (predicate 1 has consumed_at NOT
 *   NULL, predicate 2 has consumed_at IS NULL) so there's no double-
 *   counting.
 *
 * Schedule: `* * * * *` (every 60s). Documented in vercel.json
 * alongside the existing cron set.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { dispatchMReturn } from "@/lib/m-return-dispatch";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_NAME = "m-return-sweep";
const CRON_LOCK_TTL_SECONDS = 90;

const RETRY_BATCH_SIZE = 20;
const CLOSED_TAB_BATCH_SIZE = 20;

// Sweep claims closed-tab rows between 5min and 30min after creation.
//   - 5min lower bound: gives users time to fill out the form without
//     us racing them
//   - 30min upper bound: hands off to Pass 6 reclaim (widened from 10min
//     on 2026-05-27, P1-D fix for ~1000 Edge attendees who might take a
//     phone call mid-flow or get distracted)
const CLOSED_TAB_MIN_AGE_MS = 5 * 60 * 1000;
const CLOSED_TAB_MAX_AGE_MS = 30 * 60 * 1000;

interface DispatchOutcome {
  pendingId: string;
  predicate: "retry" | "closed-tab";
  ok: boolean;
  reason?: string;
}

export async function GET(req: NextRequest) {
  // CRON_SECRET bearer auth — standard for /api/cron/*.
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const acquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS, "vercel-cron");
  if (!acquired) {
    return NextResponse.json({ skipped: "lock-busy" });
  }

  try {
    const supabase = getSupabase();
    const outcomes: DispatchOutcome[] = [];

    // ─── Predicate 1: RETRY (submit happened, dispatch didn't) ──
    const { data: retryRows, error: retryErr } = await supabase
      .from("instaclaw_pending_users")
      .select("id")
      .not("channel", "is", null)
      .not("consumed_at", "is", null)
      .is("m_return_sent_at", null)
      .is("reclaimed_at", null)
      .limit(RETRY_BATCH_SIZE);

    if (retryErr) {
      logger.error("[m-return-sweep] retry query failed", {
        route: "cron/m-return-sweep",
        error: retryErr.message,
      });
    } else if (retryRows && retryRows.length > 0) {
      for (const row of retryRows) {
        const result = await dispatchMReturn(row.id, "sweep-cron");
        outcomes.push({
          pendingId: row.id,
          predicate: "retry",
          ok: result.ok,
          reason: result.ok ? undefined : result.reason,
        });
      }
    }

    // ─── Predicate 2: CLOSED-TAB (consumed_at NULL, VM ready, in window) ──
    // Bounded window so we don't race form submits (lower bound) and
    // don't conflict with Pass 6 reclaim (upper bound).
    const now = Date.now();
    const minAgeIso = new Date(now - CLOSED_TAB_MIN_AGE_MS).toISOString();
    const maxAgeIso = new Date(now - CLOSED_TAB_MAX_AGE_MS).toISOString();

    const { data: closedTabRows, error: closedTabErr } = await supabase
      .from("instaclaw_pending_users")
      .select("id")
      .not("channel", "is", null)
      .is("consumed_at", null)
      .not("user_id", "is", null)
      .lt("created_at", minAgeIso)
      .gt("created_at", maxAgeIso)
      .limit(CLOSED_TAB_BATCH_SIZE);

    if (closedTabErr) {
      logger.error("[m-return-sweep] closed-tab query failed", {
        route: "cron/m-return-sweep",
        error: closedTabErr.message,
      });
    } else if (closedTabRows && closedTabRows.length > 0) {
      for (const row of closedTabRows) {
        const result = await dispatchMReturn(row.id, "sweep-cron");
        outcomes.push({
          pendingId: row.id,
          predicate: "closed-tab",
          ok: result.ok,
          reason: result.ok ? undefined : result.reason,
        });
      }
    }

    // Tally outcomes for the response (helps with cron monitoring).
    const tally = {
      retry: {
        sent: outcomes.filter((o) => o.predicate === "retry" && o.ok).length,
        skipped: outcomes.filter(
          (o) =>
            o.predicate === "retry" &&
            !o.ok &&
            (o.reason === "vm_not_ready" || o.reason === "already_sent"),
        ).length,
        failed: outcomes.filter(
          (o) =>
            o.predicate === "retry" &&
            !o.ok &&
            o.reason !== "vm_not_ready" &&
            o.reason !== "already_sent",
        ).length,
      },
      closedTab: {
        sent: outcomes.filter((o) => o.predicate === "closed-tab" && o.ok).length,
        skipped: outcomes.filter(
          (o) =>
            o.predicate === "closed-tab" &&
            !o.ok &&
            (o.reason === "vm_not_ready" ||
              o.reason === "consumed_race_lost" ||
              o.reason === "already_sent"),
        ).length,
        failed: outcomes.filter(
          (o) =>
            o.predicate === "closed-tab" &&
            !o.ok &&
            o.reason !== "vm_not_ready" &&
            o.reason !== "consumed_race_lost" &&
            o.reason !== "already_sent",
        ).length,
      },
    };

    if (tally.retry.sent > 0 || tally.closedTab.sent > 0) {
      logger.info("[m-return-sweep] cycle complete with sends", {
        route: "cron/m-return-sweep",
        tally,
      });
    }

    return NextResponse.json({
      ok: true,
      tally,
      // Full outcomes only in response — useful for ad-hoc inspection,
      // bounded by the LIMIT clauses above so payload stays small.
      outcomes,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
