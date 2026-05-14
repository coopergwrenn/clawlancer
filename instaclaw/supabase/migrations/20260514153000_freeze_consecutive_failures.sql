-- 2026-05-14: freeze_consecutive_failures column for vm-lifecycle queue fairness.
--
-- Background: the Pass 1 v2 (freeze) loop in app/api/cron/vm-lifecycle/route.ts
-- selects suspended/hibernating candidates and attempts MAX_FREEZE_PER_RUN per
-- tick (default 2). Until today the candidate query had no explicit ORDER BY,
-- so two persistently-failing VMs (vm-866 and vm-873 — both SSH-unreachable,
-- so freezeVM's "verify silence" probe times out and returns
-- "cannot verify silence (ssh-fail) — failing closed per PRD rule 11")
-- sat at the head of the result set for hours. Both consumed the 2-slot budget
-- every cron run, blocking the other 60+ legitimately-freezable VMs from ever
-- being attempted. Queue throughput: ~0/day for 5+ days. Net waste: 63
-- assigned-but-suspended Linode instances continuing to bill at $29/mo each
-- (~$1,827/mo on instances that should be image-snapshotted and deleted).
--
-- This column lets us deprioritize persistent failers without permanently
-- excluding them. After every freezeVM call the lifecycle cron either:
--   - resets this to 0 on success
--   - increments by 1 on any non-success result (skip or real failure)
-- The candidate query now ORDERs by (freeze_consecutive_failures ASC,
-- suspended_at ASC) — so low-failure-count VMs always go first and persistent
-- failers move to the back of the queue. They are still attempted, just last.
--
-- Default 0: every existing row starts at neutral priority. The first
-- vm-lifecycle tick after this migration ships establishes the failure
-- counter from observed reality.
--
-- See CLAUDE.md "v97 (2026-05-14): freeze-queue starvation fix" and the
-- in-incident report dated 2026-05-14 for the full forensic trail.

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS freeze_consecutive_failures INTEGER NOT NULL DEFAULT 0;

-- Composite index supports the new ORDER BY (failures ASC, suspended_at ASC)
-- combined with the existing health_status IN (...) + status = 'assigned' +
-- frozen_image_id IS NULL filters. Partial index keeps it small: only the
-- ~60-VM candidate population is indexed (vs the whole 240+ row fleet).
CREATE INDEX IF NOT EXISTS idx_instaclaw_vms_freeze_queue_priority
  ON instaclaw_vms (freeze_consecutive_failures, suspended_at)
  WHERE status = 'assigned'
    AND health_status IN ('suspended', 'hibernating')
    AND frozen_image_id IS NULL;

COMMENT ON COLUMN instaclaw_vms.freeze_consecutive_failures IS
  'Number of consecutive vm-lifecycle Pass 1 v2 freeze attempts that did not '
  'succeed for this VM. Resets to 0 on success. Used in the candidate ORDER BY '
  'to deprioritize VMs that keep failing (e.g., SSH-unreachable) without '
  'permanently excluding them from the queue. See app/api/cron/vm-lifecycle/'
  'route.ts and CLAUDE.md v97 entry.';
