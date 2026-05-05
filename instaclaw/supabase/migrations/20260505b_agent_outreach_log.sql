-- Agent-to-agent outreach audit log
--
-- When User A's matching pipeline hits a top-1-change event during a
-- live event (Consensus 2026 first), A's VM DMs B's VM over XMTP with
-- an intro envelope. Every successful, failed, rate-limited, or
-- duplicate-suppressed outreach is recorded here so:
--   1. We can enforce a daily-per-introducer rate limit (5/24h to
--      start; can be raised once we trust the deliberation rationales).
--   2. We can suppress duplicates so the same top-1 across two cron
--      cycles does not double-DM B.
--   3. We have forensic ground truth if a user reports "agent spam"
--      or "the intro never arrived."
--
-- Idempotency anchor: outbound_user_id + target_user_id + top1_anchor
-- where top1_anchor = "<profile_version>:<target_user_id>". Same anchor
-- on a re-run = duplicate suppressed (status=duplicate). New pv or new
-- target = legitimate fresh intro.
--
-- Phase 1 scope (this migration): outreach over Consensus 2026 only.
-- Generalized to other live events post-conference by adding an
-- event_slug column.

CREATE TABLE IF NOT EXISTS agent_outreach_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbound_user_id      UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  outbound_vm_id        UUID REFERENCES instaclaw_vms(id) ON DELETE SET NULL,
  outbound_xmtp_address TEXT NOT NULL,
  target_user_id        UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  target_xmtp_address   TEXT NOT NULL,
  top1_anchor           TEXT NOT NULL,
  message_preview       TEXT,
  status                TEXT NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('sent', 'failed', 'rate_limited', 'duplicate', 'pending')),
  error_message         TEXT,
  sent_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  agent_outreach_log         IS 'Audit log + rate-limit ledger for agent-to-agent XMTP intros (Consensus 2026 launch).';
COMMENT ON COLUMN agent_outreach_log.top1_anchor IS '<profile_version>:<target_user_id> — used to suppress repeat intros on the same match.';
COMMENT ON COLUMN agent_outreach_log.status      IS 'sent | failed | rate_limited | duplicate | pending';

-- Rate-limit query: COUNT WHERE outbound_user_id = ? AND sent_at > NOW() - INTERVAL '24 hours'
CREATE INDEX IF NOT EXISTS idx_outreach_outbound_sent
  ON agent_outreach_log (outbound_user_id, sent_at DESC);

-- Idempotency: same outbound + target + anchor -> duplicate
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_idempotency
  ON agent_outreach_log (outbound_user_id, target_user_id, top1_anchor);

-- Forensic queries by target ("who DM'd this user lately?")
CREATE INDEX IF NOT EXISTS idx_outreach_target_sent
  ON agent_outreach_log (target_user_id, sent_at DESC);

ALTER TABLE agent_outreach_log ENABLE ROW LEVEL SECURITY;
-- Service role only. The outreach API runs server-side and uses the
-- service role; agents don't talk to this table directly.
