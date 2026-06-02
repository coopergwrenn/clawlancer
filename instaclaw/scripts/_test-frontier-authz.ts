#!/usr/bin/env tsx
/**
 * Tests for the W4/W5 pure layers:
 *   - lib/frontier-authz.ts        decideAuthorization (the keystone gate)
 *   - lib/frontier-ledger-db.ts    reserveAwareSpentTodayUsd + toLedgerRow
 *
 * Adversarial where it matters: the earned-budget gate, the human-override
 * boundary, and the self-expiring reserve (authorize-bomb defense).
 * Run: npx tsx scripts/_test-frontier-authz.ts  (exit 0 = all pass)
 */
import { decideAuthorization, type AuthorizationInput } from "../lib/frontier-authz";
import { reserveAwareSpentTodayUsd, toLedgerRow, HOLD_TTL_MS, type FrontierTxnDbRow } from "../lib/frontier-ledger-db";
import { DEFAULT_BANDS_BY_TIER, type SpendDecision, type SpendEvaluation } from "../lib/frontier-policy";
import type { CreditStanding, StandingLevel } from "../lib/frontier-standing";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

const BANDS = DEFAULT_BANDS_BY_TIER.pro;
function ev(decision: SpendDecision, reason = "test_reason"): SpendEvaluation {
  return { decision, reason, effectiveBands: BANDS };
}
function st(earned: number, level: StandingLevel = "assist", score = 600): CreditStanding {
  return {
    score,
    level,
    earnedDailyBudgetUsd: earned,
    factors: { reliability: 0.5, discipline: 0.5, tenure: 0.5, diversity: 0.5, integrity: 1 },
    worldIdVerified: true,
  };
}
function decide(p: Partial<AuthorizationInput>) {
  return decideAuthorization({
    evaluation: ev("just_do_it"),
    standing: st(10),
    reserveAwareSpentTodayUsd: 0,
    amountUsd: 1,
    humanApproved: false,
    categoryKnown: true,
    ...p,
  });
}

// ── Gate 1: hard deny is absolute ──
check("deny → not authorized", decide({ evaluation: ev("deny", "privacy_mode") }).authorized === false);
check("deny → outcome deny + reason passthrough", decide({ evaluation: ev("deny", "privacy_mode") }).reason === "privacy_mode");
check("deny beats human_approved", decide({ evaluation: ev("deny", "exceeds_daily_ceiling"), humanApproved: true }).authorized === false);
check("deny beats human even within budget", decide({ evaluation: ev("deny"), humanApproved: true, amountUsd: 0.01, standing: st(100) }).outcome === "deny");

// ── Gate 3: human in the loop lifts the autonomy gate (not hard denies) ──
check("human + ask_first → authorized", decide({ evaluation: ev("ask_first"), humanApproved: true }).authorized === true);
check("human authorized mode is human_approved", decide({ evaluation: ev("ask_first"), humanApproved: true }).mode === "human_approved");
check("human + over earned budget → authorized (human bypasses earned gate)",
  decide({ evaluation: ev("just_do_it"), humanApproved: true, amountUsd: 100, standing: st(0.1), reserveAwareSpentTodayUsd: 0 }).authorized === true);
check("human + unknown category → authorized (human decided)",
  decide({ evaluation: ev("just_do_it"), humanApproved: true, categoryKnown: false }).authorized === true);

// ── Gate 2: autonomous ──
check("autonomous + ask_first → not authorized", decide({ evaluation: ev("ask_first", "within_ask_first_band") }).authorized === false);
check("autonomous + ask_first → outcome ask_first", decide({ evaluation: ev("ask_first") }).outcome === "ask_first");
check("autonomous + unknown category → ask_first", decide({ categoryKnown: false }).outcome === "ask_first");
check("autonomous + unknown category → reason unknown_category", decide({ categoryKnown: false }).reason === "unknown_category");

// ── THE KEYSTONE: earned budget gates the autonomous spend ──
check("new agent: $1 spend vs $0.10 earned → ask_first",
  decide({ standing: st(0.1, "audit", 430), amountUsd: 1, reserveAwareSpentTodayUsd: 0 }).outcome === "ask_first");
check("new agent over-budget → reason exceeds_earned_budget",
  decide({ standing: st(0.1, "audit"), amountUsd: 1 }).reason === "exceeds_earned_budget");
check("seasoned agent: $1 spend vs $25 earned → autonomous",
  decide({ standing: st(25, "automate", 800), amountUsd: 1 }).authorized === true);
check("autonomous authorize mode is autonomous",
  decide({ standing: st(25), amountUsd: 1 }).mode === "autonomous");
check("autonomous reason within_earned_budget",
  decide({ standing: st(25), amountUsd: 1 }).reason === "within_earned_budget");

// boundary: projected exactly == earned is allowed (check is strictly >)
check("spend exactly to the earned budget → authorized",
  decide({ standing: st(5), amountUsd: 2, reserveAwareSpentTodayUsd: 3 }).authorized === true);
