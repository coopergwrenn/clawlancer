import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { validateAdminKey } from "@/lib/security";
import { auditVMConfig } from "@/lib/ssh";
import { VM_MANIFEST } from "@/lib/vm-manifest";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
// Worst case: SSH open + reconcile (~60-90s) + canary round-trip (~10-20s).
// Fits comfortably in 300s with headroom.
export const maxDuration = 300;

/**
 * POST /api/admin/reconcile-vm
 *
 * On-demand single-VM reconcile — for Phase 2c stages 1/2/3 of the strict-mode
 * migration. Calls auditVMConfig() with { strict, dryRun } options and returns
 * the full result including strictErrors and canaryHealthy so the caller can
 * make the config_version decision client-side.
 *
 * This endpoint does NOT itself bump config_version. That's deliberate — the
 * stage rollout scripts call this endpoint for a VM, inspect strictErrors and
 * canaryHealthy, and update config_version locally only on clean result.
 * Keeps the bump decision in one place (the rollout script) instead of
 * fanning it out here.
 *
 * Auth: X-Admin-Key (same as /api/vm/configure). Not Bearer CRON_SECRET —
 * this is an interactive admin op, not a scheduled task.
 *
 * Body: { vmId: string; strict?: boolean; dryRun?: boolean }
 *   - vmId: required. UUID of instaclaw_vms row.
 *   - strict: default false. Pass true for stages 1/2/3.
 *   - dryRun: default false. Pass true for stage 0 per-VM probes when the
 *     local script can't SSH (should be rare; prefer scripts/_stage0-fleet-dryrun.ts
 *     for the full-fleet case).
 *
 * Returns: {
 *   vmId, vmName, fromVersion, manifestVersion,
 *   fixed: string[], alreadyCorrect: string[],
 *   strictErrors: string[], canaryHealthy: boolean | null,
 *   wouldAdvanceConfigVersion: boolean,   // convenience for the caller
 *   durationMs: number,
 * }
 */
export async function POST(req: NextRequest) {
  if (!validateAdminKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { vmId?: string; strict?: boolean; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { vmId, strict = false, dryRun = false } = body;
  if (!vmId || typeof vmId !== "string") {
    return NextResponse.json({ error: "vmId required" }, { status: 400 });
  }

  const supabase = getSupabase();
  const { data: vm, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("*")
    .eq("id", vmId)
    .single();

  if (vmErr || !vm) {
    return NextResponse.json({ error: "VM not found" }, { status: 404 });
  }

  const startMs = Date.now();
  try {
    const result = await auditVMConfig(vm, { strict, dryRun });
    const durationMs = Date.now() - startMs;

    // The same gate the reconcile-fleet cron applies. Surfaced here so the
    // caller (rollout script) can decide whether to bump config_version
    // without re-implementing the rule.
    const wouldAdvanceConfigVersion =
      !dryRun &&
      result.strictErrors.length === 0 &&
      result.canaryHealthy !== false;

    logger.info("admin/reconcile-vm: done", {
      route: "admin/reconcile-vm",
      vmId,
      vmName: vm.name,
      strict,
      dryRun,
      fixed: result.fixed.length,
      alreadyCorrect: result.alreadyCorrect.length,
      strictErrors: result.strictErrors.length,
      canaryHealthy: result.canaryHealthy,
      wouldAdvanceConfigVersion,
      durationMs,
    });

    return NextResponse.json({
      vmId: vm.id,
      vmName: vm.name,
      fromVersion: vm.config_version ?? 0,
      manifestVersion: VM_MANIFEST.version,
      fixed: result.fixed,
      alreadyCorrect: result.alreadyCorrect,
      strictErrors: result.strictErrors,
      canaryHealthy: result.canaryHealthy,
      wouldAdvanceConfigVersion,
      strict,
      dryRun,
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("admin/reconcile-vm: failed", {
      route: "admin/reconcile-vm",
      vmId,
      error: msg,
      durationMs,
    });
    return NextResponse.json(
      { error: msg, vmId, durationMs },
      { status: 500 },
    );
  }
}
