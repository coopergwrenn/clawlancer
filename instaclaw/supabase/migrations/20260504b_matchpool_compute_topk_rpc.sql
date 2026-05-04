-- ─────────────────────────────────────────────────────────────────────
-- Supplemental migration for the consensus intent matching engine.
-- Registers matchpool_compute_topk_mutual() — the Layer 1 retrieval RPC.
--
-- Companion to 20260504_matchpool_intent_matching.sql. This migration
-- is split out because the previous migration was already pasted into
-- Studio.
--
-- This RPC powers lib/match-scoring.ts:computeTopKMutual(). It does the
-- dual-embedding mutual-score retrieval inside the database in a single
-- round-trip — no row-shipping, no client-side scoring.
--
-- Algorithm (Reciprocal Rank Fusion hybrid retrieval):
--   1. forward_pool: HNSW top-N by `offering_embedding <=> my_seeking`.
--      Catches candidates whose offering is near my seeking.
--   2. reverse_pool: HNSW top-N by `seeking_embedding <=> my_offering`.
--      Catches candidates whose seeking is near my offering — the
--      "they desperately want what I offer" case that forward-only
--      retrieval would miss.
--   3. fused_pool: union, with RRF score = 1/(60 + rank_fwd) + 1/(60 + rank_rev).
--      Take top p_pool_size by RRF.
--   4. scored: compute exact forward + reverse cos similarities. Clamp
--      via GREATEST(0, …) for numerical stability — embeddings are
--      unit-normalized to ~1.0003 so 1 - cos can dip slightly below 0
--      on near-anti-correlated pairs.
--   5. Final SELECT: geometric-mean mutual score, filter > min, sort,
--      top-k. Geometric mean (sqrt(fwd × rev)) penalizes asymmetric
--      "stalker" matches where one side is 0.9 and the other 0.1.
--
-- Why RRF rather than forward-only HNSW prefilter: the original
-- implementation only retrieved by the forward direction, which would
-- miss candidates whose `seeking` matched the user's `offering` but
-- whose `offering` did not match the user's `seeking`. For a small
-- pool (Consensus ~500 users) the forward HNSW already covers most of
-- the universe and the marginal gain is small, but for a larger pool
-- this is the difference between "complementarity matching" and
-- "similarity matching." The architectural commitment is the former.
--
-- Security: SECURITY DEFINER — only callable by service_role. Anonymous
-- and authenticated PostgREST callers cannot invoke this; the API path
-- (`lib/match-scoring.ts:computeTopKMutual`) uses the service-role
-- client and enforces "compute for the authenticated user only" in TS.
--
-- PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md §2.2
-- ─────────────────────────────────────────────────────────────────────

-- Drop any previous, broader-grant version of this function before
-- redefining (idempotent re-run safe).
DROP FUNCTION IF EXISTS matchpool_compute_topk_mutual(
  UUID, TEXT, TEXT, INT, NUMERIC, INT, UUID[]
);

