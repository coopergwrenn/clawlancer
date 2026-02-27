-- Add UNIQUE constraint on telegram_bot_token for instaclaw_vms.
-- Multiple NULLs are allowed by default in PostgreSQL UNIQUE constraints.
-- Only non-null values must be unique (prevents two VMs sharing the same bot).
CREATE UNIQUE INDEX IF NOT EXISTS instaclaw_vms_telegram_bot_token_unique
  ON instaclaw_vms (telegram_bot_token)
  WHERE telegram_bot_token IS NOT NULL;
