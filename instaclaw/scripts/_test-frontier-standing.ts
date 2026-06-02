#!/usr/bin/env tsx
/**
 * Tests for lib/frontier-standing.ts — the credit-standing engine (score + earned budget).
 * Covers the graduated-autonomy loop + the World-ID cap + the integrity-driven decay.
 * Run: npx tsx scripts/_test-frontier-standing.ts  (exit 0 = all pass)
 */
import { creditStanding } from "../lib/frontier-standing";
import type { TrackRecord } from "../lib/frontier-ledger";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function tr(p: Partial<TrackRecord>): TrackRecord {
  return {
    qualifyingSettlements: 0, weightedSettlements: 0, failures: 0, disputes: 0, drainEvents: 0,
    firstActivityAtMs: null, distinctCounterparties: 0, distinctCategories: 0, earns: false, spends: false,
    newCounterpartiesInWindow: 0, anomalyFlag: false, worldIdVerified: true,
    goodDecisions: 0, wastedOrDisputed: 0, spentTodayUsd: 0, earnedTodayUsd: 0, ...p,
  };
}
const opt = { nowMs: NOW };

// ── New verified agent: low level, floor budget ──
{
  const s = creditStanding(tr({ worldIdVerified: true }), "starter", opt);
  check("new agent → audit level", s.level === "audit");
  check("new agent → floor budget $0.10", Math.abs(s.earnedDailyBudgetUsd - 0.1) < 1e-6);
  check("new agent score below assist threshold", s.score < 550);
}

// ── Unverified agent: capped at 500, audit, regardless of history ──
{
  const seasoned = tr({
    qualifyingSettlements: 100, weightedSettlements: 100, goodDecisions: 100,
    distinctCounterparties: 10, distinctCategories: 4, earns: true, spends: true,
    firstActivityAtMs: NOW - 120 * DAY, worldIdVerified: false,
  });
  const s = creditStanding(seasoned, "power", opt);
  check("unverified capped at 500", s.score <= 500);
  check("unverified stuck at audit", s.level === "audit");
  check("unverified budget capped low (audit ceiling)", s.earnedDailyBudgetUsd <= 100 * 0.2 + 1e-6);
}

// ── Seasoned, verified, clean: high score, automate, budget near tier cap ──
{
  const seasoned = tr({
    qualifyingSettlements: 100, weightedSettlements: 100, failures: 1, goodDecisions: 100, wastedOrDisputed: 1,
    distinctCounterparties: 10, distinctCategories: 4, earns: true, spends: true,
    firstActivityAtMs: NOW - 120 * DAY, worldIdVerified: true,
  });
  const s = creditStanding(seasoned, "power", opt);
  check("seasoned → automate", s.level === "automate");
  check("seasoned → high score (>=750)", s.score >= 750);
  check("seasoned power budget grows toward cap (>$50)", s.earnedDailyBudgetUsd > 50);
  check("seasoned budget never exceeds tier just-do-it-per-day (100)", s.earnedDailyBudgetUsd <= 100);
}

// ── Dispute-heavy agent: reliability + discipline tank → lower score & budget ──
{
  const good = tr({ qualifyingSettlements: 50, weightedSettlements: 50, goodDecisions: 50, distinctCounterparties: 8, distinctCategories: 3, earns: true, spends: true, firstActivityAtMs: NOW - 60 * DAY });
  const bad = tr({ qualifyingSettlements: 50, weightedSettlements: 50, disputes: 40, goodDecisions: 50, wastedOrDisputed: 40, distinctCounterparties: 8, distinctCategories: 3, earns: true, spends: true, firstActivityAtMs: NOW - 60 * DAY });
  const sg = creditStanding(good, "pro", opt);
  const sb = creditStanding(bad, "pro", opt);
  check("disputes lower the score", sb.score < sg.score);
  check("disputes decay the earned budget", sb.earnedDailyBudgetUsd < sg.earnedDailyBudgetUsd);
}

// ── Anomaly flag sharply penalizes the integrity factor ──
{
  const base = tr({ qualifyingSettlements: 30, weightedSettlements: 30, goodDecisions: 30, distinctCounterparties: 6, distinctCategories: 3, earns: true, spends: true, firstActivityAtMs: NOW - 40 * DAY });
  const clean = creditStanding({ ...base, anomalyFlag: false }, "pro", opt);
  const flagged = creditStanding({ ...base, anomalyFlag: true }, "pro", opt);
  check("anomaly flag lowers score", flagged.score < clean.score);
}

// ── Earned budget is monotonic in good decisions, decayed by waste ──
{
  const few = creditStanding(tr({ qualifyingSettlements: 5, weightedSettlements: 5, goodDecisions: 5, distinctCounterparties: 5, distinctCategories: 3, earns: true, spends: true, firstActivityAtMs: NOW - 40 * DAY, worldIdVerified: true }), "pro", opt);
  const many = creditStanding(tr({ qualifyingSettlements: 80, weightedSettlements: 80, goodDecisions: 80, distinctCounterparties: 8, distinctCategories: 3, earns: true, spends: true, firstActivityAtMs: NOW - 90 * DAY, worldIdVerified: true }), "pro", opt);
  check("more good decisions → >= budget", many.earnedDailyBudgetUsd >= few.earnedDailyBudgetUsd);
  const wasteful = creditStanding(tr({ qualifyingSettlements: 80, weightedSettlements: 80, goodDecisions: 40, wastedOrDisputed: 40, distinctCounterparties: 8, distinctCategories: 3, earns: true, spends: true, firstActivityAtMs: NOW - 90 * DAY, worldIdVerified: true }), "pro", opt);
  check("waste decays budget vs all-good", wasteful.earnedDailyBudgetUsd < many.earnedDailyBudgetUsd);
}

// ── Factors are all within [0,1] ──
{
  const s = creditStanding(tr({ qualifyingSettlements: 10, weightedSettlements: 10, goodDecisions: 10, distinctCounterparties: 5, distinctCategories: 2, earns: true, spends: true, firstActivityAtMs: NOW - 20 * DAY }), "pro", opt);
  const f = s.factors;
  const inRange = [f.reliability, f.discipline, f.tenure, f.diversity, f.integrity].every((x) => x >= 0 && x <= 1);
  check("all factors in [0,1]", inRange);
  check("score in [300,850]", s.score >= 300 && s.score <= 850);
}

console.log(`\nfrontier-standing: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
