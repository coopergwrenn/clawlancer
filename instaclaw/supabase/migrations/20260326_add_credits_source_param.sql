-- Add p_source parameter to instaclaw_add_credits
-- Default 'stripe' for backward compatibility — callers can now pass 'wld', 'admin', etc.

CREATE OR REPLACE FUNCTION instaclaw_add_credits(
  p_vm_id UUID,
  p_credits INTEGER,
  p_reference_id TEXT DEFAULT NULL,
  p_source TEXT DEFAULT 'stripe'
)
RETURNS INTEGER AS $$
DECLARE
  new_balance INTEGER;
BEGIN
  UPDATE instaclaw_vms
  SET credit_balance = COALESCE(credit_balance, 0) + p_credits
  WHERE id = p_vm_id
  RETURNING credit_balance INTO new_balance;

  INSERT INTO instaclaw_credit_ledger (vm_id, amount, balance_after, source, reference_id)
  VALUES (p_vm_id, p_credits, COALESCE(new_balance, 0), p_source, p_reference_id);

  RETURN COALESCE(new_balance, 0);
END;
$$ LANGUAGE plpgsql;
