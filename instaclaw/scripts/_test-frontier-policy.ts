#!/usr/bin/env tsx
/**
 * Unit tests for lib/frontier-policy.ts (the autonomy spend gate).
 *
 * Run: npx tsx scripts/_test-frontier-policy.ts
 * Exits 0 if all pass, 1 on any failure. No DB / network — pure logic.
 *
 * Covers the safety-critical properties (audit risk #2 + Rule 22):
 * boundary semantics, daily-cap chaining, drain guard, privacy mode,
 * unverified counterparty, staker 2x ceilings, unknown-balance downgrade.
 */

import {
  evaluateSpend,
  effectiveBands,
  clampOverrides,
  DEFAULT_BANDS_BY_TIER,
  type FrontierTier,
  type SpendContext,
  type SpendDecision,
} from "../lib/frontier-policy";

let passed = 0;
let failed = 0;

function ok(): SpendContext {
  // A baseline "healthy" context: verified counterparty, privacy off, plenty of balance.
  return {
    amountUsd: 0,
    spentTodayUsd: 0,
    walletBalanceUsd: 10_000,
    privacyModeOn: false,
    counterpartyVerified: true,
  };
}

function expect(
  label: string,
  tier: FrontierTier,
  ctx: SpendContext,
  wantDecision: SpendDecision,
  wantReason?: string,
): void {
  const r = evaluateSpend(tier, ctx);
  const decisionOk = r.decision === wantDecision;
  const reasonOk = wantReason === undefined || r.reason === wantReason;
  if (decisionOk && reasonOk) {
    passed++;
  } else {
    failed++;
    console.error(
      `FAIL: ${label}\n  want decision=${wantDecision}${wantReason ? ` reason=${wantReason}` : ""}\n  got  decision=${r.decision} reason=${r.reason}`,
    );
  }
}

// ── Boundary semantics (Starter: jdt<1/tx,<5/day; ask 1–10; never >10/tx,>25/day) ──
expect("starter $0.50 fresh → just_do_it", "starter", { ...ok(), amountUsd: 0.5 }, "just_do_it");
expect("starter $1.00 (== jdt_tx, not strictly below) → ask_first", "starter", { ...ok(), amountUsd: 1 }, "ask_first");
expect("starter $5 → ask_first", "starter", { ...ok(), amountUsd: 5 }, "ask_first");
expect("starter $10 (== never_tx, not over) → ask_first", "starter", { ...ok(), amountUsd: 10 }, "ask_first");
expect("starter $10.01 (> never_tx) → deny", "starter", { ...ok(), amountUsd: 10.01 }, "deny", "exceeds_per_tx_ceiling");

// ── Daily-cap chaining (the audit-risk-#2 case): many sub-per-tx spends ──
// Starter just-do-it daily is <$5. $0.90 each is individually just_do_it, but
// once today's total would cross the bands the aggregate must gate it.
expect("starter $0.90 with $4.50 already today (agg 5.40 ≥ jdt_day 5) → ask_first", "starter",
  { ...ok(), amountUsd: 0.9, spentTodayUsd: 4.5 }, "ask_first", "within_ask_first_band");
// And once the aggregate crosses the NEVER daily ceiling, deny — cannot chain past it.
expect("starter $0.90 with $24.50 already today (agg 25.40 > never_day 25) → deny", "starter",
  { ...ok(), amountUsd: 0.9, spentTodayUsd: 24.5 }, "deny", "exceeds_daily_ceiling");
expect("starter $0.50 with $24.50 today (agg 25.00 == never_day, not over) → ask_first", "starter",
  { ...ok(), amountUsd: 0.5, spentTodayUsd: 24.5 }, "ask_first");

// ── Drain guard at the flat $0.10 dust floor (#2a, 2026-06-09) ──
expect("2a.1 starter $0.10 spend, balance $0.15 (would leave $0.05 < $0.10 dust floor) → deny", "starter",
  { ...ok(), amountUsd: 0.1, walletBalanceUsd: 0.15 }, "deny", "would_drain_wallet");
