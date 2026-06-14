/**
 * cron/file-drift — Rule 47 (CLAUDE.md Root Cause 0.5).
 *
 * Continuous reconciliation cron that runs ONLY `stepFiles` on healthy,
 * assigned VMs regardless of their `config_version`. Closes the
 * architectural gap where reconcile-fleet's `cv < VM_MANIFEST.version`
 * filter (route.ts:272) excludes caught-up VMs from receiving template-
 * only updates.
 *
 * Schedule: every 15 minutes (cron entry in vercel.json).
 *
 * Invariants:
 *   - Does NOT bump config_version. Holds its own cron-lock so it can
 *     run concurrently with reconcile-fleet without conflicting.
 *   - Does NOT touch any other reconciler step (no config-set, no
 *     service restart, no auth-profiles, no skill installs). Just file
 *     hash comparison + atomic replace via `stepFiles`.
 *   - Manifest-freshness gated: refuses to run on a stale bundle, same
 *     gate reconcile-fleet uses (commit 16aa97c9 / D.2-A pattern). A
 *     stale bundle could regress VMs that already have newer content.
 *   - Random selection of BATCH_SIZE VMs per tick. Over 4 ticks/hour ×
 *     ~150 fleet, each VM is visited ~5×/day on average.
 *
 * Operational notes:
 *   - Per-VM hard timeout 30s. stepFiles is just SCP + md5 comparison;
 *     30s covers the slowest expected SSH round-trip.
 *   - Concurrency 5. Total wall-clock for 30 VMs ≈ 6 waves × 30s = 180s,
 *     within Vercel's 300s function ceiling.
 *   - No alert dispatch on file-drift errors — these are non-customer-
 *     facing (file content rolls back on next tick via Rule 23 sentinel
 *     guard if the bundle is somehow stale). Errors logged via logger.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { VM_MANIFEST } from "@/lib/vm-manifest";
import { verifyManifestFreshness, manifestFingerprint } from "@/lib/manifest-integrity";
import { runFileDriftPass } from "@/lib/vm-reconcile";
import { connectSSH, type VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";
// 5-min ceiling. Per-VM 30s × 6 waves at concurrency 5 = 180s typical.
// 300s budget gives ~2x headroom for tail latency.
export const maxDuration = 300;

const CRON_NAME = "file-drift";
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-06-14 12:46 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-06-12 13:41 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-06-12 11:22 UTC
// nft cache-bust auto-touch (vm-manifest.ts changed): 2026-06-10 21:30 UTC
// nft cache-bust manual-touch (2026-05-24 13:30 UTC): the v120 commit only
// busted reconcile-fleet's bundle via pre-commit hook; file-drift's bundle
// stayed on stale v119 manifest → manifest-integrity refused to run →
// strip-thinking patch didn't reach vm-1019. Pre-commit hook now extended
// to touch this file on every vm-manifest.ts change (see .husky/pre-commit).
const LOCK_TTL_SECONDS = 360; // > maxDuration with 60s headroom
const BATCH_SIZE = 30;
const CONCURRENCY = 5;
const PER_VM_TIMEOUT_MS = 30_000;

// VMRecord (lib/ssh.ts) is intentionally narrow — only the fields connectSSH
// actually reads. file-drift uses a wider DB row (name + status fields) for
// logging + selection. Local interface keeps that distinction explicit.
interface FleetVm {
  id: string;
  name: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  gateway_url: string | null;
  gateway_token: string | null;
  health_status: string;
  assigned_to: string | null;
  config_version: number | null;
  tier: string | null;
  api_mode: string | null;
  user_timezone: string | null;
  partner: string | null;
}

type PerVmOutcome =
  | { vm: string; ok: true; drifted: boolean; fixed: number; warnings: number; ms: number }
  | { vm: string; ok: false; error: string; ms: number };

async function processVmWithTimeout(vm: FleetVm): Promise<PerVmOutcome> {
  const start = Date.now();
  return Promise.race<PerVmOutcome>([
    processVmInner(vm, start),
    new Promise<PerVmOutcome>((resolve) =>
      setTimeout(
        () => resolve({ vm: vm.name, ok: false, error: `hard-timeout ${PER_VM_TIMEOUT_MS}ms`, ms: PER_VM_TIMEOUT_MS }),
        PER_VM_TIMEOUT_MS,
      ),
    ),
  ]);
}

async function processVmInner(vm: FleetVm, start: number): Promise<PerVmOutcome> {
  let ssh;
  try {
    ssh = await connectSSH(vm as VMRecord);
  } catch (e) {
    return { vm: vm.name, ok: false, error: `ssh-connect: ${String(e).slice(0, 100)}`, ms: Date.now() - start };
  }
  try {
    const r = await runFileDriftPass(vm as VMRecord & { api_mode?: string }, ssh, false);
    if (r.errors.length > 0) {
      return {
        vm: vm.name,
        ok: false,
        error: `errors: ${r.errors.slice(0, 2).join("; ").slice(0, 200)}`,
        ms: Date.now() - start,
      };
    }
    return {
      vm: vm.name,
      ok: true,
      drifted: r.fixed.length > 0,
      fixed: r.fixed.length,
      warnings: r.warnings.length,
      ms: Date.now() - start,
    };
  } catch (e) {
    return { vm: vm.name, ok: false, error: `exception: ${String(e).slice(0, 120)}`, ms: Date.now() - start };
  } finally {
    try {
      // connectSSH returns a node-ssh NodeSSH; dispose() is the close API.
      if (ssh && typeof (ssh as { dispose?: () => void }).dispose === "function") {
        (ssh as { dispose: () => void }).dispose();
      }
    } catch {
      // ignore close errors — connection is gone anyway
    }
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // 1. Auth
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Cron lock (separate key from reconcile-fleet so they can coexist)
  const lockAcquired = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("file-drift: lock held, skipping", { route: "cron/file-drift" });
    return NextResponse.json({ skipped: "lock_held" });
  }

  try {
    // 3. Manifest freshness — refuse to run on a stale bundle. A stale
    //    bundle could regress VMs that already have newer content.
    const integrity = await verifyManifestFreshness(manifestFingerprint(VM_MANIFEST));
    if (integrity.ok && !integrity.fresh) {
      logger.error("file-drift: STALE BUNDLE — refusing to run", {
        route: "cron/file-drift",
        runtime_version: integrity.runtime_version,
        remote_version: integrity.remote_version,
      });
      return NextResponse.json({
        halted: "stale_bundle",
        runtime_version: integrity.runtime_version,
        remote_version: integrity.remote_version,
      });
    }

    const supabase = getSupabase();

    // 4. Select a random batch of healthy+assigned VMs.
    //    We pull the full list and shuffle in-memory because PostgREST
    //    doesn't expose ORDER BY RANDOM() directly. Cheap for ~150 VMs.
    const { data: allVms, error: fetchErr } = await supabase
      .from("instaclaw_vms")
      .select(
        "id, name, ip_address, ssh_port, ssh_user, gateway_url, gateway_token, " +
          "health_status, assigned_to, config_version, tier, api_mode, user_timezone, partner",
      )
      .eq("health_status", "healthy")
      .eq("status", "assigned");
    if (fetchErr) {
      logger.error("file-drift: DB fetch failed", { route: "cron/file-drift", error: fetchErr.message });
      return NextResponse.json({ error: "db_fetch_failed", detail: fetchErr.message }, { status: 500 });
    }
    const vmsAll = (allVms ?? []) as unknown as FleetVm[];
    if (vmsAll.length === 0) {
      return NextResponse.json({ ok: true, processed: 0, reason: "no_eligible_vms" });
    }
    // Fisher-Yates shuffle, slice BATCH_SIZE.
    for (let i = vmsAll.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [vmsAll[i], vmsAll[j]] = [vmsAll[j], vmsAll[i]];
    }
    const batch = vmsAll.slice(0, BATCH_SIZE);

    // 5. Process in waves of CONCURRENCY
    const t0 = Date.now();
    const outcomes: PerVmOutcome[] = [];
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const slice = batch.slice(i, i + CONCURRENCY);
      const sliceResults = await Promise.all(slice.map(processVmWithTimeout));
      outcomes.push(...sliceResults);
    }
    const wallMs = Date.now() - t0;

    // 6. Summarize
    const ok = outcomes.filter((o) => o.ok).length;
    const drifted = outcomes.filter((o) => o.ok && (o as { drifted: boolean }).drifted).length;
    const errored = outcomes.filter((o) => !o.ok).length;
    const driftedNames = outcomes
      .filter((o) => o.ok && (o as { drifted: boolean }).drifted)
      .map((o) => o.vm);
    const erroredDetail = outcomes
      .filter((o) => !o.ok)
      .map((o) => ({ vm: o.vm, error: (o as { error: string }).error }));

    if (drifted > 0 || errored > 0) {
      logger.info("file-drift: pass complete", {
        route: "cron/file-drift",
        processed: outcomes.length,
        ok,
        drifted,
        errored,
        driftedNames,
        erroredDetail,
        wall_ms: wallMs,
      });
    }

    return NextResponse.json({
      ok: true,
      processed: outcomes.length,
      drifted,
      errored,
      wall_ms: wallMs,
      drifted_vms: driftedNames,
      errors: erroredDetail,
    });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
