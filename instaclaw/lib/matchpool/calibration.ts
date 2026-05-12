/**
 * Threshold calibration for the 3-layer matching pipeline.
 *
 * Treats threshold tuning as a binary classification problem:
 *   Positive class: rating_post_meeting >= 4 (substantively valuable meeting)
 *   Negative class: counterpart_response = 'declined'
 *                   OR (meeting_actually_happened = false AND
 *                       counterpart_response NOT IN ('accepted', NULL))
 *
 * For each candidate threshold T, computes precision/recall/F-beta over
 * the labelled outcomes. Recommends argmax(F-beta with beta=0.5) — the
 * precision-weighted optimum, because at a real-world conference a bad
 * match wastes the user's time but a missed match is invisible. We'd
 * rather surface fewer high-quality candidates than more mixed-quality
 * ones.
 *
 * Confidence intervals via Wilson score (better small-sample behaviour
 * than the normal approximation). Sample-size threshold for actionable
 * recommendation: 30 labelled outcomes minimum (rule of thumb for
 * proportion estimation; tightens to 95% CI of ~±15pp at that N).
 *
 * Two predictors supported:
 *   - mutual_score: Layer 1 cutoff (the foundation PRD's mutual_threshold,
 *     default 0.55). Geometric mean of forward × reverse embedding
 *     similarity.
 *   - deliberation_score: Layer 3 cutoff. The agent's per-candidate
 *     LLM judgment, 0..1. Useful for surfacing decisions / dashboard
 *     gating but not used as a hard cutoff today.
 *
 * Outputs both a structured JSON (for the API / dashboard) and a
 * markdown report (for the calibration-report doc archive). Same
 * library; one Source of Truth.
 *
 * Future extensions (deferred — small N today):
 *   - Per-cohort calibration (cohort_tag breakdown)
 *   - Time-windowed (last 24h vs 7d vs all-time)
 *   - Per-engine (match_engine = 'instaclaw' vs 'index')
 */

export type Predictor = "mutual_score" | "deliberation_score";

export interface LabelledOutcome {
  /** Predictor value, 0..1. */
  score: number;
  /** True if rating_post_meeting >= 4. */
  positive: boolean;
}

export interface ThresholdMetrics {
  threshold: number;
  /** True positives — predictor >= threshold AND positive class. */
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  /** TP / (TP+FP). NaN when TP+FP = 0. */
  precision: number;
  /** TP / (TP+FN). NaN when TP+FN = 0. */
  recall: number;
  /** F-beta with caller-specified beta. NaN when both precision and recall NaN. */
  f_beta: number;
}

export interface WilsonInterval {
  /** Point estimate (e.g. precision). */
  point: number;
  /** Lower bound of 95% CI. */
  lower: number;
  /** Upper bound of 95% CI. */
  upper: number;
  /** Sample size used for the estimate. */
  n: number;
}

export interface CalibrationResult {
  predictor: Predictor;
  /** Total labelled samples. */
  n_total: number;
  n_positive: number;
  n_negative: number;
  /** Current production threshold. */
  current_threshold: number;
  /** Metrics at the current threshold. */
  current_metrics: ThresholdMetrics;
  /** Metrics at the recommended threshold. Null if sample too small. */
  recommended_threshold: number | null;
  recommended_metrics: ThresholdMetrics | null;
  /** Wilson CI on precision at the recommended threshold. */
  recommended_precision_ci: WilsonInterval | null;
  /** Sweep across thresholds — for chart rendering. */
  sweep: ThresholdMetrics[];
  /** Minimum sample size needed for actionable recommendation. */
  min_samples_for_recommendation: number;
  /** True if n_total >= min_samples AND recommended differs from current
   * by more than the CI half-width. */
  ready_to_recommend_change: boolean;
  /** Suggested next-step copy for the dashboard. */
  status_message: string;
  computed_at: string;
}

const F_BETA = 0.5; // Precision-weighted (beta < 1 favours precision)
const MIN_SAMPLES_FOR_RECOMMENDATION = 30;
const SWEEP_THRESHOLDS = 21; // 0.00, 0.05, ..., 1.00

export const DEFAULT_THRESHOLDS: Record<Predictor, number> = {
  // Foundation PRD §4 step 5 default.
  mutual_score: 0.55,
  // No explicit deliberation_score threshold ships today — the agent's
  // own ranking acts as the surface gate. 0.5 is a sensible default for
  // "above-average match quality".
  deliberation_score: 0.5,
};

