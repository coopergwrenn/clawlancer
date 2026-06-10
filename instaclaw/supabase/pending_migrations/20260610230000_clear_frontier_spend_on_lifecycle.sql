-- clear_frontier_spend_on_lifecycle — red-team F4. Revoke autonomous-spend authority
-- (instaclaw_vms.frontier_spend_enabled) on VM lifecycle transitions that END or TRANSFER
-- ownership, or DESTROY the VM. This is the DATA-LAYER chokepoint: a BEFORE UPDATE trigger
-- fires on the DB write itself, so NO code path can forget to clear it — there are 10+
-- scattered `assigned_to: null` sites (configure, health-check, process-pending, vm-lifecycle)
-- plus the freeze flow plus any future path. A helper would have to be CALLED by each; the
-- trigger cannot be routed around. Same "enforce at the layer that can't be bypassed"
-- principle as F2 (unforgeable consent).
--
-- MIRRORS lib/frontier-spend-lifecycle.ts:shouldRevokeSpendAuthority EXACTLY. The live-probe
-- (set the flag true, do a transition, prove it cleared) verifies the SQL and the TS agree.
--
-- REVOKES on:
--   - assigned_to changed (IS DISTINCT FROM): unassign (→null), reassign (A→B), fresh-assign
--     (null→B). A new or absent owner must never inherit the prior owner's opt-in.
--   - status ENTERED a terminal state (frozen / terminated): the VM is destroyed; a future
--     thaw to the same owner must RE-ENABLE (fail-closed).
-- DELIBERATELY DOES NOT revoke on:
--   - health_status suspend / hibernate (a sleep, not an ownership/billing change): the agent
--     cannot spend while asleep (gateway stopped) and clearing would force an annoying
--     re-enable on every wake. (health_status is not even in the WHEN clause.)
--   - status 'failed' (transient / recoverable).
--   - thaw to the SAME owner (already false from the freeze).
-- CANCEL is handled at the BILLING chokepoint (the customer.subscription.deleted webhook,
-- which also sets frontier_spend_enabled=false), NOT here — cancel manifests as
-- health_status='suspended', indistinguishable from an inactivity-suspend at the VM-column
-- level, so a trigger on it would over-clear legitimate sleeps.
--
-- The WHEN clause limits the function to writes that change assigned_to OR status, so a pure
-- frontier_spend_enabled UPDATE (the user/canary enable-disable dance) NEVER fires it.
-- BEFORE UPDATE modifies NEW in the same write — no recursion, no second UPDATE.
--
-- Rule 56: trigger/function-only (no CREATE TABLE, no ALTER ... ADD COLUMN) — verify-migrations
-- does not parse these object types, so this is safe in migrations/ once applied. Idempotent
-- via CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER.

CREATE OR REPLACE FUNCTION clear_frontier_spend_on_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
     OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('frozen', 'terminated'))
  THEN
    NEW.frontier_spend_enabled := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_frontier_spend_on_lifecycle ON instaclaw_vms;

CREATE TRIGGER trg_clear_frontier_spend_on_lifecycle
  BEFORE UPDATE ON instaclaw_vms
  FOR EACH ROW
  WHEN (NEW.assigned_to IS DISTINCT FROM OLD.assigned_to OR NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION clear_frontier_spend_on_lifecycle();

COMMENT ON FUNCTION clear_frontier_spend_on_lifecycle() IS
  'F4: clears instaclaw_vms.frontier_spend_enabled on ownership change (assigned_to) or terminal status (frozen/terminated). Mirrors lib/frontier-spend-lifecycle.ts:shouldRevokeSpendAuthority. Cancel handled at the billing webhook.';
