#!/usr/bin/env tsx
/**
 * Rule-31 failure-mode suite for Slice B #5b — the velocity-anomaly ask.
 *
 * The change (two files):
 *   - lib/frontier-standing.ts: surface `CreditStanding.anomalyFlag` — an explicit
 *     boolean threaded from frontier-ledger `TrackRecord.anomalyFlag`. Read-only
 *     passthrough; no score / level / budget / factors change.
 *   - lib/frontier-authz.ts: new Gate 2e, placed strictly BETWEEN 2c (the
 *     earned-budget keystone) and 2d (the autonomous fallthrough):
 *       if (standing.anomalyFlag === true) → ask_first (reason velocity_anomaly).
 *
 * THE ADDITIVE-ONLY CONTRACT this suite proves (the quality bar):
 *   #5b can ONLY turn an otherwise-autonomous just_do_it into an ask_first (raise
 *   friction) — never the reverse. It CANNOT widen a deny (Gate 1 is upstream),
 *   CANNOT bypass gate 2c (2e is downstream AND has zero authorize-returns), and is
 *   BYTE-IDENTICAL for any non-anomalous agent (anomalyFlag !== true).
 *
 * Covers spec frontier-slice-b-spec-2026-06-08.md §4 #5b (5b.1–5b.4) + the
 * 2c-priority downstream proof (5b.5) + the non-anomalous byte-identical sweep
 * (5b.6) + the optional-field conservative default (5b.7) + the zero-authorize
 * invariant (5b.8).
 *
 * Pure functions only (no I/O). Run: npx tsx scripts/_test-frontier-anomaly-ask.ts  (exit 0 = all pass)
 */
import { decideAuthorization, type AuthorizationInput } from "../lib/frontier-authz";
import { DEFAULT_BANDS_BY_TIER, type SpendDecision, type SpendEvaluation } from "../lib/frontier-policy";
import type { CreditStanding, StandingLevel } from "../lib/frontier-standing";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

const BANDS = DEFAULT_BANDS_BY_TIER.pro;
function ev(decision: SpendDecision, reason = "test_reason"): SpendEvaluation {
  return { decision, reason, effectiveBands: BANDS };
}

/**
 * Build a CreditStanding. `anomaly` undefined → the field is OMITTED entirely
 * (the realistic "unset / old caller" shape), which the gate must treat as clean.
 * `factors.integrity` is set consistently (anomaly ? 0.15 : 1) for realism, but the
 * gate reads `anomalyFlag`, NOT the integrity factor — that's the whole point of #5b.
 */
function standing(earned: number, anomaly?: boolean, level: StandingLevel = "assist"): CreditStanding {
  const baseStanding = {
    score: 600,
    level,
    earnedDailyBudgetUsd: earned,
    factors: { reliability: 0.5, discipline: 0.5, tenure: 0.5, diversity: 0.5, integrity: anomaly ? 0.15 : 1 },
    worldIdVerified: true,
  };
  return anomaly === undefined ? baseStanding : { ...baseStanding, anomalyFlag: anomaly };
}

/** Default path = otherwise-autonomous (just_do_it eval, known category, ¬human, within earned). */
function decide(p: Partial<AuthorizationInput>) {
  return decideAuthorization({
    evaluation: ev("just_do_it"),
    standing: standing(10, false),
    reserveAwareSpentTodayUsd: 0,
    amountUsd: 1,
    humanApproved: false,
    categoryKnown: true,
    ...p,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b.1 — LOAD-BEARING: anomaly + otherwise-autonomous → ask_first, never auto
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ standing: standing(10, true), amountUsd: 3 }); // $3 well within $10 earned
  check("5b.1 LOAD-BEARING: anomaly + within-budget autonomous spend → NOT authorized", r.authorized === false);
  check("5b.1 outcome ask_first", r.outcome === "ask_first");
  check("5b.1 reason velocity_anomaly (within budget — so NOT exceeds_earned_budget)", r.reason === "velocity_anomaly");
  check("5b.1 mode null (anomaly never produces autonomous)", r.mode === null);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b.2 — clean agent, same spend → autonomous (byte-identical to pre-#5b)
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ standing: standing(10, false), amountUsd: 3 });
  check("5b.2 clean + within-budget → authorized autonomous", r.authorized === true);
  check("5b.2 mode autonomous", r.mode === "autonomous");
  check("5b.2 reason within_earned_budget", r.reason === "within_earned_budget");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b.3 — anomaly + humanApproved → auto (Gate 3 lifts, upstream of 2e)
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ standing: standing(10, true), amountUsd: 3, humanApproved: true });
  check("5b.3 anomaly + human → authorized (anomaly never blocks a human-approved spend)", r.authorized === true);
  check("5b.3 mode human_approved", r.mode === "human_approved");
  check("5b.3 reason human_approved", r.reason === "human_approved");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b.4 — anomaly + hard deny → deny (Gate 1 absolute, upstream of 2e)
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ standing: standing(10, true), evaluation: ev("deny", "privacy_mode"), amountUsd: 3 });
  check("5b.4 anomaly + deny eval → deny (anomaly cannot lift a hard deny)", r.outcome === "deny");
  check("5b.4 deny reason passthrough", r.reason === "privacy_mode");
  check("5b.4 not authorized", r.authorized === false);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b.5 — 2c-PRIORITY / downstream proof: anomaly + OVER budget → 2c reason wins