/** Compute precision/recall/F-beta at one threshold. */
export function metricsAtThreshold(
  outcomes: LabelledOutcome[],
  threshold: number,
  beta: number = F_BETA,
): ThresholdMetrics {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const o of outcomes) {
    const above = o.score >= threshold;
    if (above && o.positive) tp++;
    else if (above && !o.positive) fp++;
    else if (!above && !o.positive) tn++;
    else fn++;
  }
  const precision = tp + fp === 0 ? Number.NaN : tp / (tp + fp);
  const recall = tp + fn === 0 ? Number.NaN : tp / (tp + fn);
  let f_beta: number;
  if (Number.isNaN(precision) && Number.isNaN(recall)) {
    f_beta = Number.NaN;
  } else if (Number.isNaN(precision) || Number.isNaN(recall) || (precision === 0 && recall === 0)) {
    f_beta = 0;
  } else {
    const beta_sq = beta * beta;
    f_beta = ((1 + beta_sq) * precision * recall) / (beta_sq * precision + recall);
  }
  return { threshold, tp, fp, tn, fn, precision, recall, f_beta };
}

/** Wilson score interval for a binomial proportion. 95% CI by default. */
export function wilsonInterval(successes: number, trials: number, z: number = 1.96): WilsonInterval {
  if (trials === 0) {
    return { point: Number.NaN, lower: Number.NaN, upper: Number.NaN, n: 0 };
  }
  const phat = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = (phat + (z * z) / (2 * trials)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * trials)) / trials)) / denom;
  return {
    point: phat,
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin),
    n: trials,
  };
}

/** Sweep candidate thresholds and find argmax(F-beta). */
function sweepAndRecommend(
  outcomes: LabelledOutcome[],
  beta: number = F_BETA,
): { sweep: ThresholdMetrics[]; recommended: ThresholdMetrics | null } {
  const sweep: ThresholdMetrics[] = [];
  for (let i = 0; i < SWEEP_THRESHOLDS; i++) {
    const t = i / (SWEEP_THRESHOLDS - 1);
    sweep.push(metricsAtThreshold(outcomes, t, beta));
  }
  // argmax F-beta — tie-break toward higher threshold (favours precision)
  let best: ThresholdMetrics | null = null;
  for (const m of sweep) {
    if (Number.isNaN(m.f_beta)) continue;
    if (best === null || m.f_beta > best.f_beta || (m.f_beta === best.f_beta && m.threshold > best.threshold)) {
      best = m;
    }
  }
  return { sweep, recommended: best };
}

/**
 * Run the full calibration analysis for one predictor.
 * Pure function — pass in labelled outcomes, get a result.
 * Callers in scripts/, app/api/, and lib/ all use this.
 */
export function calibrate(
  predictor: Predictor,
  outcomes: LabelledOutcome[],
  options?: { currentThreshold?: number; beta?: number; minSamples?: number },
): CalibrationResult {
  const current = options?.currentThreshold ?? DEFAULT_THRESHOLDS[predictor];
  const beta = options?.beta ?? F_BETA;
  const minSamples = options?.minSamples ?? MIN_SAMPLES_FOR_RECOMMENDATION;

  const n_total = outcomes.length;
  const n_positive = outcomes.filter((o) => o.positive).length;
  const n_negative = n_total - n_positive;

  const currentMetrics = metricsAtThreshold(outcomes, current, beta);
  const { sweep, recommended } = sweepAndRecommend(outcomes, beta);

  const precisionCi = recommended
    ? wilsonInterval(recommended.tp, recommended.tp + recommended.fp)
    : null;

  // "Ready to recommend a change" requires three conditions:
  //   1. Sample size >= min threshold.
  //   2. Recommended differs from current by more than the CI half-width on precision.
  //   3. Recommended has at least 5 TPs (so we're not recommending based on a fluke).
  let ready = false;
  if (
    recommended &&
    precisionCi &&
    n_total >= minSamples &&
    recommended.tp >= 5
  ) {
    const halfWidth = (precisionCi.upper - precisionCi.lower) / 2;
    const delta = Math.abs(recommended.threshold - current);
    ready = delta > halfWidth;
  }

  let status_message: string;
  if (n_total < minSamples) {
    const need = minSamples - n_total;
    status_message = n_total === 0
      ? `No rated meetings yet. Calibration deferred until Edge data arrives. Need ${minSamples} rated outcomes for first recommendation.`
      : `${n_total}/${minSamples} rated outcomes collected. Need ${need} more before recommendation.`;
  } else if (!recommended) {
    status_message = `${n_total} rated outcomes, but no valid threshold found (likely all-positive or all-negative cohort).`;
  } else if (!ready) {
    status_message = `Current threshold (${current.toFixed(2)}) is statistically indistinguishable from recommended (${recommended.threshold.toFixed(2)}). No change suggested.`;
  } else {
    const direction = recommended.threshold > current ? "raise" : "lower";
    status_message = `Recommend ${direction} ${predictor} threshold from ${current.toFixed(2)} to ${recommended.threshold.toFixed(2)} (precision ${(recommended.precision * 100).toFixed(0)}%, 95% CI ${(precisionCi!.lower * 100).toFixed(0)}-${(precisionCi!.upper * 100).toFixed(0)}%, n=${n_total}).`;
  }

  return {
    predictor,
    n_total,
    n_positive,
    n_negative,
    current_threshold: current,
    current_metrics: currentMetrics,
    recommended_threshold: recommended?.threshold ?? null,
    recommended_metrics: recommended,
    recommended_precision_ci: precisionCi,
    sweep,
    min_samples_for_recommendation: minSamples,
    ready_to_recommend_change: ready,
    status_message,
    computed_at: new Date().toISOString(),
  };
}