expect("2a.2 starter $0.30 spend, balance $0.50 (leaves $0.20 ≥ $0.10; floor must not over-deny) → just_do_it", "starter",
  { ...ok(), amountUsd: 0.3, walletBalanceUsd: 0.5 }, "just_do_it");

// ── Unknown balance never auto-approves ──
expect("starter $0.50 jdt-sized but balance unknown → ask_first (downgrade)", "starter",
  { ...ok(), amountUsd: 0.5, walletBalanceUsd: null }, "ask_first", "just_do_it_but_balance_unknown");
expect("starter $0.50 balance undefined → ask_first", "starter",
  { ...ok(), amountUsd: 0.5, walletBalanceUsd: undefined }, "ask_first", "just_do_it_but_balance_unknown");

// ── Privacy mode → strict read-only (denies even a tiny spend) ──
expect("privacy on denies even $0.10", "power",
  { ...ok(), amountUsd: 0.1, privacyModeOn: true }, "deny", "privacy_mode");

// ── Counterparty trust ──
expect("unverified counterparty (required) → deny", "pro",
  { ...ok(), amountUsd: 1, counterpartyVerified: false }, "deny", "unverified_counterparty");
expect("unverified counterparty but not required → evaluated normally (ask_first @ $1 pro? no, $1<5 jdt)", "pro",
  { ...ok(), amountUsd: 1, counterpartyVerified: false, requireVerifiedCounterparty: false }, "just_do_it");

// ── Staker 2x ceilings ──
// Pro non-staker: never_tx=50. $80 → deny. Staker: never_tx=100 → $80 is ask_first.
expect("pro non-staker $80 (> never_tx 50) → deny", "pro", { ...ok(), amountUsd: 80 }, "deny", "exceeds_per_tx_ceiling");
expect("pro STAKER $80 (never_tx now 100) → ask_first", "pro",
  { ...ok(), amountUsd: 80, isStaker: true }, "ask_first");
// Pro non-staker jdt_tx=5: $4 → just_do_it. Staker jdt_tx=10: $9 → just_do_it.
expect("pro non-staker $9 (>= jdt_tx 5) → ask_first", "pro", { ...ok(), amountUsd: 9 }, "ask_first");
expect("pro STAKER $9 (jdt_tx now 10) → just_do_it", "pro", { ...ok(), amountUsd: 9, isStaker: true }, "just_do_it");

// ── Power tier sanity (jdt<20/tx,<100/day; never >200/tx,>1000/day) ──
expect("power $15 fresh → just_do_it", "power", { ...ok(), amountUsd: 15 }, "just_do_it");
expect("power $150 → ask_first", "power", { ...ok(), amountUsd: 150 }, "ask_first");
expect("power $250 (> never_tx 200) → deny", "power", { ...ok(), amountUsd: 250 }, "deny", "exceeds_per_tx_ceiling");

// ── Invalid inputs ──
expect("zero amount → deny", "starter", { ...ok(), amountUsd: 0 }, "deny", "invalid_amount");
expect("negative amount → deny", "starter", { ...ok(), amountUsd: -5 }, "deny", "invalid_amount");
expect("NaN amount → deny", "starter", { ...ok(), amountUsd: NaN }, "deny", "invalid_amount");
expect("negative spentToday → deny", "starter", { ...ok(), amountUsd: 1, spentTodayUsd: -1 }, "deny", "invalid_spent_today");

