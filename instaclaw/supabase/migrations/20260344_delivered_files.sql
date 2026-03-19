-- delivered_files: tracks every file delivered to users via deliver_file.sh
-- Powers delivery history UI and Supabase Storage-backed downloads

CREATE TABLE IF NOT EXISTS delivered_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  vm_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_path_vm TEXT,                   -- original path on VM
  storage_path TEXT,                   -- Supabase Storage path (delivered-files bucket)
  file_size_bytes BIGINT NOT NULL DEFAULT 0,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  telegram_file_id TEXT,               -- for re-sending without re-upload
  telegram_method TEXT,                -- sendDocument, sendPhoto, sendVideo
  caption TEXT,
  dashboard_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  deleted_at TIMESTAMPTZ               -- soft delete for cleanup
);

CREATE INDEX idx_delivered_files_user ON delivered_files(user_id, created_at DESC);
CREATE INDEX idx_delivered_files_expires ON delivered_files(expires_at) WHERE deleted_at IS NULL;

-- RLS: users can only see their own deliveries
ALTER TABLE delivered_files ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS, so our API routes (which use service key) work fine.
-- This policy is for any direct client access.
CREATE POLICY "Users see own deliveries"
  ON delivered_files FOR SELECT
  USING (user_id = auth.uid());

-- Storage bucket for delivered files (created via Supabase dashboard or API)
-- Bucket name: delivered-files
-- Public: false (files served via signed URLs or API)
-- Note: Bucket must be created via Supabase dashboard if not using supabase CLI storage commands
INSERT INTO storage.buckets (id, name, public)
VALUES ('delivered-files', 'delivered-files', false)
ON CONFLICT (id) DO NOTHING;
