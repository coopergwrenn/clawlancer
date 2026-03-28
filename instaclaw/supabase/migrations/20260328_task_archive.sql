-- Add archived_at column for task archiving
ALTER TABLE instaclaw_tasks
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_archived
  ON instaclaw_tasks(user_id, archived_at)
  WHERE archived_at IS NOT NULL;