check("one cent over the budget → ask_first",
  decide({ standing: st(5), amountUsd: 2.01, reserveAwareSpentTodayUsd: 3 }).outcome === "ask_first");

// remaining-earned math
{
  const d = decide({ standing: st(10), amountUsd: 3, reserveAwareSpentTodayUsd: 4 });
  check("remainingEarnedAfter = earned - (spent+amount)", Math.abs(d.remainingEarnedAfterUsd - 3) < 1e-9);
  check("earnedDailyBudgetUsd surfaced", d.earnedDailyBudgetUsd === 10);
}

// ════════════════════════════════════════════════════════════════════
// reserveAwareSpentTodayUsd — the self-expiring reserve (authorize-bomb defense)
// ════════════════════════════════════════════════════════════════════
const NOW = 1_800_000_000_000;
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
function r(p: Partial<FrontierTxnDbRow>): FrontierTxnDbRow {
  return {
    direction: "spend", status: "settled", amount_usdc: 1, created_at: minsAgo(1),
    counterparty_vm_id: null, counterparty_address: null, verified_on_chain_at: null, metadata: null, ...p,
  };
}

check("settled spend in window counts",
  reserveAwareSpentTodayUsd([r({ status: "settled", amount_usdc: 2 })], { nowMs: NOW }) === 2);
check("fresh pending hold counts (reserve)",
  reserveAwareSpentTodayUsd([r({ status: "pending", amount_usdc: 3, created_at: minsAgo(5) })], { nowMs: NOW }) === 3);
check("STALE pending hold excluded (self-expires → no authorize-bomb)",
  reserveAwareSpentTodayUsd([r({ status: "pending", amount_usdc: 99, created_at: new Date(NOW - HOLD_TTL_MS - 60_000).toISOString() })], { nowMs: NOW }) === 0);
check("failed excluded", reserveAwareSpentTodayUsd([r({ status: "failed", amount_usdc: 5 })], { nowMs: NOW }) === 0);
check("refunded excluded", reserveAwareSpentTodayUsd([r({ status: "refunded", amount_usdc: 5 })], { nowMs: NOW }) === 0);
check("disputed excluded", reserveAwareSpentTodayUsd([r({ status: "disputed", amount_usdc: 5 })], { nowMs: NOW }) === 0);
check("earn excluded", reserveAwareSpentTodayUsd([r({ direction: "earn", status: "settled", amount_usdc: 50 })], { nowMs: NOW }) === 0);
check("out-of-window settled excluded",
  reserveAwareSpentTodayUsd([r({ status: "settled", amount_usdc: 5, created_at: minsAgo(60 * 25) })], { nowMs: NOW }) === 0);
check("PostgREST string numerics parsed",
  reserveAwareSpentTodayUsd([r({ status: "settled", amount_usdc: "1.500000" as unknown as string })], { nowMs: NOW }) === 1.5);
{
  const rows = [
    r({ status: "settled", amount_usdc: 1.25 }),
    r({ status: "pending", amount_usdc: 0.75, created_at: minsAgo(3) }), // fresh
    r({ status: "pending", amount_usdc: 9, created_at: new Date(NOW - HOLD_TTL_MS - 1).toISOString() }), // stale
    r({ status: "failed", amount_usdc: 4 }),
    r({ direction: "earn", status: "settled", amount_usdc: 100 }),
  ];
  check("mixed reserve sum = settled + fresh-pending only (2.00)", reserveAwareSpentTodayUsd(rows, { nowMs: NOW }) === 2);
}

// ════════════════════════════════════════════════════════════════════
// toLedgerRow — DB → pure LedgerRow
// ════════════════════════════════════════════════════════════════════
{
  const row = toLedgerRow(r({
    direction: "spend", status: "settled", amount_usdc: "0.001000" as unknown as string,
    created_at: new Date(NOW).toISOString(), counterparty_vm_id: "vm-1", counterparty_address: "0xABC",
    verified_on_chain_at: new Date(NOW).toISOString(),
    metadata: { endpoint: "https://x.com/p", tags: ["price", 5, "token"], result_used: true },
  }));
  check("toLedgerRow amount string→number", row.amountUsd === 0.001);
  check("toLedgerRow createdAtMs parsed", row.createdAtMs === NOW);
  check("toLedgerRow endpoint from metadata", row.endpoint === "https://x.com/p");
  check("toLedgerRow tags filtered to strings", row.tags.length === 2 && row.tags[0] === "price");
  check("toLedgerRow result_used", row.resultUsed === true);
  check("toLedgerRow verifiedOnChain", row.verifiedOnChain === true);
  check("toLedgerRow counterparty fields", row.counterpartyVmId === "vm-1" && row.counterpartyAddress === "0xABC");
}
check("toLedgerRow null metadata safe", toLedgerRow(r({ metadata: null })).tags.length === 0);
check("toLedgerRow unknown status → failed", toLedgerRow(r({ status: "weird" })).status === "failed");
check("toLedgerRow missing result_used → false", toLedgerRow(r({ metadata: { endpoint: "x" } })).resultUsed === false);

console.log(`\nfrontier-authz + ledger-db: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
