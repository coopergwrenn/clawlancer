-- Phase 1 silence detection: track last API call per VM
-- Health cron will flag VMs with stale last_proxy_call_at as potentially silent

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS last_proxy_call_at TIMESTAMPTZ;

-- Index for the health cron silence detection query
CREATE INDEX IF NOT EXISTS idx_vms_last_proxy_call
  ON instaclaw_vms (last_proxy_call_at)
  WHERE status = 'assigned';

-- Silence events table for tracking detected silences
CREATE TABLE IF NOT EXISTS instaclaw_silence_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  vm_id uuid NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  detection_method text NOT NULL,  -- 'stale_proxy', 'pending_updates', 'watchdog'
  pending_message_count integer,
  details text
);

CREATE INDEX IF NOT EXISTS idx_silence_events_vm
  ON instaclaw_silence_events (vm_id, detected_at DESC);
