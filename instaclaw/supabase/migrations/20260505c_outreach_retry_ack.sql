-- Application-layer delivery guarantees for agent-to-agent intros
--
-- Adds the columns that close the receiver-down edge case:
--
--   retry_count       — sender increments on each XMTP re-send. Capped
--                       at 3 by client-side logic (one cron cycle is
--                       30 min, so 3 retries spans 90 min — enough to
--                       cover a typical receiver-side outage).
--   last_retry_at     — sender's anti-thundering-herd guard. Don't
--                       re-fire if we just retried in the same cycle.
--   ack_received_at   — receiver writes this when the intro is
--                       successfully surfaced to its human (Telegram,
--                       XMTP user channel, or pending-intros.jsonl).
--                       Sender's retry query filters on this NULL.
--                       The unique-not-null transition is also what
--                       the my-intros poll uses to suppress already-
--                       delivered rows.
--   ack_channel       — diagnostic only: which channel finally landed
--                       it ("telegram" | "xmtp_user" | "pending" |
--                       "polled"). Helps post-mortem any user who
--                       reports "I never got the intro."
--
-- The two new partial indexes accelerate the hot paths:
--   - Sender retry: rows owned by caller, status=sent, no ack yet,
--     order by sent_at to retry the oldest first.
--   - Receiver poll: rows targeting the caller, status=sent, no ack
--     yet, order by sent_at so we surface the oldest intro first.
--
-- Idempotency on receive is guaranteed by:
--   1. The unique index on (outbound_user_id, target_user_id,
--      top1_anchor) (already exists) — prevents the sender from
--      double-reserving.
--   2. The receiver's local pending-intros.jsonl dedup-on-intake
--      check by log_id (added in the mjs).
--   3. Server-side ack is idempotent (UPDATE WHERE ack_received_at
--      IS NULL — a second ACK is a no-op).

ALTER TABLE agent_outreach_log
  ADD COLUMN IF NOT EXISTS retry_count      INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ack_received_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ack_channel      TEXT;

COMMENT ON COLUMN agent_outreach_log.retry_count     IS 'Sender increments on each XMTP re-send; capped at 3 by client.';
COMMENT ON COLUMN agent_outreach_log.last_retry_at   IS 'Sender''s thundering-herd guard — refuse re-send within 15 min.';
COMMENT ON COLUMN agent_outreach_log.ack_received_at IS 'Receiver sets when the intro is surfaced to its human via any channel.';
COMMENT ON COLUMN agent_outreach_log.ack_channel     IS 'Diagnostic: telegram | xmtp_user | pending | polled.';

-- Sender retry hot-path: my outbound rows, sent but not acked, oldest
-- first. Partial index on the unacked subset keeps it tight.
CREATE INDEX IF NOT EXISTS idx_outreach_unacked_outbound
  ON agent_outreach_log (outbound_user_id, sent_at ASC)
  WHERE status = 'sent' AND ack_received_at IS NULL;

-- Receiver poll hot-path: rows targeting me, sent but not acked,
-- oldest first.
CREATE INDEX IF NOT EXISTS idx_outreach_unacked_target
  ON agent_outreach_log (target_user_id, sent_at ASC)
  WHERE status = 'sent' AND ack_received_at IS NULL;

-- Re-trigger Vercel build after migration applied
