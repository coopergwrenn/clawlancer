#!/usr/bin/env tsx
/**
 * Unit tests for the per-VM category allowlist override (W3, §5 Q4).
 *
 * Run: npx tsx scripts/_test-frontier-categories.ts
 * Exits 0 if all pass, 1 on any failure. No DB / network — pure logic.
 *
 * Covers the safety-critical property: the per-VM category override is
 * TIGHTEN-ONLY (effective = tierDefault ∩ override). A user can REMOVE
 * categories but can NEVER widen into a category above their tier — in
 * particular "market" (trading), which is in no tier default, can never be
 * enabled via the override path. Plus the gate integration (category_not_allowed).
 */

import {
  effectiveAllowedCategories,
  evaluateSpend,
  mapTagsToCategory,
  ALL_CATEGORIES,
  DEFAULT_ALLOWED_CATEGORIES_BY_TIER,
  TRAVEL_MAX_PER_TX,
  TRAVEL_MAX_PER_DAY,
  type FrontierTier,
  type SpendCategory,
  type SpendContext,
} from "../lib/frontier-policy";

let passed = 0;
let failed = 0;

function eqSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}

function expectCats(
  label: string,
  tier: FrontierTier,
  override: readonly SpendCategory[] | null | undefined,
  want: readonly SpendCategory[],
): void {
  const got = effectiveAllowedCategories(tier, override);
  if (eqSet(got, want)) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${label}\n  want [${want.join(",")}]\n  got  [${got.join(",")}]`);
  }
}

function ok(): SpendContext {
  return { amountUsd: 0.5, spentTodayUsd: 0, walletBalanceUsd: 10_000, privacyModeOn: false, counterpartyVerified: true };
}

function expectDecision(
  label: string,
  tier: FrontierTier,
  ctx: SpendContext,
  wantReason: string,
): void {
  const r = evaluateSpend(tier, ctx);
  if (r.reason === wantReason) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}\n  want reason=${wantReason}\n  got reason=${r.reason} decision=${r.decision}`);
  }
}

// ── effectiveAllowedCategories: tighten-only intersection ──
expectCats("null override → tier default (starter)", "starter", null, DEFAULT_ALLOWED_CATEGORIES_BY_TIER.starter);
expectCats("undefined override → tier default (pro)", "pro", undefined, DEFAULT_ALLOWED_CATEGORIES_BY_TIER.pro);
expectCats("subset override removes a category", "starter", ["data", "search"], ["data", "search"]);
expectCats("override down to one category", "starter", ["data"], ["data"]);
expectCats("empty override → empty (everything off, valid)", "starter", [], []);

// THE load-bearing tighten-only tests: can't widen past the tier, can't add market.
expectCats("starter cannot add 'market' (not in tier default)", "starter", ["data", "search", "market"], ["data", "search"]);
expectCats("starter cannot add 'inference' (pro-tier category)", "starter", ["data", "inference"], ["data"]);
expectCats("pro cannot add 'market'", "pro", ["data", "market"], ["data"]);
expectCats("power cannot add 'market'", "power", ["data", "search", "market"], ["data", "search"]);
expectCats("override of only-above-tier categories → empty", "starter", ["inference", "compute", "market"], []);

// ── evaluateSpend integration: the category gate ──
// "market" is in no tier default → with the tier-default allowlist it's denied.
expectDecision(
  "market spend with tier-default allowlist → category_not_allowed",
  "starter",
  { ...ok(), category: "market", allowedCategories: DEFAULT_ALLOWED_CATEGORIES_BY_TIER.starter },
  "category_not_allowed",
);
// A category the user turned OFF via a tightened allowlist → denied even though it's in the tier default.
expectDecision(
  "agent spend after user tightened to [data] → category_not_allowed",
  "starter",
  { ...ok(), category: "agent", allowedCategories: effectiveAllowedCategories("starter", ["data"]) },
  "category_not_allowed",
);
// An allowed category, small amount, verified → passes the category gate to just_do_it.
expectDecision(
  "data spend within allowlist + small → within_just_do_it_band",
  "starter",
  { ...ok(), category: "data", allowedCategories: DEFAULT_ALLOWED_CATEGORIES_BY_TIER.starter },
  "within_just_do_it_band",
);
// Effective allowlist drives the gate: tightened-to-[data], then a data spend still allowed.
expectDecision(
  "data spend after tighten-to-[data] → still allowed (within_just_do_it_band)",
  "starter",
  { ...ok(), category: "data", allowedCategories: effectiveAllowedCategories("starter", ["data", "market"]) },
  "within_just_do_it_band",
);

// ── travel category (ToolRouter StableTravel; §6) ──
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

