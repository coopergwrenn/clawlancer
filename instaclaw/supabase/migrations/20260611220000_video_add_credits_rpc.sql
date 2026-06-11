-- instaclaw_add_video_credits — the ONLY increment path for video_credit_balance.
--
-- Higgsfield launch build order §3.3. Clone of instaclaw_add_credits
-- (20260326_add_credits_source_param.sql), but targets the VIDEO balance and
-- writes a `video_topup` ledger row. Called by the Stripe credit-pack webhook
-- for target="video" packs (Taste/Creator/Studio).
--
-- TYPES: instaclaw_vms.video_credit_balance is NUMERIC (20260608220000), so
-- p_credits is NUMERIC and the balance math stays exact. The shared
-- instaclaw_credit_ledger has INTEGER amount/balance_after (built for message
-- credits); video top-ups are whole (pack sizes 52/156/416), so ROUND() is a
-- no-op in practice and only guards the unlikely fractional-balance case. The
-- AUTHORITATIVE, exact video balance lives in instaclaw_vms.video_credit_balance
-- + instaclaw_video_transactions; this ledger row exists so the webhook's
-- idempotency probe (vm_id + reference_id) dedups video purchases exactly like
-- credit-balance ones, plus a coarse audit trail.
--
-- No new table → no RLS change (Rule 60 n/a). Idempotency is the caller's job
-- (instaclaw_credit_purchases UNIQUE(vm_id, payment_intent) + the ledger probe);
-- this RPC is a pure increment, exactly like instaclaw_add_credits.

CREATE OR REPLACE FUNCTION instaclaw_add_video_credits(
  p_vm_id UUID,
  p_credits NUMERIC,
  p_reference_id TEXT DEFAULT NULL,
  p_source TEXT DEFAULT 'video_topup'
)
RETURNS NUMERIC AS $$
DECLARE
  new_balance NUMERIC;
BEGIN
  UPDATE instaclaw_vms
  SET video_credit_balance = COALESCE(video_credit_balance, 0) + p_credits
  WHERE id = p_vm_id
  RETURNING video_credit_balance INTO new_balance;

  INSERT INTO instaclaw_credit_ledger (vm_id, amount, balance_after, source, reference_id)
  VALUES (p_vm_id, ROUND(p_credits), ROUND(COALESCE(new_balance, 0)), p_source, p_reference_id);

  RETURN COALESCE(new_balance, 0);
END;
$$ LANGUAGE plpgsql;
