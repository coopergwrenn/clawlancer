/**
 * Pure decision logic for the replenish-pool cron.
 *
 * Extracted to its own module so it can be unit-tested without any DB,
 * Linode API, or env var dependencies. The route handler is responsible
 * for collecting state and applying side effects; this file just decides
 * what to do given a snapshot of state + config.
 */

export interface PoolState {
  /** Linode VMs in "ready" status (unassigned, waiting for users) */
  ready: number;
  /** VMs currently in "provisioning" status (any provider) */
  provisioning: number;
  /** Total non-terminated VMs (cost ceiling input) */
  total: number;
  /** Provisioning VMs older than the stuck threshold */
  stuckProvisioning: { name: string; minutesOld: number }[];
}

export interface PoolConfig {
  /** Provision when ready < FLOOR */
  POOL_FLOOR: number;
  /** Provision up to TARGET (must be > FLOOR) */
  POOL_TARGET: number;
  /** Never provision when ready >= CEILING */
  POOL_CEILING: number;
  /** Critical alert threshold (admin email) */
  POOL_CRITICAL: number;
  /** Hard cap on VMs created per cron run */
  MAX_PER_RUN: number;
  /** Cost ceiling — total active VMs across the fleet */
  MAX_TOTAL_VMS: number;
}

export type DecisionAction =
  | "provision" // proceed to create VMs
  | "skip_healthy" // pool above floor, no action needed
  | "skip_ceiling" // pool already at or above ceiling
  | "skip_stuck" // stuck provisioning VMs detected — wait for admin
  | "skip_cap"; // cost ceiling reached, can't create more

export interface Decision {
  action: DecisionAction;
  toProvision: number;
  reason: string;
  /** True if ready pool is below the critical threshold (alert regardless of action) */
  criticalAlert: boolean;
}

/**
 * Pure decision function. No side effects.
 *
 * KEY INSIGHT: "in-flight" count = ready + provisioning. We treat
 * provisioning VMs as future inventory toward the target. Without this,
 * the cron over-provisions on slow cloud-init: ready stays low for
 * several cycles while VMs are still booting, and each cycle would
 * re-provision a full batch.
 *
 * Order of checks (all use in-flight, NOT just ready):
 *   1. Stuck VMs → skip + alert (something is wrong, don't pile on)
 *   2. In-flight >= floor → skip_healthy
 *   3. In-flight >= ceiling → skip_ceiling (defensive)
 *   4. Below floor → deficit = target - in-flight, capped by MAX_PER_RUN and cost
 *   5. If cap math yields 0 → skip_cap
 *
 * criticalAlert is based on `ready` ALONE (not in-flight): even if more
 * VMs are coming, "users right now have nothing to grab" is still critical.
 */
export function decideAction(state: PoolState, config: PoolConfig): Decision {
  const inFlight = state.ready + state.provisioning;
  const criticalAlert = state.ready <= config.POOL_CRITICAL;

  // 1. Stuck VMs — bail and let an admin investigate
  if (state.stuckProvisioning.length > 0) {
    return {
      action: "skip_stuck",
      toProvision: 0,
      reason: `${state.stuckProvisioning.length} VMs stuck in provisioning >15 min — refusing to provision more`,
      criticalAlert,
    };
  }

  // 2. In-flight pool already meets the floor
  if (inFlight >= config.POOL_FLOOR) {
    return {
      action: "skip_healthy",
      toProvision: 0,
      reason: `Pool healthy: ${state.ready} ready + ${state.provisioning} provisioning = ${inFlight} in-flight (floor=${config.POOL_FLOOR})`,
      criticalAlert,
    };
  }

  // 3. Above ceiling (defensive — shouldn't trigger if floor < ceiling)
  if (inFlight >= config.POOL_CEILING) {
    return {
      action: "skip_ceiling",
      toProvision: 0,
      reason: `Pool at ceiling: ${inFlight} in-flight (ceiling=${config.POOL_CEILING})`,
      criticalAlert,
    };
  }

  // 4. Below floor — compute deficit using in-flight, capped by per-run + cost ceiling
  const needed = config.POOL_TARGET - inFlight;
  const remainingCeiling = Math.max(0, config.MAX_TOTAL_VMS - state.total);
  const toProvision = Math.min(needed, config.MAX_PER_RUN, remainingCeiling);

  // 5. Cost ceiling caps us at zero
  if (toProvision <= 0) {
    return {
      action: "skip_cap",
      toProvision: 0,
      reason: `Cost ceiling: ${state.total}/${config.MAX_TOTAL_VMS} VMs active — cannot provision more`,
      criticalAlert,
    };
  }

  return {
    action: "provision",
    toProvision,
    reason: `Pool low: ready=${state.ready}, provisioning=${state.provisioning} (in-flight=${inFlight}, floor=${config.POOL_FLOOR}, target=${config.POOL_TARGET}). Provisioning ${toProvision}.`,
    criticalAlert,
  };
}
