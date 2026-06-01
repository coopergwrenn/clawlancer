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

// ── Drain guard (floor enforced regardless of band) ──
expect("starter $0.50 jdt-sized but balance $2.40 (would leave $1.90 < $2 floor) → deny", "starter",
  { ...ok(), amountUsd: 0.5, walletBalanceUsd: 2.4 }, "deny", "would_drain_wallet");
expect("starter $0.50 with balance exactly $2.50 (leaves $2.00 == floor, ok) → just_do_it", "starter",
  { ...ok(), amountUsd: 0.5, walletBalanceUsd: 2.5 }, "just_do_it");

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

console.log(`\nfrontier-policy: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
