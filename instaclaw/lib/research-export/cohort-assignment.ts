/**
 * Cohort assignment policy for Vendrov's pre-registered experiments.
 *
 * Hard constraints:
 *   1. Deterministic — same wallet always maps to same cohort given
 *      same experiment_id + salt + buckets. Re-running the assignment
 *      script must produce identical assignments.
 *   2. Independent across experiments — the cohort for experiment H1
 *      tells you nothing about the cohort for H2. We salt the hash
 *      per-experiment so the partitions are statistically independent.
 *   3. Approximately uniform — over a large enough pool, each cohort
 *      gets ~equal share. We use SHA-256 (uniform output distribution)
 *      and modulo by bucket count.
 *   4. Manually overridable — Vendrov can hand-assign edge cases. The
 *      auto-assigner respects existing rows in research.cohort_assignments
 *      and never overwrites.
 *
 * Why per-experiment salt (not just experiment_id):
 *   If two experiments both partition into treatment/control by raw
 *   bankr_address parity, the cohorts are PERFECTLY correlated — same
 *   users always end up in "treatment" for both. That nukes the
 *   independence assumption Vendrov's analyses depend on. Adding the
 *   experiment_id as a salt (or as part of the hash input) decorrelates
 *   the assignments.
 *
 * Salt isolation:
 *   We use the experiment_id as the hash salt (deterministic, no
 *   environment dependency, reproducible from the assignment table
 *   alone). For higher-stakes experiments, callers can layer an
 *   additional environment salt (EDGE_COHORT_ASSIGNMENT_SALT) to
 *   prevent adversaries from gaming the assignment by picking their
 *   wallet address to land in the cohort they want. For Edge Esmeralda
 *   2026 the additional salt is optional — the cohort assignment isn't
 *   high-stakes enough that gaming is realistic.
 */

import * as crypto from "node:crypto";

export interface CohortDefinition {
  /** Vendrov's pre-registered experiment slug. Used as hash salt. */
  experiment_id: string;
  /** Ordered list of cohort names. Uniform partition modulo this length. */
  cohorts: string[];
  /** Optional environment salt for additional gaming protection. */
  envSalt?: string;
}

export interface CohortAssignment {
  bankr_wallet: string;
  experiment_id: string;
  cohort: string;
  /** Hex digest of the hash, for audit. */
  audit_hash: string;
  /** Buckets used at assignment time (so re-runs with different counts
   * are detectable). */
  bucket_count: number;
}

/**
 * Compute the cohort for one wallet under one experiment definition.
 * Pure function — no side effects.
 */
export function assignCohort(
  bankrWallet: string,
  def: CohortDefinition,
): CohortAssignment {
  if (def.cohorts.length === 0) {
    throw new Error("CohortDefinition.cohorts must be non-empty");
  }
  // Normalize the wallet address: lowercase, strip whitespace. Bankr
  // wallets are mixed-case in some places (checksummed); we don't want
  // the assignment to flip when the case changes.
  const normalizedWallet = bankrWallet.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalizedWallet)) {
    throw new Error(`bankrWallet must be 0x + 40 hex chars (got ${bankrWallet.slice(0, 12)}...)`);
  }
  const input = `${def.experiment_id}:${normalizedWallet}${def.envSalt ? `:${def.envSalt}` : ""}`;
  const digest = crypto.createHash("sha256").update(input).digest("hex");
  // Use first 8 hex chars (32 bits) for the bucket pick. Plenty of
  // entropy for our cohort counts (<10).
  const bucketIdx = parseInt(digest.slice(0, 8), 16) % def.cohorts.length;
  return {
    bankr_wallet: normalizedWallet,
    experiment_id: def.experiment_id,
    cohort: def.cohorts[bucketIdx],
    audit_hash: digest,
    bucket_count: def.cohorts.length,
  };
}

/**
 * Standard cohort definitions for Edge Esmeralda 2026. Mirror Vendrov's
 * pre-registered hypotheses (H1-H5 from the Edge strategy doc + tactical
 * PRD). Adjust this list with Vendrov before pre-registration locks.
 *
 * Treatment/control split:
 *   - "h1-treatment" / "h1-control" — matching engine on vs off
 *   - "h2-treatment" / "h2-control" — norm-formation experiment
 *   - "h3-treatment" / "h3-control" — Coasean bargaining
 *   - "h4-treatment" / "h4-control" — agent autonomy levels
 *   - "h5-treatment" / "h5-control" — deliberation broadens vs deepens
 *
 * Each experiment is independent (independent hash salts → uncorrelated
 * partitions). One user can be in h1-treatment + h2-control + h3-treatment
 * simultaneously.
 */
export const EE26_EXPERIMENTS: CohortDefinition[] = [
  { experiment_id: "ee26-h1-matching", cohorts: ["h1-treatment", "h1-control"] },
  { experiment_id: "ee26-h2-norms", cohorts: ["h2-treatment", "h2-control"] },
  { experiment_id: "ee26-h3-coasean", cohorts: ["h3-treatment", "h3-control"] },
  { experiment_id: "ee26-h4-autonomy", cohorts: ["h4-treatment", "h4-control"] },
  { experiment_id: "ee26-h5-deliberation", cohorts: ["h5-treatment", "h5-control"] },
];

/**
 * Compute a balance report across all experiments — useful for sanity-
 * checking that the consistent hash is producing approximately even
 * splits.
 */
export function computeBalance(
  wallets: string[],
  experiments: CohortDefinition[] = EE26_EXPERIMENTS,
): Array<{ experiment_id: string; cohort_counts: Record<string, number>; total: number; max_skew_pct: number }> {
  return experiments.map((def) => {
    const counts: Record<string, number> = {};
    for (const c of def.cohorts) counts[c] = 0;
    for (const w of wallets) {
      const a = assignCohort(w, def);
      counts[a.cohort]++;
    }
    const expected = wallets.length / def.cohorts.length;
    const maxDeviation = Math.max(...Object.values(counts).map((c) => Math.abs(c - expected)));
    const max_skew_pct = wallets.length === 0 ? 0 : (maxDeviation / wallets.length) * 100;
    return { experiment_id: def.experiment_id, cohort_counts: counts, total: wallets.length, max_skew_pct };
  });
}
