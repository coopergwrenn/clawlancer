-- Empty-completion guards (Guard 2: never bill empty) — schema + refund RPC.
--
-- INCIDENT (2026-06-10): with fable pinned, turns returned empty completions
-- (HTTP 200, stop_reason=stop, zero content blocks) AND were billed cost_weight
-- 38. The governor (instaclaw_check_and_increment) charges BEFORE the model
-- call, so an empty can't be "skipped" — it must be REFUNDED on detection.
--
-- TWO objects, both additive + idempotent:
--
-- 1. instaclaw_usage_log.billing_refunded BOOLEAN — audit flag. The empty row
--    keeps its output_tokens=0 (the fleet-wide empty-rate detector) AND its
--    cost_weight (forensic: what would have been charged); billing_refunded
--    marks it as reversed. The 2-week margin readout's "true billed" becomes
--    SUM(cost_weight) FILTER (WHERE NOT billing_refunded). Three signals all
--    survive on one row: empty-rate (output_tokens=0), refund-rate
--    (billing_refunded), true-billed (the FILTER).
--
-- 2. instaclaw_refund_empty(...) — reverses exactly what the governor charged,
--    keyed by the governor's returned `source`. The proxy passes the same
--    cost_weight + source the governor returned, so the reversal is exact:
--      daily_limit -> message_count -= w
--      credits     -> message_count -= w  AND  credit_balance += w
--      heartbeat   -> heartbeat_count -= w
--      virtuals    -> virtuals_count  -= w
--    GREATEST(0, …) floors at zero so a double-call (or a refund racing a
--    fresh increment) can never drive a counter negative. The proxy fires the
--    refund AT MOST ONCE per turn (request-scope guard), only on the FINAL
--    empty outcome — so a turn that empties-then-succeeds-on-fallback bills
--    once (at the served model's weight) and is never refunded.
--
-- FAIL-OPEN: if this RPC errors or the column write fails, the proxy swallows
-- it (the worst case is one un-refunded empty — an over-bill of one message,
-- never a serving failure). Same posture as the token-capture writes.
--
-- Apply: paste into Supabase Studio (prod), confirm success, then git mv this
-- file into supabase/migrations/ (Rule 56). The ALTER ADD COLUMN is what
-- verify-migrations gates on; the CREATE FUNCTION is not gated.

ALTER TABLE public.instaclaw_usage_log
  ADD COLUMN IF NOT EXISTS billing_refunded BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.instaclaw_usage_log.billing_refunded IS 'true = this charge was reversed (empty completion, Guard 2). Row keeps output_tokens + cost_weight; true-billed = SUM(cost_weight) FILTER (WHERE NOT billing_refunded).';

CREATE OR REPLACE FUNCTION instaclaw_refund_empty(
  p_vm_id UUID,
  p_cost_weight NUMERIC,
  p_source TEXT,
  p_timezone TEXT DEFAULT 'America/New_York'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  today DATE;
  new_count NUMERIC;
BEGIN
  today := (NOW() AT TIME ZONE p_timezone)::DATE;

  IF p_source = 'daily_limit' OR p_source = 'credits' THEN
    UPDATE instaclaw_daily_usage
      SET message_count = GREATEST(0, message_count - p_cost_weight), updated_at = NOW()
      WHERE vm_id = p_vm_id AND usage_date = today
      RETURNING message_count INTO new_count;
    IF p_source = 'credits' THEN
      -- restore the credits the governor spent (governor decremented on the credits path)
      UPDATE instaclaw_vms SET credit_balance = credit_balance + p_cost_weight WHERE id = p_vm_id;
    END IF;
    RETURN jsonb_build_object('refunded', true, 'source', p_source, 'amount', p_cost_weight, 'new_message_count', COALESCE(new_count, 0));

  ELSIF p_source = 'heartbeat' THEN
    UPDATE instaclaw_daily_usage
      SET heartbeat_count = GREATEST(0, heartbeat_count - p_cost_weight), updated_at = NOW()
      WHERE vm_id = p_vm_id AND usage_date = today
      RETURNING heartbeat_count INTO new_count;
    RETURN jsonb_build_object('refunded', true, 'source', p_source, 'amount', p_cost_weight, 'new_heartbeat_count', COALESCE(new_count, 0));

  ELSIF p_source = 'virtuals' THEN
    UPDATE instaclaw_daily_usage
      SET virtuals_count = GREATEST(0, virtuals_count - p_cost_weight), updated_at = NOW()
      WHERE vm_id = p_vm_id AND usage_date = today
      RETURNING virtuals_count INTO new_count;
    RETURN jsonb_build_object('refunded', true, 'source', p_source, 'amount', p_cost_weight, 'new_virtuals_count', COALESCE(new_count, 0));

  ELSE
    -- infrastructure / unknown sources never went through the governor's
    -- increment, so there is nothing to refund. No-op.
    RETURN jsonb_build_object('refunded', false, 'source', p_source, 'reason', 'source not governed');
  END IF;
END;
$$;
