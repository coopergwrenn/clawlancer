#!/usr/bin/env tsx
/**
 * Rule-31 failure-mode suite for Slice B #1 — the justDoItPerTx ceiling reversal.
 *
 * The change (lib/frontier-policy.ts:clampOverrides): justDoItPerTx flips from
 * tighten-only `min(base, override, neverPerTx)` to allow-raise `min(neverPerTx,
 * override ?? base)` — the per-tx no-ask line becomes USER-RAISABLE up to the hard
 * per-tx ceiling. justDoItPerTx ONLY; no other band moves; the deny line (neverPerTx)
 * is untouched.
 *
 * THE SAFETY CONTRACT this suite proves (audit §1, the load-bearing invariant):
 *   a widened ceiling never auto-spends above the EARNED budget — decideAuthorization
 *   gate 2c is the real, independent bound, so a $10 user ceiling on a $0.10-earned
 *   agent STILL ASKS. Raising the ceiling moves a spend from "asks (over the per-tx
 *   line)" to "asks (over earned)" — never to "auto". It becomes auto only once the
 *   agent has EARNED it. Willingness (user-set ceiling) ≠ reality (earned budget).
 *
 * Covers (spec frontier-slice-b-spec-2026-06-08.md §4 #1 + audit §4 headroom case):
 *   A  clamp semantics  — raise works, capped at neverPerTx, lower still works,
 *                          invalid→base, NO OTHER BAND MOVES, coherence vs lowered cap
 *   B  load-bearing     — raised ceiling + low earned → ask_first(exceeds_earned_budget),
 *                          NOT auto; earned it → autonomous (symmetry); explicit 2c-bypass guard
 *   C  hard deny        — neverPerTx still denies even human-approved, even with a raised ceiling
 *   D  headroom display — a raised ceiling shows min(raised, earned-remaining), not the raw number
 *
 * Pure functions only (no I/O). Run: npx tsx scripts/_test-frontier-ceiling-reversal.ts  (exit 0 = all pass)
 */
import {
  clampOverrides,
  evaluateSpend,
  DEFAULT_BANDS_BY_TIER,
  type PolicyOverrides,
} from "../lib/frontier-policy";
import { decideAuthorization } from "../lib/frontier-authz";
import { autonomousHeadroom } from "../lib/frontier-headroom";
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

const S = DEFAULT_BANDS_BY_TIER.starter; // { justDoItPerTx 1, justDoItPerDay 5, neverPerTx 10, neverPerDay 25, minWalletBalance 2 }

function standing(earned: number): CreditStanding {
  return {
    score: 400,
    level: "audit",
    earnedDailyBudgetUsd: earned,
    factors: { reliability: 0.2, discipline: 0.5, tenure: 0.1, diversity: 0.1, integrity: 1 },
    worldIdVerified: true,
  };
}

/** Run a full spend through the real gate: evaluateSpend (which applies clampOverrides) → decideAuthorization. */
function gate(opts: {
  overrides?: PolicyOverrides | null;
  amount: number;
  earned: number;
  humanApproved?: boolean;
  spentToday?: number;
}) {
  const spent = opts.spentToday ?? 0;
  const evaluation = evaluateSpend("starter", {
    amountUsd: opts.amount,
    spentTodayUsd: spent,
    walletBalanceUsd: 1000, // ample + known → never the drain floor in these cases
    privacyModeOn: false,
    counterpartyVerified: true,
    requireVerifiedCounterparty: false, // skip the verified-counterparty gate
    overrides: opts.overrides ?? null,
    // category omitted → category allowlist gate skipped
  });
  const decision = decideAuthorization({
    evaluation,
    standing: standing(opts.earned),
    reserveAwareSpentTodayUsd: spent,
    amountUsd: opts.amount,
    humanApproved: opts.humanApproved ?? false,
    categoryKnown: true,
  });
  return { evaluation, decision };
}

// ─────────────────────────────────────────────────────────────────────────────
// A — clamp semantics (lib/frontier-policy.ts:clampOverrides directly)
// ─────────────────────────────────────────────────────────────────────────────
check("A1 raise: override justDoItPerTx=10 (starter) → effective 10 (raised to the hard cap)",
  clampOverrides(S, { justDoItPerTx: 10 }).justDoItPerTx === 10);
check("A2 cap: override justDoItPerTx=999 → effective 10 (capped at neverPerTx, never above the deny line)",
  clampOverrides(S, { justDoItPerTx: 999 }).justDoItPerTx === 10);
check("A3 lower still works: override justDoItPerTx=0.5 → effective 0.5 (tighten direction preserved)",
  clampOverrides(S, { justDoItPerTx: 0.5 }).justDoItPerTx === 0.5);
check("A4 invalid: override justDoItPerTx=-3 → falls back to base 1 (never less safe on a bad value)",
  clampOverrides(S, { justDoItPerTx: -3 }).justDoItPerTx === 1);
check("A5 absent: no override → base 1 (unchanged for the 99% with no override)",
  clampOverrides(S, {}).justDoItPerTx === 1);

// A6 — THE "one band changed" proof: raising justDoItPerTx moves NOTHING else.
const c6 = clampOverrides(S, { justDoItPerTx: 10 });
check("A6 no other band moves: neverPerTx unchanged", c6.neverPerTx === S.neverPerTx);
check("A6 no other band moves: neverPerDay unchanged", c6.neverPerDay === S.neverPerDay);
check("A6 no other band moves: minWalletBalance unchanged", c6.minWalletBalance === S.minWalletBalance);
check("A6 no other band moves: justDoItPerDay unchanged (still tighten-only)", c6.justDoItPerDay === S.justDoItPerDay);

