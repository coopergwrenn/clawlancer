import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

// Rows older than this with status='pending' are presumed abandoned and
// flipped to 'expired'. 6h is conservative — investigation 2026-04-30 found
// only ~0.2% of pending rows are <1h old; the bulk (>93%) are >24h old. 6h
// guarantees no realistically-in-flight user gets clobbered.
const EXPIRE_AFTER_HOURS = 6;

// Sample size used by dryRun preview AND post-update logging. The actual
// UPDATE has no per-call cap — it's a single statement matched by full
// WHERE clause, so URL length limits don't apply (an `id IN (...)` with
// 1000 UUIDs blew past PostgREST's URL limit on the first prod run, so
// the route was rewritten to update by predicate, not by id list).
const SAMPLE_LIMIT = 100;

/**
 * Expire stale `pending` rows in instaclaw_wld_delegations.
 *
 * The mini-app onboarding creates a `pending` row BEFORE the World wallet
 * popup (delegate/initiate). Any cancel / timeout / network drop after that
 * leaves an orphan row forever — there is no other cleanup path. This cron
 * flips them to `expired` so audits, funnel queries, and dashboards stop
 * counting them as in-flight.
 *
 * Selection criteria — must match ALL of:
 *   - status = 'pending'                 (not pending_confirmation: those
 *                                        made it past the wallet popup)
 *   - delegated_at < now - 6h            (definitely abandoned, not slow)
 *   - transaction_hash IS NULL           (no on-chain hash recorded)
 *   - vm_id IS NULL                      (skip the 18 pending-with-vm
 *                                        anomalies — separate investigation)
 *
 * `expired` is a NEW status value. The text column is unconstrained, but
 * make sure existing readers don't bucket it with `failed`:
 *   - agent-dashboard.tsx:225 / settings-client.tsx:310 — show "Payment
 *     failed" UI on status === "failed" || "amount_mismatch". Expired
 *     intentionally NOT included: a user who sees an expired row didn't
 *     have a payment problem, they just never finished the popup.
 *   - home/page.tsx — only counts confirmed / pending_confirmation; expired
 *     correctly drops out.
 *   - agent/{provision,assign}/route.ts — pick up pending / pending_confirmation
 *     for retro-confirm; expired stays untouched (intended: don't auto-confirm
 *     a row we've given up on).
 *
 * Idempotent. Safe to re-run. dryRun=1 returns the candidate count without
 * writing.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const supabase = getSupabase();

  const cutoff = new Date(Date.now() - EXPIRE_AFTER_HOURS * 60 * 60 * 1000).toISOString();

  // For dryRun and for visibility logging, fetch a sample of candidates.
  // This is informational only — the actual UPDATE matches by predicate,
  // not by this id list, so it's not subject to the SAMPLE_LIMIT cap.
  const { data: sample, error: selErr } = await supabase
    .from("instaclaw_wld_delegations")
    .select("id, user_id, delegated_at, transaction_id")
    .eq("status", "pending")
    .lt("delegated_at", cutoff)
    .is("transaction_hash", null)
    .is("vm_id", null)
    .order("delegated_at", { ascending: true })
    .limit(SAMPLE_LIMIT);

  if (selErr) {
    logger.error("expire-pending-delegations: select failed", {
      route: "cron/expire-pending-delegations",
      error: selErr.message,
      code: selErr.code,
    });
    return NextResponse.json(
      { error: "select failed", detail: selErr.message },
      { status: 500 }
    );
  }

  const sampleCount = sample?.length ?? 0;
  const oldest = sample?.[0]?.delegated_at ?? null;
  const newestInSample = sample?.[sampleCount - 1]?.delegated_at ?? null;

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      cutoff,
      expireAfterHours: EXPIRE_AFTER_HOURS,
      sampleLimit: SAMPLE_LIMIT,
      sampleCount,
      sampleAtCap: sampleCount === SAMPLE_LIMIT,
      oldest,
      newestInSample,
      sample: (sample ?? []).slice(0, 5).map((c) => ({
        id: c.id,
        userId: c.user_id,
        delegatedAt: c.delegated_at,
        transactionId: c.transaction_id,
      })),
    });
  }

  if (sampleCount === 0) {
    return NextResponse.json({
      cutoff,
      expireAfterHours: EXPIRE_AFTER_HOURS,
      expired: 0,
    });
  }

  // Update by predicate, not by id list. PostgREST's URL length limit
  // makes large `id=in.(...)` filters fail with HTTP 400 once you cross
  // ~30K characters (~800 UUIDs). The WHERE clause below is identical to
  // the SELECT above, so the race-safety check `status='pending'` is
  // implicit — any row that flipped between SELECT and UPDATE is harmlessly
  // skipped.
  const { data: updated, error: updErr } = await supabase
    .from("instaclaw_wld_delegations")
    .update({ status: "expired" })
    .eq("status", "pending")
    .lt("delegated_at", cutoff)
    .is("transaction_hash", null)
    .is("vm_id", null)
    .select("id");

  if (updErr) {
    logger.error("expire-pending-delegations: update failed", {
      route: "cron/expire-pending-delegations",
      error: updErr.message,
      code: updErr.code,
    });
    return NextResponse.json(
      { error: "update failed", detail: updErr.message },
      { status: 500 }
    );
  }

  const expiredCount = updated?.length ?? 0;

  logger.info("expire-pending-delegations: completed", {
    route: "cron/expire-pending-delegations",
    cutoff,
    expiredCount,
    sampleCount,
    sampleAtCap: sampleCount === SAMPLE_LIMIT,
    oldest,
    newestInSample,
  });

  return NextResponse.json({
    cutoff,
    expireAfterHours: EXPIRE_AFTER_HOURS,
    expired: expiredCount,
    oldest,
    newestInSample,
  });
}
