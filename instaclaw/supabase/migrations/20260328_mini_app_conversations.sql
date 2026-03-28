-- Multi-conversation chat for mini app
-- Reuses the existing instaclaw_conversations and instaclaw_chat_messages tables
-- (already created by the web app migrations). No new tables needed.
-- This migration is a no-op if tables already exist.

CREATE TABLE IF NOT EXISTS instaclaw_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New Chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  last_message_preview TEXT DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_updated
  ON instaclaw_conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS instaclaw_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES instaclaw_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
  ON instaclaw_chat_messages(conversation_id, created_at ASC);
