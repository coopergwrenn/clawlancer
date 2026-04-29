/**
 * EE26 Research Export Pipeline — orchestrator.
 *
 * One function: `runResearchExport()`. Pulls all 5 research tables,
 * anonymizes, runs PII sweep on free-text columns, writes per-table
 * Parquet/CSV files, and writes a manifest + redaction-review log.
 *
 * Designed to be called from:
 *   - The CLI script (scripts/_export-research-data.ts)
 *   - A Vercel cron route (future, not in v0.1.0)
 *   - An ad-hoc admin endpoint (future)
 *
 * The pipeline is deterministic for a given (input data, salt). Repeat
 * runs produce identical output.
 */

import * as crypto from "node:crypto";
import * as path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  hashAgentId,
  sweepStringArray,
  sweepString,
  validateSalt,
  type RedactionEvent,
} from "./anonymize";
import {
  extractAgentSignals,
  extractMatchOutcomes,
  extractBriefingOutcomes,
  extractGovernanceEvents,
  extractCohortAssignments,
  type DateRange,
} from "./extractors";
import {
  PIPELINE_VERSION,
  RESEARCH_TABLES,
  SCHEMA_VERSION,
  type ExportAgentSignal,
  type ExportBriefingOutcome,
  type ExportCohortAssignment,
  type ExportGovernanceEvent,
  type ExportManifest,
  type ExportMatchOutcome,
  type ResearchTableName,
  type SourceAgentSignal,
  type SourceBriefingOutcome,
  type SourceCohortAssignment,
  type SourceGovernanceEvent,
  type SourceMatchOutcome,
} from "./schemas";
import {
  writeCsv,
  writeManifest,
  writeParquetOrFallback,
  writeRedactionLog,
  type Row,
} from "./writers";

export interface RunOptions {
  supabase: SupabaseClient;
  /** Required. Held only by InstaClaw, rotated post-village. */
  salt: string;
  /**
   * Short tag identifying the salt version (e.g. "ee26-v1"). Recorded
   * in the manifest so future analysts can correlate exports that
   * used the same agent_id mapping.
   */
  saltVersion: string;
  /** Where output files go. Per-export subdirectory created underneath. */
  outputDir: string;
  /** Output format. Default 'csv'. */
  format?: "csv" | "parquet";
  /** Optional date filter applied to each table's primary timestamp column. */
  dateRange?: DateRange;
  /** Console output mode. Default 'normal'. */
  verbose?: boolean;
}

export interface RunResult {
  exportId: string;
  outputPath: string;
  manifest: ExportManifest;
  rowCounts: Record<ResearchTableName, number>;
  redactionCounts: Record<ResearchTableName, number>;
  totalRedactions: number;
}

/** Generate a per-export id like `ee26-export-2026-04-29T16-30-45-abc123`. */
function generateExportId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = crypto.randomBytes(3).toString("hex");
  return `ee26-export-${ts}-${rand}`;
}

// ─── Per-table anonymizers ───────────────────────────────────────────

function anonymizeAgentSignal(
  source: SourceAgentSignal,
  salt: string,
  events: RedactionEvent[]
): ExportAgentSignal {
  const interests = sweepStringArray(source.interests, {
    rowId: source.signal_id,
    column: "interests",
  });
  const goals = sweepStringArray(source.goals, {
    rowId: source.signal_id,
    column: "goals",
  });
  const lookingFor = sweepStringArray(source.looking_for, {
    rowId: source.signal_id,
    column: "looking_for",
  });
  events.push(...interests.events, ...goals.events, ...lookingFor.events);

  return {
    signal_id: source.signal_id,
    agent_id: hashAgentId(source.bankr_wallet, salt),
    night_of: source.night_of,
    interests: interests.cleaned,
    goals: goals.cleaned,
    looking_for: lookingFor.cleaned,
    available_slot_count: source.available_slot_count,
    week: source.week,
    submitted_to_index_network_at: source.submitted_to_index_network_at,
    created_at: source.created_at,
  };
}

