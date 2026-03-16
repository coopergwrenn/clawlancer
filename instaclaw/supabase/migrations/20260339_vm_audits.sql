-- VM Validation Audits table
-- Stores results from the fleet validation system (vm-validate.ts)
CREATE TABLE IF NOT EXISTS instaclaw_vm_audits (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vm_id UUID REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  overall_status TEXT NOT NULL,
  critical_count INTEGER DEFAULT 0,
  warning_count INTEGER DEFAULT 0,
  checks JSONB NOT NULL,
  fixed_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_vm_audits_vm_id ON instaclaw_vm_audits(vm_id);
CREATE INDEX IF NOT EXISTS idx_vm_audits_created ON instaclaw_vm_audits(created_at DESC);