// enum + registry
check("ALL_CATEGORIES includes travel", ALL_CATEGORIES.includes("travel"));
check("ALL_CATEGORIES length is 9", ALL_CATEGORIES.length === 9);

// tag mapping — the ordering fix: 'flights_search' contains 'search' but must map to
// travel (travel rule is first), not search.
check("['flight'] → travel", mapTagsToCategory(["flight"]) === "travel");
check("['hotel'] → travel", mapTagsToCategory(["hotel"]) === "travel");
check("['lodging'] → travel", mapTagsToCategory(["lodging"]) === "travel");
check("['flights_search'] → travel (NOT search — ordering)", mapTagsToCategory(["flights_search"]) === "travel");
check("['stabletravel.hotels_search'] → travel", mapTagsToCategory(["stabletravel.hotels_search"]) === "travel");
check("['search'] still → search (no travel term)", mapTagsToCategory(["search"]) === "search");

// tier defaults — pro + power allow travel; starter does NOT.
check("pro default includes travel", DEFAULT_ALLOWED_CATEGORIES_BY_TIER.pro.includes("travel"));
check("power default includes travel", DEFAULT_ALLOWED_CATEGORIES_BY_TIER.power.includes("travel"));
check("starter default INCLUDES travel (Q1 reversed 2026-06-12 — every tier books)", DEFAULT_ALLOWED_CATEGORIES_BY_TIER.starter.includes("travel"));

// tighten-only: travel is in starter's default now (Q1 reversal), so a tightening
// that KEEPS it is legal; "market" (in no tier default) is the above-tier case.
expectCats("starter keeps 'travel' through a tightening that includes it", "starter", ["data", "travel"], ["data", "travel"]);
expectCats("starter cannot add 'market' (above-tier)", "starter", ["data", "market"], ["data"]);
// pro keeps travel through a tightening that includes it.
check("pro effective keeps travel by default", effectiveAllowedCategories("pro", null).includes("travel"));

// gate integration — the load-bearing layering proof:
// (a) starter travel spend → HARD DENY (travel not in starter allowlist).
expectDecision(
  "starter travel spend → ask_first ALLOW-path (Q1 reversed 2026-06-12)",
  "starter",
  { ...ok(), category: "travel", allowedCategories: DEFAULT_ALLOWED_CATEGORIES_BY_TIER.starter },
  "within_ask_first_band",
);
// ── travel CEILING matrix (§6 — the category-scoped raise; the half that completes
//    the category so real-priced bookings reach ask_first instead of hard-denying) ──
const proCats = DEFAULT_ALLOWED_CATEGORIES_BY_TIER.pro;
const powerCats = DEFAULT_ALLOWED_CATEGORIES_BY_TIER.power;

check("TRAVEL_MAX_PER_TX is 1200", TRAVEL_MAX_PER_TX === 1200);
check("TRAVEL_MAX_PER_DAY is 3000", TRAVEL_MAX_PER_DAY === 3000);

// ── Q1 REVERSED (Cooper ruling 2026-06-12): travel is open to EVERY tier,
// Starter included — no tier gate anywhere in the travel lane. A starter's
// booking flows exactly like a pro's: category gate passes, travelBands replace
// the tier bands (justDoItPerTx=0 → consent-always tap), $1200/$3000 ceiling. ──
const starterCats = DEFAULT_ALLOWED_CATEGORIES_BY_TIER.starter;
check("travel ∈ starter's default allowlist (the one-line reversal)", starterCats.includes("travel"));
expectDecision("STARTER $84.50 travel → ask_first ALLOW-path (the reversal's proof)", "starter",
  { ...ok(), amountUsd: 84.5, category: "travel", allowedCategories: starterCats }, "within_ask_first_band");
expectDecision("starter $5 travel → ask_first NOT just_do_it (consent-always holds for starter too)", "starter",
  { ...ok(), amountUsd: 5, category: "travel", allowedCategories: starterCats }, "within_ask_first_band");
expectDecision("starter $1300 travel → exceeds_per_tx_ceiling (same $1200 cap as pro — no worse wall)", "starter",
  { ...ok(), amountUsd: 1300, category: "travel", allowedCategories: starterCats }, "exceeds_per_tx_ceiling");
expectDecision("starter travel via TIGHTENED override excluding travel → category_not_allowed (the honest-generic path)", "starter",
  { ...ok(), amountUsd: 84.5, category: "travel", allowedCategories: effectiveAllowedCategories("starter", ["data"]) }, "category_not_allowed");

// real bookings now REACH ask_first (were hard-denying at the tier neverPerTx $50/$200).
expectDecision("pro $100 travel → ask_first (was hard-deny at $50)", "pro",
  { ...ok(), amountUsd: 100, category: "travel", allowedCategories: proCats }, "within_ask_first_band");
