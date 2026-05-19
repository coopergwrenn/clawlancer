/**
 * recordIndexMatch — the sole writer for `matchpool_outcomes` rows with
 * `match_engine='index'`.
 *
 * Used by BOTH:
 *  - Path A: the webhook handler at `app/api/webhook/index-encounter/route.ts`
 *  - Path C: the cron poller at `app/api/cron/poll-index-opportunities/route.ts`
 *
 * Responsibility split (read before changing):
 *  - This function is the only thing that should INSERT engine='index' rows.
 *    Any new trigger source (future MCP-side observation, manual admin
 *    backfill) should also go through here so all the invariants stay one
 *    place: user-id mapping, idempotency, self-match defense, structured
 *    result shape, logging.
 *  - Validation and shape parsing live in the caller. By the time we get
 *    here, the three id args are already-validated strings.
 *
 * Idempotency contract:
 *
 *   Postgres enforces the dedup via the partial-unique index
 *   `matchpool_outcomes_index_opportunity_unique ON (index_opportunity_id)
 *   WHERE index_opportunity_id IS NOT NULL` (migration
 *   20260519180000_matchpool_index_opportunity.sql). Duplicate INSERTs land
 *   on a 23505 SQLSTATE and we return `{status:'already_recorded'}` — never
 *   throw, never 5xx the caller.
 *
 * Edge cases (deliberate behavior, not bugs):
 *
 *   - Unknown Index user (no row in `instaclaw_vms.index_user_id` matching
 *     the input UUID): return `skipped: 'unknown_index_user'`. Common
 *     legitimate cause — Index network includes users outside our Edge
 *     City cohort. The caller returns 200 to Index so it doesn't retry
 *     forever; the operator sees a logger.warn.
 *
 *   - Self-match (both resolved user_ids identical): return
 *     `skipped: 'self_match'`. Malformed match — Index probably wouldn't
 *     emit this but defense in depth.
 *
 *   - Missing/zero-length ids: caller's parser should have rejected with
 *     a 400; this function trusts non-empty strings and returns
 *     `skipped: 'missing_field'` if it sees any empty input.
 *
 * Logging:
 *
 *   logger.info on every recorded match (with truncated id prefixes for
 *   forensics). logger.warn on skip. logger.error only on unexpected
 *   Supabase errors. Never use logger.error for `skipped` outcomes —
 *   those are expected operating conditions.
 *
 * Returns a tagged union — callers pattern-match on `result.status`.
 */
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

export type RecordIndexMatchInput = {
  /** Index Network opportunity.id (uuid). Used as idempotency key. */
  indexOpportunityId: string;
  /** Index Network user.id for the proposer/acceptor (uuid). */
  indexUserA: string;
  /** Index Network user.id for the other party (uuid). */
  indexUserB: string;
  /**
   * Optional metadata from the Index event. All persisted to the
   * matchpool_outcomes row when present. Field names mirror the existing
   * matchpool_outcomes columns to keep audit queries uniform.
   */
  metadata?: {
    rrfScore?: number | null;
    mutualScore?: number | null;
    deliberationScore?: number | null;
    reasoning?: string | null;
  };
  /**
   * Optional caller tag stitched into reason_text for audit. Defaults to
   * 'unspecified'. Path A passes 'webhook'; Path C passes 'poller'.
   */
  source?: "webhook" | "poller" | "manual";
};

