-- Operator audit log — captures every operator SSH command attempted on an
-- edge_city VM, written by the privacy-bridge (lib/privacy-bridge-script.ts)
-- via POST /api/internal/log-operator-command.
--
-- Used by the daily sample-operator-audit cron to email each user a 5% sample
-- of recent operator activity. Building user trust is the whole point — if we
-- expect users to leave privacy mode OFF most of the time, they need a
-- continuous, low-friction view of what we're doing on their behalf.
--
-- Decision values:
--   "allowed_privacy_off" — privacy was OFF, command allowed (the default)
--   "allowed"             — privacy was ON, command in ALWAYS_ALLOWED list
--   "blocked"             — privacy was ON, command in SENSITIVE list or default-deny

CREATE TABLE IF NOT EXISTS instaclaw_operator_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id UUID NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'blocked', 'allowed_privacy_off')),
  privacy_mode_active BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operator_audit_user_time
  ON instaclaw_operator_audit_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_audit_vm
  ON instaclaw_operator_audit_log(vm_id, created_at DESC);

COMMENT ON TABLE instaclaw_operator_audit_log IS
  'Operator SSH command audit log for edge_city VMs. Written by the privacy-bridge (~/.openclaw/scripts/privacy-bridge.sh). Read by /api/cron/sample-operator-audit which mails each user a 5% sample daily.';
