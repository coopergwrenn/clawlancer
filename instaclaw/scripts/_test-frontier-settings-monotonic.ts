#!/usr/bin/env tsx
/**
 * Gate suite for the agent-facing /settings monotonic-safe combine
 * (lib/frontier-settings-monotonic.ts). PURE (no DB / network).
 *
 * Run: npx tsx scripts/_test-frontier-settings-monotonic.ts
 * Exits 0 if all pass, 1 on any failure.
 *
 * The endpoint a hijacked agent can reach MUST be structurally incapable of
 * loosening a money rail. This suite proves wall 1 (the monotonic combine) directly:
 * a loosening request applies to NOTHING (bandsToApply has no loosening; turnOff is
 * never true-for-ON; categories never gain a member). That holds INDEPENDENT of the
 * read-side clamp (wall 2) - the TWO-WALLS proof below asserts on the combine output
 * alone, so even with wall 2 disabled, no loosening is stored.
 *
 * Threat cases (a)-(e1) from the design table each get a named test. Discrimination
 * is proven out-of-band (see the two perl mutations in the build log): max->min on
 * the reserve safe line reds the reserve-raise tests; inverting the reserve direction
 * reds the (a) zero-reserve guard.
 */

import { monotonicSafeSettings, type CurrentSettings } from "../lib/frontier-settings-monotonic";
import type { SpendCategory } from "../lib/frontier-policy";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}
const has = (arr: { field: string }[], field: string) => arr.some((v) => v.field === field);

// Current effective: a starter with spend ON and a 3-category allowlist.
const CUR: CurrentSettings = {
  bands: { justDoItPerTx: 1, justDoItPerDay: 5, neverPerTx: 10, neverPerDay: 25, minWalletBalance: 0.1 },
  categories: ["data", "search", "inference"] as SpendCategory[],
  spendEnabled: true,
};
const CUR_OFF: CurrentSettings = { ...CUR, spendEnabled: false };

// ── Tightenings APPLY (the safe direction) ──
{
  const r = monotonicSafeSettings(CUR, { bands: { minWalletBalance: 5 } }); // raise reserve
  check("T1 reserve RAISE applies (5)", r.bandsToApply.minWalletBalance === 5 && has(r.applied, "minWalletBalance"));
  check("T1 reserve RAISE not flagged loosening", !has(r.needsConfirmation, "minWalletBalance"));
}
{
  const r = monotonicSafeSettings(CUR, { bands: { justDoItPerTx: 0.5 } }); // lower no-ask line
  check("T2 no-ask LOWER applies (0.5)", r.bandsToApply.justDoItPerTx === 0.5 && has(r.applied, "justDoItPerTx"));
}
{
  const r = monotonicSafeSettings(CUR, { bands: { neverPerTx: 5 } }); // lower hard ceiling
  check("T3 hard-ceiling LOWER applies (5)", r.bandsToApply.neverPerTx === 5 && has(r.applied, "neverPerTx"));
}
{
  const r = monotonicSafeSettings(CUR, { categories: ["data"] as SpendCategory[] }); // remove search+inference
  check("T4 category REMOVE applies ([data])", JSON.stringify(r.categoriesToApply) === JSON.stringify(["data"]));
  check("T4 category remove not flagged loosening", r.needsConfirmation.length === 0);
}
{
  const r = monotonicSafeSettings(CUR, { spendEnabled: false }); // turn OFF
  check("T5 turn OFF applies", r.turnOff === true && has(r.applied, "spendEnabled"));
}

// ── (a) zero the reserve → NO loosening applied, routed to confirm ──
{
  const r = monotonicSafeSettings(CUR, { bands: { minWalletBalance: 0 } });
  check("(a) zero-reserve: NOT applied", r.bandsToApply.minWalletBalance === undefined);
  check("(a) zero-reserve: routed to needs_confirmation", has(r.needsConfirmation, "minWalletBalance"));
  check("(a) zero-reserve: nothing in applied", !has(r.applied, "minWalletBalance"));
  // TWO-WALLS: the combine output carries no reserve change, so even if the read-side
  // clamp (wall 2) were disabled, storing bandsToApply leaves the reserve untouched.
  check("(a) TWO-WALLS: combine emits no reserve mutation (wall 1 alone holds)", !("minWalletBalance" in r.bandsToApply));
}

// ── (b) raise every ceiling → none applied ──
{
  const r = monotonicSafeSettings(CUR, { bands: { neverPerTx: 999, neverPerDay: 999, justDoItPerTx: 999, justDoItPerDay: 999 } });
  check("(b) raise-ceilings: NONE applied", Object.keys(r.bandsToApply).length === 0);
  check("(b) raise-ceilings: all four routed to confirm", ["neverPerTx", "neverPerDay", "justDoItPerTx", "justDoItPerDay"].every((f) => has(r.needsConfirmation, f)));
}

// ── (c) flip spending ON → not applied (dashboard-only) ──
{
  const r = monotonicSafeSettings(CUR_OFF, { spendEnabled: true });
  check("(c) flip-ON: turnOff stays false", r.turnOff === false);
  check("(c) flip-ON: routed to needs_confirmation", has(r.needsConfirmation, "spendEnabled"));
}

// ── (d) a loosening mints NO replayable capability - only a {field,requested,current} descriptor ──
{
  const r = monotonicSafeSettings(CUR, { bands: { minWalletBalance: 0 } });
  const v = r.needsConfirmation.find((x) => x.field === "minWalletBalance")!;
  check("(d) needs_confirmation descriptor has exactly field/requested/current (no token/grant)", Object.keys(v).sort().join(",") === "current,field,requested");
}

// ── (e1) add a category → not applied; remove still applies ──
{
  const r = monotonicSafeSettings(CUR, { categories: ["data", "search", "inference", "market"] as SpendCategory[] });
  check("(e1) add-category: routed to needs_confirmation", has(r.needsConfirmation, "allowedCategories"));
  check("(e1) add-category: nothing applied (no removal)", r.categoriesToApply === null);
}
{
  // mixed: remove search+inference (tighten) AND add market (loosen) in one request.
  const r = monotonicSafeSettings(CUR, { categories: ["data", "market"] as SpendCategory[] });
  check("(e1) mixed: removals APPLY as safe subset ([data])", JSON.stringify(r.categoriesToApply) === JSON.stringify(["data"]));
  check("(e1) mixed: the add is routed to confirm", has(r.needsConfirmation, "allowedCategories"));
}

// ── mixed bands: a tighten applies, a loosen routes, in one call ──
{
  const r = monotonicSafeSettings(CUR, { bands: { minWalletBalance: 5, justDoItPerTx: 20 } });
  check("mixed: reserve raise APPLIES (5)", r.bandsToApply.minWalletBalance === 5);
  check("mixed: no-ask raise ROUTES (not applied)", r.bandsToApply.justDoItPerTx === undefined && has(r.needsConfirmation, "justDoItPerTx"));
}

// ── noop: requested == current ──
{
  const r = monotonicSafeSettings(CUR, { bands: { minWalletBalance: 0.1 } });
  check("noop: reserve == current -> nothing applied, nothing flagged", Object.keys(r.bandsToApply).length === 0 && r.needsConfirmation.length === 0 && has(r.noop, "minWalletBalance"));
}

console.log(`\nsettings-monotonic suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
