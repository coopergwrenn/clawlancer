-- Personal Telegram handle on instaclaw_users.
--
-- Distinct from instaclaw_vms.telegram_bot_username (the AGENT's bot
-- username, e.g. "@edgecitybot"). This column is the user's PERSONAL
-- handle (e.g. "@cooperwrenn"), used as the human-facing CTA in
-- agent-to-agent intro messages so receivers can DM the human
-- directly instead of being routed to the sender's AI bot.
--
-- Population: filled organically by /api/cron/backfill-telegram-handles,
-- which calls Telegram's getChat for users whose chat_id is known but
-- whose handle is null. Self-healing — runs every 30 min, picks up
-- new users as their chat_ids land in instaclaw_vms (which itself
-- happens lazily as users DM their bot for the first time).
--
-- Stored without the leading "@" for storage consistency; renderers
-- prepend "@" for display.

ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS telegram_handle TEXT;

COMMENT ON COLUMN instaclaw_users.telegram_handle IS
  'User''s personal Telegram @handle (without leading @). Used as the human-facing CTA in agent-to-agent intros so receivers can DM the human directly. Distinct from instaclaw_vms.telegram_bot_username, which is the agent''s bot.';

-- Backfill cron query hits this index for fast filtering.
CREATE INDEX IF NOT EXISTS idx_users_handle_null
  ON instaclaw_users (id)
  WHERE telegram_handle IS NULL;

-- Re-trigger build after migration applied (PostgREST schema cache lag)
