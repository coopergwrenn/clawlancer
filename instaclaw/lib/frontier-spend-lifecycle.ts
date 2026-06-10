/**
 * Frontier spend-authority lifecycle (red-team F4). PURE — the canonical SPEC of when a VM
 * lifecycle change must revoke autonomous-spend authority (frontier_spend_enabled).
 *
 * ENFORCEMENT is a Postgres BEFORE UPDATE trigger on instaclaw_vms
 * (supabase/migrations/20260610230000_clear_frontier_spend_on_lifecycle.sql) — the
 * data-layer chokepoint, so NO code path (10+ scattered assigned_to:null sites, the freeze
 * flow, future paths) can forget to clear it. A trigger fires on the DB write itself; a
 * helper can be routed around. The same "enforce at the layer that can't be bypassed"
 * principle as F2 (unforgeable consent).
 *
 * This module is the trigger's TESTABLE MIRROR (the SQL must match shouldRevokeSpendAuthority;
 * the live-probe proves they agree) AND the Rule-27 audit primitive (hasStaleSpendAuthority
 * finds any VM whose flag survived a transition the trigger should have caught — pre-trigger
 * drift, or a future regression).
 *
 * Why these transitions (reasoned in docs / the migration header):
 *   REVOKE on:
 *     - ownership changed (assigned_to differs): unassign (→null), reassign (A→B), fresh-
 *       assign (null→B). A new/absent owner must never inherit the prior owner's consent.
 *     - status entered a terminal state (frozen / terminated): the VM is destroyed; on a
 *       future thaw the owner must RE-ENABLE (fail-closed).
 *   DO NOT revoke on:
 *     - inactivity-suspend / hibernate (a health_status sleep, not an ownership/billing
 *       change): the agent cannot spend while asleep (gateway stopped) and clearing would
 *       force an annoying re-enable on every wake.
 *     - 'failed' status (transient, recoverable; can't spend while failed).
 *     - thaw to the SAME owner (already false from the freeze; re-enable required).
 *   CANCEL is handled at the BILLING chokepoint (the customer.subscription.deleted webhook),
 *     NOT here — it manifests as health_status='suspended', indistinguishable from an
 *     inactivity-suspend at the VM-column level, so a trigger on it would over-clear.
 */

/** The terminal VM statuses that revoke spend authority (the VM is gone / destroyed). */
export const SPEND_REVOKING_TERMINAL_STATUSES: readonly string[] = ["frozen", "terminated"];

export interface VmLifecycleState {
  assignedTo: string | null;
  status: string | null;
}

/**
 * Does this lifecycle TRANSITION (old → new) require clearing frontier_spend_enabled?
 * The SQL trigger mirrors this exactly. Only assigned_to + status drive it; health_status
 * (suspend/hibernate) deliberately does NOT (see module doc).
 */
export function shouldRevokeSpendAuthority(oldS: VmLifecycleState, newS: VmLifecycleState): boolean {
  // Ownership changed — unassign / reassign / fresh-assign. The new (or absent) owner must
  // not inherit the prior owner's opt-in.
  if (oldS.assignedTo !== newS.assignedTo) return true;
  // Status ENTERED a terminal/destroyed state. Only on the transition INTO it (so a no-op
  // re-write of an already-terminal status is not "newly revoking", though clearing again
  // would be a harmless idempotent no-op).
  if (newS.status !== oldS.status && SPEND_REVOKING_TERMINAL_STATUSES.includes(newS.status ?? "")) {
    return true;
  }
  return false;
}

/**
 * Rule-27 audit primitive: does this VM currently hold STALE spend authority — the flag is
 * true but its lifecycle state says it shouldn't be? Catches pre-trigger drift and any
 * future regression. A VM is stale-authorized iff spend is enabled AND it is either
 * unassigned OR in a terminal status.
 */
export function hasStaleSpendAuthority(vm: {
  frontier_spend_enabled?: boolean | null;
  assigned_to: string | null;
  status: string | null;
}): boolean {
  if (vm.frontier_spend_enabled !== true) return false;
  if (vm.assigned_to === null) return true; // unassigned but still spend-enabled
  if (SPEND_REVOKING_TERMINAL_STATUSES.includes(vm.status ?? "")) return true; // terminal but enabled
  return false;
}
