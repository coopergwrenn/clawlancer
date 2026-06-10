-- ─────────────────────────────────────────────────────────────────────────────
-- Video DELIVERY idempotency — instaclaw_video_claim_delivery.
--
-- THE BUG (2026-06-10, higgsfield-cloud e2e canary on vm-050): the completion
-- webhook delivered the same render twice (soul/standard's webhook double-fired
-- at 3:57 + 3:58). Higgsfield retries the webhook until 2xx, and our handler is
-- slow (it fetches the asset and uploads it to Telegram INLINE before returning
-- 200), so a retry lands mid-flight and the unconditional delivery code runs
-- again. The settle RPC is idempotent, but DELIVERY had no dedup — "keyed on the
-- render id, not just the hold" (Cooper's ruling).
--
-- THE FIX: an atomic claim keyed on the render's row (vm_id, request_id) — which
-- is 1:1 with the Higgsfield request_id. The webhook calls this BEFORE
-- delivering; only the winner (the first call to flip the delivered_at marker)
-- proceeds. Row-level locking makes the conditional UPDATE a single-winner CAS:
-- a concurrent retry blocks on the row, re-evaluates the WHERE after the winner
-- commits, matches 0 rows, and returns false → skips. Separate from the settle
-- CAS so it's a true delivery-specific dedup.
--
-- Function-only (no schema change). The delivered_at marker lives in the
-- existing metadata jsonb.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION instaclaw_video_claim_delivery(
  p_vm_id       uuid,
  p_request_id  text
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE instaclaw_video_transactions
     SET metadata = metadata || jsonb_build_object('delivered_at', now())
   WHERE vm_id = p_vm_id
     AND request_id = p_request_id
     AND NOT (metadata ? 'delivered_at')
   RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;  -- true = we won the claim and should deliver
END;
$$;
