/**
 * Frontier - the monotonic-toward-safe combine for the gateway-token /settings
 * endpoint (PRD step 2). PURE. The security spine of the agent-facing write path.
 *
 * WHY THIS EXISTS (the threat): the gateway token authenticates the VM, NOT the
 * user's intent (GATEWAY_TOKEN lives in ~/.openclaw/.env, readable by the agent;
 * a hostile prompt can emit any gateway-token call with any body). So the /settings
 * endpoint a VM can reach MUST be structurally incapable of LOOSENING a money rail.
 * We achieve that not by "classify the direction and trust it" but by a per-field
 * MONOTONIC-TOWARD-SAFE combine against the CURRENT EFFECTIVE value (read
 * server-side, unforgeable): a loosening simply has no representation on this path.
 *
 *   minWalletBalance (reserve)       safe = max(current, requested)   // raise only
 *   justDoItPerTx / justDoItPerDay   safe = min(current, requested)   // lower only
 *   neverPerTx / neverPerDay         safe = min(current, requested)   // lower only
 *   allowedCategories                safe = current ∩ requested       // remove only
 *   spendEnabled                     safe = current && requested      // turn OFF only
 *
 * Composed with the EXISTING read-side clamp (frontier-policy.clampOverrides /
 * effectiveAllowedCategories) as the second wall: even a value that slipped through
 * here is re-railed at read. The two walls are independent; this function is wall 1.
 *
 * LOOSENINGS (lower reserve, raise a no-ask line, add a category, turn spend ON)
 * are reported in `needsConfirmation` and applied to NOTHING - they route to the
 * session-authed dashboard (the only channel the VM-resident agent cannot forge).
 * The descriptor carries only {field, requested, current}: it mints no token, no
 * grant, nothing replayable. Consent is the in-session Save, never a payload.
 *
 * Tests: scripts/_test-frontier-settings-monotonic.ts (named threat cases a..e1 +
 * the max->min discrimination + the two-walls proof).
 */
import type { TierBands, SpendCategory } from "./frontier-policy";

/** Mentioned bands only (camelCase), already range-validated [0, MAX] by the caller. */
export type RequestedBands = Partial<Record<keyof TierBands, number>>;

export interface CurrentSettings {
  /** EFFECTIVE bands (post tier x staker x clampOverrides) - what the gate enforces now. */
  bands: TierBands;
  /** EFFECTIVE allowlist (already tierDefault ∩ stored). */
  categories: readonly SpendCategory[];
  /** instaclaw_vms.frontier_spend_enabled (the master switch). */
  spendEnabled: boolean;
}

export interface RequestedSettings {
  /** Mentioned bands (absent = leave alone). */
  bands?: RequestedBands;
  /** Mentioned allowlist (absent/undefined = leave alone; [] = turn all off). */
  categories?: SpendCategory[];
  /** Mentioned master switch (absent = leave alone). */
  spendEnabled?: boolean;
}

export interface FieldVerdict {
  field: string;
  requested: number | boolean | SpendCategory[];
  current: number | boolean | SpendCategory[];
}

export interface MonotonicResult {
  /** Effective values to STORE (camelCase) - every one is a tighten vs current. */
  bandsToApply: RequestedBands;
  /** New stored allowlist when a removal tightened it; null = no category change. */
  categoriesToApply: SpendCategory[] | null;
  /** True iff the master switch should be set to false (OFF). Never true-for-ON. */
  turnOff: boolean;
  /** Fields that tightened (a real, applied change). */
  applied: FieldVerdict[];
  /** Loosening requests: applied to nothing; route to the session-authed dashboard. */
  needsConfirmation: FieldVerdict[];
  /** Requested == current: no change, not a loosening. */
  noop: FieldVerdict[];
}

/** The four bands whose SAFE direction is "lower" (tighten). */
const MIN_FIELDS: ReadonlyArray<keyof TierBands> = [
  "justDoItPerTx",
  "justDoItPerDay",
  "neverPerTx",
  "neverPerDay",
];

export function monotonicSafeSettings(
  current: CurrentSettings,
  req: RequestedSettings,
): MonotonicResult {
  const bandsToApply: RequestedBands = {};
  const applied: FieldVerdict[] = [];
  const needsConfirmation: FieldVerdict[] = [];
  const noop: FieldVerdict[] = [];

  // ── Bands ──
  if (req.bands) {
    // minWalletBalance (reserve): RAISE is safe; LOWER is a loosening.
    if (req.bands.minWalletBalance !== undefined) {
      const cur = current.bands.minWalletBalance;
      const want = req.bands.minWalletBalance;
      const safe = Math.max(cur, want); // monotonic up
      const v: FieldVerdict = { field: "minWalletBalance", requested: want, current: cur };
      if (want > cur) {
        bandsToApply.minWalletBalance = safe; // == want; a raise (tighten)
        applied.push(v);
      } else if (want < cur) {
        needsConfirmation.push(v); // a LOWER (loosen) - apply nothing
      } else {
        noop.push(v);
      }
    }
    // the four "lower is safe" bands.
    for (const field of MIN_FIELDS) {
      const want = req.bands[field];
      if (want === undefined) continue;
      const cur = current.bands[field];
      const safe = Math.min(cur, want); // monotonic down
      const v: FieldVerdict = { field, requested: want, current: cur };
      if (want < cur) {
        bandsToApply[field] = safe; // == want; a lower (tighten)
        applied.push(v);
      } else if (want > cur) {
        needsConfirmation.push(v); // a RAISE (loosen) - apply nothing
      } else {
        noop.push(v);
      }
    }
  }

  // ── Categories: safe = current ∩ requested (remove only). ──
  let categoriesToApply: SpendCategory[] | null = null;
  if (req.categories !== undefined) {
    const curSet = new Set(current.categories);
    const reqSet = new Set(req.categories);
    const safe = current.categories.filter((c) => reqSet.has(c)); // current ∩ requested (preserve order)
    const removed = current.categories.filter((c) => !reqSet.has(c)); // tighten
    const added = req.categories.filter((c) => !curSet.has(c)); // LOOSEN (turning a category back on)
    const v: FieldVerdict = {
      field: "allowedCategories",
      requested: [...req.categories],
      current: [...current.categories],
    };
    if (added.length > 0) needsConfirmation.push(v); // the add part is a loosening
    if (removed.length > 0) {
      categoriesToApply = safe; // apply the safe subset (removals stick; adds dropped)
      applied.push({ field: "allowedCategories(removals)", requested: removed, current: [...current.categories] });
    }
    if (added.length === 0 && removed.length === 0) noop.push(v);
  }

  // ── Master switch: safe = current && requested (OFF only). ──
  let turnOff = false;
  if (req.spendEnabled !== undefined) {
    const cur = current.spendEnabled;
    const want = req.spendEnabled;
    const v: FieldVerdict = { field: "spendEnabled", requested: want, current: cur };
    if (cur === true && want === false) {
      turnOff = true; // safe: more conservative
      applied.push(v);
    } else if (cur === false && want === true) {
      needsConfirmation.push(v); // turning ON is dashboard-only - apply nothing
    } else {
      noop.push(v);
    }
  }

  return { bandsToApply, categoriesToApply, turnOff, applied, needsConfirmation, noop };
}
