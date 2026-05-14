/**
 * cron/clear-stale-configure-locks — P1-6 (Timour feedback #4 — partner-readiness).
 *
 * Clears stale deployment locks that would otherwise trap a user with an
 * apparent "deployment already in progress" state forever.
 *
 * Two tables, two columns, both cleared on 15-min staleness:
 *   - `instaclaw_users.deployment_lock_at`
 *     Used by app/api/billing/checkout/route.ts:72-83 to gate new Stripe
 *     checkouts: if set and <15 min old → return 409. The auto-overwrite-
 *     on-acquire only kicks in when the USER re-clicks "deploy"; a user who
 *     navigates away and comes back >15 min later would still get the 409
 *     because the existing column has a stale-but-not-cleared value.
 *
 *   - `instaclaw_vms.configure_lock_at`
 *     Acquired by app/api/vm/configure/route.ts:270 with a 5-min stale-
 *     accept threshold; this is more defensive in nature but still useful
 *     because a stale entry on an unassigned VM blocks the next provision
 *     attempt unless the same user reattempts within the 5-min window.
 *
 * Why 15 min as the universal threshold: matches billing/checkout's gate.
 * Real configure completes in <5 min worst-case; 15 min means the user is
 * either stuck (Rule 33 partial-commit family) or has abandoned. Either
 * way, clearing the lock is the right action.
 *
 * Schedule: every 10 minutes. Quick run — two UPDATE queries + one email
 * (deduped 6h via instaclaw_admin_alert_log).
 *
 * Lock semantics: own cron-lock (key `clear-stale-configure-locks`), TTL
 * 120s — far longer than the actual run takes.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { sendAdminAlertEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CRON_NAME = "clear-stale-configure-locks";
const LOCK_TTL_SECONDS = 120;
const STALE_THRESHOLD_MIN = 15;
const STALE_THRESHOLD_MS = STALE_THRESHOLD_MIN * 60 * 1000;

const ALERT_DEDUP_KEY = "stale-configure-locks-cleared";
const ALERT_COOLDOWN_HOURS = 6;

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
    const thresholdIso = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

    // ── Pass 1: instaclaw_users.deployment_lock_at ────────────────────────
    // The user-visible trap path: billing/checkout returns 409 on this.
    const { data: staleUsers, error: usersFindErr } = await supabase
      .from("instaclaw_users")
      .select("id, email, deployment_lock_at")
      .lt("deployment_lock_at", thresholdIso)
      .not("deployment_lock_at", "is", null);
    if (usersFindErr) {
      logger.error("clear-stale-configure-locks: users find failed", {
        route: "cron/clear-stale-configure-locks",
        code: usersFindErr.code,
        error: usersFindErr.message,
      });
      return NextResponse.json({ error: "users_find_failed" }, { status: 500 });
    }

    const userClearCount = staleUsers?.length ?? 0;
    let clearedUserEmails: string[] = [];
    if (userClearCount > 0) {
      const userIds = (staleUsers ?? []).map((u) => (u as { id: string }).id);
      clearedUserEmails = (staleUsers ?? [])
        .map((u) => (u as { email?: string | null }).email)
        .filter((e): e is string => typeof e === "string" && e.length > 0);
      const { error: usersUpdateErr } = await supabase
        .from("instaclaw_users")
        .update({ deployment_lock_at: null })
        .in("id", userIds);
      if (usersUpdateErr) {
        logger.error("clear-stale-configure-locks: users update failed", {
          route: "cron/clear-stale-configure-locks",
          code: usersUpdateErr.code,
          error: usersUpdateErr.message,
          userIds,
        });
        return NextResponse.json({ error: "users_update_failed" }, { status: 500 });
      }
    }

    // ── Pass 2: instaclaw_vms.configure_lock_at ───────────────────────────
    // VM-side lock; less critical but defensive. Could otherwise block a
    // re-configure of an abandoned VM.
    const { data: staleVms, error: vmsFindErr } = await supabase
      .from("instaclaw_vms")
      .select("id, name, configure_lock_at")
      .lt("configure_lock_at", thresholdIso)
      .not("configure_lock_at", "is", null);
    if (vmsFindErr) {
      logger.error("clear-stale-configure-locks: vms find failed", {
        route: "cron/clear-stale-configure-locks",
        code: vmsFindErr.code,
        error: vmsFindErr.message,
      });
      return NextResponse.json({ error: "vms_find_failed" }, { status: 500 });
    }

    const vmClearCount = staleVms?.length ?? 0;
    let clearedVmNames: string[] = [];
    if (vmClearCount > 0) {
      const vmIds = (staleVms ?? []).map((v) => (v as { id: string }).id);
      clearedVmNames = (staleVms ?? [])
        .map((v) => (v as { name?: string | null }).name)
        .filter((n): n is string => typeof n === "string" && n.length > 0);
      const { error: vmsUpdateErr } = await supabase
        .from("instaclaw_vms")
        .update({ configure_lock_at: null })
        .in("id", vmIds);
      if (vmsUpdateErr) {
        logger.error("clear-stale-configure-locks: vms update failed", {
          route: "cron/clear-stale-configure-locks",
          code: vmsUpdateErr.code,
          error: vmsUpdateErr.message,
          vmIds,
        });
        return NextResponse.json({ error: "vms_update_failed" }, { status: 500 });
      }
    }

    const totalCleared = userClearCount + vmClearCount;
    if (totalCleared === 0) {
      return NextResponse.json({ ok: true, cleared_users: 0, cleared_vms: 0 });
    }

    // ── Admin alert (deduped via instaclaw_admin_alert_log, 6h cooldown) ──
    // Don't block on email — fire-and-forget so the DB clear is the
    // load-bearing side effect and the email is best-effort.
    void sendStaleLockAlert(supabase, {
      userCount: userClearCount,
      vmCount: vmClearCount,
      userEmails: clearedUserEmails,
      vmNames: clearedVmNames,
    }).catch((err) => {
      logger.error("clear-stale-configure-locks: alert dispatch failed", {
        route: "cron/clear-stale-configure-locks",
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.warn("clear-stale-configure-locks: cleared stale locks", {
      route: "cron/clear-stale-configure-locks",
      cleared_users: userClearCount,
      cleared_vms: vmClearCount,
      user_emails: clearedUserEmails,
      vm_names: clearedVmNames,
    });

    return NextResponse.json({
      ok: true,
      cleared_users: userClearCount,
      cleared_vms: vmClearCount,
      user_emails: clearedUserEmails,
      vm_names: clearedVmNames,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}

async function sendStaleLockAlert(
  supabase: ReturnType<typeof getSupabase>,
  ctx: {
    userCount: number;
    vmCount: number;
    userEmails: string[];
    vmNames: string[];
  },
): Promise<void> {
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
    // Within cooldown — log only, don't send.
    return;
  }

  const subject = `Stale deployment locks cleared (${ctx.userCount} user(s) + ${ctx.vmCount} VM(s))`;
  const body =
    `${ctx.userCount} user(s) had deployment_lock_at older than ${STALE_THRESHOLD_MIN} min.\n` +
    `${ctx.vmCount} VM(s) had configure_lock_at older than ${STALE_THRESHOLD_MIN} min.\n\n` +
    `Both cleared so affected users can re-initiate deployment.\n\n` +
    `Affected users:\n  ${ctx.userEmails.join("\n  ") || "(none)"}\n\n` +
    `Affected VMs:\n  ${ctx.vmNames.join("\n  ") || "(none)"}\n\n` +
    `This is a signal that /api/vm/configure or /api/billing/checkout paths failed\n` +
    `without releasing their locks. Investigate via Rule 33 troubleshooting playbook.\n\n` +
    `Next alert in this category will be suppressed for ${ALERT_COOLDOWN_HOURS}h (dedup).`;

  // Record before send so a concurrent run doesn't double-send.
  await supabase.from("instaclaw_admin_alert_log").insert({
    alert_key: ALERT_DEDUP_KEY,
    vm_count: ctx.userCount + ctx.vmCount,
    details: `${ctx.userCount} users, ${ctx.vmCount} vms`,
  });

  await sendAdminAlertEmail(subject, body);
}
