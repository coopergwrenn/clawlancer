-- Dispatch pairing codes: short-lived codes that encode gateway token + VM IP
-- for zero-friction CLI onboarding. 10-minute TTL, one-time use.
CREATE TABLE IF NOT EXISTS instaclaw_dispatch_pairing_codes (
  code TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  vm_id UUID NOT NULL,
  gateway_token TEXT NOT NULL,
  vm_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  used_at TIMESTAMPTZ DEFAULT NULL
);

-- Auto-cleanup expired codes
CREATE INDEX idx_dispatch_pairing_expires ON instaclaw_dispatch_pairing_codes (expires_at)
  WHERE used_at IS NULL;
