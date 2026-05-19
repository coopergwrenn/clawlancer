/**
 * lib/bake/drift.ts — Cross-run drift detection.
 *
 * Compares the current source-of-truth (pins, env vars, reconciler hash)
 * against the fingerprint of the last successful bake. Surfaces:
 *
 *   - New env var references in vm-reconcile.ts (likely a new feature flag)
 *   - Changed pin values (gbrain, manifest, etc.)
 *   - Reconciler step-sequence hash changed (new step added or removed)
 *
 * Each finding is a P1 warning by default — bake proceeds but the operator
 * is told to review. Severity escalates to P0 if `--strict-drift` is passed.
 *
 * Per design doc §2.7.
 */

import {
  detectEnvVarReferences,
  distinctEnvVars,
  hashReconcilerStepSequence,
  readSourcePins,
  type SourcePins,
} from "./source-of-truth";
import type { BakeFingerprint } from "./state";

export interface DriftReport {
  any_drift: boolean;
  new_env_vars: string[];
  removed_env_vars: string[];
  changed_pins: Array<{ name: string; old: string; new: string }>;
  reconciler_hash_changed: boolean;
  reconciler_step_count_delta: number;
  reconciler_added_steps: string[];
  reconciler_removed_steps: string[];
  last_bake_completed_at: string | null;
  current_hash: string;
}

/**
 * Compute the full drift report. Pure function — caller decides what to do
 * with the findings.
 *
 * If `lastFingerprint` is null (no prior bake recorded), returns
 * `any_drift=false` and current values — drift is undefined on first run.
 */
export function computeDriftReport(
  repoRoot: string,
  lastFingerprint: BakeFingerprint | null,
): DriftReport {
  const currentPins = readSourcePins(repoRoot);
  const currentEnvVars = distinctEnvVars(detectEnvVarReferences(repoRoot));
  const currentStepHash = hashReconcilerStepSequence(repoRoot);

  if (!lastFingerprint) {
    return {
      any_drift: false,
      new_env_vars: [],
      removed_env_vars: [],
      changed_pins: [],
      reconciler_hash_changed: false,
      reconciler_step_count_delta: 0,
      reconciler_added_steps: [],
      reconciler_removed_steps: [],
      last_bake_completed_at: null,
      current_hash: currentStepHash.hash,
    };
  }

  // ── Env var deltas ──
  const lastVars = new Set(lastFingerprint.known_env_vars);
  const newVars = currentEnvVars.filter((v) => !lastVars.has(v));
  const removedVars = lastFingerprint.known_env_vars.filter(
    (v) => !currentEnvVars.includes(v),
  );

  // ── Pin deltas ──
  const changedPins: DriftReport["changed_pins"] = [];
  const last = lastFingerprint.source_pins;
  const cur = currentPins;
  const pinKeys: Array<keyof SourcePins> = [
    "gbrain_commit",
    "gbrain_version",
    "openclaw_pinned_version",
    "node_version",
  ];
  for (const k of pinKeys) {
    const lv = (last as any)[k];
    const cv = (cur as any)[k];
    if (lv && cv && lv !== cv) {
      changedPins.push({ name: String(k), old: String(lv), new: String(cv) });
    }
  }
  if (last.manifest_version !== cur.manifest_version) {
    changedPins.push({
      name: "manifest_version",
      old: String(last.manifest_version),
      new: String(cur.manifest_version),
    });
  }
  if (last.bootstrap_max_chars !== cur.bootstrap_max_chars) {
    changedPins.push({
      name: "bootstrap_max_chars",
      old: String(last.bootstrap_max_chars),
      new: String(cur.bootstrap_max_chars),
    });
  }
  if ((last.secret_version ?? null) !== (cur.secret_version ?? null)) {
    changedPins.push({
      name: "secret_version",
      old: String(last.secret_version ?? "null"),
      new: String(cur.secret_version ?? "null"),
    });
  }

  // ── Reconciler step sequence ──
  const reconcilerHashChanged = lastFingerprint.reconciler_hash !== currentStepHash.hash;
  // We don't have the last bake's step list, only its hash. To compute
  // added/removed-steps we'd need to persist the step list. For P0 we just
  // report hash drift; P1 enhancement: persist step list in fingerprint.
  const reconcilerAddedSteps: string[] = [];
  const reconcilerRemovedSteps: string[] = [];
  const reconcilerStepCountDelta = 0;

  const any_drift =
    newVars.length > 0 ||
    removedVars.length > 0 ||
    changedPins.length > 0 ||
    reconcilerHashChanged;

  return {
    any_drift,
    new_env_vars: newVars,
    removed_env_vars: removedVars,
    changed_pins: changedPins,
    reconciler_hash_changed: reconcilerHashChanged,
    reconciler_step_count_delta: reconcilerStepCountDelta,
    reconciler_added_steps: reconcilerAddedSteps,
    reconciler_removed_steps: reconcilerRemovedSteps,
    last_bake_completed_at: lastFingerprint.completed_at,
    current_hash: currentStepHash.hash,
  };
}

/**
 * Format a DriftReport as a human-readable string for the bake log.
 */
export function formatDriftReport(d: DriftReport): string {
  if (!d.any_drift) {
    return d.last_bake_completed_at
      ? `no drift since last bake (${d.last_bake_completed_at})`
      : `no last-bake fingerprint — drift undefined`;
  }
  const lines: string[] = ["drift detected:"];
  if (d.new_env_vars.length > 0) {
    lines.push(`  new env vars: ${d.new_env_vars.join(", ")}`);
  }
  if (d.removed_env_vars.length > 0) {
    lines.push(`  removed env vars: ${d.removed_env_vars.join(", ")}`);
  }
  for (const p of d.changed_pins) {
    lines.push(`  pin ${p.name}: ${p.old} → ${p.new}`);
  }
  if (d.reconciler_hash_changed) {
    lines.push(`  reconciler step sequence hash changed`);
  }
  return lines.join("\n");
}