/**
 * Format the result as a markdown report for `docs/calibration-reports/`.
 * Useful for archiving snapshots over time. Same data as JSON; just
 * human-readable.
 */
export function formatMarkdownReport(results: CalibrationResult[]): string {
  const lines: string[] = [];
  lines.push(`# Matching pipeline calibration report`);
  lines.push(``);
  lines.push(`**Computed at:** ${results[0]?.computed_at ?? new Date().toISOString()}`);
  lines.push(``);
  for (const r of results) {
    lines.push(`## ${r.predictor}`);
    lines.push(``);
    lines.push(`- Sample size: **${r.n_total}** rated outcomes (${r.n_positive} positive / ${r.n_negative} negative)`);
    lines.push(`- Current threshold: **${r.current_threshold.toFixed(2)}**`);
    lines.push(`  - Precision at current: ${Number.isNaN(r.current_metrics.precision) ? "—" : (r.current_metrics.precision * 100).toFixed(1) + "%"}  (TP=${r.current_metrics.tp}, FP=${r.current_metrics.fp})`);
    lines.push(`  - Recall at current: ${Number.isNaN(r.current_metrics.recall) ? "—" : (r.current_metrics.recall * 100).toFixed(1) + "%"}  (FN=${r.current_metrics.fn})`);
    if (r.recommended_threshold !== null && r.recommended_metrics) {
      lines.push(`- Recommended threshold: **${r.recommended_threshold.toFixed(2)}**`);
      lines.push(`  - Precision: ${(r.recommended_metrics.precision * 100).toFixed(1)}%  (95% CI ${(r.recommended_precision_ci!.lower * 100).toFixed(1)}–${(r.recommended_precision_ci!.upper * 100).toFixed(1)}%)`);
      lines.push(`  - Recall: ${(r.recommended_metrics.recall * 100).toFixed(1)}%`);
      lines.push(`  - F${(F_BETA).toFixed(1)}-score: ${r.recommended_metrics.f_beta.toFixed(3)}`);
    } else {
      lines.push(`- Recommended threshold: **—** (insufficient signal)`);
    }
    lines.push(``);
    lines.push(`**Status:** ${r.status_message}`);
    lines.push(``);
    lines.push(`### Threshold sweep`);
    lines.push(``);
    lines.push(`| Threshold | TP | FP | FN | Precision | Recall | F${F_BETA.toFixed(1)} |`);
    lines.push(`|---|---|---|---|---|---|---|`);
    for (const m of r.sweep) {
      const p = Number.isNaN(m.precision) ? "—" : (m.precision * 100).toFixed(0) + "%";
      const rcl = Number.isNaN(m.recall) ? "—" : (m.recall * 100).toFixed(0) + "%";
      const f = Number.isNaN(m.f_beta) ? "—" : m.f_beta.toFixed(2);
      const star = r.recommended_metrics && m.threshold === r.recommended_metrics.threshold ? " ⭐" : "";
      lines.push(`| ${m.threshold.toFixed(2)}${star} | ${m.tp} | ${m.fp} | ${m.fn} | ${p} | ${rcl} | ${f} |`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}