export type RecordIndexMatchResult =
  | {
      status: "recorded";
      outcomeId: string;
      sourceUserId: string;
      candidateUserId: string;
    }
  | {
      status: "already_recorded";
      outcomeId: string;
    }
  | {
      status: "skipped";
      reason: "self_match" | "unknown_index_user" | "missing_field" | "invalid_uuid";
      detail?: string;
    }
  | {
      status: "error";
      reason: string;
      detail?: string;
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordIndexMatch(
  input: RecordIndexMatchInput,
): Promise<RecordIndexMatchResult> {
  // ── Shape validation (defense in depth — caller should have done this) ──
  if (!input.indexOpportunityId || !input.indexUserA || !input.indexUserB) {
    return { status: "skipped", reason: "missing_field" };
  }
  for (const [field, value] of [
    ["indexOpportunityId", input.indexOpportunityId],
    ["indexUserA", input.indexUserA],
    ["indexUserB", input.indexUserB],
  ] as const) {
    if (!UUID_RE.test(value)) {
      return {
        status: "skipped",
        reason: "invalid_uuid",
        detail: `${field} is not a valid uuid`,
      };
    }
  }

  const sb = getSupabase();

  // ── Resolve both Index users → our user_ids via instaclaw_vms ──
  // We look up via `index_user_id` (the value stepIndexProvision persisted
  // after the Index /signup call). Both lookups in parallel to keep latency
  // low on the webhook path.
  const [aRow, bRow] = await Promise.all([
    sb
      .from("instaclaw_vms")
      .select("id, assigned_to")
      .eq("index_user_id", input.indexUserA)
      .eq("partner", "edge_city")
      .maybeSingle()
      .then((r) => r.data),
    sb
      .from("instaclaw_vms")
      .select("id, assigned_to")
      .eq("index_user_id", input.indexUserB)
      .eq("partner", "edge_city")
      .maybeSingle()
      .then((r) => r.data),
  ]);

  if (!aRow?.assigned_to || !bRow?.assigned_to) {
    const which = !aRow?.assigned_to && !bRow?.assigned_to ? "both" : !aRow?.assigned_to ? "A" : "B";
    logger.warn("[index-recorder] unknown index_user_id", {
      indexOpportunityId: input.indexOpportunityId,
      indexUserA_prefix: input.indexUserA.slice(0, 8),
      indexUserB_prefix: input.indexUserB.slice(0, 8),
      missing: which,
    });
    return {
      status: "skipped",
      reason: "unknown_index_user",
      detail: `Index user(s) not in our edge_city cohort: ${which}`,
    };
  }

  const sourceUserId = aRow.assigned_to as string;
  const candidateUserId = bRow.assigned_to as string;

  // ── Self-match defense ──
  if (sourceUserId === candidateUserId) {
    logger.warn("[index-recorder] self-match refused", {
      indexOpportunityId: input.indexOpportunityId,
      userId: sourceUserId,
    });
    return { status: "skipped", reason: "self_match" };
  }

  // ── INSERT — idempotent on index_opportunity_id ──
  // The matchpool_outcomes_index_opportunity_unique partial index makes
  // duplicate writes fail with SQLSTATE 23505. We catch that specifically
  // and re-read the existing row to return its outcome_id; any other error
  // path returns `status:'error'` and is logged at error level.
  const reasonText = buildReasonText(input);

  const { data: inserted, error: insertErr } = await sb
    .from("matchpool_outcomes")
    .insert({
      source_user_id: sourceUserId,
      candidate_user_id: candidateUserId,
      match_engine: "index",
      agent_action: "proposed",
      index_opportunity_id: input.indexOpportunityId,
      rrf_score: input.metadata?.rrfScore ?? null,
      mutual_score: input.metadata?.mutualScore ?? null,
      deliberation_score: input.metadata?.deliberationScore ?? null,
      reason_text: reasonText,
    })
    .select("outcome_id")
    .single();

  if (!insertErr && inserted?.outcome_id) {
    logger.info("[index-recorder] recorded", {
      outcomeId: inserted.outcome_id,
      indexOpportunityId: input.indexOpportunityId,
      sourceUserIdPrefix: sourceUserId.slice(0, 8),
      candidateUserIdPrefix: candidateUserId.slice(0, 8),
      source: input.source ?? "unspecified",
    });
    return {
      status: "recorded",
      outcomeId: inserted.outcome_id,
      sourceUserId,
      candidateUserId,
    };
  }

  // Unique violation → already recorded. PostgreSQL 23505 surfaces as
  // PostgREST error code '23505' or 'PGRST116'-adjacent; the message reliably
  // contains the index name.
  const isDupViolation =
    insertErr?.code === "23505" ||
    /matchpool_outcomes_index_opportunity_unique/i.test(insertErr?.message ?? "") ||
    /duplicate key/i.test(insertErr?.message ?? "");

  if (isDupViolation) {
    const { data: existing } = await sb
      .from("matchpool_outcomes")
      .select("outcome_id")
      .eq("index_opportunity_id", input.indexOpportunityId)
      .maybeSingle();
    logger.info("[index-recorder] already_recorded (dup)", {
      outcomeId: existing?.outcome_id,
      indexOpportunityId: input.indexOpportunityId,
      source: input.source ?? "unspecified",
    });
    return {
      status: "already_recorded",
      outcomeId: existing?.outcome_id ?? "(unknown)",
    };
  }

  // Anything else is a real error — log loud, return structured.
  logger.error("[index-recorder] INSERT failed", {
    indexOpportunityId: input.indexOpportunityId,
    code: insertErr?.code,
    message: insertErr?.message?.slice(0, 300),
  });
  return {
    status: "error",
    reason: insertErr?.code ?? "unknown",
    detail: insertErr?.message?.slice(0, 300),
  };
}

function buildReasonText(input: RecordIndexMatchInput): string {
  const tag = `[index:${input.source ?? "unspecified"}]`;
  const opp = `opportunity=${input.indexOpportunityId}`;
  if (input.metadata?.reasoning) {
    return `${tag} ${opp} — ${input.metadata.reasoning.slice(0, 200)}`;
  }
  return `${tag} ${opp}`;
}
