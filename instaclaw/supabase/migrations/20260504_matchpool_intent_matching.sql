-- ════════════════════════════════════════════════════════════════════
-- Intent matching for Consensus 2026 — schema
-- ════════════════════════════════════════════════════════════════════
--
-- PRD: instaclaw/docs/prd/consensus-intent-matching-2026-05-04.md
-- Foundation: instaclaw/docs/prd/matching-engine-design-2026-05-03.md
--
-- Creates the full matchpool schema in one migration. Includes everything
-- needed for Phase 1 (Tue 9am) AND Phase 2 (Wed XMTP intros) so we don't
-- need a second migration mid-week.
--
-- Tables created:
--   matchpool_profiles       — one row per opted-in user; dual embeddings
--   matchpool_cached_top3    — for diff-based notification gating
--   matchpool_deliberations  — Layer 3 deliberation cache per user × candidate
--   matchpool_notifications  — outbound queue for per-VM agent cron
--   matchpool_intros         — Phase 2 XMTP negotiation state
--
-- Trigger:
--   matchpool_profiles INSERT/UPDATE → pg_notify('matchpool_changed', ...)
--   gated to fire only on embedding or consent_tier changes
--
-- All indexes for the pipeline. RLS for self-read on profiles.
-- ════════════════════════════════════════════════════════════════════

