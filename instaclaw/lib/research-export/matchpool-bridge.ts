/**
 * matchpool_outcomes → research.matchpool_outcomes bridge.
 *
 * Incremental anonymizing sync. Reads operational rows from
 * public.matchpool_outcomes since the last watermark, hashes
 * identifier columns + PII-sweeps free-text, and upserts to
 * research.matchpool_outcomes via the public.research_matchpool_sync
 * RPC. Atomically advances the watermark on success.
 *
 * Architecture decisions documented in the migration header. Quick recap:
 *   - Hash user_ids directly (UUIDs) with salt rather than joining
 *     through bankr wallets. Stable per village, simpler.
 *   - Use the existing anonymize.ts library for the sweep logic — one
 *     SOURCE OF TRUTH for what counts as PII.
 *   - Salt-version stamped on each row so post-rotation joins stay
 *     scoped.
 *   - Cross-schema writes go through public.research_matchpool_sync
 *     (SECURITY DEFINER), same pattern as public.assign_cohort.
 *
 * Called from:
 *   - app/api/cron/research-export-sync/route.ts  (daily Vercel cron)
 *   - scripts/_sync-research-outcomes.ts          (manual trigger)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  hashAgentId,
  sweepString,
  validateSalt,
  type RedactionEvent,
} from "./anonymize";

export interface BridgeSyncOptions {
  /** EDGE_CITY_RESEARCH_SALT — 32+ char random hex held only by InstaClaw. */
  salt: string;
  /** Short version tag (e.g. "ee26-v1"). Stamped on every row for
   * post-rotation joins. */
  saltVersion: string;
  /** Max rows to fetch per run. Defaults to 1000 — enough for the daily
   * cadence at expected village scale, low enough not to blow Vercel's
   * 300s function budget. */
  batchSize?: number;
}

export interface BridgeSyncResult {
  rows_fetched: number;
  rows_upserted: number;
  new_last_synced_at: string;
  prior_last_synced_at: string;
  prior_salt_version: string | null;
  salt_version_changed: boolean;
  total_rows_in_research: number;
  redactions_in_run: number;
  duration_ms: number;
}

// Shape we read from public.matchpool_outcomes.
interface OperationalOutcomeRow {
  outcome_id: string;
  outreach_log_id: string | null;
  intro_id: string | null;
  negotiation_thread_id: string | null;
  request_id: string | null;
  source_user_id: string;
  candidate_user_id: string;
  match_engine: string;
  rrf_score: number | null;
  mutual_score: number | null;
  deliberation_score: number | null;
  agent_action: string | null;
  counterpart_response: string | null;
  human_confirmed: boolean | null;
  meeting_actually_happened: boolean | null;
  rating_post_meeting: number | null;
  rating_source: string | null;
  reason_text: string | null;
  proposed_at: string | null;
  responded_at: string | null;
  met_at: string | null;
  rated_at: string | null;
  post_meeting_prompted_at: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_BATCH_SIZE = 1000;

function hashOptional(id: string | null, salt: string): string | null {
  return id ? hashAgentId(id, salt) : null;
}

/**
 * Transform one operational row into its anonymized research-schema
 * shape. Pure function — no DB calls. The salt is the only input
 * besides the row.
 */
export function anonymizeRow(
  row: OperationalOutcomeRow,
  salt: string,
  saltVersion: string,
): { record: Record<string, unknown>; redactions: RedactionEvent[] } {
  const redactions: RedactionEvent[] = [];

  let reasonSwept: string | null = null;
  if (row.reason_text) {
    const swept = sweepString(row.reason_text, {
      rowId: row.outcome_id,
      column: "reason_text",
    });
    reasonSwept = swept.cleaned;
    redactions.push(...swept.events);
  }

  // Serialize values as strings for JSONB round-trip via the RPC.
  // The RPC casts each one back to its typed column. NULL → empty
  // string sentinel so the RPC's NULLIF(...,'') restores NULL on the
  // server side.
  const toStr = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "true" : "false";
    return String(v);
  };

  return {
    record: {
      outcome_id: row.outcome_id,
      source_agent_id: hashAgentId(row.source_user_id, salt),
      candidate_agent_id: hashAgentId(row.candidate_user_id, salt),
      outreach_log_id_hash: hashOptional(row.outreach_log_id, salt) ?? "",
      intro_id_hash: hashOptional(row.intro_id, salt) ?? "",
      negotiation_thread_id_hash: hashOptional(row.negotiation_thread_id, salt) ?? "",
      request_id_hash: hashOptional(row.request_id, salt) ?? "",
      match_engine: row.match_engine,
      rrf_score: toStr(row.rrf_score),
      mutual_score: toStr(row.mutual_score),
      deliberation_score: toStr(row.deliberation_score),
      agent_action: row.agent_action ?? "",
      counterpart_response: row.counterpart_response ?? "",
      human_confirmed: toStr(row.human_confirmed),
      meeting_actually_happened: toStr(row.meeting_actually_happened),
      rating_post_meeting: toStr(row.rating_post_meeting),
      rating_source: row.rating_source ?? "",
      reason_text_swept: reasonSwept ?? "",
      reason_text_redactions: redactions.length > 0 ? JSON.stringify(redactions) : "",
      proposed_at: toStr(row.proposed_at),
      responded_at: toStr(row.responded_at),
      met_at: toStr(row.met_at),
      rated_at: toStr(row.rated_at),
      post_meeting_prompted_at: toStr(row.post_meeting_prompted_at),
      source_created_at: row.created_at,
      source_updated_at: row.updated_at,
      salt_version: saltVersion,
    },
    redactions,
  };
}

