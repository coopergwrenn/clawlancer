#!/usr/bin/env tsx
/**
 * Unit + gate-consistency tests for lib/frontier-headroom.ts.
 *
 * Run: npx tsx scripts/_test-frontier-headroom.ts
 * Exits 0 if all pass, 1 on any failure. Pure — no DB / network.
 *
 * The load-bearing property: the headroom the DASHBOARD will show can never lie
 * about what the GATE actually does. So every scenario asserts the headroom AND
 * runs the real gate (evaluateSpend → decideAuthorization, humanApproved=false)
 * at points inside / outside the headroom and checks they agree.
 */

import { autonomousHeadroom } from "../lib/frontier-headroom";
import { evaluateSpend, DEFAULT_BANDS_BY_TIER, type FrontierTier } from "../lib/frontier-policy";
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

/** Run the REAL gate for an autonomous (humanApproved=false), category-allowed spend. */
function gate(
  tier: FrontierTier,
  s: { earned: number; spent: number; balance: number | null; amount: number },
): "just_do_it" | "ask_first" | "deny" {
  const evaluation = evaluateSpend(tier, {
    amountUsd: s.amount,
    spentTodayUsd: s.spent,
    walletBalanceUsd: s.balance,
    privacyModeOn: false,
    counterpartyVerified: true,
    // no category gate in these dollar-dimension tests (category covered elsewhere)
  });
  const standing = { earnedDailyBudgetUsd: s.earned } as CreditStanding;
  return decideAuthorization({
    evaluation,
    standing,
    reserveAwareSpentTodayUsd: s.spent,
    amountUsd: s.amount,
    humanApproved: false,
    categoryKnown: true,
  }).outcome;
}

const STARTER = DEFAULT_BANDS_BY_TIER.starter; // jdt 1/5, never 10/25, minWallet 2

// ── Scenario A: fresh agent — earned budget binds ──
{
  const h = autonomousHeadroom({
    spendEnabled: true,
    standing: { earnedDailyBudgetUsd: 0.1 },
    bands: STARTER,
    spentTodayUsd: 0,
    walletBalanceUsd: 10,
  });
  check("A: effectiveMaxToday = 0.10", h.effectiveMaxTodayUsd === 0.1);
  check("A: binding = earned", h.binding === "earned");
  check("A: gate(0.05) auto", gate("starter", { earned: 0.1, spent: 0, balance: 10, amount: 0.05 }) === "just_do_it");
  check("A: gate(0.10) auto (== earned, ≤)", gate("starter", { earned: 0.1, spent: 0, balance: 10, amount: 0.1 }) === "just_do_it");
  check("A: gate(0.11) asks (over earned)", gate("starter", { earned: 0.1, spent: 0, balance: 10, amount: 0.11 }) === "ask_first");
}

// ── Scenario B: ramped agent — per-purchase ceiling binds the single buy ──
{
  const h = autonomousHeadroom({
    spendEnabled: true,
    standing: { earnedDailyBudgetUsd: 5 },
    bands: STARTER,
    spentTodayUsd: 0,
    walletBalanceUsd: 10,
  });
  check("B: effectiveMaxToday = 5 (aggregate)", h.effectiveMaxTodayUsd === 5);
  check("B: perPurchaseCap = 1 (jdtTx)", h.perPurchaseCapUsd === 1);
  check("B: gate(0.5) auto", gate("starter", { earned: 5, spent: 0, balance: 10, amount: 0.5 }) === "just_do_it");
  check("B: gate(1.0) asks (== jdtTx, strict <)", gate("starter", { earned: 5, spent: 0, balance: 10, amount: 1.0 }) === "ask_first");
  check("B: gate(2) asks (over jdtTx)", gate("starter", { earned: 5, spent: 0, balance: 10, amount: 2 }) === "ask_first");
}

// ── Scenario C: unfunded at the drain floor — wallet binds, nothing autonomous ──
{
  const h = autonomousHeadroom({
    spendEnabled: true,
    standing: { earnedDailyBudgetUsd: 5 },
    bands: STARTER,
    spentTodayUsd: 0,
    walletBalanceUsd: 2, // == minWalletBalance
  });
  check("C: effectiveMaxToday = 0", h.effectiveMaxTodayUsd === 0);
  check("C: walletHeadroom = 0", h.walletHeadroomUsd === 0);
  check("C: binding = wallet", h.binding === "wallet");
  check("C: gate(0.5) denies (drain)", gate("starter", { earned: 5, spent: 0, balance: 2, amount: 0.5 }) === "deny");
}

// ── Scenario D: balance unreadable — never auto-spend blind ──
{
  const h = autonomousHeadroom({
    spendEnabled: true,
    standing: { earnedDailyBudgetUsd: 5 },
    bands: STARTER,
    spentTodayUsd: 0,
    walletBalanceUsd: null,
  });
  check("D: effectiveMaxToday = 0", h.effectiveMaxTodayUsd === 0);
  check("D: binding = balance_unknown", h.binding === "balance_unknown");
  check("D: gate(0.5, null balance) asks", gate("starter", { earned: 5, spent: 0, balance: null, amount: 0.5 }) === "ask_first");
}

// ── Scenario E: opt-in OFF — effective 0, but potential surfaced for "turn on to unlock $X" ──
{
  const h = autonomousHeadroom({
    spendEnabled: false,
    standing: { earnedDailyBudgetUsd: 5 },
    bands: STARTER,
    spentTodayUsd: 0,
    walletBalanceUsd: 10,
  });
  check("E: effectiveMaxToday = 0 (off)", h.effectiveMaxTodayUsd === 0);
  check("E: binding = spend_disabled", h.binding === "spend_disabled");
  check("E: potentialMaxToday = 5 (would-unlock)", h.potentialMaxTodayUsd === 5);
}

// ── Scenario F: partial spend today — daily/earned remaining binds ──
{
  const h = autonomousHeadroom({
    spendEnabled: true,
    standing: { earnedDailyBudgetUsd: 5 },
    bands: STARTER,
    spentTodayUsd: 4.5,
    walletBalanceUsd: 10,
  });
  check("F: earnedRemaining = 0.5", h.earnedRemainingUsd === 0.5);
  check("F: dailyLimitRemaining = 0.5", h.dailyLimitRemainingUsd === 0.5);
  check("F: effectiveMaxToday = 0.5", h.effectiveMaxTodayUsd === 0.5);
  check("F: gate(0.4) auto", gate("starter", { earned: 5, spent: 4.5, balance: 10, amount: 0.4 }) === "just_do_it");
  check("F: gate(0.6) asks (over remaining)", gate("starter", { earned: 5, spent: 4.5, balance: 10, amount: 0.6 }) === "ask_first");
}

console.log(`\nfrontier-headroom: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
