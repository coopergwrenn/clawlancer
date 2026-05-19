-- matchpool_outcomes: support engine='index' rows natively.
--
-- Adds `index_opportunity_id UUID` so Index Network's canonical opportunity id
-- threads through the audit trail AND serves as the natural idempotency key
-- for both webhook retries (Path A) and the server-side poller (Path C).
-- Replaces the smoke-test hack of reusing an existing outreach_log_id.
--
-- Behavior:
--
--   1. New nullable column. Existing rows (match_engine='instaclaw') stay NULL
--      forever — no defaults, no backfill needed. Pure additive.
--
--   2. The has_linkage check is extended so engine='index' rows can satisfy
--      it via `index_opportunity_id IS NOT NULL`. Existing engines satisfy
--      it via their pre-existing routes (outreach_log_id, intro_id, request_id).
--
--   3. A partial UNIQUE index on `index_opportunity_id WHERE NOT NULL` enforces
--      one matchpool_outcomes row per Index opportunity. INSERT … ON CONFLICT
--      (or catching the 23505 SQLSTATE in the recorder) gives us idempotent
--      writes: both webhook redeliveries AND dual-direction Index broadcasts
--      (A→B + B→A for the same opportunity) collapse to one row.
--
-- Rollback (if ever needed):
--   DROP INDEX  matchpool_outcomes_index_opportunity_unique;
--   ALTER TABLE matchpool_outcomes DROP CONSTRAINT matchpool_outcomes_has_linkage;
--   ALTER TABLE matchpool_outcomes ADD  CONSTRAINT matchpool_outcomes_has_linkage CHECK (
--     outreach_log_id IS NOT NULL OR intro_id IS NOT NULL OR request_id IS NOT NULL
--   );
--   ALTER TABLE matchpool_outcomes DROP COLUMN index_opportunity_id;
--   (No data loss for existing rows — all engine='instaclaw'.)

ALTER TABLE public.matchpool_outcomes
  ADD COLUMN IF NOT EXISTS index_opportunity_id UUID NULL;

COMMENT ON COLUMN public.matchpool_outcomes.index_opportunity_id IS
  'Index Network opportunity.id for match_engine=''index'' rows. Carries Index''s canonical id through our audit log AND serves as the dedup key for webhook retries + bilateral broadcasts. UNIQUE-partial — see matchpool_outcomes_index_opportunity_unique index.';

-- Re-create the has_linkage check with `index_opportunity_id` as a fourth
-- accepted linkage. Drop+add is the safe path since the constraint name is
-- referenced in error messages and we want a clean replacement.
ALTER TABLE public.matchpool_outcomes
  DROP CONSTRAINT IF EXISTS matchpool_outcomes_has_linkage;

ALTER TABLE public.matchpool_outcomes
  ADD CONSTRAINT matchpool_outcomes_has_linkage CHECK (
    outreach_log_id       IS NOT NULL
    OR intro_id           IS NOT NULL
    OR request_id         IS NOT NULL
    OR index_opportunity_id IS NOT NULL
  );

-- Partial UNIQUE index: enforce one row per Index opportunity, but only for
-- rows that have one. NULL values are treated as distinct by Postgres so
-- legacy engine='instaclaw' rows (all NULL on this column) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS matchpool_outcomes_index_opportunity_unique
  ON public.matchpool_outcomes (index_opportunity_id)
  WHERE index_opportunity_id IS NOT NULL;
