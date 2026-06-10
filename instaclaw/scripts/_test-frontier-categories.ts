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
check("starter default excludes travel", !DEFAULT_ALLOWED_CATEGORIES_BY_TIER.starter.includes("travel"));

// tighten-only: starter can never ADD travel (not in its tier default).
expectCats("starter cannot add 'travel' (above-tier)", "starter", ["data", "travel"], ["data"]);
// pro keeps travel through a tightening that includes it.
check("pro effective keeps travel by default", effectiveAllowedCategories("pro", null).includes("travel"));

// gate integration — the load-bearing layering proof:
// (a) starter travel spend → HARD DENY (travel not in starter allowlist).
expectDecision(
  "starter travel spend → category_not_allowed (hard deny)",
  "starter",
  { ...ok(), category: "travel", allowedCategories: DEFAULT_ALLOWED_CATEGORIES_BY_TIER.starter },
  "category_not_allowed",
);
// (b) pro small travel spend → autonomous (category allowed, under just_do_it).
expectDecision(
  "pro small travel spend → within_just_do_it_band",
  "pro",
  { ...ok(), category: "travel", allowedCategories: DEFAULT_ALLOWED_CATEGORIES_BY_TIER.pro },
  "within_just_do_it_band",
);
// (c) pro LARGE travel spend (over justDoItPerTx $5, under neverPerTx $50) → ask_first,
//     NOT hard-denied. This is the whole layering: travel is categorically allowed, and
//     the AMOUNT gate sends a big booking to human approval (the human_approved flow).
expectDecision(
  "pro $6 travel spend → ask_first (amount gate, not category deny)",
  "pro",
  { ...ok(), amountUsd: 6, category: "travel", allowedCategories: DEFAULT_ALLOWED_CATEGORIES_BY_TIER.pro },
  "within_ask_first_band",
);

console.log(`\nfrontier-categories: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
