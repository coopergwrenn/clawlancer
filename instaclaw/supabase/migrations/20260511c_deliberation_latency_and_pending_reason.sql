-- ════════════════════════════════════════════════════════════════════════
-- Data-quality fixes for the week-1 audit
-- ════════════════════════════════════════════════════════════════════════
--
-- Two small fixes from the matching-pipeline-week1-audit (2026-05-11):
--
--   (1) Layer 3 latency was unmeasurable — my Q2 proxy (intent_extracted_at
--       → deliberated_at) was confounded by the 2h periodic_summary_hook
--       cadence + user overnight gaps. p95 reported 19.5 HOURS which is
--       meaningless. We need a per-call timestamp pair.
--
--   (2) ack_channel='pending' was attributed to a "writeback bug" in the
--       audit but on re-read of the code it's a LEGITIMATE channel value:
--       receiver agent stored the intro to pending-intros.jsonl as fallback
--       when direct surface failed. The 33% pending rate is real receiver
--       fallback. To diagnose WHY the receiver took that path 33% of the
--       time, we need a free-text reason field on the ack call.
--
-- Adds:
--   - matchpool_deliberations.deliberation_started_at + deliberation_completed_at
--     Captured by consensus_match_deliberate.py around each curl call to
--     the gateway proxy. Both timestamps are per-batch (3 candidates share
--     one LLM call), which is fine — the LLM latency is the load-bearing
--     measurement, not per-candidate parsing latency.
--   - agent_outreach_log.pending_reason
--     Free-text up to 200 chars, set when receiver ACK's with
--     channel='pending'. xmtp-agent.mjs writes the reason
--     (e.g. "no_telegram_handle", "notify_user_sh_failed", "telegram_401")
--     so we can diagnose without re-instrumenting.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE matchpool_deliberations
  ADD COLUMN IF NOT EXISTS deliberation_started_at   TIMESTAMPTZ;
ALTER TABLE matchpool_deliberations
  ADD COLUMN IF NOT EXISTS deliberation_completed_at TIMESTAMPTZ;

-- Index for latency-distribution queries. Partial index — only rows
-- with both timestamps set are worth indexing for the analytics path.
CREATE INDEX IF NOT EXISTS matchpool_deliberations_latency
  ON matchpool_deliberations (deliberation_completed_at DESC)
  WHERE deliberation_started_at IS NOT NULL
    AND deliberation_completed_at IS NOT NULL;

ALTER TABLE agent_outreach_log
  ADD COLUMN IF NOT EXISTS pending_reason TEXT;

ALTER TABLE agent_outreach_log
  DROP CONSTRAINT IF EXISTS agent_outreach_log_pending_reason_length;
ALTER TABLE agent_outreach_log
  ADD CONSTRAINT agent_outreach_log_pending_reason_length
  CHECK (pending_reason IS NULL OR char_length(pending_reason) <= 200);

-- Partial index for "show me the pending intros + their reasons"
-- diagnostic queries.
CREATE INDEX IF NOT EXISTS agent_outreach_log_pending_reasons
  ON agent_outreach_log (sent_at DESC NULLS LAST, pending_reason)
  WHERE ack_channel = 'pending' AND pending_reason IS NOT NULL;

COMMENT ON COLUMN matchpool_deliberations.deliberation_started_at IS
  'When the Layer 3 LLM call started (per-batch). Use to measure real latency vs the consensus addendum projection of ~5s.';

COMMENT ON COLUMN matchpool_deliberations.deliberation_completed_at IS
  'When the Layer 3 LLM response was parsed (per-batch).';

COMMENT ON COLUMN agent_outreach_log.pending_reason IS
  'Free-text diagnostic (max 200 chars) when ack_channel=pending. Lets us see WHY 33% of intros fall back to file storage instead of real-time Telegram. Set by xmtp-agent.mjs receive path.';

-- ════════════════════════════════════════════════════════════════════════
-- Done.
-- ════════════════════════════════════════════════════════════════════════