function anonymizeMatchOutcome(
  source: SourceMatchOutcome,
  salt: string,
  _events: RedactionEvent[]
): ExportMatchOutcome {
  return {
    outcome_id: source.outcome_id,
    signal_id: source.signal_id,
    candidate_agent_id: hashAgentId(source.candidate_bankr_wallet, salt),
    match_score: source.match_score,
    agent_action: source.agent_action,
    counterpart_response: source.counterpart_response,
    human_confirmed: source.human_confirmed,
    meeting_actually_happened: source.meeting_actually_happened,
    created_at: source.created_at,
  };
}

function anonymizeBriefingOutcome(
  source: SourceBriefingOutcome,
  salt: string,
  _events: RedactionEvent[]
): ExportBriefingOutcome {
  return {
    briefing_id: source.briefing_id,
    agent_id: hashAgentId(source.bankr_wallet, salt),
    briefing_date: source.briefing_date,
    proposed_intro_count: source.proposed_intro_count,
    proposed_event_count: source.proposed_event_count,
    proposed_governance_count: source.proposed_governance_count,
    human_response: source.human_response,
    response_latency_minutes: source.response_latency_minutes,
    created_at: source.created_at,
  };
}

function anonymizeGovernanceEvent(
  source: SourceGovernanceEvent,
  salt: string,
  _events: RedactionEvent[]
): ExportGovernanceEvent {
  return {
    event_id: source.event_id,
    proposal_id: source.proposal_id,
    agent_id: hashAgentId(source.bankr_wallet, salt),
    agent_surfaced_to_human: source.agent_surfaced_to_human,
    human_voted: source.human_voted,
    vote_value: source.vote_value,
    vote_latency_minutes: source.vote_latency_minutes,
    created_at: source.created_at,
  };
}

function anonymizeCohortAssignment(
  source: SourceCohortAssignment,
  salt: string,
  events: RedactionEvent[]
): ExportCohortAssignment {
  // The notes field is free-text — sweep it.
  const notesSwept = source.notes
    ? sweepString(source.notes, { rowId: source.assignment_id, column: "notes" })
    : { cleaned: null, events: [] };
  events.push(...notesSwept.events);

  return {
    assignment_id: source.assignment_id,
    agent_id: hashAgentId(source.bankr_wallet, salt),
    experiment_id: source.experiment_id,
    cohort: source.cohort,
    assigned_at: source.assigned_at,
    notes: notesSwept.cleaned ?? null,
  };
}

// ─── Pipeline ────────────────────────────────────────────────────────

