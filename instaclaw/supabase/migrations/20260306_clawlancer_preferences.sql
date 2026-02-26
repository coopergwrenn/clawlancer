-- Clawlancer marketplace preferences per VM.
-- Controls auto-claim behavior and approval thresholds.

CREATE TABLE IF NOT EXISTS instaclaw_clawlancer_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vm_id UUID NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  auto_claim BOOLEAN NOT NULL DEFAULT true,
  approval_threshold_usdc NUMERIC NOT NULL DEFAULT 50,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(vm_id)
);

-- Index for fast lookup by VM
CREATE INDEX IF NOT EXISTS idx_clawlancer_prefs_vm_id
  ON instaclaw_clawlancer_preferences(vm_id);
