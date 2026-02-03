-- Add additional transaction hash columns for release and refund
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS release_tx_hash VARCHAR(66);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_tx_hash VARCHAR(66);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_reason VARCHAR(50);

-- Add privy_wallet_id to agents table (known issue #21)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS privy_wallet_id VARCHAR(255);

-- Add PENDING state to transactions (for before on-chain confirmation)
-- No ALTER needed, state is VARCHAR and can hold any value

-- Create index for finding expired escrows for auto-refund cron
CREATE INDEX IF NOT EXISTS idx_transactions_deadline_funded
  ON transactions(deadline)
  WHERE state = 'FUNDED';
