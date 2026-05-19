-- 20260519220000_vm_gbrain_enabled.sql
--
-- Add gbrain_enabled column for fleet rollout canary mechanism.
-- See instaclaw/docs/prd/gbrain-fleet-rollout-canary-2026-05-19.md.
--
-- Three-state semantics (read by isGbrainEligibleForVM in lib/vm-reconcile.ts):
--   NULL  (default) → follow partner allowlist (current pre-v107 behavior)
--   true            → explicitly enable (canary cohort)
--   false           → explicitly disable (rollback hatch for known-broken VMs)
--
-- Partial index targets the canary lookup specifically — avoids index bloat
-- on the NULL majority. Healthy + assigned + partner=null + canary=true is
-- the canary candidate filter; partial index on `gbrain_enabled = true` makes
-- this a cheap lookup.
--
-- Rule 56: this file lives in pending_migrations/ until applied to prod,
-- then promoted to migrations/ in the same commit that lands the code that
-- references gbrain_enabled.

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS gbrain_enabled BOOLEAN DEFAULT NULL;

CREATE INDEX IF NOT EXISTS instaclaw_vms_gbrain_enabled_partial
  ON instaclaw_vms (id)
  WHERE gbrain_enabled = true;

COMMENT ON COLUMN instaclaw_vms.gbrain_enabled IS
  'Three-state gbrain canary opt-in. NULL = follow partner allowlist (default); true = canary enable; false = explicit disable (rollback hatch). See isGbrainEligibleForVM in lib/vm-reconcile.ts. PRD: docs/prd/gbrain-fleet-rollout-canary-2026-05-19.md.';
