#!/usr/bin/env tsx
/**
 * Gate suite for Slice-B #2b: the minWalletBalance floor reversal (clampOverrides
 * frontier-policy.ts: Math.max(0, at(ov, base)) instead of Math.max(base, ...)).
 *
 * Run: npx tsx scripts/_test-frontier-floor-reversal.ts
 * Exits 0 if all pass, 1 on any failure. Pure (no DB / network).
 *
 * The #2b change is the only net-new gate-SAFETY change in the slice, and it is
 * load-bearing in THREE places, all proven here (not inferred):
 *   1. clampOverrides itself  - the five-row floor table (raise / below-base / zero
 *      / negative->base fail-safe / absent->base).
 *   2. evaluateSpend would_drain (frontier-policy.ts:222) - at floor=0 a spend down
 *      to exactly $0 is allowed, an overdraw is still denied; a default floor denies
 *      the same near-empty spend (the reversal's actual effect on the drain guard).
 *   3. frontier-headroom walletHeadroom (frontier-headroom.ts:88) - floor=0 yields
 *      walletHeadroom == balance (no understatement, no sign error); a corrupt
 *      negative override fails safe to base so it can NEVER inflate headroom; and
 *      floor=0 + a huge balance still can't push effective autonomy past earned.
 *
 * Discrimination is proven out-of-band: temp-revert :84 -> the floor + would_drain
 * + headroom-floor rows go RED; temp-remove at()'s `v >= 0` -> the negative->base
 * row goes RED. A guard that cannot fail on the change it guards is theater.
 */

import {
  clampOverrides,
  effectiveBands,
  evaluateSpend,
  DEFAULT_BANDS_BY_TIER,
  type FrontierTier,
} from "../lib/frontier-policy";
import { autonomousHeadroom } from "../lib/frontier-headroom";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}
const approx = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const STARTER = DEFAULT_BANDS_BY_TIER.starter; // jdt 1/5, never 10/25, minWalletBalance 0.10
const BASE = STARTER.minWalletBalance; // 0.10

// ── 1. clampOverrides floor table (the five rows + non-finite guards) ──
// R1 raise above base -> preserved.
check("R1 raise: floor override 5 -> effective 5", clampOverrides(STARTER, { minWalletBalance: 5 }).minWalletBalance === 5);
// R2 below base -> allowed (THE #2b capability; old Math.max(base,..) would pin to base).
check("R2 below-base: floor override 0.05 -> effective 0.05", clampOverrides(STARTER, { minWalletBalance: 0.05 }).minWalletBalance === 0.05);
// R3 zero -> 0 ("spend it all"; old Math.max(base,..) would pin to base).
check("R3 zero: floor override 0 -> effective 0", clampOverrides(STARTER, { minWalletBalance: 0 }).minWalletBalance === 0);
// R4 negative (the rewritten 2b.3) -> base, NOT 0. Corrupt/illegitimate value fails SAFE.
check("R4 negative: floor override -5 -> effective base (fail-safe)", clampOverrides(STARTER, { minWalletBalance: -5 }).minWalletBalance === BASE);
// R5 absent -> base (unchanged default).
check("R5 absent: no floor override -> effective base", clampOverrides(STARTER, {}).minWalletBalance === BASE);
// Non-finite guards (NaN / Infinity) -> base, same fail-safe class as negative.
check("R4b NaN: floor override NaN -> base", clampOverrides(STARTER, { minWalletBalance: NaN }).minWalletBalance === BASE);
check("R4c Infinity: floor override Infinity -> base", clampOverrides(STARTER, { minWalletBalance: Infinity }).minWalletBalance === BASE);
// Effective-floor invariant: never negative, for any override (the load-bearing guarantee).
for (const ov of [5, 0.05, 0, -5, -0.0001, NaN, Infinity, -Infinity]) {
  check(`INV effective floor >= 0 for override=${ov}`, clampOverrides(STARTER, { minWalletBalance: ov }).minWalletBalance >= 0);
}

