-- Operator quarantine (2026-05-20, P1-7).
--
-- The 2026-05-20 vm-043 incident: an operator manually flipped
-- vm-043 to status='failed' to quarantine it. A cron (likely the
-- health-check auto-recovery at app/api/cron/health-check/route.ts
-- line 2779-2783) detected the gateway was healthy and silently
-- flipped status back to 'assigned' (or further down a path that
-- ended at 'ready'), undoing the operator's intent. No audit trail.
--
-- The existing `reconcile_quarantined_at` and `watchdog_quarantined_at`
-- columns are CRON-OWNED (set by reconcile-fleet on 5+ failures and
-- the watchdog system on its own criteria). Mixing operator-set
-- quarantines into those columns conflates semantics — the next
-- cron tick that "succeeds" against the VM would clear the operator's
-- intent.
--
-- The fix: a NEW operator-owned column. Every cron that mutates
-- instaclaw_vms.status MUST check `operator_quarantined_at IS NULL`
-- before any flip. Operators set this manually via
-- scripts/_quarantine-vm.ts <vm_name> or a direct SQL update; nothing
-- in cron code ever writes to it.
--
-- Schema:
--   `operator_quarantined_at TIMESTAMPTZ NULL`
--     - NULL (default) → cron behavior unchanged
--     - Non-NULL → status mutations from cron paths refuse to fire
--
-- Rollback: ALTER TABLE … DROP COLUMN operator_quarantined_at.
-- Safe — cron code falls back to unmodified pre-this-change behavior
-- when the column doesn't exist (no foreign key, no constraint).

ALTER TABLE public.instaclaw_vms
  ADD COLUMN IF NOT EXISTS operator_quarantined_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.instaclaw_vms.operator_quarantined_at IS
  'Operator-set quarantine timestamp. When non-NULL, all cron-driven status mutations skip this VM. Set via scripts/_quarantine-vm.ts. Distinct from reconcile_quarantined_at / watchdog_quarantined_at which are cron-owned. See CLAUDE.md "Operator quarantine durability".';

-- Index on the partial-non-null set so the cron gate-check is cheap.
CREATE INDEX IF NOT EXISTS idx_vms_operator_quarantined_at
  ON public.instaclaw_vms (operator_quarantined_at)
  WHERE operator_quarantined_at IS NOT NULL;
