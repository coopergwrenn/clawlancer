-- Add agent_name column for user-customizable agent name
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS agent_name TEXT DEFAULT NULL;
