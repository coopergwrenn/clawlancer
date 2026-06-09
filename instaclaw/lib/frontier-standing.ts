/**
 * Frontier — the credit-standing engine (PRD §7.3 + §8.3). THE keystone.
 *
 * One pure function over the integrity-filtered track record (frontier-ledger)
 * produces BOTH projections of an agent's economic standing:
 *   - the EXTERNAL score (300–850, FICO-for-agents) — public trust, what others read
 *   - the INTERNAL earned daily budget — the autonomy governor, what WE let it spend
 * They are one truth (the agent's standing) with two faces. Merged from the former
 * separate budget + score engines (§8.3 taste fix) so they can never drift.
 *
 * FICO-for-Agents factor weights (§7.3): settlement reliability 35%, budget
 * discipline 30%, tenure 15%, activity diversity 10%, velocity/anomaly 10%.
 * World-ID-verified is a hard cap: unverified agents cannot rise above "audit".
 *
 * The earned budget implements graduated autonomy / the Rule-28 solution (§1
 * Invention 1): starts at $0.10/day, grows with GOOD decisions (§7.3.2), decays
 * on waste/disputes, ceilinged by the agent's level and the tier's pre-approved
 * daily band (and the staker 2x via effectiveBands). It is the elegant answer to
 * "the agent refuses to spend": the agent EXERCISES an autonomy it earned.
 *
 * PURE + deterministic (caller passes nowMs). Tests: scripts/_test-frontier-standing.ts.
 */

import { effectiveBands, type FrontierTier, type PolicyOverrides } from "./frontier-policy";
import type { TrackRecord } from "./frontier-ledger";

export type StandingLevel = "audit" | "assist" | "automate";

export interface StandingFactors {
  reliability: number; // 0..1 (35%)
  discipline: number; // 0..1 (30%)
  tenure: number; // 0..1 (15%)
  diversity: number; // 0..1 (10%)
  integrity: number; // 0..1 (10%) — velocity/anomaly (1 = clean)
}

export interface CreditStanding {
  /** FICO-familiar 300–850. */
  score: number;
  level: StandingLevel;
  /** The internal autonomy governor — USD/day the agent may spend right now. */
  earnedDailyBudgetUsd: number;
  /** Per-factor 0..1 breakdown — drives the dashboard "why your score is X" (§7.6). */
  factors: StandingFactors;
  worldIdVerified: boolean;
  /**
   * Velocity-anomaly flag (frontier-ledger TrackRecord.anomalyFlag), surfaced
   * explicitly so the authorization gate (frontier-authz Gate 2e, Slice B #5b) can
   * read it DIRECTLY rather than inferring it from the integrity score factor — a
   * money gate must not silently change which spends trip the anomaly-ask if
   * computeFactors' encoding ever changes. Read-only passthrough: does not affect
   * score, level, budget, or factors. Optional: prod (creditStanding) always sets
   * it; absent ⇒ the gate treats the agent as clean (conservative — no added friction).
   */
  anomalyFlag?: boolean;
}

export interface StandingOptions {
  nowMs: number;
  isStaker?: boolean;
  overrides?: PolicyOverrides | null;
}

const SCORE_FLOOR = 300;
const SCORE_RANGE = 550; // 300..850
const UNVERIFIED_CAP = 500; // §7.3: unverified agents capped low
const BUDGET_FLOOR = 0.1; // $0.10/day starting autonomy

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const sat = (x: number, k: number) => 1 - Math.exp(-Math.max(0, x) / k); // saturating 0→1

function computeFactors(tr: TrackRecord, nowMs: number): StandingFactors {
  // 1. Settlement reliability (35%): rep-weighted success rate × volume confidence.
  const attempts = tr.qualifyingSettlements + tr.failures + tr.disputes;
  const rate = attempts > 0 ? tr.qualifyingSettlements / attempts : 0;
  const volumeConfidence = sat(tr.weightedSettlements, 20); // ~20 weighted settles ≈ 0.63
  const reliability = clamp01(rate * volumeConfidence);

  // 2. Budget discipline (30%): fraction of decisions that were NOT wasteful/disputed/drains.
  const decisions = tr.goodDecisions + tr.wastedOrDisputed;
  const discipline = decisions > 0 ? clamp01(1 - (tr.wastedOrDisputed + tr.drainEvents) / decisions) : 0.5;

  // 3. Tenure (15%): saturating in days (~30d ≈ 0.63, ~90d ≈ 0.95).
  const tenureDays = tr.firstActivityAtMs ? Math.max(0, (nowMs - tr.firstActivityAtMs) / 86_400_000) : 0;
  const tenure = sat(tenureDays, 30);

  // 4. Activity diversity (10%): distinct counterparties + categories + two-sidedness.
  const diversity = clamp01(
    Math.min(1, tr.distinctCounterparties / 5) * 0.5 +
      Math.min(1, tr.distinctCategories / 3) * 0.3 +
      (tr.earns && tr.spends ? 0.2 : 0),
  );

  // 5. Velocity / anomaly (10%): clean = 1, anomaly = sharply penalized.
  const integrity = tr.anomalyFlag ? 0.15 : 1;

  return { reliability, discipline, tenure, diversity, integrity };
}

/**
 * Compute an agent's credit standing — score, level, and earned daily budget —
 * from its integrity-filtered track record.
 */
export function creditStanding(tr: TrackRecord, tier: FrontierTier, opts: StandingOptions): CreditStanding {
  const f = computeFactors(tr, opts.nowMs);

  let score =
    SCORE_FLOOR +
    SCORE_RANGE * (0.35 * f.reliability + 0.3 * f.discipline + 0.15 * f.tenure + 0.1 * f.diversity + 0.1 * f.integrity);
  score = Math.round(Math.max(SCORE_FLOOR, Math.min(850, score)));

  // World-ID gate: unverified agents are capped low and cannot leave "audit".
  if (!tr.worldIdVerified) score = Math.min(score, UNVERIFIED_CAP);

  const level: StandingLevel =
    !tr.worldIdVerified || score < 550 ? "audit" : score < 700 ? "assist" : "automate";

  // Earned daily budget — graduated autonomy.
  const tierCap = effectiveBands(tier, opts.isStaker ?? false, opts.overrides ?? null).justDoItPerDay;
  const levelCeilFrac = level === "automate" ? 1.0 : level === "assist" ? 0.6 : 0.2;
  const cap = Math.max(BUDGET_FLOOR, tierCap * levelCeilFrac);
  // Progress from good decisions, set back by waste/disputes.
  const earnProgress = sat(tr.goodDecisions, 50); // ~50 good decisions ≈ 0.63 of the way
  const totalDecisions = tr.goodDecisions + tr.wastedOrDisputed;
  const wasteFrac = totalDecisions > 0 ? tr.wastedOrDisputed / totalDecisions : 0;
  const netProgress = clamp01(earnProgress - wasteFrac);
  const earnedDailyBudgetUsd = Math.round((BUDGET_FLOOR + (cap - BUDGET_FLOOR) * netProgress) * 100) / 100;

  return {
    score,
    level,
    earnedDailyBudgetUsd: Math.max(BUDGET_FLOOR, Math.min(cap, earnedDailyBudgetUsd)),
    factors: f,
    worldIdVerified: tr.worldIdVerified,
    anomalyFlag: tr.anomalyFlag,
  };
}