export async function runResearchExport(opts: RunOptions): Promise<RunResult> {
  const log = (...args: unknown[]) => {
    if (opts.verbose !== false) console.log("[research-export]", ...args);
  };

  validateSalt(opts.salt);

  const exportId = generateExportId();
  const outputPath = path.join(opts.outputDir, exportId);
  const format = opts.format ?? "csv";

  log(`starting export ${exportId}`);
  log(`format=${format} salt_version=${opts.saltVersion}`);
  if (opts.dateRange) log(`date_range=${opts.dateRange.from}..${opts.dateRange.to}`);

  // 1. Extract from Postgres
  log("extracting source rows...");
  const [signals, matches, briefings, governance, cohorts] = await Promise.all([
    extractAgentSignals(opts.supabase, opts.dateRange),
    extractMatchOutcomes(opts.supabase, opts.dateRange),
    extractBriefingOutcomes(opts.supabase, opts.dateRange),
    extractGovernanceEvents(opts.supabase, opts.dateRange),
    extractCohortAssignments(opts.supabase, opts.dateRange),
  ]);
  log(
    `extracted: signals=${signals.length} matches=${matches.length} ` +
      `briefings=${briefings.length} governance=${governance.length} ` +
      `cohorts=${cohorts.length}`
  );

  // 2. Anonymize. Collect all redaction events for the review log.
  const redactionEvents: Record<ResearchTableName, RedactionEvent[]> = {
    agent_signals: [],
    match_outcomes: [],
    briefing_outcomes: [],
    governance_events: [],
    cohort_assignments: [],
  };

  log("anonymizing...");
  const exportSignals = signals.map((s) =>
    anonymizeAgentSignal(s, opts.salt, redactionEvents.agent_signals)
  );
  const exportMatches = matches.map((m) =>
    anonymizeMatchOutcome(m, opts.salt, redactionEvents.match_outcomes)
  );
  const exportBriefings = briefings.map((b) =>
    anonymizeBriefingOutcome(b, opts.salt, redactionEvents.briefing_outcomes)
  );
  const exportGovernance = governance.map((g) =>
    anonymizeGovernanceEvent(g, opts.salt, redactionEvents.governance_events)
  );
  const exportCohorts = cohorts.map((c) =>
    anonymizeCohortAssignment(c, opts.salt, redactionEvents.cohort_assignments)
  );

  const totalRedactions = Object.values(redactionEvents).reduce((a, b) => a + b.length, 0);
  log(`redactions: ${totalRedactions}`);

  // 3. Write per-table files
  const ext = format === "parquet" ? "parquet" : "csv";
  const tablePayloads: Record<ResearchTableName, Row[]> = {
    agent_signals: exportSignals as unknown as Row[],
    match_outcomes: exportMatches as unknown as Row[],
    briefing_outcomes: exportBriefings as unknown as Row[],
    governance_events: exportGovernance as unknown as Row[],
    cohort_assignments: exportCohorts as unknown as Row[],
  };

  log(`writing ${format} to ${outputPath}/`);
  for (const table of RESEARCH_TABLES) {
    const filePath = path.join(outputPath, `${table}.${ext}`);
    if (format === "parquet") {
      const r = await writeParquetOrFallback(tablePayloads[table], filePath);
      log(`  ${table}: ${r.rowCount} rows, ${r.bytes} bytes (${r.format})`);
    } else {
      const r = await writeCsv(tablePayloads[table], filePath);
      log(`  ${table}: ${r.rowCount} rows, ${r.bytes} bytes (csv)`);
    }
  }

  // 4. Write redaction log
  const allEvents: Array<RedactionEvent & { table: ResearchTableName }> = [];
  for (const [table, events] of Object.entries(redactionEvents) as Array<
    [ResearchTableName, RedactionEvent[]]
  >) {
    for (const e of events) allEvents.push({ ...e, table });
  }
  await writeRedactionLog(
    allEvents as unknown as Array<Record<string, unknown>>,
    path.join(outputPath, "redactions.jsonl")
  );

  // 5. Write manifest
  const rowCounts: Record<ResearchTableName, number> = {
    agent_signals: exportSignals.length,
    match_outcomes: exportMatches.length,
    briefing_outcomes: exportBriefings.length,
    governance_events: exportGovernance.length,
    cohort_assignments: exportCohorts.length,
  };

  const redactionCounts: Record<ResearchTableName, number> = {
    agent_signals: redactionEvents.agent_signals.length,
    match_outcomes: redactionEvents.match_outcomes.length,
    briefing_outcomes: redactionEvents.briefing_outcomes.length,
    governance_events: redactionEvents.governance_events.length,
    cohort_assignments: redactionEvents.cohort_assignments.length,
  };

  const manifest: ExportManifest = {
    export_id: exportId,
    exported_at: new Date().toISOString(),
    salt_version: opts.saltVersion,
    row_counts: rowCounts,
    redaction_counts: redactionCounts,
    format,
    date_range: opts.dateRange,
    pipeline_version: PIPELINE_VERSION,
    schema_version: SCHEMA_VERSION,
  };

  await writeManifest(manifest, path.join(outputPath, "manifest.json"));
  log(`done — manifest at ${outputPath}/manifest.json`);

  return {
    exportId,
    outputPath,
    manifest,
    rowCounts,
    redactionCounts,
    totalRedactions,
  };
}
