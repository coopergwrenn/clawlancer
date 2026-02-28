-- Single-row table tracking which OpenClaw version we last emailed about.
-- CHECK (id = 1) enforces exactly one row. No RLS — only service role key accesses this.
CREATE TABLE instaclaw_update_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_notified_version TEXT NOT NULL DEFAULT '',
  notified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO instaclaw_update_state (id) VALUES (1) ON CONFLICT DO NOTHING;
