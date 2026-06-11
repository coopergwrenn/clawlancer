-- frontier_spend_events — the queryable record of every spend DECISION the
-- money rail makes (Tier-0 A). One immutable row per authorize / settle / refund
-- decision. Write-only from the routes (best-effort, never on the hot path via
-- next/server `after()`); never read on the request path. This is the
-- observability the announce ships on: before this, no decision was queryable —
-- you could not answer "why did agent X spend $Y", "show me every denial today",
-- or "what was the budget state when it decided".
--
-- Rule 56: lives in pending_migrations/ until applied to prod (Studio), then
-- git-mv to migrations/ in the SAME commit that promotes it — never before, or
-- the verify-migrations build gate goes down fleet-wide.
-- Rule 60: RLS enabled in-file, deny-all (service-role only — the routes write
-- and any future dashboard reads via service role). No anon/authenticated
-- policies; a fresh-DB replay is RLS-on by the file, not by an operator click.
--
-- NO foreign keys on vm_id / owner_id / transaction_id (deliberate): a deny logs
-- BEFORE any frontier_transactions hold row exists, so an FK on transaction_id
-- would reject the most important rows (denials). The columns are plain uuids;
-- joins are best-effort at query time.

CREATE TABLE IF NOT EXISTS public.frontier_spend_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- which leg of the spend lifecycle produced this decision
  decision_point  text NOT NULL CHECK (decision_point IN ('authorize','settle','refund')),

  -- WHO  (answers "agent X" and "X's owner")
  vm_id           uuid NOT NULL,
  owner_id        uuid,
  request_id      text,                 -- ties the 3 legs of ONE spend together
  transaction_id  uuid,                 -- frontier_transactions.id once a hold exists; NULL on a deny w/ no hold

  -- THE DECISION  (answers "show me every denial today")
  verdict         text NOT NULL CHECK (verdict IN (
                    'allow','deny','ask',
                    'settle_success','settle_failed','settle_disputed',
                    'refund_queued','error')),
  gate            text,                 -- derived from reason: kill_switch | opt_in | ceiling |
                                        -- earned_budget | session_approval | policy_category |
                                        -- privacy | counterparty | wallet_balance | velocity_anomaly |
                                        -- policy_band | idempotency | settle | refund | other
  reason          text,                 -- decision.reason verbatim (the gate that fired)

  -- THE SPEND IDENTITY  (answers "spend $Y on what / to whom")
  amount_usd      numeric(14,6),
  category        text,
  counterparty    text,                 -- vm_id / address / endpoint label
  consent_grade   text,                 -- autonomous | session | forgeable (NULL on deny/ask)
  mode            text,                 -- autonomous | human_approved | NULL (decision.mode)

  -- THE BUDGET STATE AT DECISION TIME  (answers "what was the budget when it decided")
  standing_score              int,
  earned_daily_budget_usd     numeric(14,6),
  spent_today_usd             numeric(14,6),
  remaining_earned_after_usd  numeric(14,6),
  wallet_balance_usd          numeric(14,6),  -- server-read on-chain; NULL = couldn't read → ask_first
  just_do_it_per_tx_usd       numeric(14,6),  -- the effective ceiling that applied
  tier            text,

  -- SETTLE / REFUND specifics (NULL on authorize)
  tx_hash          text,
  latency_ms       int,
  pay_error        text,
  protocol_fee_usd numeric(14,6),

  meta             jsonb            -- escape hatch (policy_bands, idempotent flag, privacy, ...)
);

-- Row Level Security — load-bearing (Rule 60). Deny-all to anon + authenticated;
-- service-role bypasses. Idempotent — no-op on re-run.
ALTER TABLE public.frontier_spend_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_fse_vm_created      ON public.frontier_spend_events (vm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fse_verdict_created ON public.frontier_spend_events (verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fse_created         ON public.frontier_spend_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fse_request         ON public.frontier_spend_events (request_id);
-- "which gate is denying the most" — partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_fse_deny_gate       ON public.frontier_spend_events (gate, created_at DESC) WHERE verdict = 'deny';

COMMENT ON TABLE public.frontier_spend_events IS
  'Tier-0 A: one immutable row per spend decision (authorize/settle/refund). Write-only from routes via next/server after() (best-effort, never blocks the hot path). RLS deny-all; service-role only.';
