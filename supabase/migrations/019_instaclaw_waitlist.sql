-- InstaClaw waitlist table
CREATE TABLE instaclaw_waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  source VARCHAR(50) DEFAULT 'landing',
  referrer VARCHAR(500),
  ip_hash VARCHAR(64),
  position INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  notified_at TIMESTAMPTZ
);

-- Unique index on lowercase email to prevent duplicates
CREATE UNIQUE INDEX idx_instaclaw_waitlist_email ON instaclaw_waitlist (LOWER(email));

-- Index for rate limiting queries (ip_hash + created_at)
CREATE INDEX idx_instaclaw_waitlist_rate_limit ON instaclaw_waitlist (ip_hash, created_at);

-- Auto-assign position on insert
CREATE OR REPLACE FUNCTION instaclaw_waitlist_assign_position()
RETURNS TRIGGER AS $$
BEGIN
  NEW.position := COALESCE(
    (SELECT MAX(position) FROM instaclaw_waitlist) + 1,
    1
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_instaclaw_waitlist_position
  BEFORE INSERT ON instaclaw_waitlist
  FOR EACH ROW
  EXECUTE FUNCTION instaclaw_waitlist_assign_position();

-- Enable RLS
ALTER TABLE instaclaw_waitlist ENABLE ROW LEVEL SECURITY;

-- Service role only — no public access
CREATE POLICY "service_role_only" ON instaclaw_waitlist
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