expectDecision("pro $370 travel → ask_first", "pro",
  { ...ok(), amountUsd: 370, category: "travel", allowedCategories: proCats }, "within_ask_first_band");
expectDecision("pro $1200 travel (== cap, not strictly above) → ask_first", "pro",
  { ...ok(), amountUsd: 1200, category: "travel", allowedCategories: proCats }, "within_ask_first_band");
expectDecision("pro $1300 travel → hard deny (over $1200 cap)", "pro",
  { ...ok(), amountUsd: 1300, category: "travel", allowedCategories: proCats }, "exceeds_per_tx_ceiling");

// LOAD-BEARING (c): $0 just-do-it → NO travel spend is ever autonomous. Consent-always.
expectDecision("pro $5 travel → ask_first NOT just_do_it (consent-always)", "pro",
  { ...ok(), amountUsd: 5, category: "travel", allowedCategories: proCats }, "within_ask_first_band");
expectDecision("pro $0.50 travel → ask_first NOT just_do_it", "pro",
  { ...ok(), amountUsd: 0.5, category: "travel", allowedCategories: proCats }, "within_ask_first_band");

// daily cap $3000 (total-when-travel; non-travel is tier-capped low, so this is the travel ceiling).
expectDecision("pro travel pushing total over $3000/day → deny", "pro",
  { ...ok(), amountUsd: 200, spentTodayUsd: 2900, category: "travel", allowedCategories: proCats }, "exceeds_daily_ceiling");
expectDecision("pro travel exactly at $3000 boundary → ask_first (not >)", "pro",
  { ...ok(), amountUsd: 100, spentTodayUsd: 2900, category: "travel", allowedCategories: proCats }, "within_ask_first_band");

// power: travel cap is FLAT $1200/$3000 (not tier-scaled; staker 2x not applied).
expectDecision("power $1000 travel → ask_first", "power",
  { ...ok(), amountUsd: 1000, category: "travel", allowedCategories: powerCats }, "within_ask_first_band");
expectDecision("power $1300 travel → hard deny (flat $1200 cap, not tier-scaled)", "power",
  { ...ok(), amountUsd: 1300, category: "travel", allowedCategories: powerCats }, "exceeds_per_tx_ceiling");

// (a) NON-TRAVEL UNCHANGED — the raise must not leak into any other category.
expectDecision("pro $6 DATA → within_ask_first_band (UNCHANGED)", "pro",
  { ...ok(), amountUsd: 6, category: "data", allowedCategories: proCats }, "within_ask_first_band");
expectDecision("pro $60 DATA → deny exceeds_per_tx_ceiling (tier $50, NOT travel $1200)", "pro",
  { ...ok(), amountUsd: 60, category: "data", allowedCategories: proCats }, "exceeds_per_tx_ceiling");
expectDecision("pro $4 DATA → just_do_it (UNCHANGED — non-travel still autonomous under jdt)", "pro",
  { ...ok(), amountUsd: 4, category: "data", allowedCategories: proCats }, "within_just_do_it_band");

// (b) tighten-only: a user neverPerTx override clamps travel DOWN (no surprising allow).
expectDecision("travel + neverPerTx override $400 → $500 denies (clamped down)", "pro",
  { ...ok(), amountUsd: 500, category: "travel", allowedCategories: proCats, overrides: { neverPerTx: 400 } }, "exceeds_per_tx_ceiling");
expectDecision("travel + neverPerTx override $400 → $300 still ask_first", "pro",
  { ...ok(), amountUsd: 300, category: "travel", allowedCategories: proCats, overrides: { neverPerTx: 400 } }, "within_ask_first_band");
// (b) cap: an override can NEVER raise travel above $1200.
expectDecision("travel + neverPerTx override $5000 → $1300 STILL denies (capped at $1200)", "pro",
  { ...ok(), amountUsd: 1300, category: "travel", allowedCategories: proCats, overrides: { neverPerTx: 5000 } }, "exceeds_per_tx_ceiling");

// (c) THE load-bearing hole: a RAISED justDoItPerTx override must NOT make travel autonomous.
expectDecision("travel + justDoItPerTx override $50 → $5 travel STILL ask_first (jdt pinned 0)", "pro",
  { ...ok(), amountUsd: 5, category: "travel", allowedCategories: proCats, overrides: { justDoItPerTx: 50 } }, "within_ask_first_band");
// proof the override is real (it raises jdt for non-travel; only travel pins it to 0).
expectDecision("data + justDoItPerTx override $50 → $20 data → just_do_it (override works for non-travel)", "pro",
  { ...ok(), amountUsd: 20, category: "data", allowedCategories: proCats, overrides: { justDoItPerTx: 50 } }, "within_just_do_it_band");

console.log(`\nfrontier-categories: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
