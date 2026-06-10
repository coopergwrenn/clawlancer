/**
 * cron/higgsfield-sweep — G11: stale video-hold sweeper (the gate's error handling).
 *
 * The Higgsfield video gate reserves a credit hold at submit and closes it at
 * the completion webhook (settle on success, release otherwise). The orphaned
 * hold — submitted, never closed — is THIS design's failure class. It happens
 * when Higgsfield never calls our webhook (provider drops it), or the webhook
 * was rejected/erroring for its whole retry window (e.g. the kill-switch sat
 * OFF past Higgsfield's ~2h retry budget). A pending hold left forever would:
 *   - silently consume the user's daily free allowance / video credits, and
 *   - leave the user staring at "rendering…" with no clip and no explanation.
 *
 * The bar (Cooper, 2026-06-10): NO render outcome is ever silent. Every render
 * ends as exactly one of — delivered, failed-with-refund-and-user-notified, or
 * swept-with-alert. This cron is the third arm.
 *
 * For each orphaned hold (status='pending' older than SWEEP_TTL_MIN):
 *   1. instaclaw_video_release(vm, request_id, 'swept_orphan_ttl') — idempotent
 *      pending→failed flip, refunds the hold (no charge, free slot returned).
 *   2. If metadata.chat_id is present → notify the user via their bot token
 *      (best-effort, never blocks the release).
 *   3. Admin alert, deduped 6h via instaclaw_admin_alert_log.
 *
 * RACE-FREE BY CONSTRUCTION: the webhook accepts callbacks only within 60 min
 * of submit (WEBHOOK_TTL_MS in webhook/route.ts); past that it bails at the
 * target-expired check BEFORE any settle/release/deliver. SWEEP_TTL_MIN=90 is
 * strictly past that 60-min window (+30 min margin for clock skew / in-flight
 * webhook processing), so the webhook is provably inert by the time the sweeper
 * touches a hold. They can never both act on the same request. Even if they
 * did, instaclaw_video_release / instaclaw_video_settle are idempotent
 * compare-and-set on 'pending' — second writer no-ops.
 *
 * NOT gated by HIGGSFIELD_GATE_ENABLED: when the gate is killed, in-flight
 * renders are exactly what get orphaned (their webhooks 503 past the retry
 * window). The sweeper is the cleanup the kill-switch's collateral damage
 * needs — it MUST run regardless of the gate's enable state.
 *
 * Schedule: every 15 min. Orphans are rare and the TTL is 90 min, so a hold is
 * swept within ~90-105 min of submit. Own cron-lock (key `higgsfield-sweep`).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { sendAdminAlertEmail } from "@/lib/email";
import { sendTelegramNotification } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_NAME = "higgsfield-sweep";
const LOCK_TTL_SECONDS = 120;

// Strictly past the webhook's 60-min acceptance window (WEBHOOK_TTL_MS) so the
// webhook is provably inert when the sweeper acts. See header.
const SWEEP_TTL_MIN = 90;
const SWEEP_TTL_MS = SWEEP_TTL_MIN * 60 * 1000;

// Cap per run so a backlog (e.g. after a long kill-switch outage) can't blow the
// 60s function budget. The remainder is picked up next tick (15 min later).
const MAX_PER_RUN = 100;

const ALERT_DEDUP_KEY = "higgsfield-orphan-holds-swept";
const ALERT_COOLDOWN_HOURS = 6;

const USER_MSG =
  "That video didn't come through this time — no credits were used. Want me to try again?";

type PendingHold = {
  id: string;
  request_id: string;
  vm_id: string;
  endpoint: string;
  created_at: string;
  metadata: { chat_id?: string; tier?: string; endpoint?: string } | null;
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    return NextResponse.json({ skipped: "lock_held" });
  }

  try {
    const supabase = getSupabase();
    const cutoffIso = new Date(Date.now() - SWEEP_TTL_MS).toISOString();

    // Uses the (status, created_at DESC) index on instaclaw_video_transactions.
    const { data: holds, error: findErr } = await supabase
      .from("instaclaw_video_transactions")
      .select("id, request_id, vm_id, endpoint, created_at, metadata")
      .eq("status", "pending")
      .lt("created_at", cutoffIso)
      .order("created_at", { ascending: true })
      .limit(MAX_PER_RUN);

    if (findErr) {
      logger.error("higgsfield-sweep: find failed", {
        route: "cron/higgsfield-sweep",
        code: findErr.code,
        error: findErr.message,
      });
      return NextResponse.json({ error: "find_failed" }, { status: 500 });
    }

    const orphans = (holds ?? []) as PendingHold[];
    if (orphans.length === 0) {
      return NextResponse.json({ ok: true, swept: 0 });
    }

    // Resolve delivery bot tokens once for the distinct VMs that have a chat_id.
    const vmIdsNeedingBot = Array.from(
      new Set(
        orphans
          .filter((o) => o.metadata?.chat_id)
          .map((o) => o.vm_id),
      ),
    );
    const botTokenByVm = new Map<string, string>();
    if (vmIdsNeedingBot.length > 0) {
      const { data: vms } = await supabase
        .from("instaclaw_vms")
        .select("id, telegram_bot_token")
        .in("id", vmIdsNeedingBot);
      for (const v of vms ?? []) {
        const row = v as { id: string; telegram_bot_token?: string | null };
        if (row.telegram_bot_token) botTokenByVm.set(row.id, row.telegram_bot_token);
      }
    }

    let releasedCount = 0;
    let notifiedCount = 0;
    let releaseFailCount = 0;
    const sweptVmIds = new Set<string>();
    const sweptEndpoints = new Set<string>();

    for (const o of orphans) {
      // 1. Release the hold (idempotent pending→failed; no charge). Load-bearing.
      try {
        const { data: rel, error: relErr } = await supabase.rpc(
          "instaclaw_video_release",
          {
            p_vm_id: o.vm_id,
            p_request_id: o.request_id,
            p_reason: "swept_orphan_ttl",
          },
        );
        if (relErr) {
          releaseFailCount++;
          logger.error("higgsfield-sweep: release rpc error", {
            route: "cron/higgsfield-sweep",
            vmId: o.vm_id,
            requestId: o.request_id,
            error: relErr.message,
          });
          continue; // don't notify/count a hold we couldn't actually release
        }
        // rel.released true on the flip, false if already-not-pending (idempotent).
        if (rel?.released) releasedCount++;
        sweptVmIds.add(o.vm_id);
        sweptEndpoints.add(o.endpoint);
      } catch (err) {
        releaseFailCount++;
        logger.error("higgsfield-sweep: release threw", {
          route: "cron/higgsfield-sweep",
          vmId: o.vm_id,
          requestId: o.request_id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // 2. Notify the user (best-effort; never blocks the release).
      const chatId = o.metadata?.chat_id;
      const botToken = chatId ? botTokenByVm.get(o.vm_id) : undefined;
      if (chatId && botToken) {
        try {
          const ok = await sendTelegramNotification(botToken, chatId, USER_MSG);
          if (ok) notifiedCount++;
        } catch (err) {
          logger.info("higgsfield-sweep: user notify failed (non-blocking)", {
            route: "cron/higgsfield-sweep",
            vmId: o.vm_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 3. Admin alert, deduped 6h. Fire-and-forget — the releases above are the
    //    load-bearing side effect; the email is best-effort observability.
    void sendSweepAlert(supabase, {
      sweptCount: sweptVmIds.size === 0 ? 0 : orphans.length,
      releasedCount,
      notifiedCount,
      releaseFailCount,
      vmCount: sweptVmIds.size,
      endpoints: Array.from(sweptEndpoints),
    }).catch((err) => {
      logger.error("higgsfield-sweep: alert dispatch failed", {
        route: "cron/higgsfield-sweep",
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.warn("higgsfield-sweep: swept orphaned video holds", {
      route: "cron/higgsfield-sweep",
      found: orphans.length,
      released: releasedCount,
      notified: notifiedCount,
      release_failed: releaseFailCount,
      vms: sweptVmIds.size,
      ttl_min: SWEEP_TTL_MIN,
    });

    return NextResponse.json({
      ok: true,
      found: orphans.length,
      released: releasedCount,
      notified: notifiedCount,
      release_failed: releaseFailCount,
      vms: sweptVmIds.size,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}

async function sendSweepAlert(
  supabase: ReturnType<typeof getSupabase>,
  ctx: {
    sweptCount: number;
    releasedCount: number;
    notifiedCount: number;
    releaseFailCount: number;
    vmCount: number;
    endpoints: string[];
  },
): Promise<void> {
  // Nothing actually swept (all release calls failed) is still worth an alert —
  // it means the RPC itself is broken. But if we found zero orphans we never
  // get here. Send whenever we found orphans.
  const cooldownAgoIso = new Date(
    Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data: recent } = await supabase
    .from("instaclaw_admin_alert_log")
    .select("id")
    .eq("alert_key", ALERT_DEDUP_KEY)
    .gte("sent_at", cooldownAgoIso)
    .limit(1);
  if (recent && recent.length > 0) {
    return; // within cooldown — log-only (the cron's logger.warn already fired)
  }

  const subject = `Higgsfield: ${ctx.releasedCount} orphaned video hold(s) swept (${ctx.vmCount} VM(s))`;
  const body =
    `${ctx.sweptCount} video hold(s) were still 'pending' after ${SWEEP_TTL_MIN} min ` +
    `(normal render is 1-5 min; the completion webhook is inert past 60 min).\n\n` +
    `  released (refunded, no charge): ${ctx.releasedCount}\n` +
    `  users notified:                 ${ctx.notifiedCount}\n` +
    `  release RPC failures:           ${ctx.releaseFailCount}\n` +
    `  distinct VMs:                   ${ctx.vmCount}\n` +
    `  endpoints:                      ${ctx.endpoints.join(", ") || "(none)"}\n\n` +
    `An orphaned hold means Higgsfield never closed the render (dropped webhook, ` +
    `or the gate kill-switch sat OFF past the ~2h retry window). The hold has been ` +
    `released so the user's free allowance / credits are returned and they were told ` +
    `it didn't come through.\n\n` +
    (ctx.releaseFailCount > 0
      ? `WARNING: ${ctx.releaseFailCount} release(s) FAILED — investigate instaclaw_video_release.\n\n`
      : ``) +
    `Next alert in this category suppressed for ${ALERT_COOLDOWN_HOURS}h (dedup).`;

  // Record before send so a concurrent run doesn't double-send.
  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: ALERT_DEDUP_KEY,
    vm_count: ctx.vmCount,
    details: `${ctx.releasedCount} released, ${ctx.notifiedCount} notified, ${ctx.releaseFailCount} failed`,
  });

  await sendAdminAlertEmail(subject, body);
}
