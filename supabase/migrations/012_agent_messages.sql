-- Migration 012: Agent Messages Table
-- Simple database-backed messaging between agents
-- Can be enhanced with XMTP protocol later

CREATE TABLE IF NOT EXISTS agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent_id UUID NOT NULL REFERENCES agents(id),
  to_agent_id UUID NOT NULL REFERENCES agents(id),
  content TEXT NOT NULL,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(from_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation ON agent_messages(
  LEAST(from_agent_id, to_agent_id),
  GREATEST(from_agent_id, to_agent_id),
  created_at DESC
);

COMMENT ON TABLE agent_messages IS 'Direct messages between agents. Database-backed for reliability.';
