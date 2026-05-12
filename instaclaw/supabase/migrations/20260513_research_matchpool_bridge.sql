-- ════════════════════════════════════════════════════════════════════════
-- research.matchpool_outcomes — anonymized mirror for Vendrov export
-- ════════════════════════════════════════════════════════════════════════
--
-- Step 6b of the matching-engine-competitive-research §5.2 sequence.
-- Bridges operational data from public.matchpool_outcomes to an
-- anonymized snapshot in the research schema that Vendrov can analyze
-- without privacy concerns.
--
-- Design decisions documented in the matching engine PRD; key points:
--
--   1. Snapshot not view. Writes are periodic (daily cron). Salt
--      rotation only affects new writes; in-flight analyses don't
--      break when the salt rotates.
--
--   2. Mirror the public table 1:1 — don't force-fit into the
--      pre-existing research.match_outcomes (which is signal_id-based
--      for the Index Network era and lossy for our richer schema).
--
--   3. Hash user_ids directly (UUIDs) rather than going through the
--      wallet join. Simpler, and the UUID is equally stable per village.
--
--   4. Track salt_version per row so post-rotation joins stay scoped.
--
--   5. Cross-schema writes via SECURITY DEFINER public RPCs (mirror of
--      the public.assign_cohort pattern shipped in 20260512).
-- ════════════════════════════════════════════════════════════════════════

-- Ensure the research schema exists (idempotent — already created by
-- 20260512 cohort migration or 20260429_research_schema.sql).
CREATE SCHEMA IF NOT EXISTS research;

-- ─── Table: research.matchpool_outcomes ───────────────────────────────
-- Anonymized mirror of public.matchpool_outcomes. Same shape, with
-- identity columns hashed and free-text PII-swept.