-- pgvector is required. Idempotent.
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── matchpool_profiles ─────────────────────────────────────────────
-- One row per user opted into matching. Dual embedding model: each user
-- has both an offering_embedding (what they bring) and a seeking_embedding
-- (what they're looking for). Match score = geometric mean of mutual
-- offering↔seeking cosine similarity.

CREATE TABLE IF NOT EXISTS matchpool_profiles (
  user_id              UUID PRIMARY KEY REFERENCES instaclaw_users(id) ON DELETE CASCADE,

  -- Anonymized agent_id for research export (one-way hash)
  agent_id             TEXT NOT NULL UNIQUE,

  -- Auditable summaries. User-readable. ~500 chars each.
  offering_summary     TEXT,
  seeking_summary      TEXT,

  -- Dual embeddings. voyage-3-large @ 1024 dim, int8 quantized in storage.
  -- Nullable so rows can exist before embedding (e.g. while text is captured
  -- but voyage hasn't been called yet).
  offering_embedding   vector(1024),
  seeking_embedding    vector(1024),
  embedding_model      TEXT DEFAULT 'voyage-3-large@1024',

  -- Generated tsvector across both summaries for hybrid retrieval (RRF).
  fts                  tsvector GENERATED ALWAYS AS (
                         to_tsvector('english',
                           coalesce(offering_summary, '') || ' ' ||
                           coalesce(seeking_summary, '')
                         )
                       ) STORED,

  -- Structured fields. Filterable, displayable per consent_tier.
  interests            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  goals                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  looking_for          TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  format_preferences   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  available_slots      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Filter dimensions
  partner              TEXT,                  -- 'consensus_2026', 'edge_city', NULL
  cohort_tag           TEXT,                  -- experimental cohort
  consent_tier         TEXT NOT NULL DEFAULT 'hidden',
                                              -- 'hidden' | 'name_only' | 'interests' |
                                              -- 'interests_plus_name' | 'full_profile'
  verified_human       BOOLEAN NOT NULL DEFAULT false,

  -- XMTP discovery (Phase 2 — wired up Wednesday)
  xmtp_inbox_id        TEXT,
  xmtp_consent_at      TIMESTAMPTZ,

  -- Profile lifecycle + versioning. profile_version increments on material
  -- intent change; deliberation cache keys on (user_v, candidate_v).
  profile_version      INT NOT NULL DEFAULT 1,
  intent_extracted_at  TIMESTAMPTZ,
  intent_extraction_confidence NUMERIC(3,2),
  active_through       TIMESTAMPTZ,
  last_active_at       TIMESTAMPTZ,
  match_kind_default   TEXT NOT NULL DEFAULT 'core',

  -- Bookkeeping
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Defensive constraint: consent_tier must be one of the known values.
  CONSTRAINT matchpool_profiles_consent_tier_valid CHECK (
    consent_tier IN ('hidden', 'name_only', 'interests', 'interests_plus_name', 'full_profile')
  )
);

-- HNSW index on each embedding (one per direction).
-- WHERE clause excludes NULLs since embeddings can be null pre-bake.
CREATE INDEX IF NOT EXISTS matchpool_profiles_offering_hnsw
  ON matchpool_profiles
  USING hnsw (offering_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE offering_embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS matchpool_profiles_seeking_hnsw
  ON matchpool_profiles
  USING hnsw (seeking_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE seeking_embedding IS NOT NULL;

-- Hybrid retrieval support
CREATE INDEX IF NOT EXISTS matchpool_profiles_fts_gin
  ON matchpool_profiles USING gin (fts);

-- Filter indexes for the pipeline's hard filters
CREATE INDEX IF NOT EXISTS matchpool_profiles_filter
  ON matchpool_profiles (verified_human, partner, last_active_at);

CREATE INDEX IF NOT EXISTS matchpool_profiles_consent
  ON matchpool_profiles (consent_tier)
  WHERE consent_tier <> 'hidden';

CREATE INDEX IF NOT EXISTS matchpool_profiles_interests_gin
  ON matchpool_profiles USING gin (interests);

CREATE INDEX IF NOT EXISTS matchpool_profiles_looking_for_gin
  ON matchpool_profiles USING gin (looking_for);

-- updated_at maintenance
CREATE OR REPLACE FUNCTION matchpool_profiles_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS matchpool_profiles_updated_at ON matchpool_profiles;
CREATE TRIGGER matchpool_profiles_updated_at
  BEFORE UPDATE ON matchpool_profiles
  FOR EACH ROW EXECUTE FUNCTION matchpool_profiles_set_updated_at();

-- ─── Reactive cascade trigger ───────────────────────────────────────
-- Fires only when changes that materially affect the match graph happen
-- (embeddings, consent_tier). Avoids spam from irrelevant DB writes.

CREATE OR REPLACE FUNCTION matchpool_profiles_changed_notify()
RETURNS TRIGGER AS $$
DECLARE
  embeddings_changed BOOLEAN;
  consent_changed BOOLEAN;
BEGIN
  embeddings_changed :=
    (TG_OP = 'INSERT')
    OR (OLD.offering_embedding IS DISTINCT FROM NEW.offering_embedding)
    OR (OLD.seeking_embedding IS DISTINCT FROM NEW.seeking_embedding);
  consent_changed :=
    (TG_OP = 'INSERT')
    OR (OLD.consent_tier IS DISTINCT FROM NEW.consent_tier);

  IF embeddings_changed OR consent_changed THEN
    -- pg_notify payload max 8KB; keep it lean.
    PERFORM pg_notify(
      'matchpool_changed',
      json_build_object(
        'user_id',           NEW.user_id,
        'change_kind',       TG_OP,
        'profile_version',   NEW.profile_version,
        'embeddings_changed', embeddings_changed,
        'consent_changed',    consent_changed
      )::text
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS matchpool_profiles_change_notify ON matchpool_profiles;
CREATE TRIGGER matchpool_profiles_change_notify
  AFTER INSERT OR UPDATE
  ON matchpool_profiles
  FOR EACH ROW EXECUTE FUNCTION matchpool_profiles_changed_notify();

-- RLS: a user can read their own profile. Service role bypasses.
ALTER TABLE matchpool_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS matchpool_profiles_self_read ON matchpool_profiles;
CREATE POLICY matchpool_profiles_self_read ON matchpool_profiles
  FOR SELECT USING (auth.uid() = user_id);

-- Service role full access (writes from /api/match/v1/profile)
DROP POLICY IF EXISTS matchpool_profiles_service_all ON matchpool_profiles;
CREATE POLICY matchpool_profiles_service_all ON matchpool_profiles
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ─── matchpool_cached_top3 ──────────────────────────────────────────
-- Diff-based notification gating: notify only when top-3 materially shifts.
-- Cached per user, updated by the cascade worker on each recompute.

CREATE TABLE IF NOT EXISTS matchpool_cached_top3 (
  user_id          UUID PRIMARY KEY REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  top3_user_ids    UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  top3_scores      NUMERIC[] NOT NULL DEFAULT ARRAY[]::NUMERIC[],
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT matchpool_cached_top3_arrays_align CHECK (
    array_length(top3_user_ids, 1) IS NOT DISTINCT FROM array_length(top3_scores, 1)
  )
);

-- ─── matchpool_deliberations ────────────────────────────────────────
-- Layer 3 cache. Keyed on (user × candidate × user_profile_v × candidate_profile_v).
-- Avoids recomputing deliberation if neither user's intent changed.
-- The agent-side rerank reads this and surfaces the rich rationale.

CREATE TABLE IF NOT EXISTS matchpool_deliberations (
  id                          BIGSERIAL PRIMARY KEY,
  user_id                     UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  candidate_user_id           UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  user_profile_version        INT NOT NULL,
  candidate_profile_version   INT NOT NULL,

  match_score                 NUMERIC(4,3) NOT NULL,
  rationale                   TEXT NOT NULL,
  conversation_topic          TEXT,
  meeting_window              TEXT,
  skip_reason                 TEXT,

  match_kind                  TEXT NOT NULL DEFAULT 'core',
                                              -- 'core' | 'wildcard' (Wed)
  deliberation_model          TEXT NOT NULL DEFAULT 'claude-sonnet-4-7',
  deliberated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotent: same (u, c, uv, cv) tuple → at most one row.
  UNIQUE (user_id, candidate_user_id, user_profile_version, candidate_profile_version)
);

CREATE INDEX IF NOT EXISTS matchpool_deliberations_for_user
  ON matchpool_deliberations (user_id, deliberated_at DESC);

CREATE INDEX IF NOT EXISTS matchpool_deliberations_for_candidate
  ON matchpool_deliberations (candidate_user_id, deliberated_at DESC);

-- Service role only (no user-side access — these are agent-internal).
ALTER TABLE matchpool_deliberations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS matchpool_deliberations_service ON matchpool_deliberations;
CREATE POLICY matchpool_deliberations_service ON matchpool_deliberations
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ─── matchpool_notifications ────────────────────────────────────────
-- Outbound queue. Per-VM agent cron polls every minute, sends Telegram,
-- marks delivered. Anti-spam policy enforced by the cascade worker (don't
-- enqueue if rate-limited or material-change gate didn't pass).

CREATE TABLE IF NOT EXISTS matchpool_notifications (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL,           -- 'new_arrival' | 'your_matches_updated' | 'morning_brief'
  payload         JSONB NOT NULL,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT matchpool_notifications_reason_valid CHECK (
    reason IN ('new_arrival', 'your_matches_updated', 'morning_brief', 'intro_proposal_received', 'intro_response_received')
  )
);

CREATE INDEX IF NOT EXISTS matchpool_notifications_undelivered
  ON matchpool_notifications (user_id, created_at)
  WHERE delivered_at IS NULL;

CREATE INDEX IF NOT EXISTS matchpool_notifications_recent
  ON matchpool_notifications (user_id, created_at DESC);

-- Service role only.
ALTER TABLE matchpool_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS matchpool_notifications_service ON matchpool_notifications;
CREATE POLICY matchpool_notifications_service ON matchpool_notifications
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ─── matchpool_intros (Phase 2 — XMTP intro negotiation, ships Wed) ─
-- State machine for cross-agent intro proposals over XMTP.
-- proposal → counter_proposed | accepted | declined | expired.
-- xmtp_thread_id links to the encrypted XMTP conversation.

CREATE TABLE IF NOT EXISTS matchpool_intros (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_user_id   UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  responder_user_id   UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  status              TEXT NOT NULL,
  xmtp_thread_id      TEXT,
  proposal_json       JSONB NOT NULL,
  response_json       JSONB,
  rounds              INT NOT NULL DEFAULT 1,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT matchpool_intros_status_valid CHECK (
    status IN ('proposed', 'counter_proposed', 'accepted', 'declined', 'expired')
  ),
  CONSTRAINT matchpool_intros_distinct_parties CHECK (
    initiator_user_id <> responder_user_id
  )
);

CREATE INDEX IF NOT EXISTS matchpool_intros_active
  ON matchpool_intros (initiator_user_id, status)
  WHERE status IN ('proposed', 'counter_proposed');

CREATE INDEX IF NOT EXISTS matchpool_intros_responder_active
  ON matchpool_intros (responder_user_id, status)
  WHERE status IN ('proposed', 'counter_proposed');

CREATE INDEX IF NOT EXISTS matchpool_intros_thread
  ON matchpool_intros (xmtp_thread_id)
  WHERE xmtp_thread_id IS NOT NULL;

-- updated_at maintenance for intros
DROP TRIGGER IF EXISTS matchpool_intros_updated_at ON matchpool_intros;
CREATE TRIGGER matchpool_intros_updated_at
  BEFORE UPDATE ON matchpool_intros
  FOR EACH ROW EXECUTE FUNCTION matchpool_profiles_set_updated_at();

ALTER TABLE matchpool_intros ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS matchpool_intros_self ON matchpool_intros;
CREATE POLICY matchpool_intros_self ON matchpool_intros
  FOR SELECT USING (
    auth.uid() = initiator_user_id OR auth.uid() = responder_user_id
  );
DROP POLICY IF EXISTS matchpool_intros_service ON matchpool_intros;
CREATE POLICY matchpool_intros_service ON matchpool_intros
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- ─── Helper: derive agent_id deterministically from user_id ─────────
-- The agent_id in matchpool_profiles is a hash of (user_id || research_salt).
-- One-way; safe to use in research export.
-- Salt is a vault secret (NOT in code). Function reads from app config.
-- For now: SHA-256 of user_id; salt to be applied in app code when inserting.

-- (No SQL helper needed — derived in app code via lib/match-id.ts)

-- ════════════════════════════════════════════════════════════════════
-- End of migration. Tables: 5. Triggers: 3. Indexes: 12.
-- All idempotent (CREATE IF NOT EXISTS / DROP IF EXISTS / CREATE OR REPLACE).
-- Safe to re-run.
-- ════════════════════════════════════════════════════════════════════