CREATE FUNCTION matchpool_compute_topk_mutual(
  p_user_id                UUID,
  p_my_seeking_embedding   TEXT,   -- pgvector accepts text representation
  p_my_offering_embedding  TEXT,
  p_pool_size              INT,
  p_min_mutual_score       NUMERIC,
  p_top_k                  INT,
  p_exclude_user_ids       UUID[]
)
RETURNS TABLE (
  user_id                    UUID,
  agent_id                   TEXT,
  candidate_profile_version  INT,
  offering_summary           TEXT,
  seeking_summary            TEXT,
  interests                  TEXT[],
  looking_for                TEXT[],
  format_preferences         TEXT[],
  consent_tier               TEXT,
  forward_score              DOUBLE PRECISION,
  reverse_score              DOUBLE PRECISION,
  mutual_score               DOUBLE PRECISION
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  -- 1. Forward-direction HNSW top-N: candidates whose offering matches
  -- caller's seeking ("what I want, they bring"). The window's ORDER BY
  -- and the outer ORDER BY share a sort key, so the ROW_NUMBER ranks
  -- match the HNSW retrieval order.
  forward_pool AS (
    SELECT
      mp.user_id,
      ROW_NUMBER() OVER (
        ORDER BY mp.offering_embedding <=> p_my_seeking_embedding::vector
      ) AS rnk
    FROM matchpool_profiles mp
    WHERE mp.user_id <> p_user_id
      AND NOT (mp.user_id = ANY(COALESCE(p_exclude_user_ids, ARRAY[]::UUID[])))
      AND mp.consent_tier IN ('interests', 'interests_plus_name', 'full_profile')
      AND mp.offering_embedding IS NOT NULL
      AND mp.seeking_embedding IS NOT NULL
    ORDER BY mp.offering_embedding <=> p_my_seeking_embedding::vector
    LIMIT p_pool_size
  ),
  -- 2. Reverse-direction HNSW top-N: candidates whose seeking matches
  -- caller's offering ("what I bring, they want"). Same filters.
  reverse_pool AS (
    SELECT
      mp.user_id,
      ROW_NUMBER() OVER (
        ORDER BY mp.seeking_embedding <=> p_my_offering_embedding::vector
      ) AS rnk
    FROM matchpool_profiles mp
    WHERE mp.user_id <> p_user_id
      AND NOT (mp.user_id = ANY(COALESCE(p_exclude_user_ids, ARRAY[]::UUID[])))
      AND mp.consent_tier IN ('interests', 'interests_plus_name', 'full_profile')
      AND mp.offering_embedding IS NOT NULL
      AND mp.seeking_embedding IS NOT NULL
    ORDER BY mp.seeking_embedding <=> p_my_offering_embedding::vector
    LIMIT p_pool_size
  ),
  -- 3. RRF fusion: merge by reciprocal rank. k=60 is the canonical
  -- RRF constant (Cormack et al., 2009). Candidates appearing in
  -- only one branch still get scored; FULL OUTER JOIN handles that.
  fused AS (
    SELECT
      COALESCE(f.user_id, r.user_id) AS user_id,
      COALESCE(1.0 / (60 + f.rnk), 0) + COALESCE(1.0 / (60 + r.rnk), 0) AS rrf_score
    FROM forward_pool f
    FULL OUTER JOIN reverse_pool r ON f.user_id = r.user_id
  ),
  fused_top AS (
    SELECT user_id FROM fused ORDER BY rrf_score DESC LIMIT p_pool_size
  ),
  -- 4. Compute exact forward + reverse on the fused pool.
  scored AS (
    SELECT
      mp.user_id,
      mp.agent_id,
      mp.profile_version,
      mp.offering_summary,
      mp.seeking_summary,
      mp.interests,
      mp.looking_for,
      mp.format_preferences,
      mp.consent_tier,
      GREATEST(0::float8, 1::float8 - (mp.offering_embedding <=> p_my_seeking_embedding::vector))::float8 AS fwd,
      GREATEST(0::float8, 1::float8 - (mp.seeking_embedding  <=> p_my_offering_embedding::vector))::float8 AS rev
    FROM matchpool_profiles mp
    JOIN fused_top ft ON mp.user_id = ft.user_id
  )
  SELECT
    s.user_id,
    s.agent_id,
    s.profile_version          AS candidate_profile_version,
    s.offering_summary,
    s.seeking_summary,
    s.interests,
    s.looking_for,
    s.format_preferences,
    s.consent_tier,
    s.fwd                      AS forward_score,
    s.rev                      AS reverse_score,
    SQRT(s.fwd * s.rev)::float8 AS mutual_score
  FROM scored s
  WHERE s.fwd > 0
    AND s.rev > 0
    AND SQRT(s.fwd * s.rev) >= p_min_mutual_score::float8
  ORDER BY mutual_score DESC
  LIMIT p_top_k;
$$;

-- Lock down execution. PostgREST exposes any function callable by
-- `authenticated` to logged-in users via /rpc/<name>. Even with
-- consent_tier filtering inside the function, exposing the RPC to the
-- web client would let any logged-in user enumerate the matchpool's
-- offering_summary / seeking_summary text by calling the function with
-- arbitrary p_user_id values.
--
-- The lib (`lib/match-scoring.ts:computeTopKMutual`) calls via the
-- service-role client, which bypasses these grants — so revoking from
-- authenticated does NOT break the API path.
REVOKE ALL ON FUNCTION matchpool_compute_topk_mutual(
  UUID, TEXT, TEXT, INT, NUMERIC, INT, UUID[]
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION matchpool_compute_topk_mutual(
  UUID, TEXT, TEXT, INT, NUMERIC, INT, UUID[]
) TO service_role;

COMMENT ON FUNCTION matchpool_compute_topk_mutual IS
  'Layer 1 dual-embedding mutual-score retrieval with RRF hybrid '
  'retrieval. SECURITY DEFINER, service_role only — must not be '
  'exposed to authenticated PostgREST callers. See '
  'lib/match-scoring.ts:computeTopKMutual() for the TS wrapper.';
