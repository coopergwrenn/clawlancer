import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { getBillingStatus } from "@/lib/billing-status";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/cron/auth-abandon-reaper  —  LOG-ONLY (dry-run), reaps nothing.
 *
 * Watches the auth-abandon gap: a user who completed Google OAuth (which
 * provisions a VM via assignOrProvisionUserVm BEFORE /plan) but never finished
 * onboarding or paid. Those VMs sit assigned + onboarding_complete=false with
 * no payment signal, burning $29/mo Linode each.
 *
 * Candidate predicate (List A, 2026-06-10):
 *   status='assigned'
 *   AND owner.onboarding_complete = false
 *   AND assigned_at > 72h ago        (N — generous; auth-abandon is permanent)
 *   AND partner IS NULL              (partner VMs are comp / never reaped here)
 *   AND NOT isPaying(full Rule-14)   (lib/billing-status.ts — credits/sub/partner/all_inclusive)
 *
 * THIS CRON DOES NOT RELEASE OR HIBERNATE ANYTHING. It logs the would-release
 * set so the gap is observable going forward. Promotion to live-reap is a
 * separate future ruling (Cooper, 2026-06-10 ruling #3).
 *
 * Auth: CRON_SECRET bearer (Rule 13 — /api/cron is in middleware selfAuthAPIs).
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const supabase = getSupabase();
  const N_HOURS = 72;
  const cutoff = new Date(Date.now() - N_HOURS * 3600_000).toISOString();

  try {
    // Step 1: users with onboarding_complete=false.
    const { data: incompleteUsers, error: uErr } = await supabase
      .from("instaclaw_users")
      .select("id")
      .eq("onboarding_complete", false);
    if (uErr) {
      logger.error("auth-abandon-reaper: user lookup failed", {
        route: "cron/auth-abandon-reaper",
        error: uErr.message,
      });
      return NextResponse.json({ ok: false, error: uErr.message }, { status: 500 });
    }
    const incompleteIds = (incompleteUsers ?? []).map((u) => u.id);

    if (!incompleteIds.length) {
      logger.info("auth-abandon-reaper: 0 incomplete-onboarding users — nothing to watch", {
        route: "cron/auth-abandon-reaper",
      });
      return NextResponse.json({ ok: true, examined: 0, wouldRelease: 0, mode: "log-only" });
    }

    // Step 2: their assigned, >72h, partner-null VMs.
    const candidates: Array<{ id: string; name: string | null; assigned_to: string }> = [];
    for (let i = 0; i < incompleteIds.length; i += 100) {
      const chunk = incompleteIds.slice(i, i + 100);
      const { data } = await supabase
        .from("instaclaw_vms")
        .select("id, name, assigned_to")
        .eq("status", "assigned")
        .is("partner", null)
        .lt("assigned_at", cutoff)
        .in("assigned_to", chunk);
      for (const v of data ?? []) {
        if (v.assigned_to) candidates.push(v as { id: string; name: string | null; assigned_to: string });
      }
    }

    // Step 3: full Rule-14 classification; partition would-release vs protected.
    const wouldRelease: Array<{ name: string | null; vmId: string; reasons: string[] }> = [];
    let protectedCount = 0;
    for (const vm of candidates) {
      const billing = await getBillingStatus(supabase, vm.id);
      if (billing?.isPaying) {
        protectedCount++;
      } else {
        wouldRelease.push({
          name: vm.name,
          vmId: vm.id,
          reasons: billing?.reasons ?? ["(no billing status)"],
        });
      }
    }

    logger.info("auth-abandon-reaper: dry-run sweep complete (LOG-ONLY, reaped 0)", {
      route: "cron/auth-abandon-reaper",
      nHours: N_HOURS,
      examined: candidates.length,
      wouldRelease: wouldRelease.length,
      protected: protectedCount,
      wouldReleaseVms: wouldRelease.slice(0, 50),
    });

    return NextResponse.json({
      ok: true,
      mode: "log-only",
      nHours: N_HOURS,
      examined: candidates.length,
      wouldRelease: wouldRelease.length,
      protected: protectedCount,
      wouldReleaseVms: wouldRelease,
    });
  } catch (err) {
    logger.error("auth-abandon-reaper: failed", {
      route: "cron/auth-abandon-reaper",
      error: String(err),
    });
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
