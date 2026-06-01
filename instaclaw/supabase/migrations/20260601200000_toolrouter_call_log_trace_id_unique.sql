-- ToolRouter v1.5 — K.4 wrapper idempotency guard.
--
-- The K.4 stdio wrapper (~/.openclaw/scripts/toolrouter-wrapper.mjs) observes
-- every MCP tools/call response from the toolrouter binary, extracts the
-- ToolRouter-issued trace_id from the structuredContent block, and POSTs
-- the usage record to /api/agent/toolrouter/record-usage. The endpoint
-- inserts into instaclaw_toolrouter_call_log keyed by trace_id, then
-- calls instaclaw_consume_toolrouter_searches to decrement allocation.
--
-- Two sources can race into this table for the same trace_id:
--   1. The wrapper (real-time, ~100ms after the call completes)
--   2. The cron backstop /api/cron/reconcile-toolrouter-usage (hourly,
--      pulls GET /v1/requests from ToolRouter and re-inserts any rows
--      the wrapper missed due to network glitches)
--
-- The cron MUST detect "row already present" without raising — same
-- pattern as the Stripe webhook's idempotency on stripe_payment_intent
-- (lib/billing/webhook/route.ts). A UNIQUE constraint on trace_id gives
-- us the postgres 23505 duplicate-key signal to swallow gracefully.
--
-- Why partial-unique (WHERE trace_id IS NOT NULL):
--   trace_id is nullable in the original v1 migration. Existing legacy
--   rows may have NULL (the wrapper wasn't shipped yet). Postgres treats
--   NULL != NULL in unique constraints by default, but being explicit
--   with a partial index makes the intent unambiguous: many NULL rows OK,
--   any non-NULL trace_id appears at most once.
--
-- Per Rule 56: lives in pending_migrations/ until Cooper applies via
-- Supabase Studio, then `git mv` to migrations/.
-- Per Rule 60: doesn't add a new table; no ALTER ... ENABLE RLS needed
-- (call_log already has RLS enabled per the v1 migration).

CREATE UNIQUE INDEX IF NOT EXISTS instaclaw_toolrouter_call_log_trace_id_uniq
  ON public.instaclaw_toolrouter_call_log (trace_id)
  WHERE trace_id IS NOT NULL;

COMMENT ON INDEX public.instaclaw_toolrouter_call_log_trace_id_uniq IS
  'K.4 idempotency guard: wrapper + cron-backstop both upsert by trace_id.
   Partial-unique (WHERE NOT NULL) preserves legacy NULL rows from v1.';