CREATE TABLE IF NOT EXISTS research.matchpool_outcomes (
  -- Primary key. Same UUID as public.matchpool_outcomes.outcome_id so
  -- repeated upserts on the same source row are idempotent. Not an FK
  -- (cross-schema FKs are awkward) but semantically the link.
  outcome_id              UUID PRIMARY KEY,

  -- Anonymized participant identifiers. Hash of the user_id with the
  -- village salt. Stable for the duration of one salt_version; rotates
  -- across versions. Two rows with the same source_agent_id are the
  -- same human within a salt_version.
  source_agent_id         TEXT NOT NULL,
  candidate_agent_id      TEXT NOT NULL,

  -- Hashed internal IDs — same salt + version so repeated upserts of
  -- the same source row produce identical hashes (idempotency) but
  -- Vendrov can't reconstruct the source IDs.
  outreach_log_id_hash         TEXT,
  intro_id_hash                TEXT,
  negotiation_thread_id_hash   TEXT,
  request_id_hash              TEXT,

  -- Engine attribution. Critical for the Index Network A/B comparison
  -- when the adapter ships. 'instaclaw' | 'index'.
  match_engine            TEXT NOT NULL,

  -- Score columns — copied as-is from source. Numeric, non-PII.
  rrf_score               FLOAT,
  mutual_score            FLOAT,
  deliberation_score      FLOAT,

  -- Funnel state — enum-typed in source, copied as text here.
  agent_action            TEXT,
  counterpart_response    TEXT,
  human_confirmed         BOOLEAN,
  meeting_actually_happened BOOLEAN,
  rating_post_meeting     INT,
  rating_source           TEXT,

  -- PII-swept reason_text. Sweeping happens client-side via
  -- lib/research-export/anonymize.ts:sweepString and the RPC writer.
  -- The original text never reaches this table.
  reason_text_swept       TEXT,
  reason_text_redactions  JSONB,

  -- Funnel timestamps. Useful for measuring time-to-meeting, etc.
  proposed_at             TIMESTAMPTZ,
  responded_at            TIMESTAMPTZ,
  met_at                  TIMESTAMPTZ,
  rated_at                TIMESTAMPTZ,
  post_meeting_prompted_at TIMESTAMPTZ,

  -- Source-table provenance. We carry these forward so Vendrov knows
  -- when rows changed in the operational store, separate from when
  -- they were exported.
  source_created_at       TIMESTAMPTZ NOT NULL,
  source_updated_at       TIMESTAMPTZ NOT NULL,

  -- Export-side metadata.
  exported_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  salt_version            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS research_matchpool_outcomes_engine
  ON research.matchpool_outcomes (match_engine, source_created_at DESC);

CREATE INDEX IF NOT EXISTS research_matchpool_outcomes_source_agent
  ON research.matchpool_outcomes (source_agent_id, source_created_at DESC);

CREATE INDEX IF NOT EXISTS research_matchpool_outcomes_salt_version
  ON research.matchpool_outcomes (salt_version, source_updated_at DESC);

CREATE INDEX IF NOT EXISTS research_matchpool_outcomes_funnel
  ON research.matchpool_outcomes (agent_action, counterpart_response, meeting_actually_happened);

COMMENT ON TABLE research.matchpool_outcomes IS
  'Anonymized mirror of public.matchpool_outcomes. One row per source row, identifiers hashed and free-text PII-swept. Written by lib/research-export/matchpool-bridge.ts via the public.research_matchpool_sync RPC. Snapshot semantics: cron-synced daily, salt-versioned for rotation.';

-- ─── Table: research.export_state ─────────────────────────────────────
-- Incremental sync state. One row per source table → last_synced_at.

CREATE TABLE IF NOT EXISTS research.export_state (
  source_table          TEXT PRIMARY KEY,
  last_synced_at        TIMESTAMPTZ NOT NULL,
  last_run_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_count     BIGINT NOT NULL DEFAULT 0,
  last_salt_version     TEXT
);

COMMENT ON TABLE research.export_state IS
  'Per-source last_synced_at watermarks for incremental research export. Read/written via public RPC wrappers.';

-- ════════════════════════════════════════════════════════════════════════
-- Public RPCs — narrow surface for cross-schema writes
-- ════════════════════════════════════════════════════════════════════════

-- Read the current sync watermark for a source table.
-- Returns the last_synced_at + last_synced_count + last_salt_version.
-- If no row exists yet, returns last_synced_at = epoch so the first
-- sync picks up everything.

CREATE OR REPLACE FUNCTION public.research_export_state_get(
  p_source_table TEXT
)
RETURNS TABLE (
  last_synced_at        TIMESTAMPTZ,
  last_synced_count     BIGINT,
  last_salt_version     TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, research
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(es.last_synced_at, '1970-01-01 00:00:00+00'::TIMESTAMPTZ),
    COALESCE(es.last_synced_count, 0::BIGINT),
    es.last_salt_version
  FROM research.export_state es
  WHERE es.source_table = p_source_table
  UNION ALL
  SELECT '1970-01-01 00:00:00+00'::TIMESTAMPTZ, 0::BIGINT, NULL::TEXT
  WHERE NOT EXISTS (
    SELECT 1 FROM research.export_state WHERE source_table = p_source_table
  )
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.research_export_state_get IS
  'Read the incremental-sync watermark for a research export source table. Returns epoch if no prior sync. SECURITY DEFINER for cross-schema access.';

-- Bulk upsert into research.matchpool_outcomes + advance the watermark
-- atomically. Returns the count of rows upserted and the new watermark.
--
-- The payload is a JSONB array. Each element must contain every column
-- on research.matchpool_outcomes; we cast the JSON to typed rows via
-- jsonb_populate_recordset.

CREATE OR REPLACE FUNCTION public.research_matchpool_sync(
  p_rows                JSONB,
  p_new_last_synced_at  TIMESTAMPTZ,
  p_salt_version        TEXT
)
RETURNS TABLE (
  rows_upserted         BIGINT,
  new_last_synced_at    TIMESTAMPTZ,
  state_row_count       BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, research
AS $$
DECLARE
  v_upserted BIGINT;
BEGIN
  IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
    -- Empty payload: advance the watermark anyway (caller observed
    -- no new rows but we don't want to re-scan the same range next
    -- run if we know we're caught up).
    INSERT INTO research.export_state (source_table, last_synced_at, last_run_at, last_synced_count, last_salt_version)
    VALUES ('matchpool_outcomes', p_new_last_synced_at, NOW(), 0, p_salt_version)
    ON CONFLICT (source_table) DO UPDATE
      SET last_synced_at = EXCLUDED.last_synced_at,
          last_run_at = EXCLUDED.last_run_at,
          last_synced_count = EXCLUDED.last_synced_count,
          last_salt_version = EXCLUDED.last_salt_version;

    RETURN QUERY
    SELECT 0::BIGINT, p_new_last_synced_at, 0::BIGINT;
    RETURN;
  END IF;

  -- Upsert the rows. ON CONFLICT (outcome_id) replays the latest version
  -- of every column — this is what makes the writer idempotent and
  -- correct on partial re-runs.
  INSERT INTO research.matchpool_outcomes (
    outcome_id,
    source_agent_id, candidate_agent_id,
    outreach_log_id_hash, intro_id_hash, negotiation_thread_id_hash, request_id_hash,
    match_engine,
    rrf_score, mutual_score, deliberation_score,
    agent_action, counterpart_response, human_confirmed, meeting_actually_happened,
    rating_post_meeting, rating_source,
    reason_text_swept, reason_text_redactions,
    proposed_at, responded_at, met_at, rated_at, post_meeting_prompted_at,
    source_created_at, source_updated_at,
    salt_version
  )
  SELECT
    (r->>'outcome_id')::UUID,
    r->>'source_agent_id', r->>'candidate_agent_id',
    r->>'outreach_log_id_hash', r->>'intro_id_hash',
    r->>'negotiation_thread_id_hash', r->>'request_id_hash',
    r->>'match_engine',
    NULLIF(r->>'rrf_score','')::FLOAT,
    NULLIF(r->>'mutual_score','')::FLOAT,
    NULLIF(r->>'deliberation_score','')::FLOAT,
    r->>'agent_action', r->>'counterpart_response',
    NULLIF(r->>'human_confirmed','')::BOOLEAN,
    NULLIF(r->>'meeting_actually_happened','')::BOOLEAN,
    NULLIF(r->>'rating_post_meeting','')::INT,
    r->>'rating_source',
    r->>'reason_text_swept',
    NULLIF(r->>'reason_text_redactions','')::JSONB,
    NULLIF(r->>'proposed_at','')::TIMESTAMPTZ,
    NULLIF(r->>'responded_at','')::TIMESTAMPTZ,
    NULLIF(r->>'met_at','')::TIMESTAMPTZ,
    NULLIF(r->>'rated_at','')::TIMESTAMPTZ,
    NULLIF(r->>'post_meeting_prompted_at','')::TIMESTAMPTZ,
    (r->>'source_created_at')::TIMESTAMPTZ,
    (r->>'source_updated_at')::TIMESTAMPTZ,
    r->>'salt_version'
  FROM jsonb_array_elements(p_rows) AS r
  ON CONFLICT (outcome_id) DO UPDATE SET
    source_agent_id            = EXCLUDED.source_agent_id,
    candidate_agent_id         = EXCLUDED.candidate_agent_id,
    outreach_log_id_hash       = EXCLUDED.outreach_log_id_hash,
    intro_id_hash              = EXCLUDED.intro_id_hash,
    negotiation_thread_id_hash = EXCLUDED.negotiation_thread_id_hash,
    request_id_hash            = EXCLUDED.request_id_hash,
    match_engine               = EXCLUDED.match_engine,
    rrf_score                  = EXCLUDED.rrf_score,
    mutual_score               = EXCLUDED.mutual_score,
    deliberation_score         = EXCLUDED.deliberation_score,
    agent_action               = EXCLUDED.agent_action,
    counterpart_response       = EXCLUDED.counterpart_response,
    human_confirmed            = EXCLUDED.human_confirmed,
    meeting_actually_happened  = EXCLUDED.meeting_actually_happened,
    rating_post_meeting        = EXCLUDED.rating_post_meeting,
    rating_source              = EXCLUDED.rating_source,
    reason_text_swept          = EXCLUDED.reason_text_swept,
    reason_text_redactions     = EXCLUDED.reason_text_redactions,
    proposed_at                = EXCLUDED.proposed_at,
    responded_at               = EXCLUDED.responded_at,
    met_at                     = EXCLUDED.met_at,
    rated_at                   = EXCLUDED.rated_at,
    post_meeting_prompted_at   = EXCLUDED.post_meeting_prompted_at,
    source_updated_at          = EXCLUDED.source_updated_at,
    exported_at                = NOW(),
    salt_version               = EXCLUDED.salt_version;

  GET DIAGNOSTICS v_upserted = ROW_COUNT;

  -- Advance the watermark.
  INSERT INTO research.export_state (source_table, last_synced_at, last_run_at, last_synced_count, last_salt_version)
  VALUES ('matchpool_outcomes', p_new_last_synced_at, NOW(), v_upserted, p_salt_version)
  ON CONFLICT (source_table) DO UPDATE
    SET last_synced_at = EXCLUDED.last_synced_at,
        last_run_at = EXCLUDED.last_run_at,
        last_synced_count = EXCLUDED.last_synced_count,
        last_salt_version = EXCLUDED.last_salt_version;

  RETURN QUERY
  SELECT
    v_upserted,
    p_new_last_synced_at,
    (SELECT COUNT(*)::BIGINT FROM research.matchpool_outcomes);
END;
$$;

COMMENT ON FUNCTION public.research_matchpool_sync IS
  'Bulk-upsert anonymized matchpool_outcomes rows AND advance the sync watermark atomically. Returns rows_upserted + new_last_synced_at + total_rows_in_research. SECURITY DEFINER. Idempotent — re-runs over the same payload produce the same end state.';

-- ════════════════════════════════════════════════════════════════════════
-- Done.
-- ════════════════════════════════════════════════════════════════════════
