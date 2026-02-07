-- World ID verification columns on instaclaw_users
ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS world_id_verified BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS world_id_nullifier_hash TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS world_id_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS world_id_verification_level TEXT,
  ADD COLUMN IF NOT EXISTS world_id_banner_dismissed_at TIMESTAMPTZ;

-- Partial index for nullifier_hash lookups (only non-null values)
CREATE INDEX IF NOT EXISTS idx_instaclaw_users_world_id_nullifier
  ON instaclaw_users (world_id_nullifier_hash)
  WHERE world_id_nullifier_hash IS NOT NULL;
