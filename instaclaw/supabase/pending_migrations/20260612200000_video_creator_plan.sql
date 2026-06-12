-- ─────────────────────────────────────────────────────────────────────────────
-- VIDEO CREATOR PLAN — the platform's reference implementation for
-- subscriptions-with-consumable-allowances. (Build 2026-06-12, F1-F4 ruled (a).)
--
-- $44.99/mo → 546 vc/month (42 premium clips × 13 vc) = $1.07/clip effective:
-- 24% margin at current COGS, ~5% under an HF+25% shock, ~39% if wholesale
-- lands. Sub floor rule (standing): no subscription below $1.05/clip
-- effective without re-running the shock math.
--
-- ── DIVERGENCE WHY #1: NO ROLLOVER ──
-- Industry is mixed (ElevenLabs/Lovable cap rollover at ~2x; Runway none).
-- Ours is deliberate: rollover stockpiles convert a 24%-margin plan into a
-- deferred COGS liability; the $1.07/clip effective rate only holds if the
-- allowance expires. Capped-rollover is the v2 lever if churn data demands
-- it. The grant SETs (never increments) — no-rollover falls out of the
-- mechanism itself.
--
-- ── DIVERGENCE WHY #2: FREEZE-not-grace on past_due ──
-- The PLATFORM sub gives a 7-day grace window (it protects the user's core
-- agent). The video allowance freezes immediately on past_due: it is a
-- high-COGS luxury add-on where grace is real dollars per render, and PACKS
-- REMAIN USABLE so the user is never bricked — they lose the discounted
-- lane, not the capability. The freeze is read-side (the reserve gate below
-- requires status='active'), so recovery is instant when the invoice pays
-- and the grant flips status back.
--
-- CONTENTS (one reviewable unit):
--   1. Five plan columns on instaclaw_vms (F2: same row as the balance →
--      the per-VM advisory lock makes grant/burn/refund atomic for free).
--   2. instaclaw_video_plan_grant — the ONE grant mechanism (invoice.paid).
--   3. instaclaw_video_reserve_spend — (D) allowance-before-balance burn
--      with boundary split (F1+F3).
--   4. instaclaw_video_settle — (D) split-aware balance debit.
--   5. instaclaw_video_release — (D) same-period allowance refund.
-- 3-5 are byte-careful clones of current prod (incl. the (A)/(B)/(C) fixes)
-- with the (D) blocks marked. No new tables → no RLS change (Rule 60 n/a).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Plan state columns ────────────────────────────────────────────────────
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS video_plan_stripe_sub_id TEXT,
  ADD COLUMN IF NOT EXISTS video_plan_status TEXT,
  ADD COLUMN IF NOT EXISTS video_plan_allowance_remaining NUMERIC NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS video_plan_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS video_plan_last_invoice_id TEXT;

-- ── 2. THE GRANT — invoice.paid only (Stripe's canonical provision shape). ──
-- Takes the SAME per-VM advisory lock as reserve/settle/release: a grant can
-- never race a render. Idempotency pair (Finding 3):
--   p_invoice_id <> last_invoice_id   (a retry of the same invoice skips)
--   AND p_period_end >= stored        (>= NOT >: a late-paying dunning
--     invoice whose period subscription.updated already advanced MUST still
--     grant; a stale PRIOR-period retry (<) must not. Same-period different-
--     invoice cannot occur in v1 — single price, no proration events.)
-- SET-not-increment: even a guard-bypassing same-period replay is value-
-- idempotent, and no-rollover is the mechanism, not a cleanup job.
CREATE OR REPLACE FUNCTION instaclaw_video_plan_grant(
  p_vm_id       uuid,
  p_invoice_id  text,
  p_sub_id      text,
  p_status      text,
  p_period_end  timestamptz,
  p_allowance   numeric
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_last_invoice text;
  v_period_end   timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_vm_id::text));

  SELECT video_plan_last_invoice_id, video_plan_period_end
    INTO v_last_invoice, v_period_end
    FROM instaclaw_vms WHERE id = p_vm_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'vm_not_found');
  END IF;

  IF v_last_invoice IS NOT NULL AND v_last_invoice = p_invoice_id THEN
    RETURN jsonb_build_object('granted', false, 'idempotent', true, 'reason', 'duplicate_invoice');
  END IF;

  IF v_period_end IS NOT NULL AND p_period_end < v_period_end THEN
    -- Stale prior-period invoice retry arriving after a newer grant: granting
    -- would rewind the period AND resurrect expired allowance. Skip.
    RETURN jsonb_build_object('granted', false, 'idempotent', true, 'reason', 'stale_period');
  END IF;

  UPDATE instaclaw_vms
     SET video_plan_allowance_remaining = p_allowance,  -- SET: no-rollover by mechanism
         video_plan_period_end          = p_period_end,
         video_plan_status              = p_status,
         video_plan_stripe_sub_id       = COALESCE(p_sub_id, video_plan_stripe_sub_id),
         video_plan_last_invoice_id     = p_invoice_id
   WHERE id = p_vm_id;

  RETURN jsonb_build_object('granted', true, 'allowance', p_allowance,
                            'period_end', p_period_end);