//        (proves 2e sits DOWNSTREAM of 2c — it never replaces or bypasses it)
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ standing: standing(0.1, true), amountUsd: 3 }); // $3 > $0.10 earned
  check("5b.5 anomaly + over-budget → ask_first", r.outcome === "ask_first");
  check("5b.5 reason exceeds_earned_budget (2c fires FIRST; 2e is downstream)", r.reason === "exceeds_earned_budget");
  check("5b.5 not authorized (2e can never bypass 2c)", r.authorized === false);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b.6 — NON-ANOMALOUS BYTE-IDENTICAL SWEEP (anomaly off ⇒ every gate unchanged)
// ─────────────────────────────────────────────────────────────────────────────
check("5b.6a clean deny eval → deny", decide({ evaluation: ev("deny", "x") }).outcome === "deny");
check("5b.6b clean ask_first eval → ask_first", decide({ evaluation: ev("ask_first", "within_ask_first_band") }).outcome === "ask_first");
check("5b.6c clean unknown category → ask_first unknown_category", decide({ categoryKnown: false }).reason === "unknown_category");
check("5b.6d clean over-budget → ask_first exceeds_earned_budget", decide({ standing: standing(0.1, false), amountUsd: 3 }).reason === "exceeds_earned_budget");
check("5b.6e clean within-budget → autonomous within_earned_budget", (() => { const r = decide({ standing: standing(10, false), amountUsd: 3 }); return r.mode === "autonomous" && r.reason === "within_earned_budget"; })());
check("5b.6f clean human → human_approved", decide({ humanApproved: true }).mode === "human_approved");

// ─────────────────────────────────────────────────────────────────────────────
// 5b.7 — anomalyFlag ABSENT (field omitted) → treated as clean (conservative optional default)
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ standing: standing(10), amountUsd: 3 }); // anomaly omitted entirely
  check("5b.7 absent anomalyFlag → autonomous (undefined ⇒ clean, the conservative default)",
    r.authorized === true && r.mode === "autonomous");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b.8 — INVARIANT: Gate 2e has ZERO authorize-returns. Even with huge earned
//        headroom, an anomalous spend can never come back authorized/autonomous.
// ─────────────────────────────────────────────────────────────────────────────
{
  const r = decide({ standing: standing(100, true), amountUsd: 1 }); // trivially within $100 earned
  check("5b.8 INVARIANT: anomaly + deeply-within-budget → STILL ask_first, never authorized",
    r.authorized === false && r.outcome === "ask_first" && r.mode === null && r.reason === "velocity_anomaly");
}

// ─────────────────────────────────────────────────────────────────────────────
// 5b.9 + 5b.10 — DECOUPLING (guards the exact property that justified Option B):
// the gate MUST follow anomalyFlag, NOT factors.integrity. standing() normally couples
// them; here we deliberately MISMATCH. If the gate were ever reverted to read
// `factors.integrity < 1`, EXACTLY these two cases flip and fail — verified against a
// temp-reverted gate (the other 24 still pass because they couple the two).
// ─────────────────────────────────────────────────────────────────────────────
function standingMismatch(anomalyFlag: boolean, integrity: number): CreditStanding {
  return {
    score: 600,
    level: "assist",
    earnedDailyBudgetUsd: 10,
    factors: { reliability: 0.5, discipline: 0.5, tenure: 0.5, diversity: 0.5, integrity },
    worldIdVerified: true,
    anomalyFlag,
  };
}
{
  // anomalyFlag=false but integrity=0.15 (anomalous-LOOKING score). Gate follows anomalyFlag → autonomous.
  const r = decide({ standing: standingMismatch(false, 0.15), amountUsd: 3 });
  check("5b.9 DECOUPLE: anomalyFlag=false WHILE integrity=0.15 → autonomous (gate reads anomalyFlag, IGNORES integrity)",
    r.authorized === true && r.mode === "autonomous");
}
{
  // anomalyFlag=true but integrity=1 (clean-LOOKING score). Gate follows anomalyFlag → ask_first.
  const r = decide({ standing: standingMismatch(true, 1), amountUsd: 3 });
  check("5b.10 DECOUPLE: anomalyFlag=true WHILE integrity=1 → ask_first velocity_anomaly (gate reads anomalyFlag, IGNORES integrity)",
    r.authorized === false && r.outcome === "ask_first" && r.reason === "velocity_anomaly");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
