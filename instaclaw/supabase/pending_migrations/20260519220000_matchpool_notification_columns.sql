-- matchpool_outcomes: per-side notification idempotency columns.
--
-- When an Index match lands in matchpool_outcomes (via the poller or any
-- future write path), both cohort participants should get a Telegram
-- notification from their own bot. The two columns below track delivery
-- per participant so partial failures don't double-notify and full
-- successes don't re-notify on subsequent poller ticks.
--
-- One column per side (source vs candidate) instead of a single
-- combined "notified_at" so we can:
--   1. Retry just the failed side on the next tick (without re-sending
--      to the side that already got it).
--   2. Audit per-side delivery rates separately.
--   3. Surface "this user got notified but their counterpart didn't" as
--      a P1 alert if it ever happens.
--
-- Idempotency guard in lib/index-match-notifier.ts:
--   - source notification fires when notified_source_at IS NULL
--   - candidate notification fires when notified_candidate_at IS NULL
--   - After successful notify_user.sh: UPDATE matchpool_outcomes SET
--     notified_<side>_at = now() WHERE outcome_id = ...
--
-- Rollback:
--   ALTER TABLE matchpool_outcomes DROP COLUMN notified_source_at;
--   ALTER TABLE matchpool_outcomes DROP COLUMN notified_candidate_at;

ALTER TABLE public.matchpool_outcomes
  ADD COLUMN IF NOT EXISTS notified_source_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notified_candidate_at TIMESTAMPTZ;

COMMENT ON COLUMN public.matchpool_outcomes.notified_source_at IS
  'Wall-clock time when source_user_id received the Telegram notification about this match. NULL = not yet notified (or notification failed and will be retried on next poller tick).';

COMMENT ON COLUMN public.matchpool_outcomes.notified_candidate_at IS
  'Wall-clock time when candidate_user_id received the Telegram notification about this match. Same NULL semantics as notified_source_at.';
