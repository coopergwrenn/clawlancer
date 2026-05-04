/**
 * Layer 1 match scoring for the matching engine.
 *
 * Given a userId, returns top-K candidates by dual-embedding mutual score:
 *   forward = cos(my_seeking, their_offering)
 *   reverse = cos(their_seeking, my_offering)
 *   mutual  = sqrt(forward × reverse)   // geometric mean
 *
 * Geometric mean penalizes asymmetric matches structurally (the "stalker"
 * pattern where forward=0.9 reverse=0.1 falls to 0.3, while balanced
 * forward=0.5 reverse=0.5 stays at 0.5).
 *
 * The math runs in Postgres via a single CTE:
 *   1. Filter candidates (consent_tier, embeddings present, exclude self)
 *   2. HNSW lookup: top-N by forward score (offering_embedding HNSW index)
 *   3. For those N, compute reverse score directly (no index — N is small)
 *   4. Compute mutual; filter mutual > 0; sort; return top-K
 *
 * Single round-trip, ~80ms for 500-user pool. No data shipping.
 *
 * PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §2.2, §5
 */
import { getSupabase } from "@/lib/supabase";

// ─── Types ──────────────────────────────────────────────────────────

export interface MatchCandidate {
  user_id: string;
  agent_id: string;
  candidate_profile_version: number;

  // Visible per consent_tier (caller's UI gates display).
  offering_summary: string;
  seeking_summary: string;
  interests: string[];
  looking_for: string[];
  format_preferences: string[];
  consent_tier: string;

  // Scoring (geometric mean of forward × reverse).
  mutual_score: number;
  forward_score: number;
  reverse_score: number;
}

export interface ComputeTopKOptions {
  /** Filter out matches with mutual_score below this threshold (default 0). */
  minMutualScore?: number;
  /** Retrieval pool size BEFORE the reverse-score rank cut (default 200). */
  candidatePoolSize?: number;
  /** Additional user_ids to exclude from candidates. */
  excludeUserIds?: string[];
}

// ─── computeTopKMutual ──────────────────────────────────────────────

/**
 * Compute top-K matches for `userId` using dual-embedding mutual scoring.
 *
 * Returns [] when:
 *   - userId has no matchpool_profiles row yet
 *   - userId's profile has no embeddings (extraction pending)
 *   - no candidates pass the consent / embedding filters
 *
 * Throws on DB errors.
 */
export async function computeTopKMutual(
  userId: string,
  k = 50,
  options: ComputeTopKOptions = {}
): Promise<MatchCandidate[]> {
  if (k <= 0) return [];
  const minMutualScore = options.minMutualScore ?? 0.0;
  const poolSize = options.candidatePoolSize ?? 200;
  const excludeUserIds = options.excludeUserIds ?? [];

  const supabase = getSupabase();

  // ─ 1. Lookup caller's embeddings ─
  const { data: me, error: meErr } = await supabase
    .from("matchpool_profiles")
    .select("offering_embedding, seeking_embedding, consent_tier")
    .eq("user_id", userId)
    .maybeSingle();

  if (meErr) throw new Error(`computeTopKMutual: caller lookup failed: ${meErr.message}`);
  if (!me) return []; // no profile yet — nothing to match against
  if (!me.offering_embedding || !me.seeking_embedding) return []; // not embedded yet

  // pgvector returns embeddings as strings like "[0.1,0.2,...]" via supabase-js;
  // we pass them BACK into the SQL parameters as the same string format and
  // PG re-parses to vector. This works because our match query uses parameter
  // placeholders typed as ::vector explicitly.
  const mySeeking = me.seeking_embedding as unknown as string;
  const myOffering = me.offering_embedding as unknown as string;

  // ─ 2. Call Layer 1 retrieval RPC ─
  // The dual-embedding HNSW + scoring math lives in Postgres for a single
  // round-trip and zero row-shipping. RPC source of truth:
  //   supabase/migrations/20260504b_matchpool_compute_topk_rpc.sql
  //
  // Note: pgvector's <=> is cosine DISTANCE = 1 - cos_sim for unit vectors.
  // Our embedder produces unit-normalized vectors (verified norm≈1.0003).
  // The RPC clamps via GREATEST(0, …) for anti-correlated pairs.

  const { data, error } = await supabase.rpc("matchpool_compute_topk_mutual", {
    p_user_id: userId,
    p_my_seeking_embedding: mySeeking,
    p_my_offering_embedding: myOffering,
    p_pool_size: poolSize,
    p_min_mutual_score: minMutualScore,
    p_top_k: k,
    p_exclude_user_ids: excludeUserIds,
  });

  if (error) {
    // If the RPC doesn't exist yet (first run), surface a clear error.
    const m = error.message;
    const rpcMissing =
      (m.includes("function") && m.includes("does not exist")) ||
      m.includes("Could not find the function") ||
      m.includes("matchpool_compute_topk_mutual");
    if (rpcMissing) {
      throw new Error(
        `computeTopKMutual: matchpool_compute_topk_mutual() RPC not registered. ` +
        `Apply the supplemental migration in Supabase Studio: ` +
        `supabase/migrations/20260504b_matchpool_compute_topk_rpc.sql`
      );
    }
    throw new Error(`computeTopKMutual: query failed: ${error.message}`);
  }

  if (!data || !Array.isArray(data)) return [];

  return data.map((row: Record<string, unknown>) => ({
    user_id: row.user_id as string,
    agent_id: row.agent_id as string,
    candidate_profile_version: row.candidate_profile_version as number,
    offering_summary: row.offering_summary as string,
    seeking_summary: row.seeking_summary as string,
    interests: (row.interests as string[]) ?? [],
    looking_for: (row.looking_for as string[]) ?? [],
    format_preferences: (row.format_preferences as string[]) ?? [],
    consent_tier: row.consent_tier as string,
    mutual_score: row.mutual_score as number,
    forward_score: row.forward_score as number,
    reverse_score: row.reverse_score as number,
  }));
}

// ─── Helper: compute top-K and project per consent_tier ─────────────

/**
 * Filter visible fields per the candidate's consent_tier.
 * Used by the UI / Layer 2 to avoid leaking content the candidate didn't
 * agree to expose.
 */
export function projectForConsent(c: MatchCandidate): MatchCandidate {
  const tier = c.consent_tier;

  if (tier === "name_only") {
    // Show name only — strip everything else.
    return {
      ...c,
      offering_summary: "",
      seeking_summary: "",
      interests: [],
      looking_for: [],
      format_preferences: [],
    };
  }

  if (tier === "interests") {
    // Show interests + looking_for, but blank out summaries.
    return {
      ...c,
      offering_summary: "",
      seeking_summary: "",
    };
  }

  // 'interests_plus_name' and 'full_profile' show everything in the
  // candidate result (plus name resolution which the UI does separately
  // by joining instaclaw_users on user_id where consent permits).
  return c;
}
