CREATE TABLE IF NOT EXISTS instaclaw_notification_signups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'banner',
  discord_clicked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_notification_signups_email ON instaclaw_notification_signups(email);
