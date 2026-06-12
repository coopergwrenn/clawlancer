-- Token logging on instaclaw_usage_log (launch-week margin measurement).
--
-- WHY: the entire cost side of the Fable@38 / Opus@19 margin model is currently
-- ESTIMATED (14k in / 2k out, no cache) because usage_log has no token columns.
-- With the Fable announce about to drive premium picks, every un-logged message
-- is margin data lost. These columns turn cost from guessed into measured so we
-- can answer "does 38 hold, or does Fable go Pro+" with real numbers in ~2 weeks.
--
-- SHAPE: additive, NULLABLE, idempotent. Existing rows + any insert that doesn't
-- set these write NULL. The proxy populates them via a SEPARATE deferred UPDATE
-- keyed by the row id (insert-then-update), so the row+attribution always lands
-- even if token capture fails — and this column-add can happen before OR after
-- the proxy deploy without breaking the existing insert (Rule 56 ordering-safe).
--
-- FOUR token classes (not three): Anthropic bills four distinct legs and the
-- cost formula needs all of them to be exact —
--   input_tokens          : fresh input, billed at the model's input rate (1x)
--   output_tokens         : generated output, billed at the output rate
--   cache_read_tokens      : cache hits, billed ~0.1x input (the big discount)
--   cache_creation_tokens : cache writes, billed ~1.25x input (the premium leg)
-- Our ~32K system prompt is cached, so BOTH cache legs are material to margin.
--
-- BIGINT: per-call values fit INT, but BIGINT removes any doubt for the
-- aggregate SUMs the 2-week margin readout will run. Nullable everywhere —
-- a row with NULL tokens (capture missed) is still a valid attribution row.
--
-- RLS: instaclaw_usage_log already exists with its established policies; ALTER
-- ADD COLUMN inherits them (Rule 60 applies to CREATE TABLE, not column-adds).

ALTER TABLE public.instaclaw_usage_log
  ADD COLUMN IF NOT EXISTS input_tokens          BIGINT,
  ADD COLUMN IF NOT EXISTS output_tokens         BIGINT,
  ADD COLUMN IF NOT EXISTS cache_read_tokens     BIGINT,
  ADD COLUMN IF NOT EXISTS cache_creation_tokens BIGINT;

COMMENT ON COLUMN public.instaclaw_usage_log.input_tokens          IS 'Anthropic usage.input_tokens (fresh input, 1x rate). NULL = capture missed; row still valid.';
COMMENT ON COLUMN public.instaclaw_usage_log.output_tokens         IS 'Anthropic usage.output_tokens (generated output). NULL = capture missed.';
COMMENT ON COLUMN public.instaclaw_usage_log.cache_read_tokens     IS 'Anthropic usage.cache_read_input_tokens (~0.1x input rate — the discount leg).';
COMMENT ON COLUMN public.instaclaw_usage_log.cache_creation_tokens IS 'Anthropic usage.cache_creation_input_tokens (~1.25x input rate — the cache-write premium leg).';
