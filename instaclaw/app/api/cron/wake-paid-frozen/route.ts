/**
 * GET /api/cron/wake-paid-frozen — G2 safety net (audit 2026-06-11).
 *
 * Sibling to wake-paid-hibernating, but for the FROZEN state (v1 Linode-image
 * freeze: instance deleted, personal snapshot preserved, status='frozen').
 *
 * The primary v1-thaw path is the billing webhook (customer.subscription.created
 * / .updated calls thawVM on resubscribe). If that webhook fails to fire or
 * process — Stripe delivery hiccup, a new reactivation path that doesn't route
 * through it, a code regression — a paying customer's VM stays frozen forever
 * and they get silence. Without this cron, v1 thaw is webhook-ONLY (no retry).
 *
 * This cron makes the return path webhook-independent: every 5 min it finds
 * frozen VMs whose owner is NOW paying (by the SoT — Rule 14, NOT a reinvented
 * weak check) and thaws them. Bounded max-downtime = the cron interval.
 *
 * Lessons internalized:
 *   - Rule 14 / Rule 82: billing via classifyFreezeBilling (the SoT), never a
 *     reinvented check. The freeze gate that this complements was the exact
 *     anti-pattern (fixed same day).
 *   - Lesson 2: thaw is NON-destructive (it restores), but we still only thaw on
 *     a VERIFIED paying signal. "unverifiable" (Stripe outage) → leave frozen
 *     this tick; a later tick thaws once Stripe is reachable. Never thaw a
 *     not-paying user (that would resurrect a VM the freeze correctly retired).
 *   - Rule 19: select * for the safety-critical read.
 *   - thawVM acquires a per-VM lifecycle lock, so a race with the webhook thaw
 *     is serialized — the loser bails cleanly.
 *
 * Schedule: every 5 min (vercel.json). maxDuration=800 (thawVM provisions a
 * Linode + SSH-verifies, ~3 min; cap MAX_THAW_PER_RUN keeps the run bounded).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { classifyFreezeBilling } from "@/lib/billing-status";
import { thawVM } from "@/lib/vm-freeze-thaw";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const CRON_NAME = "wake-paid-frozen";
const CRON_LOCK_TTL_SECONDS = 15 * 60;
/** Cap thaws per run — each thawVM provisions a Linode (~3 min). */
const MAX_THAW_PER_RUN = 2;
/** How many frozen rows to scan per tick. */
const SCAN_LIMIT = 50;

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runId = randomUUID();
  const supabase = getSupabase();
  const stripe = getStripe();

  const lock = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lock) {
    return NextResponse.json({ runId, skipped: "another run holds the lock" });
  }

  const summary = {
    runId,
    scanned: 0,
    thawed: 0,
    skipped_not_paying: 0,
    skipped_unverifiable: 0,
    failed: 0,
  };

  try {
    // v1-frozen VMs whose owner may have returned. Rule 19: select *.
    const { data: frozen, error } = await supabase
      .from("instaclaw_vms")
      .select("*")
      .eq("status", "frozen")
      .not("frozen_image_id", "is", null)
      .not("assigned_to", "is", null)
      .limit(SCAN_LIMIT);

    if (error) {
      logger.error("wake-paid-frozen: query failed", { route: "cron/wake-paid-frozen", runId, error: error.message });
      return NextResponse.json({ ...summary, error: error.message }, { status: 500 });
    }

    for (const vm of frozen ?? []) {
      if (summary.thawed >= MAX_THAW_PER_RUN) break;
      summary.scanned++;

      // SoT billing — only thaw a VERIFIED paying owner.
      const verdict = await classifyFreezeBilling(supabase, stripe, vm.id);
      if (verdict === "unverifiable") {
        summary.skipped_unverifiable++;
        continue; // Stripe outage — leave frozen this tick, retry next.
      }
      if (verdict !== "paying") {
        summary.skipped_not_paying++;
        continue; // correctly retired — do NOT resurrect a non-paying user's VM.
      }

      // Paying owner, still frozen → the webhook thaw was missed. Thaw now.
      logger.info("wake-paid-frozen: paying owner with frozen VM — thawing (webhook miss)", {
        route: "cron/wake-paid-frozen", runId, vmId: vm.id, vmName: vm.name, userId: vm.assigned_to,
      });
      const result = await thawVM(supabase, vm.assigned_to, false, runId);
      if (result.success) {
        summary.thawed++;
      } else {
        summary.failed++;
        logger.error("wake-paid-frozen: auto-thaw FAILED", {
          route: "cron/wake-paid-frozen", runId, vmId: vm.id, userId: vm.assigned_to, reason: result.reason,
        });
        sendAdminAlertEmail(
          "wake-paid-frozen: auto-thaw FAILED",
          `Paying owner ${vm.assigned_to} has a frozen VM (${vm.name ?? vm.id}) but the safety-net auto-thaw failed.\nReason: ${result.reason}\nRun ID: ${runId}\n\nManual recovery: POST /api/admin/thaw-vm with { user_id: "${vm.assigned_to}" }`,
        ).catch(() => {});
      }
    }

    logger.info("wake-paid-frozen: done", { route: "cron/wake-paid-frozen", ...summary });
    return NextResponse.json(summary);
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
