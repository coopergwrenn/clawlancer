-- ════════════════════════════════════════════════════════════════════════
-- matchpool_outcomes — ingest path for the 3-layer pipeline's feedback loop
-- ════════════════════════════════════════════════════════════════════════
--
-- Context: foundation PRD §6.1 specified matchpool_outcomes but no migration
-- ever created it. The competitive-research PRD (2026-05-11) revealed that
-- the 3-layer pipeline has been operating blind — Layer 3 generates
-- match_score predictions but no production code captures ground truth
-- (did the meeting happen, was it valuable). Without this, we cannot:
--   - Tune mutual_threshold against valuable-vs-declined distributions
--   - Measure the Hinge-analogue success rate (the north-star metric)
--   - Detect MAST inter-agent misalignment (Layer 3 score vs actual outcome)
--   - A/B compare InstaClaw engine vs Index Network adapter when it ships
--
-- This migration closes the feedback loop. It:
--   1. Creates public.matchpool_outcomes per foundation PRD §6.1, with
--      additional lifecycle timestamps + outreach/intro linkage + Layer 3
--      score (the consensus addendum's deliberation output).
--   2. Adds match_engine column to matchpool_deliberations, agent_outreach_log,
--      matchpool_intros so we can A/B Index vs InstaClaw end-to-end.
--   3. Backfills outcome rows for the 30 existing v1 intros (historical
--      baseline — counterpart_response stays 'no_reply' since we can't
--      retroactively determine if meetings happened).
--
-- Index-integration insurance per Cooper's 2026-05-11 prompt: the
-- match_engine TEXT NOT NULL discriminator lets the same schema serve
-- both engines. No data-model split required when the adapter ships.
-- ════════════════════════════════════════════════════════════════════════

-- ─── Table: matchpool_outcomes ─────────────────────────────────────────
-- One row per (source_user, candidate_user, outreach OR intro). The row
-- is created at intro-send time (agent_action='proposed') and mutated
-- through the funnel as signals arrive: counterpart_response from v2
-- envelopes or post-meeting capture, meeting_actually_happened and
-- rating_post_meeting from the user via the post-meeting Telegram prompt.

CREATE TABLE IF NOT EXISTS matchpool_outcomes (
  outcome_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Linkage. At least one of outreach_log_id / intro_id / request_id MUST be set.
  -- outreach_log_id: v1 INTRO_V1 single-shot path
  -- intro_id: v2 negotiation path
  -- request_id: foundation PRD §3 route_intent request — flows through Layer 1
  outreach_log_id      UUID REFERENCES agent_outreach_log(id) ON DELETE SET NULL,
  intro_id             UUID REFERENCES matchpool_intros(id)   ON DELETE SET NULL,
  request_id           UUID,

  -- The pair (source = whose agent generated/sent the match; perspective-aware).
  -- Symmetric meetings produce two rows — one per party rating the other.
  source_user_id       UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  candidate_user_id    UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,

  -- Engine that produced this match. Critical for Index A/B when adapter ships.
  match_engine         TEXT NOT NULL DEFAULT 'instaclaw',

  -- Scores at proposal time (denormalized from deliberations + route_intent).
  -- rrf_score: hybrid retrieval (Layer 1) score, if available
  -- mutual_score: post-asymmetric-filter geometric-mean score (Layer 1 output)
  -- deliberation_score: Layer 3 LLM match_score (foundation PRD §6.1 didn't have this;
  --   we add it because tuning Layer 3 prompts requires this signal)
  rrf_score            FLOAT,
  mutual_score         FLOAT,
  deliberation_score   FLOAT,

  -- The funnel (mutated over time as signals arrive).
  agent_action         TEXT,
  counterpart_response TEXT,
  human_confirmed      BOOLEAN,
  meeting_actually_happened BOOLEAN,
  rating_post_meeting  INT,
  rating_source        TEXT,
  reason_text          TEXT,

  -- Lifecycle timestamps — explicit so we can measure funnel timing
  -- without inferring from updated_at + diffing.
  proposed_at                 TIMESTAMPTZ,
  responded_at                TIMESTAMPTZ,
  met_at                      TIMESTAMPTZ,
  rated_at                    TIMESTAMPTZ,
  post_meeting_prompted_at    TIMESTAMPTZ,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── Constraints ──
  CONSTRAINT matchpool_outcomes_match_engine_valid CHECK (
    match_engine IN ('instaclaw', 'index')
  ),
  CONSTRAINT matchpool_outcomes_agent_action_valid CHECK (
    agent_action IS NULL OR agent_action IN ('surfaced', 'dismissed', 'proposed')
  ),
  CONSTRAINT matchpool_outcomes_counterpart_response_valid CHECK (
    counterpart_response IS NULL OR
    counterpart_response IN ('accepted', 'declined', 'countered', 'no_reply')
  ),
  CONSTRAINT matchpool_outcomes_rating_valid CHECK (
    rating_post_meeting IS NULL OR
    (rating_post_meeting >= 1 AND rating_post_meeting <= 5)
  ),
  CONSTRAINT matchpool_outcomes_rating_source_valid CHECK (
    rating_source IS NULL OR
    rating_source IN ('user_self_report', 'inferred', 'admin')
  ),
  CONSTRAINT matchpool_outcomes_distinct_parties CHECK (
    source_user_id != candidate_user_id
  ),
  CONSTRAINT matchpool_outcomes_has_linkage CHECK (
    outreach_log_id IS NOT NULL OR
    intro_id IS NOT NULL OR
    request_id IS NOT NULL
  )
);

-- Partial unique indexes — one outcome per (source, candidate, outreach)
-- or per (source, candidate, intro). Allows both v1 and v2 paths.
CREATE UNIQUE INDEX IF NOT EXISTS matchpool_outcomes_unique_outreach
  ON matchpool_outcomes (source_user_id, candidate_user_id, outreach_log_id)
  WHERE outreach_log_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS matchpool_outcomes_unique_intro
  ON matchpool_outcomes (source_user_id, candidate_user_id, intro_id)
  WHERE intro_id IS NOT NULL;

-- Query indexes
CREATE INDEX IF NOT EXISTS matchpool_outcomes_source
  ON matchpool_outcomes (source_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS matchpool_outcomes_candidate
  ON matchpool_outcomes (candidate_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS matchpool_outcomes_engine
  ON matchpool_outcomes (match_engine, created_at DESC);

-- Funnel-state index for dashboard queries ("how many proposed but no response?")
CREATE INDEX IF NOT EXISTS matchpool_outcomes_funnel
  ON matchpool_outcomes (
    agent_action,
    counterpart_response,
    meeting_actually_happened
  );

-- Index for the post-meeting prompt cron
CREATE INDEX IF NOT EXISTS matchpool_outcomes_unprompted
  ON matchpool_outcomes (responded_at)
  WHERE counterpart_response = 'accepted'
    AND meeting_actually_happened IS NULL
    AND post_meeting_prompted_at IS NULL;

COMMENT ON TABLE matchpool_outcomes IS
  'Feedback loop for the 3-layer matching pipeline. One row per (source, candidate, outreach|intro). Mutated over time as funnel signals arrive: proposed → counterpart_response → meeting_actually_happened → rating_post_meeting. Index-engine-agnostic via match_engine column.';

-- ─── Updated_at trigger ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION matchpool_outcomes_set_timestamps()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();

  -- Auto-stamp funnel transitions if the field is set fresh on this op
  IF NEW.agent_action = 'proposed' AND NEW.proposed_at IS NULL THEN
    NEW.proposed_at := NOW();
  END IF;

  IF NEW.counterpart_response IS NOT NULL AND NEW.responded_at IS NULL THEN
    NEW.responded_at := NOW();
  END IF;

  IF NEW.meeting_actually_happened IS NOT NULL AND NEW.met_at IS NULL THEN
    NEW.met_at := NOW();
  END IF;

  IF NEW.rating_post_meeting IS NOT NULL AND NEW.rated_at IS NULL THEN
    NEW.rated_at := NOW();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS matchpool_outcomes_timestamps ON matchpool_outcomes;
CREATE TRIGGER matchpool_outcomes_timestamps
  BEFORE INSERT OR UPDATE ON matchpool_outcomes
  FOR EACH ROW EXECUTE FUNCTION matchpool_outcomes_set_timestamps();

-- ─── RLS ──────────────────────────────────────────────────────────────
-- Each user can read outcomes where they're either source or candidate
-- (they're entitled to know how they appear in others' matching too).
-- Service role bypasses for all writes.

ALTER TABLE matchpool_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS matchpool_outcomes_self_read ON matchpool_outcomes;
CREATE POLICY matchpool_outcomes_self_read ON matchpool_outcomes
  FOR SELECT
  USING (auth.uid() = source_user_id OR auth.uid() = candidate_user_id);

DROP POLICY IF EXISTS matchpool_outcomes_service_all ON matchpool_outcomes;
CREATE POLICY matchpool_outcomes_service_all ON matchpool_outcomes
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role');

-- ════════════════════════════════════════════════════════════════════════
-- Index-integration insurance — add match_engine to upstream tables
-- ════════════════════════════════════════════════════════════════════════
-- Per Cooper's 2026-05-11 prompt: build everything Index-compatible.
-- Without these columns, when the Index adapter flips on we cannot
-- attribute deliberations / outreaches / negotiations back to engines.

ALTER TABLE matchpool_deliberations
  ADD COLUMN IF NOT EXISTS match_engine TEXT NOT NULL DEFAULT 'instaclaw';

ALTER TABLE matchpool_deliberations
  DROP CONSTRAINT IF EXISTS matchpool_deliberations_match_engine_valid;
ALTER TABLE matchpool_deliberations
  ADD CONSTRAINT matchpool_deliberations_match_engine_valid
  CHECK (match_engine IN ('instaclaw', 'index'));

CREATE INDEX IF NOT EXISTS matchpool_deliberations_engine
  ON matchpool_deliberations (match_engine, deliberated_at DESC);

ALTER TABLE agent_outreach_log
  ADD COLUMN IF NOT EXISTS match_engine TEXT NOT NULL DEFAULT 'instaclaw';

ALTER TABLE agent_outreach_log
  DROP CONSTRAINT IF EXISTS agent_outreach_log_match_engine_valid;
ALTER TABLE agent_outreach_log
  ADD CONSTRAINT agent_outreach_log_match_engine_valid
  CHECK (match_engine IN ('instaclaw', 'index'));

CREATE INDEX IF NOT EXISTS agent_outreach_log_engine
  ON agent_outreach_log (match_engine, sent_at DESC NULLS LAST);

ALTER TABLE matchpool_intros
  ADD COLUMN IF NOT EXISTS match_engine TEXT NOT NULL DEFAULT 'instaclaw';

ALTER TABLE matchpool_intros
  DROP CONSTRAINT IF EXISTS matchpool_intros_match_engine_valid;
ALTER TABLE matchpool_intros
  ADD CONSTRAINT matchpool_intros_match_engine_valid
  CHECK (match_engine IN ('instaclaw', 'index'));

CREATE INDEX IF NOT EXISTS matchpool_intros_engine
  ON matchpool_intros (match_engine, created_at DESC);

-- ════════════════════════════════════════════════════════════════════════
-- Backfill outcome rows for the 30 existing v1 intros
-- ════════════════════════════════════════════════════════════════════════
-- Historical baseline. counterpart_response stays 'no_reply' since we
-- cannot retroactively determine if the meetings happened. Provides
-- a starting funnel from May 5 → May 11 (Consensus week-1 insiders cohort).

INSERT INTO matchpool_outcomes (
  outreach_log_id,
  source_user_id,
  candidate_user_id,
  match_engine,
  agent_action,
  proposed_at,
  created_at,
  updated_at
)
SELECT
  id                      AS outreach_log_id,
  outbound_user_id        AS source_user_id,
  target_user_id          AS candidate_user_id,
  'instaclaw'             AS match_engine,
  CASE WHEN status = 'sent' THEN 'proposed' ELSE NULL END AS agent_action,
  sent_at                 AS proposed_at,
  COALESCE(sent_at, NOW()) AS created_at,
  COALESCE(sent_at, NOW()) AS updated_at
FROM agent_outreach_log
WHERE id NOT IN (SELECT outreach_log_id FROM matchpool_outcomes WHERE outreach_log_id IS NOT NULL)
ON CONFLICT DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════
-- Helper RPC: get_funnel_counts
-- Used by the Live Activity Dashboard. Returns a single row of denormalized
-- counters that the dashboard polls every N seconds. Cheap to compute,
-- partial-indexed.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION matchpool_funnel_counts(
  p_partner TEXT DEFAULT NULL,
  p_match_engine TEXT DEFAULT NULL,
  p_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  total_outcomes BIGINT,
  proposed_count BIGINT,
  responded_count BIGINT,
  accepted_count BIGINT,
  declined_count BIGINT,
  met_count BIGINT,
  valuable_count BIGINT,
  -- Hinge-analogue: valuable / proposed = "off-platform completion rate"
  valuable_rate NUMERIC,
  -- Average deliberation_score among valuable matches (sanity check on Layer 3)
  avg_deliberation_score_valuable NUMERIC,
  -- Average deliberation_score among declined matches
  avg_deliberation_score_declined NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH eligible AS (
    SELECT o.*
    FROM matchpool_outcomes o
    LEFT JOIN matchpool_profiles src ON src.user_id = o.source_user_id
    WHERE
      (p_partner IS NULL OR src.partner = p_partner)
      AND (p_match_engine IS NULL OR o.match_engine = p_match_engine)
      AND (p_since IS NULL OR o.created_at >= p_since)
  )
  SELECT
    COUNT(*)::BIGINT AS total_outcomes,
    COUNT(*) FILTER (WHERE agent_action = 'proposed')::BIGINT AS proposed_count,
    COUNT(*) FILTER (WHERE counterpart_response IS NOT NULL AND counterpart_response != 'no_reply')::BIGINT AS responded_count,
    COUNT(*) FILTER (WHERE counterpart_response = 'accepted')::BIGINT AS accepted_count,
    COUNT(*) FILTER (WHERE counterpart_response = 'declined')::BIGINT AS declined_count,
    COUNT(*) FILTER (WHERE meeting_actually_happened = TRUE)::BIGINT AS met_count,
    COUNT(*) FILTER (WHERE rating_post_meeting >= 4)::BIGINT AS valuable_count,
    CASE
      WHEN COUNT(*) FILTER (WHERE agent_action = 'proposed') > 0
      THEN ROUND(
        COUNT(*) FILTER (WHERE rating_post_meeting >= 4)::NUMERIC
        / COUNT(*) FILTER (WHERE agent_action = 'proposed')::NUMERIC,
        4
      )
      ELSE NULL
    END AS valuable_rate,
    ROUND(AVG(deliberation_score) FILTER (WHERE rating_post_meeting >= 4)::NUMERIC, 4) AS avg_deliberation_score_valuable,
    ROUND(AVG(deliberation_score) FILTER (WHERE counterpart_response = 'declined')::NUMERIC, 4) AS avg_deliberation_score_declined
  FROM eligible;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION matchpool_funnel_counts IS
  'Dashboard helper. Returns denormalized funnel counters with optional partner / engine / since filters. Hinge-analogue: valuable_rate = valuable / proposed.';

-- ════════════════════════════════════════════════════════════════════════
-- Done.
-- ════════════════════════════════════════════════════════════════════════
