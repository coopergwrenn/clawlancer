/**
 * Loads matchpool_outcomes from Supabase and turns it into labelled
 * outcomes for the calibration library. Shared between
 * scripts/_calibrate-thresholds.ts (offline) and
 * app/api/match/v1/calibration/route.ts (live dashboard data).
 *
 * Labelling decisions (codified here so they don't drift):
 *
 *   Positive class (TRUE):
 *     rating_post_meeting >= 4
 *
 *   Negative class (FALSE):
 *     counterpart_response = 'declined'
 *       OR (meeting_actually_happened = false AND
 *           counterpart_response NOT IN ('accepted', 'countered'))
 *
 *   Excluded (null label, dropped from analysis):
 *     - counterpart_response = 'no_reply' (we don't know if it would
 *       have been valuable — the receiver simply didn't engage)
 *     - rating_post_meeting null AND meeting_actually_happened null AND
 *       counterpart_response IS NULL OR 'accepted' (intermediate state;
 *       outcome not yet observed)
 *     - rating_post_meeting in [1..3] — ambiguous middle ground;
 *       neither clearly valuable nor clearly declined
 *
 * Per CLAUDE.md Rule 19: uses .select("*") for safety-critical reads.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { calibrate, type CalibrationResult, type LabelledOutcome, type Predictor } from "./calibration";

type OutcomeRow = {
  outcome_id: string;
  mutual_score: number | null;
  deliberation_score: number | null;
  counterpart_response: string | null;
  meeting_actually_happened: boolean | null;
  rating_post_meeting: number | null;
  match_engine: string;
};

export interface CalibrationFetchOptions {
  /** Optionally filter by match_engine for engine-specific calibration. */
  matchEngine?: "instaclaw" | "index";
  /** Optionally filter to outcomes created after this ISO timestamp. */
  since?: string;
}

/**
 * Classify one outcome row into positive / negative / null.
 * Returns null if the row should be excluded from calibration.
 */
function classifyOutcome(row: OutcomeRow): boolean | null {
  if (row.rating_post_meeting !== null) {
    if (row.rating_post_meeting >= 4) return true;
    if (row.rating_post_meeting <= 2) return false;
    return null; // 3 = ambiguous middle ground
  }
  if (row.counterpart_response === "declined") return false;
  if (
    row.meeting_actually_happened === false &&
    row.counterpart_response !== "accepted" &&
    row.counterpart_response !== "countered"
  ) {
    return false;
  }
  return null;
}

export async function fetchLabelledOutcomes(
  supabase: SupabaseClient,
  options: CalibrationFetchOptions = {},
): Promise<{
  mutual: LabelledOutcome[];
  deliberation: LabelledOutcome[];
  total_rows: number;
  excluded_rows: number;
}> {
  let query = supabase.from("matchpool_outcomes").select("*");
  if (options.matchEngine) {
    query = query.eq("match_engine", options.matchEngine);
  }
  if (options.since) {
    query = query.gte("created_at", options.since);
  }
  const { data, error } = await query;
  if (error) throw new Error(`fetchLabelledOutcomes: ${error.message}`);
  const rows = (data ?? []) as OutcomeRow[];

  const mutual: LabelledOutcome[] = [];
  const deliberation: LabelledOutcome[] = [];
  let excluded = 0;
  for (const row of rows) {
    const label = classifyOutcome(row);
    if (label === null) {
      excluded++;
      continue;
    }
    if (row.mutual_score !== null) {
      mutual.push({ score: row.mutual_score, positive: label });
    }
    if (row.deliberation_score !== null) {
      deliberation.push({ score: row.deliberation_score, positive: label });
    }
  }
  return { mutual, deliberation, total_rows: rows.length, excluded_rows: excluded };
}

/**
 * Run calibration for both predictors against current production data.
 * Returns the structured result the API endpoint serves and the script
 * formats as markdown.
 */
export async function runCalibration(
  supabase: SupabaseClient,
  options: CalibrationFetchOptions = {},
): Promise<{
  results: CalibrationResult[];
  total_rows: number;
  excluded_rows: number;
}> {
  const { mutual, deliberation, total_rows, excluded_rows } = await fetchLabelledOutcomes(
    supabase,
    options,
  );
  const results: CalibrationResult[] = [
    calibrate("mutual_score" as Predictor, mutual),
    calibrate("deliberation_score" as Predictor, deliberation),
  ];
  return { results, total_rows, excluded_rows };
}
