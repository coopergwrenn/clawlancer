-- Phase 2 — vm-lifecycle cron fix
-- See: instaclaw/docs/prd-vm-cost-optimization.md

-- ─── 1. Forensic log for orphan deletions ────────────────────────────────
-- Append-only audit table. Every Pass -1 decision (delete or skip) is
-- logged here with full forensic data so we can investigate root cause
-- of orphan accumulation later.

CREATE TABLE IF NOT EXISTS instaclaw_orphan_deletion_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  linode_id          BIGINT,                       -- nullable just in case
  vm_label           TEXT,                          -- linode label (best effort)
  vm_db_id           UUID,                          -- instaclaw_vms.id if row existed
  user_id            UUID,                          -- assigned user if row existed
  user_email         TEXT,                          -- denormalized for log forensics
  action             TEXT NOT NULL,                 -- delete_db_dead | delete_no_db | skip_active | skip_safety | skip_too_young | skip_infra
  reason             TEXT NOT NULL,
  linode_created_at  TIMESTAMPTZ,                   -- when Linode was created
  linode_tags        TEXT[],
  linode_type        TEXT,
  monthly_cost_usd   INTEGER,
  run_id             TEXT NOT NULL,                 -- UUID per cron run for grouping
  cron_route         TEXT NOT NULL,                 -- "cron/vm-lifecycle" for now
  dry_run            BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orphan_log_run ON instaclaw_orphan_deletion_log(run_id);
CREATE INDEX IF NOT EXISTS idx_orphan_log_linode ON instaclaw_orphan_deletion_log(linode_id);
CREATE INDEX IF NOT EXISTS idx_orphan_log_action_created ON instaclaw_orphan_deletion_log(action, created_at DESC);

COMMENT ON TABLE instaclaw_orphan_deletion_log IS
  'Append-only forensic log for Pass -1 (Linode → DB orphan reconciliation) of vm-lifecycle cron. See prd-vm-cost-optimization.md.';

-- ─── 2. Per-VM lifecycle lock (Phase 2 + 3 race protection) ──────────────
-- Used to prevent freeze/thaw races. Set to NOW() before starting any
-- destructive lifecycle operation; cleared on completion. Cron skips any
-- VM with non-null lifecycle_locked_at younger than 15 minutes (in flight).
-- A non-null lock older than 15 min indicates a stuck operation — admin
-- alert recommended.

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS lifecycle_locked_at TIMESTAMPTZ;

COMMENT ON COLUMN instaclaw_vms.lifecycle_locked_at IS
  'Set when a freeze/thaw/orphan-delete operation is in flight. Cleared on completion. NULL = idle. Older than 15 min = stuck (alert admin).';

-- ─── 3. Phase 2 kill switches ────────────────────────────────────────────
-- Both default to safe values:
--   orphan_reconciliation_enabled = true  → Pass -1 IS active. Safe because
--     orphans have no user data and pre-flight checks (Stripe, activity,
--     age, infra-protect) gate every delete.
--   vm_lifecycle_v2_enabled = false → Pass 1 keeps LEGACY behavior. The
--     new logic (drop world_id_verified skip, 30-day uniform grace) is
--     coded but inert until Phase 3's freeze/thaw is operational, at
--     which point flipping this flag turns Pass 1 into "freeze instead
--     of delete" with the new protection rules. This prevents the case
--     where Phase 2 alone would destroy ~50 users' data permanently
--     before Phase 3 lands to preserve it.

INSERT INTO instaclaw_admin_settings (setting_key, bool_value, notes, updated_at)
VALUES
  (
    'orphan_reconciliation_enabled',
    true,
    'Master switch for Pass -1 (Linode → DB orphan reconciliation). When true, vm-lifecycle deletes Linodes that are running but have no healthy DB row, after Stripe + 7-day-activity + WLD-credits + infra-protect + age safety checks. When false, Pass -1 is a no-op. Phase 2 of prd-vm-cost-optimization.md.',
    NOW()
  ),
  (
    'vm_lifecycle_v2_enabled',
    false,
    'Master switch for Pass 1 v2 (drop world_id_verified blanket-skip, 30-day uniform grace, freeze-instead-of-delete). When false (default for Phase 2 ship), Pass 1 keeps legacy behavior. Phase 3 will flip this to true once freeze/thaw flow is operational so we never destroy data. DO NOT FLIP MANUALLY until Phase 3 ships.',
    NOW()
  )
ON CONFLICT (setting_key) DO NOTHING;