// ── effectiveBands math ──
(() => {
  const s = effectiveBands("pro", true);
  const base = DEFAULT_BANDS_BY_TIER.pro;
  const want = base.justDoItPerTx * 2;
  if (s.justDoItPerTx === want && s.minWalletBalance === base.minWalletBalance) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: effectiveBands staker doubling — got jdtTx=${s.justDoItPerTx} minBal=${s.minWalletBalance}`);
  }
})();

// ── clampOverrides (tighten-only) ──
(() => {
  const base = DEFAULT_BANDS_BY_TIER.pro; // jdtTx5 jdtDay25 nvTx50 nvDay200 minBal10
  const t = (label: string, cond: boolean) => { if (cond) passed++; else { failed++; console.error(`FAIL: ${label}`); } };

  // tighten a ceiling down — allowed
  t("override lowers neverPerTx", clampOverrides(base, { neverPerTx: 20 }).neverPerTx === 20);
  // attempt to RAISE a ceiling — ignored (clamped to base)
  t("override cannot raise neverPerTx", clampOverrides(base, { neverPerTx: 999 }).neverPerTx === 50);
  // raise the wallet floor — allowed
  t("override raises minWalletBalance", clampOverrides(base, { minWalletBalance: 40 }).minWalletBalance === 40);
  // #2b floor reversal: the wallet reserve is now USER-LOWERABLE below the tier
  // default, down to 0 ("spend it all"); negative/non-finite still fail safe to base
  // (full coverage in scripts/_test-frontier-floor-reversal.ts).
  t("override below base 0.10 LOWERS the floor (#2b floor reversal)", clampOverrides(base, { minWalletBalance: 0.05 }).minWalletBalance === 0.05);
  t("override 0 sets the floor to 0 (#2b spend-it-all)", clampOverrides(base, { minWalletBalance: 0 }).minWalletBalance === 0);
  t("negative floor override fails safe to base (#2b)", clampOverrides(base, { minWalletBalance: -5 }).minWalletBalance === base.minWalletBalance);
  // coherence: lowering neverPerTx below justDoItPerTx re-coerces jdt down
  const c = clampOverrides(base, { neverPerTx: 3 });
  t("ceiling below jdt re-coerces just_do_it ≤ never (per-tx)", c.justDoItPerTx === 3 && c.neverPerTx === 3);
  const c2 = clampOverrides(base, { neverPerDay: 10 });
  t("ceiling below jdt re-coerces just_do_it ≤ never (daily)", c2.justDoItPerDay === 10 && c2.neverPerDay === 10);
  // invalid override values fall back to base (never less safe)
  t("negative override ignored", clampOverrides(base, { neverPerTx: -5 }).neverPerTx === 50);
  t("NaN override ignored", clampOverrides(base, { minWalletBalance: NaN }).minWalletBalance === 0.1);
  // empty override = base unchanged
  const e = clampOverrides(base, {});
  t("empty override = base", e.neverPerTx === 50 && e.minWalletBalance === 0.1);
})();

// ── evaluateSpend honors overrides end-to-end ──
// A pro user tightens neverPerTx to 20; a $30 spend (under tier's 50, over the
// override's 20) must now deny.
expect(
  "override tightens: pro $30 with neverPerTx=20 → deny",
  "pro",
  { ...ok(), amountUsd: 30, overrides: { neverPerTx: 20 } },
  "deny",
  "exceeds_per_tx_ceiling",
);
// Same spend without the override is allowed (ask_first) — proves the override
// is what flipped it.
expect("no override: pro $30 → ask_first", "pro", { ...ok(), amountUsd: 30 }, "ask_first");
// Raising the floor forces a drain-deny that wouldn't fire at the tier default.
expect(
  "override raises floor: pro $5 leaving $8 (floor 12) → deny",
  "pro",
  { ...ok(), amountUsd: 5, walletBalanceUsd: 13, overrides: { minWalletBalance: 12 } },
  "deny",
  "would_drain_wallet",
);

// ── #2a flat-floor: the $0.10 dust floor flows through evaluateSpend for EVERY tier
//    (pro/power were $10/$25 — these spends were drain-denied pre-#2a, now pass), and the
//    hard ceiling is unaffected by the floor change. ──
expect("2a.3 pro $1 spend, balance $5 (leaves $4 ≥ $0.10; was deny at old $10 floor) → just_do_it", "pro",
  { ...ok(), amountUsd: 1, walletBalanceUsd: 5 }, "just_do_it");
expect("2a.3 power $1 spend, balance $5 (leaves $4 ≥ $0.10; was deny at old $25 floor) → just_do_it", "power",
  { ...ok(), amountUsd: 1, walletBalanceUsd: 5 }, "just_do_it");
expect("2a.4 hard per-tx ceiling unaffected by the floor change: starter $11 > neverPerTx $10 → deny", "starter",
  { ...ok(), amountUsd: 11, walletBalanceUsd: 10_000 }, "deny", "exceeds_per_tx_ceiling");

console.log(`\nfrontier-policy: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