END;
$$;

-- ── 3. RESERVE — (D) allowance-before-balance with boundary split. ──────────
-- Clone of prod (20260611230000, incl. (A) consumed-slots fix, (B) fail-closed
-- cap, (C) seed exclusion) + the (D) blocks. Allowance accounting is EAGER-
-- decrement (refunded by release within the same period); balance keeps its
-- proven holds-sum accounting. The asymmetry is deliberate: eager means a new
-- period's grant SET never has to reason about old-period in-flight holds —
-- their release refunds check period identity and no-op across the boundary.
CREATE OR REPLACE FUNCTION instaclaw_video_reserve_spend(
  p_vm_id                 uuid,
  p_request_id            text,
  p_endpoint              text,
  p_est_credits           numeric,
  p_hf_cost_credits       numeric,
  p_is_free               boolean,
  p_free_cap_daily        integer,
  p_cap_daily             numeric,
  p_window_start          timestamptz,
  p_fresh_pending_cutoff  timestamptz,
  p_metadata              jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance      numeric;
  v_holds        numeric;
  v_settled      numeric;
  v_free_used    integer;
  v_available    numeric;
  v_id           uuid;
  -- (D) plan locals
  v_plan_status      text;
  v_plan_period_end  timestamptz;
  v_plan_allowance   numeric;
  v_plan_active      boolean;
  v_plan_used        numeric := 0;
  v_balance_need     numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_vm_id::text));

  -- ── Free path: count CONSUMED slots, then a zero-cost hold. ──
  IF p_is_free THEN
    SELECT COUNT(*) INTO v_free_used
    FROM instaclaw_video_transactions
    WHERE vm_id = p_vm_id
      AND is_free = true
      AND status IN ('pending','settled')  -- (A) FIX 2026-06-10: only CONSUMED slots count.
      AND (metadata->>'seed') IS DISTINCT FROM 'true'  -- (C) FIX 2026-06-11: the first-video
                                            --     seed is a GIFT on top of the daily
                                            --     allowance, never a swap for it.
      AND created_at >= p_window_start;     --     A released/failed hold (sweeper, submit_failed,
                                            --     nsfw, provider failure) delivered nothing + was
                                            --     refunded, so it must NOT burn the allowance.
    IF v_free_used >= COALESCE(p_free_cap_daily, 0) THEN
      RETURN jsonb_build_object('reserved', false, 'reason', 'free_exhausted', 'free_used', v_free_used);
    END IF;

    INSERT INTO instaclaw_video_transactions
      (request_id, vm_id, endpoint, est_credits, hf_cost_credits, is_free, status, metadata)
    VALUES
      (p_request_id, p_vm_id, p_endpoint, 0, p_hf_cost_credits, true, 'pending', p_metadata)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('reserved', true, 'id', v_id, 'free', true, 'free_used', v_free_used + 1);
  END IF;

  -- ── Paid path. (B) Fail CLOSED if no daily ceiling was supplied. ──
  IF p_cap_daily IS NULL THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'no_cap_provided');
  END IF;

  -- (D) Read plan state + balance in ONE row read, under the lock.
  SELECT video_credit_balance, video_plan_status, video_plan_period_end,
         video_plan_allowance_remaining
    INTO v_balance, v_plan_status, v_plan_period_end, v_plan_allowance
    FROM instaclaw_vms WHERE id = p_vm_id;

  -- Re-sum committed (settled + fresh pending) under the lock.
  -- (D) Split-aware: a hold's BALANCE portion is what pins the balance — the
  -- plan portion was eagerly debited from the allowance at reserve. Legacy
  -- rows (no split metadata) COALESCE to their full est_credits, so the
  -- proven pack path's availability math is BYTE-IDENTICAL for them.
  SELECT COALESCE(SUM(COALESCE((metadata->>'balance_used')::numeric, est_credits)), 0)
    INTO v_holds
  FROM instaclaw_video_transactions
  WHERE vm_id = p_vm_id AND is_free = false AND status = 'pending'
    AND created_at >= p_fresh_pending_cutoff;

  SELECT COALESCE(SUM(settled_credits), 0) INTO v_settled
  FROM instaclaw_video_transactions
  WHERE vm_id = p_vm_id AND is_free = false AND status = 'settled'
    AND created_at >= p_window_start;

  -- Per-VM daily paid ceiling (always bound now — NULL was rejected above).
  -- (D) note: the ceiling counts the WHOLE est (plan + balance portions) —
  -- it is the anti-runaway blast-radius cap and plan renders are real COGS.
  IF (v_settled + v_holds + p_est_credits) > p_cap_daily THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'exceeds_daily_ceiling',
                              'committed', v_settled + v_holds);
  END IF;

  -- (D) F1+F3: allowance-before-balance, with boundary split. The plan lane
  -- is usable only while status='active' AND the period hasn't lapsed (the
  -- F4 freeze is the status check; period expiry is the second blade — a
  -- canceled-at-period-end plan dies here at the boundary even before the
  -- deleted webhook lands).
  v_plan_active := (v_plan_status = 'active' AND v_plan_period_end IS NOT NULL
                    AND v_plan_period_end > now());
  IF v_plan_active THEN
    v_plan_used := LEAST(GREATEST(COALESCE(v_plan_allowance, 0), 0), p_est_credits);
  END IF;
  v_balance_need := p_est_credits - v_plan_used;

  -- Balance gate — only the BALANCE portion needs covering.
  v_available := COALESCE(v_balance, 0) - v_holds;
  IF v_balance_need > 0 AND v_balance_need > v_available THEN
    -- (D) plan_status rides the denial so the gate can tell the user the
    -- truth (e.g. past_due → "payment issue with your video plan; packs
    -- still work") instead of a generic insufficient-credits.
    RETURN jsonb_build_object('reserved', false, 'reason', 'insufficient_balance',
                              'available', v_available, 'required', v_balance_need,
                              'plan_status', v_plan_status);
  END IF;

  -- (D) Eager allowance debit (refund path: release, same-period only).
  IF v_plan_used > 0 THEN
    UPDATE instaclaw_vms
       SET video_plan_allowance_remaining = video_plan_allowance_remaining - v_plan_used
     WHERE id = p_vm_id;
  END IF;

  INSERT INTO instaclaw_video_transactions
    (request_id, vm_id, endpoint, est_credits, hf_cost_credits, is_free, status, metadata)
  VALUES
    (p_request_id, p_vm_id, p_endpoint, p_est_credits, p_hf_cost_credits, false, 'pending',
     -- (D) The split is recorded ON THE HOLD: settle debits balance by
     -- balance_used only; release refunds plan_used only within the period
     -- whose identity is captured here. Gate-constructed, not caller-forgeable.
     p_metadata || jsonb_build_object(
       'plan_used', v_plan_used,
       'balance_used', v_balance_need,
       'plan_period_end_at_hold', v_plan_period_end))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('reserved', true, 'id', v_id, 'held', p_est_credits,
                            'plan_used', v_plan_used, 'balance_used', v_balance_need,
                            'available_before', v_available);
EXCEPTION
  WHEN unique_violation THEN
    -- (D) NOTE: the eager allowance debit above cannot leak here — the
    -- unique violation fires ON the INSERT, which Postgres rolls back along
    -- with the debit (same transaction). Idempotent retry semantics intact.
    RETURN jsonb_build_object('reserved', false, 'conflict', true, 'reason', 'duplicate_request_id');
  WHEN foreign_key_violation THEN
    RETURN jsonb_build_object('reserved', false, 'reason', 'invalid_vm');
END;
$$;

-- ── 4. SETTLE — (D) split-aware balance debit. ───────────────────────────────
-- Clone of prod (20260608230000 incl. the (C) charge clamp) + the (D) block:
-- the allowance portion was eagerly debited at reserve, so settle debits the
-- balance by the BALANCE PORTION only. settled_credits stays the FULL charge
-- (the audit/reporting number; the funnel + ceiling math read it). Legacy
-- rows (no split metadata) COALESCE to the full charge → byte-identical.
CREATE OR REPLACE FUNCTION instaclaw_video_settle(
  p_vm_id           uuid,
  p_request_id      text,
  p_actual_credits  numeric,
  p_metadata        jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_free       boolean;
  v_charge        numeric;
  v_new_bal       numeric;
  v_id            uuid;
  v_status        text;
  v_balance_used  numeric;  -- (D)
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_vm_id::text));

  -- Atomic compare-and-set: only the call that flips pending→settled wins.
  -- (C) charge is clamped to the row's held est_credits — never more than reserved.
  UPDATE instaclaw_video_transactions
     SET status          = 'settled',
         settled_credits = CASE WHEN is_free THEN 0
                                ELSE LEAST(GREATEST(p_actual_credits, 0), est_credits) END,
         settled_at      = now(),
         metadata        = metadata || COALESCE(p_metadata, '{}'::jsonb)
   WHERE vm_id = p_vm_id AND request_id = p_request_id AND status = 'pending'
   RETURNING id, is_free,
             CASE WHEN is_free THEN 0
                  ELSE LEAST(GREATEST(p_actual_credits, 0), est_credits) END,
             -- (D) the hold's recorded balance portion; legacy rows → NULL.
             (metadata->>'balance_used')::numeric
       INTO v_id, v_is_free, v_charge, v_balance_used;

  IF v_id IS NULL THEN
    -- Lost the race or already terminal → idempotent: report current state.
    SELECT status INTO v_status FROM instaclaw_video_transactions
      WHERE vm_id = p_vm_id AND request_id = p_request_id;
    RETURN jsonb_build_object('settled', v_status = 'settled', 'idempotent', true,
                              'reason', COALESCE(v_status, 'not_found'));
  END IF;

  -- Debit balance only for paid holds; free holds cost the user nothing.
  -- (D) Split rows debit the BALANCE PORTION only (LEAST with the clamped
  -- charge is belt+suspenders: flat pricing makes charge==est==portions-sum
  -- today; if a sub-est settle ever appears, we under-debit, never over).
  IF NOT v_is_free AND LEAST(COALESCE(v_balance_used, v_charge), v_charge) > 0 THEN
    UPDATE instaclaw_vms
       SET video_credit_balance = video_credit_balance - LEAST(COALESCE(v_balance_used, v_charge), v_charge)
     WHERE id = p_vm_id
     RETURNING video_credit_balance INTO v_new_bal;
  ELSE
    SELECT video_credit_balance INTO v_new_bal FROM instaclaw_vms WHERE id = p_vm_id;
  END IF;

  RETURN jsonb_build_object('settled', true, 'charged', v_charge,
                            'was_free', v_is_free, 'new_balance', v_new_bal,
                            'balance_debited', CASE WHEN v_is_free THEN 0
                                                    ELSE LEAST(COALESCE(v_balance_used, v_charge), v_charge) END);
