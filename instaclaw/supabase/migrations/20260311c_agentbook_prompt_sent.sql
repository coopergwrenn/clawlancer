-- Track whether the one-time AgentBook registration prompt has been sent via Telegram
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS agentbook_prompt_sent BOOLEAN NOT NULL DEFAULT false;
