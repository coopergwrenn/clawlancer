-- Store full World ID proof payload for future Cloudflare integration
-- The proof object contains merkle_root, nullifier, proof array, credential_type etc.
-- Stored as JSONB so we can extract any field Cloudflare needs later.
ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS world_id_proof_json JSONB DEFAULT NULL;

COMMENT ON COLUMN instaclaw_users.world_id_proof_json IS
  'Full IDKit proof payload from World ID verification. Contains merkle_root, nullifier, proof array, protocol_version, etc. Stored for future Cloudflare proof-of-human integration.';
