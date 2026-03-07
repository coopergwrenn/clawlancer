-- 20260319b: Fix ambiguous vm_id column reference in instaclaw_reclaim_vm
-- The variable `vm_id` shadowed the column name `vm_id` in the DELETE statement,
-- causing `WHERE vm_id = vm_id` to always be true (deleting ALL rows).

CREATE OR REPLACE FUNCTION instaclaw_reclaim_vm(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_vm_id UUID;
BEGIN
  SELECT id INTO v_vm_id FROM instaclaw_vms WHERE assigned_to = p_user_id;

  IF v_vm_id IS NULL THEN RETURN FALSE; END IF;

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
    acp_auth_request_id = NULL
  WHERE id = v_vm_id;

  DELETE FROM instaclaw_daily_usage WHERE vm_id = v_vm_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
