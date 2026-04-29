/**
 * Source-side data extraction for the EE26 research export pipeline.
 *
 * Each extractor:
 *   - Pulls one of the 5 research.* tables from Supabase
 *   - Optionally applies a date-range filter on the table's primary
 *     timestamp column
 *   - Returns raw `Source*` rows (containing bankr_wallet) for the
 *     pipeline to anonymize before writing
 *
 * The extractors do NOT do any anonymization themselves. That's the
 * pipeline's job. Splitting extract/anonymize keeps each layer testable
 * in isolation and makes it easy to add new tables later.
 *
 * Pagination: extractors page through Supabase using `range()` with a
 * fixed page size. This is necessary because Supabase's default RLS-
 * agnostic API caps at 1000 rows per request.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SourceAgentSignal,
  SourceBriefingOutcome,
  SourceCohortAssignment,
  SourceGovernanceEvent,
  SourceMatchOutcome,
} from "./schemas";

const PAGE_SIZE = 1000;

export interface DateRange {
  /** Inclusive lower bound (ISO date or timestamp) */
  from: string;
  /** Inclusive upper bound */
  to: string;
}

/**
 * Generic paginated select. Iterates through all pages and returns the
 * complete result set. Caller specifies the schema, table, optional
 * date filter, and the timestamp column to filter on.
 */
async function paginatedSelect<T>(
  supabase: SupabaseClient,
  schema: string,
  table: string,
  options: {
    dateColumn?: string;
    dateRange?: DateRange;
    orderBy?: string;
  } = {}
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;

  while (true) {
    let query = supabase.schema(schema).from(table).select("*").range(offset, offset + PAGE_SIZE - 1);

    if (options.orderBy) {
      query = query.order(options.orderBy, { ascending: true });
    }

    if (options.dateColumn && options.dateRange) {
      query = query
        .gte(options.dateColumn, options.dateRange.from)
        .lte(options.dateColumn, options.dateRange.to);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`extract failed for ${schema}.${table}: ${error.message}`);
    }
    if (!data || data.length === 0) break;

    all.push(...(data as T[]));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return all;
}

// ─── Per-table extractors ────────────────────────────────────────────

export async function extractAgentSignals(
  supabase: SupabaseClient,
  dateRange?: DateRange
): Promise<SourceAgentSignal[]> {
  return paginatedSelect<SourceAgentSignal>(supabase, "research", "agent_signals", {
    dateColumn: "night_of",
    dateRange,
    orderBy: "submitted_to_index_network_at",
  });
}

export async function extractMatchOutcomes(
  supabase: SupabaseClient,
  dateRange?: DateRange
): Promise<SourceMatchOutcome[]> {
  return paginatedSelect<SourceMatchOutcome>(supabase, "research", "match_outcomes", {
    dateColumn: "created_at",
    dateRange,
    orderBy: "created_at",
  });
}

export async function extractBriefingOutcomes(
  supabase: SupabaseClient,
  dateRange?: DateRange
): Promise<SourceBriefingOutcome[]> {
  return paginatedSelect<SourceBriefingOutcome>(
    supabase,
    "research",
    "briefing_outcomes",
    {
      dateColumn: "briefing_date",
      dateRange,
      orderBy: "briefing_date",
    }
  );
}

export async function extractGovernanceEvents(
  supabase: SupabaseClient,
  dateRange?: DateRange
): Promise<SourceGovernanceEvent[]> {
  return paginatedSelect<SourceGovernanceEvent>(
    supabase,
    "research",
    "governance_events",
    {
      dateColumn: "created_at",
      dateRange,
      orderBy: "created_at",
    }
  );
}

export async function extractCohortAssignments(
  supabase: SupabaseClient,
  dateRange?: DateRange
): Promise<SourceCohortAssignment[]> {
  return paginatedSelect<SourceCohortAssignment>(
    supabase,
    "research",
    "cohort_assignments",
    {
      dateColumn: "assigned_at",
      dateRange,
      orderBy: "assigned_at",
    }
  );
}

// ─── Longitudinal-consent join (for per-human studies only) ──────────

/**
 * Returns the set of bankr_wallet addresses for users who have
 * EXPLICITLY consented to per-human longitudinal research tracking
 * (instaclaw_users.research_longitudinal_consent = TRUE).
 *
 * The pipeline uses this set to gate which rows are eligible for
 * per-human longitudinal study. Rows for non-consenting users are
 * STILL exported (they contribute to aggregate metrics) but their
 * agent_id is rotated PER NIGHT — so longitudinal tracking across
 * nights is structurally prevented.
 *
 * See PRD section 4.10.3 — re-identification guarantees.
 */
export async function fetchLongitudinalConsentWallets(
  supabase: SupabaseClient
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("instaclaw_users")
    .select("bankr_wallet_address")
    .eq("research_longitudinal_consent", true)
    .not("bankr_wallet_address", "is", null);

  if (error) {
    throw new Error(`fetchLongitudinalConsentWallets failed: ${error.message}`);
  }

  const wallets = new Set<string>();
  for (const row of (data ?? []) as Array<{ bankr_wallet_address: string | null }>) {
    if (row.bankr_wallet_address) {
      wallets.add(row.bankr_wallet_address.trim().toLowerCase());
    }
  }
  return wallets;
}