/**
 * Run one sync pass. Reads state, fetches new rows, anonymizes,
 * upserts, advances watermark. Idempotent — re-running with no new
 * rows is a no-op that just updates last_run_at.
 */
export async function runMatchpoolBridgeSync(
  sb: SupabaseClient,
  options: BridgeSyncOptions,
): Promise<BridgeSyncResult> {
  validateSalt(options.salt);
  if (!options.saltVersion || options.saltVersion.length === 0) {
    throw new Error("saltVersion must be non-empty (e.g. 'ee26-v1')");
  }

  const t0 = Date.now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  // 1. Read the prior watermark via the public RPC.
  const { data: stateData, error: stateErr } = await sb.rpc("research_export_state_get", {
    p_source_table: "matchpool_outcomes",
  });
  if (stateErr) {
    throw new Error(`research_export_state_get RPC failed: ${stateErr.message}`);
  }
  const state = (stateData?.[0] ?? {}) as {
    last_synced_at?: string;
    last_synced_count?: number;
    last_salt_version?: string | null;
  };
  const priorLastSyncedAt = state.last_synced_at ?? "1970-01-01T00:00:00Z";
  const priorSaltVersion = state.last_salt_version ?? null;
  const saltVersionChanged = priorSaltVersion !== null && priorSaltVersion !== options.saltVersion;

  // 2. Fetch new/updated rows from public.matchpool_outcomes.
  // Per CLAUDE.md Rule 19 (.select("*")) for safety-critical reads.
  const { data: rowsData, error: rowsErr } = await sb
    .from("matchpool_outcomes")
    .select("*")
    .gt("updated_at", priorLastSyncedAt)
    .order("updated_at", { ascending: true })
    .limit(batchSize);
  if (rowsErr) {
    throw new Error(`matchpool_outcomes fetch failed: ${rowsErr.message}`);
  }
  const rows = (rowsData ?? []) as OperationalOutcomeRow[];

  // If the salt rotated, we should re-sync EVERYTHING because every
  // row's agent_id changes. Detect that here and warn. (We don't
  // auto-trigger a full resync — that's a deliberate operator decision.)
  // For tonight's ship, just flag it; full-resync workflow is a follow-up.

  if (rows.length === 0) {
    // Advance the watermark even on empty — establishes that we ran.
    const newLastSyncedAt = priorLastSyncedAt;
    const { error: emptyErr } = await sb.rpc("research_matchpool_sync", {
      p_rows: [],
      p_new_last_synced_at: newLastSyncedAt,
      p_salt_version: options.saltVersion,
    });
    if (emptyErr) {
      throw new Error(`research_matchpool_sync (empty) RPC failed: ${emptyErr.message}`);
    }
    return {
      rows_fetched: 0,
      rows_upserted: 0,
      new_last_synced_at: newLastSyncedAt,
      prior_last_synced_at: priorLastSyncedAt,
      prior_salt_version: priorSaltVersion,
      salt_version_changed: saltVersionChanged,
      total_rows_in_research: 0,
      redactions_in_run: 0,
      duration_ms: Date.now() - t0,
    };
  }

  // 3. Anonymize each row.
  const anonymized: Array<Record<string, unknown>> = [];
  let totalRedactions = 0;
  for (const row of rows) {
    const out = anonymizeRow(row, options.salt, options.saltVersion);
    anonymized.push(out.record);
    totalRedactions += out.redactions.length;
  }

  // 4. Upsert via the sync RPC (atomic: upsert + watermark advance).
  const newLastSyncedAt = rows[rows.length - 1].updated_at;
  const { data: syncData, error: syncErr } = await sb.rpc("research_matchpool_sync", {
    p_rows: anonymized,
    p_new_last_synced_at: newLastSyncedAt,
    p_salt_version: options.saltVersion,
  });
  if (syncErr) {
    throw new Error(`research_matchpool_sync RPC failed: ${syncErr.message}`);
  }
  const result = (syncData?.[0] ?? {}) as {
    rows_upserted?: number;
    new_last_synced_at?: string;
    state_row_count?: number;
  };

  return {
    rows_fetched: rows.length,
    rows_upserted: Number(result.rows_upserted ?? 0),
    new_last_synced_at: result.new_last_synced_at ?? newLastSyncedAt,
    prior_last_synced_at: priorLastSyncedAt,
    prior_salt_version: priorSaltVersion,
    salt_version_changed: saltVersionChanged,
    total_rows_in_research: Number(result.state_row_count ?? 0),
    redactions_in_run: totalRedactions,
    duration_ms: Date.now() - t0,
  };
}
