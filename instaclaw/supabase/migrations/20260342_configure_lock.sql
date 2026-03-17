-- Add configure_lock_at column to prevent concurrent configures on the same VM.
-- When a configure starts, this is set to NOW(). Cleared on success/failure.
-- A 5-minute expiry acts as a safety net for crashed configures.
ALTER TABLE instaclaw_vms ADD COLUMN IF NOT EXISTS configure_lock_at TIMESTAMPTZ DEFAULT NULL;

-- Update instaclaw_assign_vm to skip VMs with active configure locks.
-- This prevents assigning a VM that is mid-configure for another user.
CREATE OR REPLACE FUNCTION instaclaw_assign_vm(p_user_id UUID)
RETURNS instaclaw_vms AS $$
DECLARE
  vm instaclaw_vms;
BEGIN
  SELECT * INTO vm FROM instaclaw_vms
  WHERE status = 'ready'
    AND provider = 'linode'
    AND (configure_lock_at IS NULL OR configure_lock_at < NOW() - INTERVAL '5 minutes')
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF vm IS NULL THEN RETURN NULL; END IF;

  UPDATE instaclaw_vms
  SET status = 'assigned',
      assigned_to = p_user_id,
      assigned_at = NOW(),
      updated_at = NOW(),
      -- Reset stale operational fields from previous assignment
      health_status = 'unknown',
      ssh_fail_count = 0,
      health_fail_count = 0,
      configure_attempts = 0,
      proxy_401_count = 0,
      heartbeat_cycle_calls = 0,
      limit_notified_date = NULL,
      cloud_reboot_count = 0,
      last_cloud_reboot = NULL,
      configure_lock_at = NULL
  WHERE id = vm.id;

  SELECT * INTO vm FROM instaclaw_vms WHERE id = vm.id;
  RETURN vm;
END;
$$ LANGUAGE plpgsql;

-- Update instaclaw_reclaim_vm to clear configure_lock_at when reclaiming a VM.
CREATE OR REPLACE FUNCTION instaclaw_reclaim_vm(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_vm_id UUID;
  old_balance INTEGER;
BEGIN
  SELECT id INTO v_vm_id FROM instaclaw_vms WHERE assigned_to = p_user_id;

  IF v_vm_id IS NULL THEN RETURN FALSE; END IF;

  -- Capture old balance before zeroing
  SELECT COALESCE(credit_balance, 0) INTO old_balance
  FROM instaclaw_vms WHERE id = v_vm_id;

  UPDATE instaclaw_vms
  SET
    status = 'provisioning',
    assigned_to = NULL,
    assigned_at = NULL,
    updated_at = NOW(),
    gateway_token = NULL,
    gateway_url = NULL,
    control_ui_url = NULL,
    tier = NULL,
    api_mode = NULL,
    credit_balance = 0,
    default_model = NULL,
    user_timezone = NULL,
    telegram_bot_token = NULL,
    telegram_bot_username = NULL,
    telegram_chat_id = NULL,
    discord_bot_token = NULL,
    channels_enabled = NULL,
    health_status = 'unknown',
    ssh_fail_count = 0,
    health_fail_count = 0,
    configure_attempts = 0,
    proxy_401_count = 0,
    heartbeat_last_at = NULL,
    heartbeat_next_at = NULL,
    heartbeat_cycle_calls = 0,
    heartbeat_credits_used_today = 0,
    limit_notified_date = NULL,
    cloud_reboot_count = 0,
    last_cloud_reboot = NULL,
    system_prompt = NULL,
    brave_api_key = NULL,
    agdp_enabled = true,
    higgsfield_enabled = false,
    solana_defi_enabled = false,
    solana_wallet_address = NULL,
    acp_auth_request_id = NULL,
    configure_lock_at = NULL
  WHERE id = v_vm_id;

  -- Log credit zeroing (only if there were credits to reclaim)
  IF old_balance > 0 THEN
    INSERT INTO instaclaw_credit_ledger (vm_id, amount, balance_after, source)
    VALUES (v_vm_id, -old_balance, 0, 'reclaim');
  END IF;

  DELETE FROM instaclaw_daily_usage WHERE vm_id = v_vm_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
