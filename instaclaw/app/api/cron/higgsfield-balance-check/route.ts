/**
 * GET /api/cron/higgsfield-balance-check — launch build order §5 (Layer 2,
 * proactive). Every 30 min: read the central Higgsfield account balance and
 * alert BEFORE fleet demand hits zero mid-render.
 *
 * Two-layer design (Rule 67's lesson — the request path sees the truth first):
 *   L1 (reactive)  — the gate's submit catch detects the SDK's named
 *                    NotEnoughCreditsError and fires a P0 instantly
 *                    (app/api/gateway/higgsfield/route.ts).
 *   L2 (THIS cron) — predicts exhaustion ahead of L1. World A: self-discover
 *                    a balance endpoint with the cloud key at runtime.
 *                    World B: anchor − our settle-ledger burn (proven burn
 *                    meter; the 2026-06-11 reconciliation matched the HF
 *                    dashboard to the credit). lib/higgsfield-balance.ts.
 *
 * Thresholds (credits; kling render = 13):
 *   < 2000 (~154 renders) — WARN, 24h dedup. The HF-side auto-top-up trigger
 *     is set AT 2000, so seeing a value below it means auto-top-up may not
 *     have fired (disabled, card failure, HF-side outage). Early smoke.
 *   < 1000 (~77 renders)  — P0, 6h dedup. The hard backstop: react time
 *     before zero even during a launch spike.
 *   World "none" — 24h-deduped setup reminder (operator must set
 *     HIGGSFIELD_BALANCE_ANCHOR or confirm a World-A endpoint), never P0.
 *
 * False-alarm bias is deliberate: a stale anchor after a top-up makes World B
 * UNDERESTIMATE → false low-alert → operator refreshes the anchor. The
 * opposite failure (silent zero with a customer watching) is the one that
 * kills the rail.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { sendAdminAlertEmail } from "@/lib/email";
import { readCentralBalance } from "@/lib/higgsfield-balance";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // 4 bounded probes (10s each) + 1 small SELECT

const CRON_NAME = "higgsfield-balance-check";
const LOCK_TTL_SECONDS = 600;

const P0_THRESHOLD = 1000;   // credits (~77 kling renders)
const WARN_THRESHOLD = 2000; // credits (~154) — the auto-top-up trigger level
const P0_DEDUP_MS = 6 * 60 * 60 * 1000;
const WARN_DEDUP_MS = 24 * 60 * 60 * 1000;
const SETUP_DEDUP_MS = 24 * 60 * 60 * 1000;

/** check-then-insert-then-send dedup against instaclaw_admin_alert_log
 *  (mirrors lib/email's vm_ready pattern). Best-effort: a dedup-table error
 *  still sends — double-send beats silence for a balance alert. */
async function sendDeduped(alertKey: string, windowMs: number, subject: string, body: string): Promise<boolean> {
  const supabase = getSupabase();
  try {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const { data } = await supabase
      .from("instaclaw_admin_alert_log")
      .select("id")
      .eq("alert_key", alertKey)
      .gte("sent_at", cutoff)
      .limit(1);
    if (data && data.length > 0) return false; // suppressed
    await supabase.from("instaclaw_admin_alert_log").insert({
      alert_key: alertKey,
      vm_count: 0,
      details: subject,
    });
  } catch (err) {
    logger.error("higgsfield-balance-check: dedup probe failed — sending anyway", {
      route: "cron/higgsfield-balance-check", error: String(err),
    });
  }
  await sendAdminAlertEmail(subject, body).catch((err) => {
    logger.error("higgsfield-balance-check: alert send failed", {
      route: "cron/higgsfield-balance-check", error: String(err),
    });
  });
  return true;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const acquired = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS, "vercel-cron");
  if (!acquired) {
    return NextResponse.json({ skipped: "lock_held" });
  }

  try {
    const reading = await readCentralBalance();

    if (reading.world === "none") {
      await sendDeduped(
        "higgsfield_balance_setup",
        SETUP_DEDUP_MS,
        "Higgsfield balance check needs setup",
        `The balance cron can't read the central account in either world.\n\nReason: ${reading.reason}\n\nFix (either):\n• World A: confirm a balance endpoint exists on platform.higgsfield.ai (one authed POST to /v1/me or /v1/balance) — the cron self-discovers it once reachable.\n• World B: set HIGGSFIELD_BALANCE_ANCHOR in Vercel env to "<credits>@<ISO>" from the dashboard reading, e.g.:\n  printf '56@2026-06-11T23:00:00Z' | npx vercel env add HIGGSFIELD_BALANCE_ANCHOR production\n(Rule 6: printf, never echo/<<<.)`,
      );
      logger.warn("higgsfield-balance-check: no reading available", {
        route: "cron/higgsfield-balance-check", reason: reading.reason,
      });
      return NextResponse.json({ world: "none", reason: reading.reason });
    }

    const bal = reading.balanceCredits;
    const renders = Math.floor(bal / 13);
    const detail =
      reading.world === "A"
        ? `World A (direct read via ${reading.endpoint}): ${bal} credits ≈ ${renders} premium renders.`
        : `World B (inference): anchor ${reading.anchorCredits} cr @ ${reading.anchorAt} − ${reading.burnSinceAnchor} cr settled since = ${bal} cr ≈ ${renders} premium renders.\n\nIf you topped up after the anchor was set, this UNDERESTIMATES — refresh HIGGSFIELD_BALANCE_ANCHOR with the new dashboard reading.`;

    let alerted: string | null = null;
    if (bal < P0_THRESHOLD) {
      await sendDeduped(
        "higgsfield_balance_low",
        P0_DEDUP_MS,
        `[P0] Higgsfield central balance LOW: ~${bal} credits (~${renders} renders left)`,
        `${detail}\n\nBelow the ${P0_THRESHOLD}-credit hard backstop. The HF-side auto-top-up (trigger 2000 → ceiling 8000) should have fired well before this — it is likely DISABLED or failing.\n\nACT NOW: top up at platform.higgsfield.ai and verify auto-top-up is enabled. At zero, every premium render fails with NotEnoughCredits (users see "temporarily at capacity").`,
      );
      alerted = "p0";
    } else if (bal < WARN_THRESHOLD) {
      await sendDeduped(
        "higgsfield_balance_warn",
        WARN_DEDUP_MS,
        `Higgsfield central balance below auto-top-up trigger: ~${bal} credits`,
        `${detail}\n\nBelow the ${WARN_THRESHOLD}-credit auto-top-up trigger. If auto-top-up is enabled this should self-correct within its cycle; seeing this twice in a row means it isn't firing — check the card + the toggle on platform.higgsfield.ai.`,
      );
      alerted = "warn";
    }

    logger.info("higgsfield-balance-check: reading", {
      route: "cron/higgsfield-balance-check",
      world: reading.world,
      balanceCredits: bal,
      renders,
      alerted,
    });
    return NextResponse.json({ world: reading.world, balanceCredits: bal, renders, alerted });
  } catch (err) {
    logger.error("higgsfield-balance-check: cycle failed", {
      route: "cron/higgsfield-balance-check",
      error: err instanceof Error ? err.message : String(err),
    });
    // No alert on probe failure — L1 (the gate detector) covers real
    // exhaustion; alerting on transient cron errors is fatigue, not signal.
    return NextResponse.json({ error: "cycle_failed" }, { status: 500 });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
