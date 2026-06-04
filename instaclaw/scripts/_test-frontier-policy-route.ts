#!/usr/bin/env tsx
/**
 * GAP-4 — coverage for the live per-VM policy money-gate, the layer that governs
 * what an agent may spend autonomously once W12 turns spend loose fleet-wide.
 * Three previously verified-by-inspection-only surfaces, now asserted:
 *
 *   1. readPolicyOverrides (lib/frontier-overrides-db) — the canonical reader the
 *      authorize gate uses: table/column-missing tolerance, snake→camel band parse,
 *      the Array.isArray category guard, the [] vs null distinction.
 *   2. validatePolicyPutBody + upsertPolicyOverrideRow (lib/frontier-policy-write) —
 *      the /policy PUT 400s + the PGRST204 (category-column-absent) retry contract
 *      (bands persist, categories flagged not-stored).
 *   3. resolveEffectivePolicy (lib/frontier-overrides-db) — the SHARED read→effective
 *      seam the authorize gate actually calls. The wiring is proven by decision
 *      CHANGE: a stored tightening, run through the gate's own seam into the real
 *      evaluateSpend → decideAuthorization, flips a spend the tier default allowed.
 *      (Proves the route feeds the stored override into the gate — not a test-local
 *      re-implementation; this is GAP-4's named integration gap.)
 *
 * Idiom mirrors scripts/_test-frontier-routes.ts (mock-supabase chain, check(),
 * async IIFE — CJS compile, no TLA). Pure + deterministic; no DB / network.
 *
 * Run: npx tsx scripts/_test-frontier-policy-route.ts   (exit 0 = all pass)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readPolicyOverrides, resolveEffectivePolicy } from "../lib/frontier-overrides-db";
import {
  validatePolicyPutBody,
  upsertPolicyOverrideRow,
  MAX_OVERRIDE,
} from "../lib/frontier-policy-write";
import {
  evaluateSpend,
  DEFAULT_ALLOWED_CATEGORIES_BY_TIER,
  type FrontierTier,
  type PolicyOverrides,
  type SpendCategory,
} from "../lib/frontier-policy";
import { decideAuthorization } from "../lib/frontier-authz";
import type { CreditStanding } from "../lib/frontier-standing";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── mock supabase: the read chain readPolicyOverrides walks (from→select→eq→maybeSingle) ──
function mockRead(result: { data?: unknown; error?: unknown }): any {
  const chain: any = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => result;
  return { from: () => chain };
}

// ── mock supabase: the upsert chain, call-count-aware (for the PGRST204 retry) + payload capture ──
function mockUpsert(seq: Array<{ error?: unknown }>): {
  sb: any;
  calls: Array<{ payload: any; opts: any }>;
} {
  const calls: Array<{ payload: any; opts: any }> = [];
  let i = 0;
  const sb = {
    from: () => ({
      upsert: async (payload: any, opts: any) => {
        calls.push({ payload, opts });
        const r = seq[Math.min(i, seq.length - 1)];
        i += 1;
        return r;
      },
    }),
  };
  return { sb, calls };
}

// ── console.error spy (the reader logs unexpected errors but NOT table-missing) ──
const origErr = console.error;
let errCount = 0;
function spyOn() {
  errCount = 0;
  console.error = () => {
    errCount += 1;
  };
}
function spyOff() {
  console.error = origErr;
}

// ── the gate the way authorize runs it: evaluateSpend → decideAuthorization, fed the
//    EFFECTIVE policy resolveEffectivePolicy produced. Returns the final outcome. ──
function gate(
  tier: FrontierTier,
  args: { earned: number; spent: number; balance: number | null; amount: number; category?: SpendCategory | null },
  resolved: { bandOverrides: PolicyOverrides | null; allowedCategories: readonly SpendCategory[] },
): "just_do_it" | "ask_first" | "deny" {
  const evaluation = evaluateSpend(tier, {
    amountUsd: args.amount,
    spentTodayUsd: args.spent,
    walletBalanceUsd: args.balance,
    privacyModeOn: false,
    counterpartyVerified: true,
    isStaker: false,
    overrides: resolved.bandOverrides,
    category: args.category ?? undefined,
    allowedCategories: resolved.allowedCategories,
  });
  const standing = { earnedDailyBudgetUsd: args.earned } as CreditStanding;
  return decideAuthorization({
    evaluation,
    standing,
    reserveAwareSpentTodayUsd: args.spent,
    amountUsd: args.amount,
    humanApproved: false,
    categoryKnown: (args.category ?? null) !== null,
  }).outcome;
}

const isEmpty = (o: { bandOverrides: unknown; allowedCategoriesOverride: unknown; persisted: boolean }) =>
  o.bandOverrides === null && o.allowedCategoriesOverride === null && o.persisted === false;

(async () => {
  // ═══════════════ 1. readPolicyOverrides ═══════════════
  // — error / empty paths —
  spyOn();
  check("reader: PGRST205 (table missing) → EMPTY", isEmpty(await readPolicyOverrides(mockRead({ error: { code: "PGRST205" } }), "vm")));
  check("reader: 42P01 (table missing) → EMPTY", isEmpty(await readPolicyOverrides(mockRead({ error: { code: "42P01" } }), "vm")));
  check("reader: table-missing does NOT log", errCount === 0);
  spyOff();
  spyOn();
  check("reader: other error code → EMPTY", isEmpty(await readPolicyOverrides(mockRead({ error: { code: "PGRST500" } }), "vm")));
  check("reader: unexpected error DOES log", errCount === 1);
  spyOff();
  check("reader: no row (data null) → EMPTY", isEmpty(await readPolicyOverrides(mockRead({ data: null }), "vm")));

  // — band parse (snake→camel via num()) —
  {
    const o = await readPolicyOverrides(
      mockRead({ data: { vm_id: "vm", just_do_it_per_tx: 1, just_do_it_per_day: 5, never_per_tx: 10, never_per_day: 25, min_wallet_balance: 2 } }),
      "vm",
    );
    check("reader: all 5 bands → camelCase", eq(o.bandOverrides, { justDoItPerTx: 1, justDoItPerDay: 5, neverPerTx: 10, neverPerDay: 25, minWalletBalance: 2 }));
    check("reader: persisted true when row exists", o.persisted === true);
  }
  {
    const o = await readPolicyOverrides(mockRead({ data: { vm_id: "vm", just_do_it_per_tx: 0.5 } }), "vm");
    check("reader: band subset → only that key", eq(o.bandOverrides, { justDoItPerTx: 0.5 }));
  }
  {
    const o = await readPolicyOverrides(mockRead({ data: { vm_id: "vm", just_do_it_per_tx: "1.5" } }), "vm");
    check("reader: string-numeric band → parseFloat", eq(o.bandOverrides, { justDoItPerTx: 1.5 }));
  }
  {
    const o = await readPolicyOverrides(mockRead({ data: { vm_id: "vm", just_do_it_per_tx: 0 } }), "vm");
    check("reader: band 0 is KEPT (finite, valid)", eq(o.bandOverrides, { justDoItPerTx: 0 }));
  }
  {
    const o = await readPolicyOverrides(mockRead({ data: { vm_id: "vm", just_do_it_per_tx: null } }), "vm");
    check("reader: null band field → dropped → bandOverrides null", o.bandOverrides === null);
  }
  {
    const o = await readPolicyOverrides(mockRead({ data: { vm_id: "vm", just_do_it_per_tx: "abc" } }), "vm");
    check("reader: non-numeric band 'abc' → dropped", o.bandOverrides === null);
  }
  {
    const o = await readPolicyOverrides(mockRead({ data: { vm_id: "vm" } }), "vm");
    check("reader: row, no band fields → bandOverrides null, persisted true", o.bandOverrides === null && o.persisted === true);
  }

  // — category parse (Array.isArray guard + filter to ALL_CATEGORIES; [] distinct from null) —
  {
    const o = await readPolicyOverrides(mockRead({ data: { vm_id: "vm" } }), "vm");
    check("reader: allowed_categories absent → null", o.allowedCategoriesOverride === null);
  }
  {
    const o = await readPolicyOverrides(mockRead({ data: { vm_id: "vm", allowed_categories: null } }), "vm");
    check("reader: allowed_categories null → null", o.allowedCategoriesOverride === null);
  }
  {
    const o = await readPolicyOverrides(mockRead({ data: { vm_id: "vm", allowed_categories: [] } }), "vm");
    check("reader: allowed_categories [] → [] (distinct from null)", Array.isArray(o.allowedCategoriesOverride) && o.allowedCategoriesOverride.length === 0);
  }
  {
    const o = await readPolicyOverrides(mockRead({ data: { vm_id: "vm", allowed_categories: ["data", "search"] } }), "vm");
    check("reader: valid cats kept", eq(o.allowedCategoriesOverride, ["data", "search"]));
  }
  {
    const o = await readPolicyOverrides(mockRead({ data: { vm_id: "vm", allowed_categories: ["data", "garbage", "market"] } }), "vm");
    check("reader: garbage filtered, market RAW-kept", eq(o.allowedCategoriesOverride, ["data", "market"]));
  }
  {
    const o = await readPolicyOverrides(mockRead({ data: { vm_id: "vm", allowed_categories: "data" } }), "vm");
    check("reader: non-array cats (string) → null", o.allowedCategoriesOverride === null);
  }

  // ═══════════════ 2. validatePolicyPutBody (pure 400s + normalize) ═══════════════
  const isErr = (r: any) => r.ok === false;
  check("validate: null → 400", isErr(validatePolicyPutBody(null)) && (validatePolicyPutBody(null) as any).status === 400);
  check("validate: array → 400", isErr(validatePolicyPutBody([1, 2])));
  check("validate: string → 400", isErr(validatePolicyPutBody("x")));
  check("validate: band non-number → 400", isErr(validatePolicyPutBody({ justDoItPerTx: "1" })));
  check("validate: band negative → 400", isErr(validatePolicyPutBody({ justDoItPerTx: -1 })));
  check("validate: band > MAX → 400", isErr(validatePolicyPutBody({ justDoItPerTx: MAX_OVERRIDE + 1 })));
  check("validate: band NaN → 400", isErr(validatePolicyPutBody({ justDoItPerTx: NaN })));
  check("validate: band Infinity → 400", isErr(validatePolicyPutBody({ justDoItPerTx: Infinity })));
  check("validate: cats non-array → 400", isErr(validatePolicyPutBody({ allowed_categories: "data" })));
  {
    const r = validatePolicyPutBody({ allowed_categories: ["data", "nope"] });
    check("validate: unknown category → 400 naming it", isErr(r) && (r as any).error.includes("nope"));
  }
  {
    const r = validatePolicyPutBody({ justDoItPerTx: 0.5 });
    check("validate: valid band → row + rawOverrides", r.ok === true && eq(r.rawOverrides, { justDoItPerTx: 0.5 }) && (r.row as any).just_do_it_per_tx === 0.5);
  }
  {
    const r = validatePolicyPutBody({ justDoItPerTx: null });
    check("validate: null band → cleared (row key null)", r.ok === true && (r.row as any).just_do_it_per_tx === null);
  }
  {
    const r = validatePolicyPutBody({});
    check("validate: {} → all bands cleared, no rawOverrides, cats null", r.ok === true && eq(r.rawOverrides, {}) && r.categoryOverride === null && (r.row as any).just_do_it_per_tx === null);
  }
  {
    const r = validatePolicyPutBody({ allowed_categories: ["search", "data", "data"] });
    check("validate: cats dedupe + taxonomy order", r.ok === true && eq(r.categoryOverride, ["data", "search"]));
  }
  {
    const r = validatePolicyPutBody({ allowed_categories: [] });
    check("validate: cats [] → stored [] (everything off)", r.ok === true && eq(r.categoryOverride, []));
  }
  {
    const r = validatePolicyPutBody({ allowed_categories: null });
    check("validate: cats null → categoryOverride null (clear)", r.ok === true && r.categoryOverride === null);
  }
  {
    const r = validatePolicyPutBody({ minWalletBalance: 0 });
    check("validate: band 0 valid (>= 0)", r.ok === true && eq(r.rawOverrides, { minWalletBalance: 0 }));
  }

  // ═══════════════ 3. upsertPolicyOverrideRow (+ PGRST204 retry contract) ═══════════════
  {
    const { sb, calls } = mockUpsert([{ error: null }]);
    const res = await upsertPolicyOverrideRow(sb, "vm", { just_do_it_per_tx: 1, allowed_categories: ["data"] });
    check("upsert: success → categoryPersisted true", res.ok === true && res.categoryPersisted === true);
    check("upsert: single call, payload carries allowed_categories", calls.length === 1 && "allowed_categories" in calls[0].payload);
  }
  {
    // PGRST204 on first (column missing) → retry WITHOUT allowed_categories, bands persist
    const { sb, calls } = mockUpsert([{ error: { code: "PGRST204" } }, { error: null }]);
    const res = await upsertPolicyOverrideRow(sb, "vm", { just_do_it_per_tx: 1, allowed_categories: ["data"] });
    check("upsert: PGRST204 retry → ok, categoryPersisted FALSE", res.ok === true && res.categoryPersisted === false);
    check("upsert: retried twice", calls.length === 2);
    check("upsert: retry payload DROPS allowed_categories", !("allowed_categories" in calls[1].payload));
    check("upsert: retry payload KEEPS bands", calls[1].payload.just_do_it_per_tx === 1);
  }
  {
    const { sb } = mockUpsert([{ error: { code: "PGRST205" } }]);
    const res = await upsertPolicyOverrideRow(sb, "vm", { just_do_it_per_tx: 1, allowed_categories: ["data"] });
    check("upsert: table-missing PGRST205 → table_missing", res.ok === false && (res as any).kind === "table_missing");
  }
  {
    const { sb } = mockUpsert([{ error: { code: "42P01" } }]);
    const res = await upsertPolicyOverrideRow(sb, "vm", { just_do_it_per_tx: 1, allowed_categories: ["data"] });
    check("upsert: table-missing 42P01 → table_missing", res.ok === false && (res as any).kind === "table_missing");
  }
  {
    const { sb } = mockUpsert([{ error: { code: "XX999" } }]);
    const res = await upsertPolicyOverrideRow(sb, "vm", { just_do_it_per_tx: 1, allowed_categories: ["data"] });
    check("upsert: other error → failed", res.ok === false && (res as any).kind === "failed");
  }
  {
    // PGRST204 but row has NO allowed_categories key → retry guard false → no retry → failed
    const { sb, calls } = mockUpsert([{ error: { code: "PGRST204" } }]);
    const res = await upsertPolicyOverrideRow(sb, "vm", { just_do_it_per_tx: 1 });
    check("upsert: PGRST204 w/o cats-key → no retry → failed", res.ok === false && (res as any).kind === "failed" && calls.length === 1);
  }

  // ═══════════════ 4. resolveEffectivePolicy WIRING (decision-change proof) ═══════════════
  const STARTER_CATS = DEFAULT_ALLOWED_CATEGORIES_BY_TIER.starter;
  // W1 — stored band tightening reaches evaluateSpend (just_do_it → ask_first)
  {
    const withOv = await resolveEffectivePolicy(mockRead({ data: { vm_id: "vm", just_do_it_per_tx: 0.5 } }), "vm", "starter");
    const noOv = await resolveEffectivePolicy(mockRead({ data: null }), "vm", "starter");
    check("wiring(bands): resolved bandOverrides = stored", eq(withOv.bandOverrides, { justDoItPerTx: 0.5 }));
    const a = { earned: 100, spent: 0, balance: 10, amount: 0.75, category: "data" as SpendCategory };
    check("wiring(bands): no override → just_do_it", gate("starter", a, noOv) === "just_do_it");
    check("wiring(bands): stored 0.5 tightens → ask_first", gate("starter", a, withOv) === "ask_first");
  }
  // W2 — stored category tightening reaches the gate (removes search from starter default)
  {
    const withOv = await resolveEffectivePolicy(mockRead({ data: { vm_id: "vm", allowed_categories: ["data"] } }), "vm", "starter");
    const noOv = await resolveEffectivePolicy(mockRead({ data: null }), "vm", "starter");
    check("wiring(cats): resolved effective = [data]", eq(withOv.allowedCategories, ["data"]));
    const a = { earned: 100, spent: 0, balance: 10, amount: 0.5, category: "search" as SpendCategory };
    const o1 = gate("starter", a, noOv);
    const o2 = gate("starter", a, withOv);
    check("wiring(cats): no override → search autonomous", o1 === "just_do_it");
    check("wiring(cats): stored [data] blocks search (decision CHANGED, not autonomous)", o2 !== o1 && o2 !== "just_do_it");
  }
  // W3 — a stored "market" override can NEVER widen (market ∉ any tier default → effective [])
  {
    const withOv = await resolveEffectivePolicy(mockRead({ data: { vm_id: "vm", allowed_categories: ["market"] } }), "vm", "starter");
    check("wiring(market): stored [market] → effective [] (can't widen)", eq(withOv.allowedCategories, []));
    const a = { earned: 100, spent: 0, balance: 10, amount: 0.5, category: "data" as SpendCategory };
    check("wiring(market): with effective [] even 'data' is not autonomous", gate("starter", a, withOv) !== "just_do_it");
  }
  // W4 — no override → tier-default behavior (the EMPTY path)
  {
    const noOv = await resolveEffectivePolicy(mockRead({ data: null }), "vm", "starter");
    check("wiring(none): bandOverrides null", noOv.bandOverrides === null);
    check("wiring(none): allowedCategories = starter tier default", eq(noOv.allowedCategories, STARTER_CATS));
    check("wiring(none): data spend within tier → just_do_it", gate("starter", { earned: 100, spent: 0, balance: 10, amount: 0.75, category: "data" }, noOv) === "just_do_it");
  }

  console.log(`\nfrontier-policy-route: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