END;
$$;

-- ── 5. RELEASE — (D) same-period allowance refund. ──────────────────────────
-- Clone of prod (20260608230000) + the (D) block: a released hold refunds its
-- plan portion ONLY if the plan period it was reserved in is still current —
-- a cross-period refund would resurrect no-rollover-expired value (the grant
-- already SET the new period's full allowance). Balance portion needs no
-- action (holds-sum accounting: a failed row simply stops pinning balance).
-- Legacy rows (no split metadata) refund nothing → byte-identical.
CREATE OR REPLACE FUNCTION instaclaw_video_release(
  p_vm_id       uuid,
  p_request_id  text,
  p_reason      text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid;
  v_plan_used        numeric;      -- (D)
  v_hold_period_end  timestamptz;  -- (D)
  v_cur_period_end   timestamptz;  -- (D)
  v_refunded         numeric := 0; -- (D)
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_vm_id::text));

  UPDATE instaclaw_video_transactions
     SET status          = 'failed',
         settled_credits = 0,
         settled_at      = now(),
         metadata        = metadata || jsonb_build_object('release_reason', p_reason)
   WHERE vm_id = p_vm_id AND request_id = p_request_id AND status = 'pending'
   RETURNING id,
             (metadata->>'plan_used')::numeric,
             NULLIF(metadata->>'plan_period_end_at_hold', '')::timestamptz
        INTO v_id, v_plan_used, v_hold_period_end;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('released', false, 'idempotent', true, 'reason', 'not_pending');
  END IF;

  -- (D) Same-period plan refund. The CAS above guarantees exactly-once.
  IF COALESCE(v_plan_used, 0) > 0 THEN
    SELECT video_plan_period_end INTO v_cur_period_end
      FROM instaclaw_vms WHERE id = p_vm_id;
    IF v_hold_period_end IS NOT NULL AND v_cur_period_end IS NOT NULL
       AND v_hold_period_end = v_cur_period_end THEN
      UPDATE instaclaw_vms
         SET video_plan_allowance_remaining = video_plan_allowance_remaining + v_plan_used
       WHERE id = p_vm_id;
      v_refunded := v_plan_used;
    END IF;
  END IF;

  RETURN jsonb_build_object('released', true, 'plan_refunded', v_refunded);
END;
$$;
