-- C6 FIX: Prevent double-credit race condition on WLD delegations.
-- Add UNIQUE constraint on transaction_id to prevent duplicate confirmations.

-- For instaclaw_wld_delegations: transaction_id is the reference UUID
ALTER TABLE instaclaw_wld_delegations
  ADD CONSTRAINT uq_wld_delegations_transaction_id UNIQUE (transaction_id);

-- For instaclaw_world_payments: reference is the payment reference UUID
ALTER TABLE instaclaw_world_payments
  ADD CONSTRAINT uq_world_payments_reference UNIQUE (reference);
