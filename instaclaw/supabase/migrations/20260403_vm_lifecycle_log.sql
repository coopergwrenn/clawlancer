-- VM Lifecycle Audit Log
-- Tracks every VM deletion for auditing and debugging.
-- Created as part of the infrastructure upgrade PRD (Phase 2).

CREATE TABLE IF NOT EXISTS instaclaw_vm_lifecycle_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  vm_id UUID NOT NULL,
  vm_name TEXT,
  ip_address TEXT,
  user_id UUID,
  user_email TEXT,
  subscription_status TEXT,
  wld_confirmed_last_30d BOOLEAN DEFAULT FALSE,
  credit_balance INTEGER DEFAULT 0,
  last_message_date DATE,
  action TEXT NOT NULL, -- 'deleted', 'skipped_safety', 'skipped_grace', 'wipe_failed', 'linode_delete_failed'
  reason TEXT,
  provider_server_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying by action type and date
CREATE INDEX IF NOT EXISTS idx_vm_lifecycle_log_action ON instaclaw_vm_lifecycle_log(action);
CREATE INDEX IF NOT EXISTS idx_vm_lifecycle_log_created ON instaclaw_vm_lifecycle_log(created_at);
