-- Per-VM reconciler-failure tracking + quarantine.
--
-- Motivation: 2026-05-11 audit surfaced 53 paying customers running on
-- stale config for 33-86 days. The reconciler had been silently failing
-- on them every cron tick for months, but the only signal was an
-- `errored++` counter in per-tick cron-response JSON that disappears the
-- moment the function returns. No persistent record. No counter. No
-- alert. No way for an operator to know.
--
-- Mirror of the watchdog_* pattern (already in this table). Same shape,
-- same K=10 quarantine threshold, same dedup-via-alert-log alerting.
--
-- Design choices:
--   - Five new columns (counter + first/last failure timestamps + last
--     error string + quarantine flag).
--   - reconcile_quarantined_at is the GATE — when set, the reconcile-fleet
--     cron's eligibility query EXCLUDES the VM. Stops wasted cron cycles.
--     Operator manually clears via UPDATE to re-enable reconciliation.
--   - reconcile_last_error captures up to 500 chars of the joined errors
--     so an operator can immediately see what step is failing without
--     needing access to ephemeral cron logs.
--   - All defaults are safe (counter=0, timestamps NULL, quarantine NULL)
--     so no behavior change for VMs without the failure history.

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS reconcile_consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reconcile_first_failure_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconcile_last_failure_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconcile_last_error TEXT,
  ADD COLUMN IF NOT EXISTS reconcile_quarantined_at TIMESTAMPTZ;

COMMENT ON COLUMN instaclaw_vms.reconcile_consecutive_failures IS
  'Number of consecutive reconcile-fleet cron cycles where this VM hit pushFailed (result.errors non-empty). Reset to 0 on successful cv bump. K=10 triggers reconcile_quarantined_at + admin alert.';

COMMENT ON COLUMN instaclaw_vms.reconcile_first_failure_at IS
  'When the current failure streak started. NULL = no current failures. Cleared on successful cv bump.';

COMMENT ON COLUMN instaclaw_vms.reconcile_last_failure_at IS
  'When the most recent reconcile failure occurred for this VM.';

COMMENT ON COLUMN instaclaw_vms.reconcile_last_error IS
  'First 500 chars of the joined result.errors from the most recent failed reconcile cycle. Surfaces what specific step is failing without needing access to ephemeral Vercel cron logs.';

COMMENT ON COLUMN instaclaw_vms.reconcile_quarantined_at IS
  'When this VM was auto-quarantined from the reconcile-fleet eligibility filter (after K=10 consecutive failures). NULL = not quarantined. Operator clears with UPDATE to re-enable.';

CREATE INDEX IF NOT EXISTS instaclaw_vms_reconcile_quarantined_idx
  ON instaclaw_vms (reconcile_quarantined_at)
  WHERE reconcile_quarantined_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS instaclaw_vms_reconcile_failures_idx
  ON instaclaw_vms (reconcile_consecutive_failures)
  WHERE reconcile_consecutive_failures > 0;
