-- ============================================
-- Audit log — admit "admin_override" decision
-- ============================================
-- The privacy-mode admin kill switch
-- (POST /api/admin/privacy-override) logs each override to
-- instaclaw_operator_audit_log so legal-compliance disables are traceable.
-- The original CHECK constraint allowed only operator-SSH decisions
-- (allowed, blocked, allowed_privacy_off). Extend it to cover the new
-- admin-side decision.
--
-- Reason field already exists (TEXT NOT NULL not enforced, but always
-- populated by the override route).
--
-- This migration is idempotent — drops the constraint if it exists,
-- re-adds with the expanded value set.

ALTER TABLE instaclaw_operator_audit_log
  DROP CONSTRAINT IF EXISTS instaclaw_operator_audit_log_decision_check;

ALTER TABLE instaclaw_operator_audit_log
  ADD CONSTRAINT instaclaw_operator_audit_log_decision_check
  CHECK (decision IN ('allowed', 'blocked', 'allowed_privacy_off', 'admin_override'));

COMMENT ON COLUMN instaclaw_operator_audit_log.decision IS
  'allowed_privacy_off=command allowed because privacy was OFF (default), allowed=command allowed under privacy mode (ALWAYS_ALLOWED list), blocked=command denied under privacy mode (SENSITIVE list or default-deny), admin_override=privacy_mode_until force-nulled by /api/admin/privacy-override (legal compliance).';
