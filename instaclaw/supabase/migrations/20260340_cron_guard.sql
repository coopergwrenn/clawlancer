-- Cron Guard: smart cron job guardrails with upsell moments
--
-- Tracks per-VM cron job state for:
--   1. Frequency warnings (< 5 min interval → suppress until confirmed)
--   2. Daily credit projection warnings (> 25% of daily limit)
--   3. Credit circuit breaker (> 50% daily credits before first manual message)

-- Per-job tracking table
CREATE TABLE IF NOT EXISTS instaclaw_cron_guard (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id uuid NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  job_name text NOT NULL,
  interval_ms bigint NOT NULL DEFAULT 0,
  schedule_expr text,
  suppressed boolean NOT NULL DEFAULT false,
  confirmed boolean NOT NULL DEFAULT false,
  projected_daily_credits numeric NOT NULL DEFAULT 0,
  warned_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(vm_id, job_name)
);

CREATE INDEX IF NOT EXISTS idx_cron_guard_vm ON instaclaw_cron_guard(vm_id);
CREATE INDEX IF NOT EXISTS idx_cron_guard_suppressed ON instaclaw_cron_guard(vm_id) WHERE suppressed = true;

-- Circuit breaker state: track first manual message per day
ALTER TABLE instaclaw_daily_usage
  ADD COLUMN IF NOT EXISTS first_manual_at timestamptz,
  ADD COLUMN IF NOT EXISTS cron_breaker_fired boolean DEFAULT false;

-- VM-level circuit breaker flag (persists until cleared)
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS cron_breaker_active boolean DEFAULT false;
