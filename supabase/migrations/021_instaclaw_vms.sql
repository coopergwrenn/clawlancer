-- InstaClaw VM Pool + Invites + Pending Users
-- Architecture: each user gets their own OpenClaw VM

-- ============================================
-- VM POOL TABLE
-- ============================================
CREATE TABLE instaclaw_vms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address TEXT NOT NULL,
  ssh_port INTEGER DEFAULT 22,
  ssh_user TEXT DEFAULT 'openclaw',
  gateway_url TEXT,
  gateway_token TEXT,
  control_ui_url TEXT,
  status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'ready', 'assigned', 'failed', 'terminated')),
  assigned_to UUID REFERENCES instaclaw_users(id),
  assigned_at TIMESTAMPTZ,
  region TEXT,
  server_type TEXT,
  monthly_cost_cents INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_health_check TIMESTAMPTZ,
  health_status TEXT DEFAULT 'unknown'
    CHECK (health_status IN ('healthy', 'unhealthy', 'unknown')),
  UNIQUE(assigned_to)
);

CREATE INDEX idx_instaclaw_vms_status ON instaclaw_vms(status);
CREATE INDEX idx_instaclaw_vms_assigned ON instaclaw_vms(assigned_to);
CREATE INDEX idx_instaclaw_vms_health ON instaclaw_vms(health_status);

-- ============================================
-- INVITE CODES TABLE
-- ============================================
CREATE TABLE instaclaw_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  email TEXT,
  max_uses INTEGER DEFAULT 1,
  times_used INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT,
  used_by UUID[] DEFAULT '{}'
);

CREATE INDEX idx_instaclaw_invites_code ON instaclaw_invites(code);
CREATE INDEX idx_instaclaw_invites_email ON instaclaw_invites(email);

-- ============================================
-- PENDING USERS (waiting for VM assignment)
-- ============================================
CREATE TABLE instaclaw_pending_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES instaclaw_users(id) UNIQUE NOT NULL,
  telegram_bot_token TEXT NOT NULL,
  api_mode TEXT NOT NULL CHECK (api_mode IN ('all_inclusive', 'byok')),
  api_key TEXT, -- encrypted, only for BYOK
  tier TEXT NOT NULL,
  stripe_session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  notified_at TIMESTAMPTZ -- when we emailed them that VM is ready
);

CREATE INDEX idx_instaclaw_pending_created ON instaclaw_pending_users(created_at);

-- ============================================
-- UPDATE WAITLIST TABLE (add invite tracking)
-- ============================================
ALTER TABLE instaclaw_waitlist ADD COLUMN IF NOT EXISTS invite_sent_at TIMESTAMPTZ;
ALTER TABLE instaclaw_waitlist ADD COLUMN IF NOT EXISTS invite_code TEXT;

-- ============================================
-- ADD invited_by TO USERS TABLE
-- ============================================
ALTER TABLE instaclaw_users ADD COLUMN IF NOT EXISTS invited_by TEXT;

-- ============================================
-- HELPER: Assign VM to user (atomic, skip-locked)
-- ============================================
CREATE OR REPLACE FUNCTION instaclaw_assign_vm(p_user_id UUID)
RETURNS instaclaw_vms AS $$
DECLARE
  vm instaclaw_vms;
BEGIN
  SELECT * INTO vm FROM instaclaw_vms
  WHERE status = 'ready'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF vm IS NULL THEN RETURN NULL; END IF;

  UPDATE instaclaw_vms
  SET status = 'assigned',
      assigned_to = p_user_id,
      assigned_at = NOW(),
      updated_at = NOW()
  WHERE id = vm.id;

  SELECT * INTO vm FROM instaclaw_vms WHERE id = vm.id;
  RETURN vm;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- HELPER: Reclaim VM (on subscription cancel)
-- ============================================
CREATE OR REPLACE FUNCTION instaclaw_reclaim_vm(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  vm_id UUID;
BEGIN
  SELECT id INTO vm_id FROM instaclaw_vms WHERE assigned_to = p_user_id;

  IF vm_id IS NULL THEN RETURN FALSE; END IF;

  UPDATE instaclaw_vms
  SET
    status = 'provisioning',
    assigned_to = NULL,
    assigned_at = NULL,
    gateway_token = NULL,
    gateway_url = NULL,
    control_ui_url = NULL,
    updated_at = NOW()
  WHERE id = vm_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- HELPER: Pool stats (for admin dashboard)
-- ============================================
CREATE OR REPLACE FUNCTION instaclaw_get_pool_stats()
RETURNS TABLE (
  total_vms INTEGER,
  ready_vms INTEGER,
  assigned_vms INTEGER,
  failed_vms INTEGER,
  pending_users INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    (SELECT COUNT(*)::INTEGER FROM instaclaw_vms),
    (SELECT COUNT(*)::INTEGER FROM instaclaw_vms WHERE status = 'ready'),
    (SELECT COUNT(*)::INTEGER FROM instaclaw_vms WHERE status = 'assigned'),
    (SELECT COUNT(*)::INTEGER FROM instaclaw_vms WHERE status = 'failed'),
    (SELECT COUNT(*)::INTEGER FROM instaclaw_pending_users);
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- UPDATED_AT TRIGGER FOR VMS
-- ============================================
CREATE TRIGGER trg_instaclaw_vms_updated_at
  BEFORE UPDATE ON instaclaw_vms
  FOR EACH ROW
  EXECUTE FUNCTION instaclaw_set_updated_at();

-- ============================================
-- RLS
-- ============================================
ALTER TABLE instaclaw_vms ENABLE ROW LEVEL SECURITY;
ALTER TABLE instaclaw_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE instaclaw_pending_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own VM" ON instaclaw_vms
  FOR SELECT USING (assigned_to = auth.uid());

CREATE POLICY "Service role full access VMs" ON instaclaw_vms
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Service role full access invites" ON instaclaw_invites
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Users can view own pending" ON instaclaw_pending_users
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Service role full access pending" ON instaclaw_pending_users
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
