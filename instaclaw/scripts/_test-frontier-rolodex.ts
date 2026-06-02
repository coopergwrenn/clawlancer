#!/usr/bin/env tsx
/**
 * Tests for lib/frontier-rolodex.ts — Thompson-sampling supplier selection.
 * Uses a SEEDED deterministic RNG (mulberry32) so the bandit is reproducible.
 * Covers: budget filtering, cold-start (base + fleet prior), exploit-known-good,
 * explore-the-unknown, and the unified Bazaar/fleet candidate shape.
 * Run: npx tsx scripts/_test-frontier-rolodex.ts  (exit 0 = all pass)
 */
import { posteriorFor, sampleBeta, selectSupplier, type SupplierCandidate, type FleetPrior } from "../lib/frontier-rolodex";
import type { SupplierStat } from "../lib/frontier-ledger";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${label}`); }
}

/** mulberry32 — deterministic, seedable PRNG in [0,1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stat(p: Partial<SupplierStat>): SupplierStat {
  return { supplierId: "x", capability: "data", successes: 0, failures: 0, avgCostUsd: 0.01, lastUsedAtMs: 0, internal: false, ...p };
}

// ── posteriorFor: layering base + fleet + own ──
{
  const { alpha, beta } = posteriorFor("s|data", {});
  check("base prior Beta(1,1)", alpha === 1 && beta === 1);
}
{
  const fleet = new Map<string, FleetPrior>([["s|data", { alpha: 4, beta: 1 }]]);
  const own = new Map<string, SupplierStat>([["s|data", stat({ successes: 5, failures: 2 })]]);
  const { alpha, beta } = posteriorFor("s|data", { fleetPriorBySupplier: fleet, statsBySupplier: own });
  check("posterior = base + fleet + own (alpha)", alpha === 1 + 4 + 5);
  check("posterior = base + fleet + own (beta)", beta === 1 + 1 + 2);
}

// ── sampleBeta: mean is approximately alpha/(alpha+beta) over many draws ──
{
  const rng = mulberry32(42);
  let sum = 0;
  const N = 5000;
  for (let i = 0; i < N; i++) sum += sampleBeta(8, 2, rng);
  const mean = sum / N;
  check("sampleBeta mean ≈ 0.8 (±0.03)", Math.abs(mean - 0.8) < 0.03);
}
{
  const rng = mulberry32(7);
  let inRange = true;
  for (let i = 0; i < 1000; i++) {
    const x = sampleBeta(2, 5, rng);
    if (x < 0 || x > 1) inRange = false;
  }
  check("sampleBeta always in [0,1]", inRange);
}

// ── budget filtering (budgeted bandit) ──
{
  const cands: SupplierCandidate[] = [
    { supplierId: "cheap", capability: "data", priceUsd: 0.01 },
    { supplierId: "pricey", capability: "data", priceUsd: 5.0 },
  ];
  const res = selectSupplier(cands, { remainingBudgetUsd: 0.5, rng: mulberry32(1) });
  check("over-budget candidate filtered out", res.ranked.length === 1 && res.ranked[0].candidate.supplierId === "cheap");
}
{
  const res = selectSupplier([{ supplierId: "x", capability: "data", priceUsd: 9.99 }], { remainingBudgetUsd: 1.0, rng: mulberry32(1) });
  check("none affordable → null + reason", res.choice === null && res.reason === "none_within_budget");
}
{
  const res = selectSupplier([], { remainingBudgetUsd: 100, rng: mulberry32(1) });
  check("no candidates → null + reason", res.choice === null && res.reason === "no_candidates");
}

// ── EXPLOIT: a proven supplier (own strong history) wins the majority of rounds ──
{
  const cands: SupplierCandidate[] = [
    { supplierId: "proven", capability: "data", priceUsd: 0.01 },
    { supplierId: "unknown", capability: "data", priceUsd: 0.01 },
  ];
  const own = new Map<string, SupplierStat>([["proven|data", stat({ supplierId: "proven", successes: 40, failures: 1 })]]);
  let provenWins = 0;
  const rng = mulberry32(123);
  for (let i = 0; i < 400; i++) {
    const res = selectSupplier(cands, { remainingBudgetUsd: 1, statsBySupplier: own, rng });
    if (res.choice?.supplierId === "proven") provenWins++;
  }
  check("exploit: proven supplier wins >75% of rounds", provenWins / 400 > 0.75);
  check("exploit: but still explores unknown sometimes (<100%)", provenWins < 400);
}

// ── COLD START: fleet prior steers a brand-new agent toward the fleet-trusted supplier ──
{
  const cands: SupplierCandidate[] = [
    { supplierId: "fleet-trusted", capability: "search", priceUsd: 0.01 },
    { supplierId: "fleet-unknown", capability: "search", priceUsd: 0.01 },
  ];
  const fleet = new Map<string, FleetPrior>([["fleet-trusted|search", { alpha: 30, beta: 1 }]]);
  let trustedWins = 0;
  const rng = mulberry32(999);
  for (let i = 0; i < 400; i++) {
    const res = selectSupplier(cands, { remainingBudgetUsd: 1, fleetPriorBySupplier: fleet, rng });
    if (res.choice?.supplierId === "fleet-trusted") trustedWins++;
  }
  check("cold-start: fleet prior steers majority to trusted supplier (the moat)", trustedWins / 400 > 0.7);
}

// ── cost-anchoring tiebreak: equal reliability → cheaper preferred on average ──
{
  // both blind (base prior only) → identical posteriors; cost penalty should favor cheap over many draws
  const cands: SupplierCandidate[] = [
    { supplierId: "cheap", capability: "data", priceUsd: 0.10 },
    { supplierId: "expensive", capability: "data", priceUsd: 0.90 },
  ];
  let cheapWins = 0;
  const rng = mulberry32(555);
  for (let i = 0; i < 600; i++) {
    const res = selectSupplier(cands, { remainingBudgetUsd: 1.0, rng });
    if (res.choice?.supplierId === "cheap") cheapWins++;
  }
  check("cost-anchoring: cheaper wins >50% when reliability is equal", cheapWins / 600 > 0.5);
}

// ── ranked output present for the "compared N suppliers" UX ──
{
  const cands: SupplierCandidate[] = [
    { supplierId: "a", capability: "data", priceUsd: 0.01 },
    { supplierId: "b", capability: "data", priceUsd: 0.02 },
    { supplierId: "c", capability: "data", priceUsd: 0.03 },
  ];
  const res = selectSupplier(cands, { remainingBudgetUsd: 1, rng: mulberry32(3) });
  check("ranked lists all affordable, sorted desc by score", res.ranked.length === 3 && res.ranked[0].score >= res.ranked[2].score);
  check("choice equals top-ranked", res.choice?.supplierId === res.ranked[0].candidate.supplierId);
}

console.log(`\nfrontier-rolodex: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