// ── 2. evaluateSpend would_drain at floor=0 (frontier-policy.ts:222) ──
const spendCtx = (amount: number, balance: number, floorOverride: number | undefined) =>
  evaluateSpend("starter", {
    amountUsd: amount,
    spentTodayUsd: 0,
    walletBalanceUsd: balance,
    privacyModeOn: false,
    counterpartyVerified: true,
    overrides: floorOverride === undefined ? null : { minWalletBalance: floorOverride },
  });
// W-zero-allowed: floor=0, spend that lands the wallet at EXACTLY $0 is not drained.
{
  const r = spendCtx(0.5, 0.5, 0); // 0.5 - 0.5 = 0, not < 0
  check("W-zero-allowed: floor=0, spend to exactly $0 is NOT would_drain", r.reason !== "would_drain_wallet");
  check("W-zero-allowed: floor=0, spend to exactly $0 -> just_do_it", r.decision === "just_do_it");
}
// W-overdraw-denied: floor=0, an overdraw is still blocked.
{
  const r = spendCtx(0.6, 0.5, 0); // 0.5 - 0.6 = -0.1 < 0
  check("W-overdraw-denied: floor=0, overdraw -> deny", r.decision === "deny");
  check("W-overdraw-denied: floor=0, overdraw -> would_drain_wallet", r.reason === "would_drain_wallet");
}
// W-contrast: the SAME near-empty spend is drain-denied at the DEFAULT floor but allowed at floor=0.
// This is the reversal's actual effect on the drain guard (a direct :84 discriminator).
{
  const atDefault = spendCtx(0.45, 0.5, undefined); // 0.5 - 0.45 = 0.05 < 0.10 (base)
  check("W-contrast default floor: near-empty spend -> would_drain", atDefault.reason === "would_drain_wallet");
  const atZero = spendCtx(0.45, 0.5, 0); // 0.05 < 0 false -> allowed
  check("W-contrast floor=0: same spend NOT would_drain", atZero.reason !== "would_drain_wallet");
  check("W-contrast floor=0: same spend -> just_do_it", atZero.decision === "just_do_it");
}

// ── 3. frontier-headroom walletHeadroom at floor=0 (frontier-headroom.ts:88) ──
const headroom = (floorOverride: number, balance: number, earned: number) =>
  autonomousHeadroom({
    spendEnabled: true,
    standing: { earnedDailyBudgetUsd: earned },
    bands: effectiveBands("starter", false, { minWalletBalance: floorOverride }),
    spentTodayUsd: 0,
    walletBalanceUsd: balance,
  });
// H1 floor=0 -> walletHeadroom == balance (no understatement, no sign error).
{
  const h = headroom(0, 5, 100); // effective floor 0; balance 5; earned high
  check("H1 floor=0: walletHeadroom == balance (5)", approx(h.walletHeadroomUsd, 5));
}
// H2 corrupt negative override -> effective floor = base (fail-safe), so walletHeadroom
//    = balance - base, NOT balance + |neg|. The sign-error / overstatement guard.
{
  const h = headroom(-5, 5, 100); // effective floor base 0.10 (NOT -5); balance 5
  check("H2 negative override: walletHeadroom == balance - base (4.9), NOT inflated", approx(h.walletHeadroomUsd, 5 - BASE));
  check("H2 negative override: walletHeadroom is NOT overstated (< balance)", h.walletHeadroomUsd < 5);
}
// H3 floor=0 + huge balance + low earned -> effective autonomy still bound by EARNED.
//    "Spend it all" removes the reserve cushion but never blows past the earned keystone.
{
  const h = headroom(0, 100, 0.5); // floor 0; balance 100; earned 0.5; daily band 5
  check("H3 floor=0: walletHeadroom == full balance (100)", approx(h.walletHeadroomUsd, 100));
  check("H3 floor=0: effectiveMaxToday bound by earned (0.5), NOT balance", approx(h.effectiveMaxTodayUsd, 0.5));
  check("H3 floor=0: binding factor is 'earned', not 'wallet'", h.binding === "earned");
}

console.log(`\nfloor-reversal suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
