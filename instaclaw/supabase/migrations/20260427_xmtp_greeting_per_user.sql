-- Per-user XMTP proactive-greeting marker.
--
-- Records the first time the agent successfully delivered the proactive
-- World Chat greeting to a user. Used to suppress double-greeting when a
-- user's VM is re-provisioned (a fresh VM has no on-disk marker file, but
-- the user already received the greeting on their previous VM).
--
-- The agent writes to this column via POST /api/admin/xmtp-greeting-recorded
-- AFTER xmtp dm.sendText() returns successfully. setupXMTP reads it on
-- subsequent provisions and tells the agent to skip via the
-- USER_GREETING_ALREADY_SENT env var.

ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS xmtp_greeting_sent_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_users_xmtp_greeting_sent_at
  ON instaclaw_users(xmtp_greeting_sent_at)
  WHERE xmtp_greeting_sent_at IS NOT NULL;

COMMENT ON COLUMN instaclaw_users.xmtp_greeting_sent_at IS
  'Timestamp when the proactive XMTP first-message was successfully delivered to this user. NULL means never delivered. Set by the agent via POST /api/admin/xmtp-greeting-recorded after sendText() returns. Used to suppress double-greeting on VM re-provisioning.';
