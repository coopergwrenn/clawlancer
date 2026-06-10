#!/usr/bin/env tsx
/**
 * Tests for lib/frontier-spend-anomaly.ts (red-team F5, per-VM spend anomaly).
 *
 * Failure-mode-first: the consent-grading that PREVENTS false positives (a legit
 * session-approved booking spree must NOT page), the dual-condition floor/trigger,
 * liveness (stale holds / failed / out-of-window excluded), fail-toward-visibility on
 * missing grade, boundaries. Run: npx tsx scripts/_test-frontier-spend-anomaly.ts
 */
import {
  evaluateSpendAnomaly,
  gradeOf,
  DEFAULT_ANOMALY_THRESHOLDS as T,
  type AnomalyTxnRow,
} from "../lib/frontier-spend-anomaly";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

const NOW = 1_900_000_000_000;
const fresh = new Date(NOW - 60_000).toISOString(); // 1 min ago — in window, fresh pending
const old = new Date(NOW - 2 * 60 * 60 * 1000).toISOString(); // 2h ago — outside 1h window
function row(amt: number, grade: string | null, status = "settled", created = fresh): AnomalyTxnRow {
  return { amount_usdc: amt, status, created_at: created, metadata: grade === null ? {} : { consent_grade: grade } };
}

// ── consent-grading: the false-positive killer ──
// A legitimate session-approved booking spree must NEVER page (this is the whole point).
check("5x $200 SESSION travel → clean (consent excluded)",
  evaluateSpendAnomaly([row(200, "session"), row(200, "session"), row(200, "session"), row(200, "session"), row(200, "session")], NOW).flagged === false);
check("session spree → sessionSum tracked, unconsented 0",
  evaluateSpendAnomaly([row(200, "session"), row(200, "session")], NOW).unconsentedSumUsd === 0);
// one forgeable spend hidden in a session spree → flagged on the forgeable one only.
check("session $1000 + one forgeable $45 → flagged single_large (grading isolates the risk)",
  evaluateSpendAnomaly([row(500, "session"), row(500, "session"), row(45, "forgeable")], NOW).reason === "single_large_unconsented");
check("…and sessionSum excluded from the unconsented total",
  evaluateSpendAnomaly([row(500, "session"), row(45, "forgeable")], NOW).unconsentedSumUsd === 45);

// ── single large unconsented ──
check("$40 forgeable (== singleLarge) → flagged",
  evaluateSpendAnomaly([row(40, "forgeable")], NOW).flagged === true);
check("$40 forgeable → reason single_large_unconsented",
  evaluateSpendAnomaly([row(40, "forgeable")], NOW).reason === "single_large_unconsented");
check("$50 autonomous → flagged (autonomous is unconsented too)",
  evaluateSpendAnomaly([row(50, "autonomous")], NOW).flagged === true);
check("$39.99 forgeable (just under singleLarge, over floor) → NOT single-flagged → clean",
  evaluateSpendAnomaly([row(39.99, "forgeable")], NOW).flagged === false);

// ── floor: never page below it ──
check("$20 forgeable (below $25 floor) → clean",
  evaluateSpendAnomaly([row(20, "forgeable")], NOW).flagged === false);
check("$24.99 forgeable (just below floor) → clean",
  evaluateSpendAnomaly([row(24.99, "forgeable")], NOW).flagged === false);

// ── burst: sum AND count ──
check("3x $30 forgeable = $90 (>= burstSum $75, count 3) → flagged unconsented_burst",
  evaluateSpendAnomaly([row(30, "forgeable"), row(30, "forgeable"), row(30, "forgeable")], NOW).reason === "unconsented_burst");
check("2x $40 forgeable → single_large wins before burst (largest >= singleLarge)",
  evaluateSpendAnomaly([row(40, "forgeable"), row(40, "forgeable")], NOW).reason === "single_large_unconsented");
check("8x $10 forgeable = $80 (>= $75, count 8) → flagged burst",
  evaluateSpendAnomaly(Array.from({ length: 8 }, () => row(10, "forgeable")), NOW).reason === "unconsented_burst");
check("2x $30 forgeable = $60 (count 2 < 3, and < burstSum) → clean",
  evaluateSpendAnomaly([row(30, "forgeable"), row(30, "forgeable")], NOW).flagged === false);
check("3x $30 but $90 sum, count exactly 3 → burst (count boundary inclusive)",
  evaluateSpendAnomaly([row(30, "forgeable"), row(30, "forgeable"), row(30, "forgeable")], NOW).unconsentedCount === 3);

// ── fail-toward-visibility: missing/unknown grade counts as unconsented ──
check("$50 with NO consent_grade (pre-F5 hold) → flagged (treated unconsented)",
  evaluateSpendAnomaly([row(50, null)], NOW).flagged === true);
check("gradeOf missing → unknown", gradeOf(row(1, null)) === "unknown");
check("gradeOf garbage → unknown", gradeOf({ amount_usdc: 1, status: "settled", created_at: fresh, metadata: { consent_grade: "bogus" } }) === "unknown");

// ── liveness: only committed, in-window spends count ──
check("stale pending hold (older than holdTtl) → excluded",
  evaluateSpendAnomaly([{ amount_usdc: 100, status: "pending", created_at: new Date(NOW - 20 * 60 * 1000).toISOString(), metadata: { consent_grade: "forgeable" } }], NOW).flagged === false);
check("FRESH pending hold (1 min) → counts",
  evaluateSpendAnomaly([{ amount_usdc: 100, status: "pending", created_at: fresh, metadata: { consent_grade: "forgeable" } }], NOW).flagged === true);
check("failed spend → excluded (not committed)",
  evaluateSpendAnomaly([row(100, "forgeable", "failed")], NOW).flagged === false);
check("refunded spend → excluded",
  evaluateSpendAnomaly([row(100, "forgeable", "refunded")], NOW).flagged === false);
check("out-of-window settled spend → excluded",
  evaluateSpendAnomaly([row(100, "forgeable", "settled", old)], NOW).flagged === false);
check("amount as string (PostgREST) → parsed",
  evaluateSpendAnomaly([{ amount_usdc: "45.000000", status: "settled", created_at: fresh, metadata: { consent_grade: "forgeable" } }], NOW).flagged === true);

// ── empty / all-session → clean ──
check("no rows → clean", evaluateSpendAnomaly([], NOW).flagged === false);
check("only session → clean regardless of size",
  evaluateSpendAnomaly([row(5000, "session")], NOW).flagged === false);

console.log(`\nfrontier-spend-anomaly: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
