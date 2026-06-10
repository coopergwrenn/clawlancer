/**
 * Frontier per-VM spend-anomaly detection (red-team F5). PURE -- no I/O, fully testable.
 *
 * "An agent spending its human's real money, nobody watching at 3am." `frontier-spend-
 * health` watches the RAILS (settle-failure spike, stuck holds); this watches BEHAVIOR:
 * a single VM spending unusually WITHOUT real human consent. Two world-class principles:
 *
 *   1. CONSENT-GRADE (the novel bit -- there is no reference implementation for this).
 *      Post-F2 every travel booking is session-approved (a human approved it in a browser)
 *      -- that is NOT an anomaly, it is the system working. The risk is UNCONSENTED spend:
 *        - autonomous : the agent decided alone (within its earned budget)
 *        - forgeable  : the raw human_approved bool, which a prompt-injected / token-stolen
 *                       agent can set itself (the exact F2 vector, still live for non-travel)
 *      We alarm ONLY on unconsented $ and EXCLUDE session-approved spend, so a legitimate
 *      human-approved booking spree never pages. (Missing consent_grade on pre-F5 holds is
 *      treated as UNCONSENTED -- fail toward visibility, never miss a real anomaly.)
 *
 *   2. DUAL CONDITION (fintech anti-false-positive, 2026 best practice -- static absolute
 *      rules run 90-95% false positive). An absolute FLOOR (never page below it) AND a
 *      trigger: a single large unconsented spend, OR an unconsented burst (sum + count).
 *      Absolute thresholds today; a per-VM personal baseline (N x the VM's trailing median)
 *      is the documented next evolution, once there is enough volume to have a baseline.
 *
 * The cron (app/api/cron/frontier-spend-anomaly) reads one VM's window rows, calls this,
 * and alerts (6h-deduped) on a flag. dryRun returns the verdict without alerting.
 */

export type ConsentGrade = "session" | "forgeable" | "autonomous" | "unknown";

/** The minimal shape of a frontier_transactions spend row this logic needs. */
export interface AnomalyTxnRow {
  amount_usdc: number | string; // PostgREST returns numeric as string
  status: string; // 'settled' | 'pending' | 'failed' | ...
  created_at: string; // ISO
  metadata?: { consent_grade?: string | null; category?: string | null } | null;
}

export interface AnomalyThresholds {
  /** Look-back window for the velocity signal (ms). */
  windowMs: number;
  /** Fresh-pending holds younger than this still count as committed spend (ms). */
  holdTtlMs: number;
  /** Never alarm when total unconsented spend in the window is below this ($). */
  floorUsd: number;
  /** A SINGLE unconsented spend at/above this ($) flags on its own. */
  singleLargeUsd: number;
  /** A burst: unconsented spend in the window at/above this ($) AND >= burstCount txns. */
  burstSumUsd: number;
  burstCount: number;
}

/** Sane defaults; the cron overrides from env. Calibrated above routine autonomous spend
 *  (starter jdt $1 / pro $5 / power $20) and to catch a forgeable spend near the pro/power
 *  per-tx ceiling, while a quiet VM's small autonomous spends never page. */
export const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds = {
  windowMs: 60 * 60 * 1000, // 1h
  holdTtlMs: 15 * 60 * 1000, // matches HOLD_TTL_MS
  floorUsd: 25,
  singleLargeUsd: 40,
  burstSumUsd: 75,
  burstCount: 3,
};

export function gradeOf(row: AnomalyTxnRow): ConsentGrade {
  const g = row.metadata?.consent_grade;
  if (g === "session" || g === "forgeable" || g === "autonomous") return g;
  return "unknown"; // pre-F5 holds / malformed → treated as unconsented downstream
}

const num = (v: number | string): number => (typeof v === "string" ? parseFloat(v) : v);
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface AnomalyVerdict {
  flagged: boolean;
  /** Stable machine reason for telemetry. */
  reason: "clean" | "single_large_unconsented" | "unconsented_burst";
  /** Unconsented (autonomous + forgeable + unknown), committed (settled + fresh-pending). */
  unconsentedSumUsd: number;
  unconsentedCount: number;
  largestUnconsentedUsd: number;
  /** Consented (session) spend in the window, for context — never contributes to the flag. */
  sessionSumUsd: number;
}

/**
 * Evaluate ONE VM's window of spend rows. A row is "committed" if it is a settled spend in
 * the window, or a FRESH pending hold (younger than holdTtlMs) — the same liveness rule as
 * reserveAwareSpentTodayUsd, so the anomaly view matches the budget view. Among committed
 * spends, the UNCONSENTED ones (grade != session) drive the dual-condition flag.
 */
export function evaluateSpendAnomaly(
  rows: AnomalyTxnRow[],
  nowMs: number,
  t: AnomalyThresholds = DEFAULT_ANOMALY_THRESHOLDS,
): AnomalyVerdict {
  const cutoff = nowMs - t.windowMs;
  let unconsentedSum = 0;
  let unconsentedCount = 0;
  let largest = 0;
  let sessionSum = 0;

  for (const r of rows) {
    const ts = Date.parse(r.created_at);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const committed =
      r.status === "settled" || (r.status === "pending" && nowMs - ts < t.holdTtlMs);
    if (!committed) continue;
    const amt = num(r.amount_usdc);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    if (gradeOf(r) === "session") {
      sessionSum += amt;
      continue; // consented — never an anomaly
    }
    unconsentedSum += amt;
    unconsentedCount += 1;
    if (amt > largest) largest = amt;
  }

  unconsentedSum = round6(unconsentedSum);
  largest = round6(largest);
  sessionSum = round6(sessionSum);

  const base = {
    unconsentedSumUsd: unconsentedSum,
    unconsentedCount,
    largestUnconsentedUsd: largest,
    sessionSumUsd: sessionSum,
  };

  // FLOOR: below this total unconsented spend, never page (dual-condition guard #1).
  if (unconsentedSum < t.floorUsd) {
    return { flagged: false, reason: "clean", ...base };
  }
  // Trigger A: a single large unconsented spend.
  if (largest >= t.singleLargeUsd) {
    return { flagged: true, reason: "single_large_unconsented", ...base };
  }
  // Trigger B: an unconsented burst (sum AND count).
  if (unconsentedSum >= t.burstSumUsd && unconsentedCount >= t.burstCount) {
    return { flagged: true, reason: "unconsented_burst", ...base };
  }
  return { flagged: false, reason: "clean", ...base };
}
