-- 062: Harden instaclaw_reclaim_vm against terminal-state resurrection
--
-- Background: instaclaw_reclaim_vm() finds a VM by assigned_to and flips it
-- back to status='provisioning' for re-use. Pre-fix, the function had no
-- status guard — if the user's VM had been terminated by vm-lifecycle but
-- assigned_to still carried their ID (vm-lifecycle's delete pass doesn't
-- clear it), the RPC would resurrect status='terminated' → 'provisioning'
-- without touching health_status. The row would then leak into pool counts
-- (replenish-pool's "active VMs" includes provisioning) and any candidate
-- query that doesn't explicitly exclude provisioning.
--
-- The JS-side callers (admin/vms/actions, cron/health-check 30-day reclaim)
-- already added status checks pre-RPC in the 2026-05-12 hardening pass, but
-- those checks aren't atomic with the RPC — a race window remains where
-- vm-lifecycle could terminate the VM between the JS check and the RPC's
-- internal SELECT. This migration closes that window at the SQL layer.
--
-- Fix: status guard on BOTH the SELECT (refuse to pick up a terminal row)
-- AND the UPDATE WHERE clause (refuse to write if the row became terminal
-- between SELECT and UPDATE). Both clauses are necessary because the
-- function doesn't take a row lock (`FOR UPDATE`) on the SELECT.

CREATE OR REPLACE FUNCTION instaclaw_reclaim_vm(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  vm_id UUID;
BEGIN
  SELECT id INTO vm_id FROM instaclaw_vms
  WHERE assigned_to = p_user_id
    AND status NOT IN ('terminated', 'destroyed', 'failed');

  IF vm_id IS NULL THEN RETURN FALSE; END IF;

  UPDATE instaclaw_vms
  SET
    status = 'provisioning',
    assigned_to = NULL,
    assigned_at = NULL,
    gateway_token = NULL,
    gateway_url = NULL,
    control_ui_url = NULL,
    tier = NULL,
    api_mode = NULL,
    credit_balance = 0,
    updated_at = NOW()
  WHERE id = vm_id
    AND status NOT IN ('terminated', 'destroyed', 'failed');

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
