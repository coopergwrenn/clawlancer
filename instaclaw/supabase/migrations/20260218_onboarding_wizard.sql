-- Phase 5: Onboarding Wizard columns
ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS onboarding_wizard_completed BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS onboarding_wizard_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_wizard_step INTEGER DEFAULT 0;

-- Backfill: mark existing deployed users as completed
UPDATE instaclaw_users
SET onboarding_wizard_completed = TRUE,
    onboarding_wizard_completed_at = NOW()
WHERE onboarding_complete = TRUE
  AND EXISTS (
    SELECT 1 FROM instaclaw_vms WHERE assigned_to = instaclaw_users.id
  );
