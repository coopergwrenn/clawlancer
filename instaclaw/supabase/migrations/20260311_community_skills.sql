CREATE TABLE instaclaw_community_skills (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('creative','productivity','commerce','social','developer','automation','communication')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  installs        INT NOT NULL DEFAULT 0,
  rating_sum      NUMERIC NOT NULL DEFAULT 0,
  rating_count    INT NOT NULL DEFAULT 0,
  featured        BOOLEAN NOT NULL DEFAULT false,
  author_name     TEXT NOT NULL,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     UUID REFERENCES instaclaw_users(id)
);

CREATE INDEX idx_community_skills_status ON instaclaw_community_skills (status);
CREATE INDEX idx_community_skills_category ON instaclaw_community_skills (category);
CREATE UNIQUE INDEX idx_community_skills_user_name ON instaclaw_community_skills (user_id, lower(name));
