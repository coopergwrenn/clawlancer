/**
 * Frontier — the supplier rolodex (PRD §1 Invention 2). Pure.
 *
 * The agent's self-built, compounding supplier intelligence: given the capabilities
 * it could buy and what it knows about each supplier, pick WHO to hire. This is a
 * BUDGETED MULTI-ARMED BANDIT solved with Thompson sampling (the exact formalism,
 * logarithmic regret): mostly exploit the best-known supplier, occasionally explore
 * a new one — always within budget. Spending provably improves over time.
 *
 * The posterior for each (supplier, capability) is a Beta over success probability,
 * built from THREE layers:
 *   1. base prior Beta(1,1) — Laplace smoothing (uniform; max exploration when blind)
 *   2. FLEET prior — the sybil-resistant fleet graph's belief about this supplier
 *      (the moat: a brand-new agent inherits the whole fleet's experience on day one)
 *   3. the agent's OWN history (successes/failures) from its ledger/gbrain rolodex
 * SupplierStat is the sufficient statistic — there is no separately-stored posterior
 * to drift; it is recomputed from the ledger each selection (one source of truth).
 *
 * PURE: RNG is injected (default Math.random) so selection is deterministically
 * testable. Tests: scripts/_test-frontier-rolodex.ts.
 */

import type { SpendCategory } from "./frontier-policy";
import type { SupplierStat } from "./frontier-ledger";

/** A discovered, payable option (from the Bazaar, or a fleet agent's offering). */
export interface SupplierCandidate {
  supplierId: string;
  capability: SpendCategory;
  priceUsd: number;
  /** display/debug only */
  endpoint?: string;
  description?: string;
}

/** A fleet-graph prior: the network's belief about a supplier (sybil-resistant). */
export interface FleetPrior {
  /** pseudo-successes / pseudo-failures the fleet has observed (already trust-weighted). */
  alpha: number;
  beta: number;
}

export interface SelectOptions {
  /** The agent's OWN per-(supplier,capability) stats (from frontier-ledger). */
  statsBySupplier?: Map<string, SupplierStat>; // key: `${supplierId}|${capability}`
  /** Fleet-graph priors (the moat) for cold-start. Key: `${supplierId}|${capability}`. */
  fleetPriorBySupplier?: Map<string, FleetPrior>;
  /** Remaining daily budget — candidates above it are unaffordable (budgeted bandit). */
  remainingBudgetUsd: number;
  /** Injected uniform RNG in [0,1). Default Math.random. Pass a seeded RNG in tests. */
  rng?: () => number;
}

export interface RankedCandidate {
  candidate: SupplierCandidate;
  alpha: number;
  beta: number;
  /** posterior mean success prob (for display — NOT the selection basis). */
  meanSuccess: number;
  /** the Thompson-sampled draw used for selection this round. */
  sampledTheta: number;
  /** final selection score (sampledTheta with a mild cost-efficiency adjustment). */
  score: number;
}

export interface SelectResult {
  choice: SupplierCandidate | null;
  reason: string;
  ranked: RankedCandidate[]; // all affordable candidates, ranked — for the "compared N, picked X" UX
}

const BASE_ALPHA = 1;
const BASE_BETA = 1;

/** Beta posterior params for a (supplier, capability): base + fleet prior + own history. */
export function posteriorFor(key: string, opts: Pick<SelectOptions, "statsBySupplier" | "fleetPriorBySupplier">): { alpha: number; beta: number } {
  let alpha = BASE_ALPHA;
  let beta = BASE_BETA;
  const fp = opts.fleetPriorBySupplier?.get(key);
  if (fp) {
    alpha += Math.max(0, fp.alpha);
    beta += Math.max(0, fp.beta);
  }
  const own = opts.statsBySupplier?.get(key);
  if (own) {
    alpha += Math.max(0, own.successes);
    beta += Math.max(0, own.failures);
  }
  return { alpha, beta };
}

// ── Beta sampler via two Gammas (Marsaglia–Tsang), normal via Box–Muller. Pure; uses injected rng. ──
function sampleNormal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function sampleGamma(k: number, rng: () => number): number {
  if (k < 1) {
    // boost: Gamma(k) = Gamma(k+1) * U^(1/k)
    const u = rng();
    return sampleGamma(1 + k, rng) * Math.pow(u === 0 ? 1e-12 : u, 1 / k);
  }
  const d = k - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 64; i++) {
    let x = 0;
    let vv = 0;
    do {
      x = sampleNormal(rng);
      vv = 1 + c * x;
    } while (vv <= 0);
    vv = vv * vv * vv;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * vv;
    if (Math.log(u) < 0.5 * x * x + d * (1 - vv + Math.log(vv))) return d * vv;
  }
  return d; // fallback (extremely rare)
}
export function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  const s = x + y;
  return s > 0 ? x / s : 0.5;
}

/**
 * Pick which supplier to hire for a capability via Thompson sampling, within budget.
 * Returns the choice + the full ranked list (for the "I compared N suppliers" UX).
 */
export function selectSupplier(candidates: SupplierCandidate[], opts: SelectOptions): SelectResult {
  const rng = opts.rng ?? Math.random;
  const affordable = candidates.filter((c) => c.priceUsd <= opts.remainingBudgetUsd && c.priceUsd >= 0);
  if (affordable.length === 0) {
    return {
      choice: null,
      reason: candidates.length === 0 ? "no_candidates" : "none_within_budget",
      ranked: [],
    };
  }

  const ranked: RankedCandidate[] = affordable.map((candidate) => {
    const key = `${candidate.supplierId}|${candidate.capability}`;
    const { alpha, beta } = posteriorFor(key, opts);
    const sampledTheta = sampleBeta(alpha, beta, rng);
    // Reliability dominates; among similar reliability, prefer the cheaper supplier
    // (budgeted bandit: same capability value, minimize cost). Mild, bounded penalty.
    const costPenalty = Math.min(0.4, (candidate.priceUsd / Math.max(1e-9, opts.remainingBudgetUsd)) * 0.4);
    const score = sampledTheta * (1 - costPenalty);
    return { candidate, alpha, beta, meanSuccess: alpha / (alpha + beta), sampledTheta, score };
  });

  ranked.sort((a, b) => b.score - a.score);
  return { choice: ranked[0].candidate, reason: "thompson_selected", ranked };
}