check("A7 coherence: raised justDoItPerTx=10 with LOWERED neverPerTx=5 → justDoItPerTx capped at 5",
  clampOverrides(S, { justDoItPerTx: 10, neverPerTx: 5 }).justDoItPerTx === 5);

// ─────────────────────────────────────────────────────────────────────────────
// B — THE LOAD-BEARING SAFETY CONTRACT (full gate composition)
// ─────────────────────────────────────────────────────────────────────────────
// B1 baseline: $3 on a fresh agent asks TODAY (over the default $1 per-tx line).
{
  const { decision } = gate({ amount: 3, earned: 0.1 });
  check("B1 baseline: $3, no raise, earned $0.10 → not authorized (asks)", decision.authorized === false);
  check("B1 baseline: outcome ask_first", decision.outcome === "ask_first");
}
// B2 THE LOAD-BEARING TEST: raise the ceiling to $10 — $3 must STILL ask, now because
// of the EARNED budget (2c), not the per-tx line. The raise did NOT make it auto.
{
  const { evaluation, decision } = gate({ overrides: { justDoItPerTx: 10 }, amount: 3, earned: 0.1 });
  check("B2 raised ceiling lets evaluateSpend return just_do_it ($3 < raised $10)", evaluation.decision === "just_do_it");
  check("B2 LOAD-BEARING: raised $10 ceiling + earned $0.10 + $3 → STILL not authorized", decision.authorized === false);
  check("B2 LOAD-BEARING: it asks for the EARNED reason (gate 2c), not the per-tx line", decision.reason === "exceeds_earned_budget");
  check("B2 LOAD-BEARING: outcome ask_first", decision.outcome === "ask_first");
}
// B3 symmetry: once the agent has EARNED $5/day, the SAME $3 spend under the same
// raised ceiling becomes autonomous. Willingness (ceiling) is constant; reality (earned) moved.
{
  const { decision } = gate({ overrides: { justDoItPerTx: 10 }, amount: 3, earned: 5 });
  check("B3 symmetry: raised $10 ceiling + earned $5 + $3 → autonomous", decision.authorized === true);
  check("B3 symmetry: mode autonomous", decision.mode === "autonomous");
  check("B3 symmetry: reason within_earned_budget", decision.reason === "within_earned_budget");
}
// B4 the regression that matters (audit §1): a 2c bypass. If a future edit ever let a
// raised-ceiling, low-earned, just_do_it spend authorize, THIS flips to true and fails.
{
  const { decision } = gate({ overrides: { justDoItPerTx: 10 }, amount: 4, earned: 0.1 });
  check("B4 2c-bypass guard: raised ceiling + $4 + earned $0.10 → authorized MUST be false", decision.authorized === false);
}

// ─────────────────────────────────────────────────────────────────────────────
// C — the deny line (neverPerTx) is untouched and absolute, even under a raise
// ─────────────────────────────────────────────────────────────────────────────
// C1 human approval cannot bypass the hard per-tx ceiling, and the raise didn't move it.
{
  const { decision } = gate({ overrides: { justDoItPerTx: 10 }, amount: 50, earned: 100, humanApproved: true });
  check("C1 hard deny absolute: $50 > neverPerTx $10, even human-approved → deny", decision.outcome === "deny");
  check("C1 hard deny reason exceeds_per_tx_ceiling", decision.reason === "exceeds_per_tx_ceiling");
}
// C2 an override above neverPerTx cannot widen the deny line: $15 > neverPerTx $10 → deny.
{
  const { decision } = gate({ overrides: { justDoItPerTx: 999 }, amount: 15, earned: 100 });
  check("C2 deny line unmoved: override 999 + $15 spend (> neverPerTx $10) → deny exceeds_per_tx_ceiling",
    decision.outcome === "deny" && decision.reason === "exceeds_per_tx_ceiling");
}

// ─────────────────────────────────────────────────────────────────────────────
// D — headroom display stays EARNED-BOUNDED under a raised ceiling (audit §4 added case)
// ─────────────────────────────────────────────────────────────────────────────
{
  const bands = clampOverrides(S, { justDoItPerTx: 10 }); // raised to 10
  const h = autonomousHeadroom({
    spendEnabled: true,
    standing: { earnedDailyBudgetUsd: 0.1 },
    bands,
    spentTodayUsd: 0,
    walletBalanceUsd: 20,
  });
  check("D1 display-bound: raised ceiling $10, earned $0.10 → perPurchaseCapUsd shows $0.10 (earned-bounded), NOT $10",
    h.perPurchaseCapUsd === 0.1);
  check("D1 display-bound: binding factor is 'earned'", h.binding === "earned");
}
{
  const bands = clampOverrides(S, { justDoItPerTx: 10 });
  const h = autonomousHeadroom({
    spendEnabled: true,
    standing: { earnedDailyBudgetUsd: 5 },
    bands,
    spentTodayUsd: 0,
    walletBalanceUsd: 20,
  });
  check("D2 display symmetry: as earned rises to $5, perPurchaseCapUsd rises to $5 (min(raised $10, earned-bounded $5))",
    h.perPurchaseCapUsd === 5);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
