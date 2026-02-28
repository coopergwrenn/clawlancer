-- Admin alert deduplication log
-- Tracks sent admin alert digests to prevent repeated emails
CREATE TABLE IF NOT EXISTS instaclaw_admin_alert_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  alert_key text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  vm_count integer DEFAULT 1,
  details text
);

CREATE INDEX IF NOT EXISTS idx_alert_log_key_sent
  ON instaclaw_admin_alert_log (alert_key, sent_at DESC);

-- Auto-cleanup: delete entries older than 7 days (run periodically)
-- This keeps the table small.
