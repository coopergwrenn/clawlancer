-- ════════════════════════════════════════════════════════════════════════
-- matchpool_outcomes — wire to v2 negotiation_threads
-- ════════════════════════════════════════════════════════════════════════
--
-- Context: the 20260511_matchpool_outcomes_ingest.sql migration shipped
-- with `intro_id UUID REFERENCES matchpool_intros(id)` because matchpool_intros
-- was the v2-placeholder table in the consensus addendum (20260504). But v2
-- (20260506a_negotiation_v2.sql) replaced that placeholder with a richer
-- schema: negotiation_threads + negotiation_messages.
--
-- Without this migration, outcomes can't be linked to v2 negotiations:
-- the dashboard would show v1 funnel only, and post-meeting capture via
-- /api/match/v1/outcome couldn't identify v2 threads.
--
-- This migration:
--   1. Adds matchpool_outcomes.negotiation_thread_id with FK to
--      negotiation_threads(id), plus partial unique index for v2 path.
--   2. Relaxes the has_linkage CHECK to accept negotiation_thread_id
--      as a valid linkage option.
--   3. Adds match_engine column to negotiation_threads with same
--      'instaclaw' | 'index' constraint, completing Index-engine
--      attribution for the v2 path.
--   4. Extends matchpool_funnel_counts RPC to JOIN through both
--      outreach_log AND negotiation_threads so dashboard funnel
--      counts v1 + v2 traffic in the same numbers.
-- ════════════════════════════════════════════════════════════════════════

-- ─── 1. Add negotiation_thread_id linkage to matchpool_outcomes ───────

ALTER TABLE matchpool_outcomes
  ADD COLUMN IF NOT EXISTS negotiation_thread_id UUID
    REFERENCES negotiation_threads(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS matchpool_outcomes_unique_negotiation_thread
  ON matchpool_outcomes (source_user_id, candidate_user_id, negotiation_thread_id)
  WHERE negotiation_thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS matchpool_outcomes_negotiation_thread
  ON matchpool_outcomes (negotiation_thread_id)
  WHERE negotiation_thread_id IS NOT NULL;

-- ─── 2. Relax has_linkage CHECK ──────────────────────────────────────
-- Now accepts any of outreach_log_id / intro_id / negotiation_thread_id
-- / request_id as a valid linkage.

ALTER TABLE matchpool_outcomes
  DROP CONSTRAINT IF EXISTS matchpool_outcomes_has_linkage;

ALTER TABLE matchpool_outcomes
  ADD CONSTRAINT matchpool_outcomes_has_linkage CHECK (
    outreach_log_id IS NOT NULL OR
    intro_id IS NOT NULL OR
    negotiation_thread_id IS NOT NULL OR
    request_id IS NOT NULL
  );

-- ─── 3. Add match_engine to negotiation_threads ──────────────────────

ALTER TABLE negotiation_threads
  ADD COLUMN IF NOT EXISTS match_engine TEXT NOT NULL DEFAULT 'instaclaw';

ALTER TABLE negotiation_threads
  DROP CONSTRAINT IF EXISTS negotiation_threads_match_engine_valid;
ALTER TABLE negotiation_threads
  ADD CONSTRAINT negotiation_threads_match_engine_valid
  CHECK (match_engine IN ('instaclaw', 'index'));

CREATE INDEX IF NOT EXISTS negotiation_threads_engine
  ON negotiation_threads (match_engine, started_at DESC NULLS LAST);

-- ─── 4. Extend funnel-counts RPC for v1 + v2 unified counting ───────
-- The RPC now operates on the outcomes table directly (no JOIN through
-- specific intro tables), so it already counts both v1 and v2 outcomes.
-- The partner filter joins through matchpool_profiles which is engine-
-- and version-agnostic. No RPC change needed — just documenting that
-- the function inherently handles both paths.

COMMENT ON FUNCTION matchpool_funnel_counts IS
  'Dashboard helper. Returns denormalized funnel counters with optional partner / engine / since filters. Hinge-analogue: valuable_rate = valuable / proposed. Counts v1 + v2 paths together; filter by match_engine for engine-specific A/B.';

-- ════════════════════════════════════════════════════════════════════════
-- Done.
-- ════════════════════════════════════════════════════════════════════════
