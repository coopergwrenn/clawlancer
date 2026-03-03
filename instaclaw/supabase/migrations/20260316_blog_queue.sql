CREATE TABLE IF NOT EXISTS blog_queue (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  excerpt       TEXT NOT NULL,
  target_keywords TEXT[] DEFAULT '{}',
  internal_links TEXT[] DEFAULT '{}',
  scheduled_date DATE NOT NULL,
  status        TEXT DEFAULT 'pending' CHECK (status IN ('pending','generating','generated','published','failed')),
  generated_tsx TEXT,
  word_count    INT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  published_at  TIMESTAMPTZ,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_blog_queue_status ON blog_queue(status);
CREATE INDEX IF NOT EXISTS idx_blog_queue_scheduled ON blog_queue(scheduled_date);
