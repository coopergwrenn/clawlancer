-- Bankr Partnership Integration: wallet provisioning + tokenization columns
-- These columns support auto-provisioned Bankr wallets and agent tokenization.
-- Partner API: https://api.bankr.bot/partner/wallets

-- 1. Add Bankr wallet + token columns to instaclaw_vms
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS bankr_wallet_id VARCHAR(32),
  ADD COLUMN IF NOT EXISTS bankr_evm_address VARCHAR(42),
  ADD COLUMN IF NOT EXISTS bankr_api_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS bankr_token_address VARCHAR(42),
  ADD COLUMN IF NOT EXISTS bankr_token_symbol VARCHAR(10),
  ADD COLUMN IF NOT EXISTS bankr_token_launched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tokenization_platform VARCHAR(20);

COMMENT ON COLUMN instaclaw_vms.bankr_wallet_id IS 'Bankr wallet ID (wlt_...) from partner provisioning API';
COMMENT ON COLUMN instaclaw_vms.bankr_evm_address IS 'EVM wallet address on Base from Bankr';
COMMENT ON COLUMN instaclaw_vms.bankr_api_key_encrypted IS 'Encrypted Bankr API key (bk_usr_...) — shown once at creation';
COMMENT ON COLUMN instaclaw_vms.bankr_token_address IS 'Agent token contract address on Base (after tokenization)';
COMMENT ON COLUMN instaclaw_vms.bankr_token_symbol IS 'Agent token symbol (e.g. $AGENT)';
COMMENT ON COLUMN instaclaw_vms.bankr_token_launched_at IS 'When the agent token was launched';
COMMENT ON COLUMN instaclaw_vms.tokenization_platform IS 'Which platform the agent is tokenized on: bankr, virtuals, or NULL';

CREATE INDEX IF NOT EXISTS idx_vms_bankr_wallet ON instaclaw_vms(bankr_wallet_id) WHERE bankr_wallet_id IS NOT NULL;

-- 2. Update instaclaw_reclaim_vm to clear Bankr fields on VM reclaim
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
    -- Clear Bankr fields (wallet persists on Bankr side, just disassociate)
    bankr_wallet_id = NULL,
    bankr_evm_address = NULL,
    bankr_api_key_encrypted = NULL,
    bankr_token_address = NULL,
    bankr_token_symbol = NULL,
    bankr_token_launched_at = NULL,
    tokenization_platform = NULL
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
