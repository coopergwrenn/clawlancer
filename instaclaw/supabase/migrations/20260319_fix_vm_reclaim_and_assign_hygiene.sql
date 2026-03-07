-- 20260319: Fix VM reclaim and assignment hygiene
--
-- PRIVACY FIX: When a VM is reclaimed (user cancels) or reassigned (new user),
-- all previous user data must be cleared from the DB record. The filesystem
-- cleanup is handled by SSH in the application layer.
--
-- BUG: instaclaw_assign_vm did not reset stale fields (ssh_fail_count,
-- health_status, etc.) from the previous assignment. New users could see
-- "Unhealthy" on their dashboard even though the VM was working.
--
-- BUG: instaclaw_reclaim_vm left many user-specific fields intact (discord,
-- channels, model, timezone, heartbeat state, etc.) which leaked to the
-- next user.

-- ============================================================
-- 1. Fix instaclaw_assign_vm — reset ALL stale fields on assign
-- ============================================================
CREATE OR REPLACE FUNCTION instaclaw_assign_vm(p_user_id UUID)
RETURNS instaclaw_vms AS $$
DECLARE
  vm instaclaw_vms;
BEGIN
  SELECT * INTO vm FROM instaclaw_vms
  WHERE status = 'ready'
    AND provider = 'linode'
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
      last_cloud_reboot = NULL
  WHERE id = vm.id;

  SELECT * INTO vm FROM instaclaw_vms WHERE id = vm.id;
  RETURN vm;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 2. Fix instaclaw_reclaim_vm — clear ALL user-specific fields
-- ============================================================
CREATE OR REPLACE FUNCTION instaclaw_reclaim_vm(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_vm_id UUID;
BEGIN
  SELECT id INTO v_vm_id FROM instaclaw_vms WHERE assigned_to = p_user_id;

  IF v_vm_id IS NULL THEN RETURN FALSE; END IF;

  UPDATE instaclaw_vms
  SET
    -- Pool status
    status = 'provisioning',
    assigned_to = NULL,
    assigned_at = NULL,
    updated_at = NOW(),
    -- Auth (revoke access)
    gateway_token = NULL,
    gateway_url = NULL,
    control_ui_url = NULL,
    -- User config (clear for next user)
    tier = NULL,
    api_mode = NULL,
    credit_balance = 0,
    default_model = NULL,
    user_timezone = NULL,
    -- Channels (clear all)
    telegram_bot_token = NULL,
    telegram_bot_username = NULL,
    telegram_chat_id = NULL,
    discord_bot_token = NULL,
    channels_enabled = NULL,
    -- Operational counters (reset)
    health_status = 'unknown',
    ssh_fail_count = 0,
    health_fail_count = 0,
    configure_attempts = 0,
    proxy_401_count = 0,
    -- Heartbeat state (clear)
    heartbeat_last_at = NULL,
    heartbeat_next_at = NULL,
    heartbeat_cycle_calls = 0,
    heartbeat_credits_used_today = 0,
    limit_notified_date = NULL,
    -- Cloud management
    cloud_reboot_count = 0,
    last_cloud_reboot = NULL,
    -- Features (reset to defaults)
    system_prompt = NULL,
    brave_api_key = NULL,
    agdp_enabled = true,
    higgsfield_enabled = false,
    solana_defi_enabled = false,
    solana_wallet_address = NULL,
    acp_auth_request_id = NULL
  WHERE id = v_vm_id;

  -- Delete all daily usage records for this VM (prevents credit leak to next user)
  DELETE FROM instaclaw_daily_usage WHERE vm_id = v_vm_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
