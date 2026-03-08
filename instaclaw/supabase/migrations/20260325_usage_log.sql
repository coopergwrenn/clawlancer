-- Per-call usage log for debugging usage spikes.
-- Each proxy call logs: timestamp, model, cost, call type, prompt hint.
-- Auto-prunes entries older than 14 days to prevent table bloat.

CREATE TABLE IF NOT EXISTS instaclaw_usage_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  vm_id uuid NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  model text NOT NULL,
  cost_weight numeric NOT NULL DEFAULT 1,
  call_type text NOT NULL DEFAULT 'user',  -- 'user', 'heartbeat', 'virtuals', 'tool_continuation'
  is_tool_continuation boolean NOT NULL DEFAULT false,
  routing_tier smallint,                    -- 1=Haiku, 2=Sonnet, 3=Opus
  routing_reason text,                      -- e.g. 'budget_cap', 'complexity', 'heartbeat'
  prompt_hint text                          -- first 80 chars of user message for debugging
);

-- Index for querying a VM's usage on a specific day
CREATE INDEX IF NOT EXISTS idx_usage_log_vm_date
  ON instaclaw_usage_log (vm_id, created_at DESC);

-- Index for cleanup of old entries
CREATE INDEX IF NOT EXISTS idx_usage_log_created
  ON instaclaw_usage_log (created_at);
