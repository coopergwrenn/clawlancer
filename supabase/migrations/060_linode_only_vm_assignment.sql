-- ============================================
-- Restrict VM assignment to Linode VMs only
-- ============================================

-- Update the assign function to only pick Linode VMs
CREATE OR REPLACE FUNCTION instaclaw_assign_vm(p_user_id UUID)
RETURNS instaclaw_vms AS $$
DECLARE
  vm instaclaw_vms;
BEGIN
  SELECT * INTO vm FROM instaclaw_vms
  WHERE status = 'ready'
    AND provider = 'linode'
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

-- Remove all non-Linode VMs from the ready pool
UPDATE instaclaw_vms
SET status = 'failed',
    health_status = 'unhealthy',
    updated_at = NOW()
WHERE status = 'ready'
  AND provider != 'linode';
