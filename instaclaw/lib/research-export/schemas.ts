/**
 * TypeScript types for the 5 EE26 research tables — both the SOURCE
 * shape (what's in Postgres) and the EXPORT shape (what the researcher
 * receives, post-anonymization).
 *
 * The export shape differs from the source shape in two ways:
 *   1. `bankr_wallet` / `candidate_bankr_wallet` are replaced with
 *      anonymized `agent_id` / `candidate_agent_id` (16-char hex).
 *   2. Free-text fields run through the PII sweep — the type stays
 *      `string` but content may include `<REDACTED:reason>` markers.
 *
 * See PRD section 4.10.3 for the schema definitions.
 * See lib/research-export/anonymize.ts for the hash + sweep utilities.
 */

// ─── Source shapes (what's in Postgres) ──────────────────────────────

export interface SourceAgentSignal {
  signal_id: string;
  bankr_wallet: string;
  night_of: string; // ISO date
  interests: string[];
  goals: string[];
  looking_for: string[];
  available_slot_count: number;
  week: number;
  submitted_to_index_network_at: string; // ISO timestamp
  created_at: string;
}

export interface SourceMatchOutcome {
  outcome_id: string;
  signal_id: string;
  candidate_bankr_wallet: string;
  match_score: number;
  agent_action: "dm_sent" | "skipped" | "cluster_added";
  counterpart_response: "accepted" | "declined" | "counter" | "no_reply" | null;
  human_confirmed: boolean | null;
  meeting_actually_happened: boolean | null;
  created_at: string;
}

export interface SourceBriefingOutcome {
  briefing_id: string;
  bankr_wallet: string;
  briefing_date: string;
  proposed_intro_count: number;
  proposed_event_count: number;
  proposed_governance_count: number;
  human_response:
    | "approved_all"
    | "approved_partial"
    | "declined_all"
    | "no_response"
    | "modified"
    | null;
  response_latency_minutes: number | null;
  created_at: string;
}

export interface SourceGovernanceEvent {
  event_id: string;
  proposal_id: string;
  bankr_wallet: string;
  agent_surfaced_to_human: boolean;
  human_voted: boolean;
  vote_value: "yes" | "no" | "abstain" | null;
  vote_latency_minutes: number | null;
  created_at: string;
}

export interface SourceCohortAssignment {
  assignment_id: string;
  bankr_wallet: string;
  experiment_id: string;
  cohort: string;
  assigned_at: string;
  notes: string | null;
}

// ─── Export shapes (what the researcher receives) ────────────────────

export interface ExportAgentSignal {
  signal_id: string;
  agent_id: string; // 16-char hashed
  night_of: string;
  interests: string[]; // PII-swept
  goals: string[]; // PII-swept
  looking_for: string[]; // PII-swept
  available_slot_count: number;
  week: number;
  submitted_to_index_network_at: string;
  created_at: string;
}

export interface ExportMatchOutcome {
  outcome_id: string;
  signal_id: string;
  candidate_agent_id: string; // 16-char hashed
  match_score: number;
  agent_action: SourceMatchOutcome["agent_action"];
  counterpart_response: SourceMatchOutcome["counterpart_response"];
  human_confirmed: boolean | null;
  meeting_actually_happened: boolean | null;
  created_at: string;
}

export interface ExportBriefingOutcome {
  briefing_id: string;
  agent_id: string; // 16-char hashed
  briefing_date: string;
  proposed_intro_count: number;
  proposed_event_count: number;
  proposed_governance_count: number;
  human_response: SourceBriefingOutcome["human_response"];
  response_latency_minutes: number | null;
  created_at: string;
}

export interface ExportGovernanceEvent {
  event_id: string;
  proposal_id: string;
  agent_id: string; // 16-char hashed
  agent_surfaced_to_human: boolean;
  human_voted: boolean;
  vote_value: SourceGovernanceEvent["vote_value"];
  vote_latency_minutes: number | null;
  created_at: string;
}

export interface ExportCohortAssignment {
  assignment_id: string;
  agent_id: string; // 16-char hashed
  experiment_id: string;
  cohort: string;
  assigned_at: string;
  notes: string | null; // PII-swept (Vendrov can put context here, but no PII)
}

// ─── Table registry — used by the pipeline orchestrator ───────────────

/**
 * Names of the 5 tables. The pipeline iterates this list and runs
 * extract → anonymize → write for each.
 */
export const RESEARCH_TABLES = [
  "agent_signals",
  "match_outcomes",
  "briefing_outcomes",
  "governance_events",
  "cohort_assignments",
] as const;

export type ResearchTableName = (typeof RESEARCH_TABLES)[number];

// ─── Manifest — written alongside each export ────────────────────────

export interface ExportManifest {
  /** Unique id for this export run (used in directory naming + logs) */
  export_id: string;
  /** ISO timestamp when the export ran */
  exported_at: string;
  /** A short tag for the salt version — does NOT include the salt itself */
  salt_version: string;
  /** Per-table row counts */
  row_counts: Record<ResearchTableName, number>;
  /** Per-table redaction event counts (from the PII sweep) */
  redaction_counts: Record<ResearchTableName, number>;
  /** Output format */
  format: "parquet" | "csv";
  /**
   * Optional date filter (inclusive). If set, only rows where the
   * primary timestamp column is within [from, to] are included.
   */
  date_range?: { from: string; to: string };
  /** Pipeline + schema versions */
  pipeline_version: string;
  schema_version: string;
}

export const PIPELINE_VERSION = "0.1.0";
export const SCHEMA_VERSION = "2026-04-29-initial";
