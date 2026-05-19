/**
 * lib/bake/synthetic-vm.ts — Synthetic VM record for §3.3 reconcile.
 *
 * The bake VM doesn't exist in `instaclaw_vms` — it's a fresh nanode
 * provisioned outside the production pool. But `auditVMConfig` /
 * `reconcileVM` need a VMRecord-shaped argument to function.
 *
 * Per the v105 checklist §3.3 inline TS pattern, the synthetic record is:
 *   { id: "bake-vm-<run-id>", ip_address: "<bake-ip>", partner: null,
 *     api_mode: "all_inclusive", ssh_user: "openclaw", ssh_port: 22 }
 *
 * Two considerations:
 *
 *   1. connectSSH has a duplicate-IP guard (lib/ssh.ts:5085) that queries
 *      instaclaw_vms for matching IPs. For a fresh bake VM, this returns
 *      empty (no duplicates). We pass `skipDuplicateIPCheck: true` defensively
 *      anyway — there's no harm and it makes intent explicit.
 *
 *   2. Some reconciler steps query the DB by vm.id (e.g., to write
 *      `secret_version`). For a synthetic id not in the DB, those updates
 *      silently no-op (Supabase returns count=0 from `.eq("id", ...).update(...)`).
 *      That's actually desirable: we don't want to pollute the DB with
 *      bake-vm rows. The reconciler succeeds on the disk side; the DB
 *      side gracefully no-ops.
 *
 * Some steps might fail in unexpected ways against a synthetic id. The
 * checklist §3.3 has run cleanly multiple times against this exact shape,
 * so empirically it works. The orchestrator's reconcile step gates on
 * `errors === []` and `strictErrors === []`, so any surfacing of an
 * unexpected synthetic-id failure mode aborts cleanly.
 *
 * Per design doc §1.6 gap-fill item #5.
 */

import { resolve } from "path";
import type { BakeState } from "./step-spec";

/** The synthetic VM record we pass to auditVMConfig. */
export interface SyntheticVM {
  id: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  partner: string | null;
  api_mode: string;
  tier: string | null;
  user_timezone: string | null;
  gateway_token?: string;
}

/**
 * Build the synthetic VM record from the current bake state.
 * Throws if the bake VM IP isn't set (caller must provision first).
 *
 * `partner` is null. This is deliberate (per §2.6.6 critical note):
 *   - stepGbrain skips (partner not in allowlist) → installed via §3.5 manual SSH instead.
 *   - stepIndexProvision skips (partner != edge_city).
 *   - stepDeployEdgeOverlay skips (partner != edge_city).
 *   - stepRewriteSoulPartnerSections skips (no partner section to rewrite).
 *
 *   This keeps the snapshot GENERIC. Partner-specific content is applied
 *   per-VM at assign time via configureOpenClaw injection.
 */
export function buildSyntheticVM(state: BakeState): SyntheticVM {
  if (!state.bake_vm.ip_address) {
    throw new Error("buildSyntheticVM: bake_vm.ip_address not set");
  }
  return {
    id: `bake-vm-${state.run_id}`,
    ip_address: state.bake_vm.ip_address,
    ssh_port: 22,
    ssh_user: "openclaw",
    partner: null,
    api_mode: "all_inclusive",
    tier: null,
    user_timezone: null,
  };
}

/**
 * Wrapper around `auditVMConfig` that imports it dynamically. Dynamic
 * import is used so that:
 *
 *   (a) The bake module doesn't force-load the entire reconciler at
 *       startup (lib/vm-reconcile.ts is 8K+ lines with heavy imports).
 *   (b) The orchestrator can run preflight checks even if some upstream
 *       module (e.g., Supabase client) fails to construct — preflight
 *       can report the failure cleanly.
 *
 * Returns the audit result directly. The orchestrator's reconcile step
 * inspects `errors` and `strictErrors`.
 */
export async function runReconcileOnBakeVM(
  syntheticVM: SyntheticVM,
  options: { strict: boolean; dryRun: boolean; skipGatewayRestart: boolean },
  repoRoot: string,
): Promise<{
  fixed: string[];
  alreadyCorrect: string[];
  warnings: string[];
  errors: string[];
  strictErrors: string[];
  gatewayRestartNeeded: boolean;
  gatewayRestarted: boolean;
  canaryHealthy: boolean | null;
}> {
  // Dynamic import keeps the module graph lean.
  const sshModulePath = resolve(repoRoot, "lib/ssh.ts");
  // tsx resolves .ts at runtime; type-only check via @ts-ignore-next-line for the import path.
  // @ts-ignore — dynamic path
  const sshModule = await import(sshModulePath);
  const auditVMConfig = sshModule.auditVMConfig as (
    vm: SyntheticVM,
    opts: { strict: boolean; dryRun: boolean; skipGatewayRestart: boolean },
  ) => Promise<{
    fixed: string[];
    alreadyCorrect: string[];
    warnings: string[];
    errors: string[];
    strictErrors: string[];
    gatewayRestartNeeded: boolean;
    gatewayRestarted: boolean;
    canaryHealthy: boolean | null;
  }>;

  const r = await auditVMConfig(syntheticVM, options);
  return {
    fixed: r.fixed ?? [],
    alreadyCorrect: r.alreadyCorrect ?? [],
    warnings: r.warnings ?? [],
    errors: r.errors ?? [],
    strictErrors: r.strictErrors ?? [],
    gatewayRestartNeeded: r.gatewayRestartNeeded ?? false,
    gatewayRestarted: r.gatewayRestarted ?? false,
    canaryHealthy: r.canaryHealthy ?? null,
  };
}
