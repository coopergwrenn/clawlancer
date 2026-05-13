-- ════════════════════════════════════════════════════════════════════
-- Rule 41: structural CHECK constraint — an assigned VM must have a
-- gateway_token, except during legitimate transient states.
-- ════════════════════════════════════════════════════════════════════
--
-- Background:
--   CLAUDE.md Fleet Health Rule 41 establishes the invariant:
--     "a VM with status='assigned' AND assigned_to IS NOT NULL MUST
--      have gateway_token IS NOT NULL"
--   vm-918 (khomenko89@gmail.com, paying customer) violated this for
--   ~24h before Cooper noticed — gateway_token never landed in DB
--   because configureOpenClaw's dispatch_deploy critical step failed
--   pre-Rule 33 fix, route handler returned 500 before the
--   supplemental update block ran.
--
-- This migration:
--   1. Documents the remaining Rule 41 violators (SELECT, not a write).
--      Expectation: 1 row (vm-918) before the manual fix lands, 0 after.
--   2. Adds the CHECK constraint with NOT VALID so existing rows
--      don't block the migration.
--   3. Comments out the VALIDATE step — Cooper runs that AFTER
--      vm-918 is fixed, when the violator count = 0.
--
-- Why NOT VALID + manual VALIDATE pattern:
--   With NOT VALID, the constraint is enforced on all FUTURE
--   INSERT/UPDATE but not validated against existing rows. New
--   provisioning code that touches this column boundary will
--   immediately fail-fast, but the migration itself doesn't error
--   on vm-918's existing bad state. After vm-918 is fixed externally,
--   the VALIDATE step scans the table and converts the constraint to
--   "fully enforced" status.
--
-- Constraint formulation:
--   Forbid (status='assigned' AND assigned_to IS NOT NULL AND
--           gateway_token IS NULL)
--   UNLESS one of these legitimate transient markers is set:
--     a. configure_lock_at IS NOT NULL — configure is in-flight
--        (5-min stale safety net in lib/vm-pool.ts:instaclaw_assign_vm).
--     b. configure_attempts = 0 — VM just assigned, configure hasn't
--        started yet (the seconds-to-minutes window between assign
--        and configureOpenClaw call).
--     c. health_status = 'configure_failed' — Rule 33 retry-queue
--        owns this state; process-pending Pass 2/2c handles recovery.
--
-- Edge cases considered:
--   - 'hibernating' / 'suspended' health states (Rule 15): the gateway
--     service is stopped but gateway_token in DB is preserved. So the
--     constraint passes (gateway_token IS NOT NULL).
--   - 'frozen' health/status: Linode instance deleted (snapshot only).
--     gateway_token may have been cleared by lib/vm-freeze-thaw;
--     status would also typically be != 'assigned'. If not, the
--     constraint blocks — Cooper should adjust if frozen-while-assigned
--     is a valid state we want to allow.
--   - instaclaw_reclaim_vm (lib/vm-pool.ts:20260342): sets
--     gateway_token=NULL + status='provisioning' simultaneously.
--     Constraint not triggered because status changed away from
--     'assigned'.
--
-- Rollback:
--   ALTER TABLE instaclaw_vms DROP CONSTRAINT IF EXISTS
--     vms_assigned_has_gateway_token;
--
-- Apply order:
--   1. Apply this migration (NOT VALID step).
--   2. Run the vm-918 fix (out of band — resyncGatewayToken or
--      surgical UPDATE; Cooper-approved path).
--   3. Run `SELECT count(*) FROM ...` from §0 to confirm 0 violators.
--   4. Manually run the VALIDATE statement at the bottom of this
--      file (or commit a follow-up migration).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── §0. Pre-migration sanity: list current violators (read-only) ───
--
-- Expectation when this comment block was authored (2026-05-13):
--   1 row → instaclaw-vm-918 (b84e47b3-d2bf-42f3-98d9-4c7752d1950a).
-- After vm-918 fix lands, this query should return 0 rows. The
-- migration itself does not depend on this — it's documentation +
-- pre-VALIDATE sanity check.
--
-- Manual run before VALIDATE:
--   SELECT id, name, assigned_at, assigned_to, configure_attempts,
--          configure_lock_at, health_status, status
--   FROM public.instaclaw_vms
--   WHERE status = 'assigned'
--     AND assigned_to IS NOT NULL
--     AND gateway_token IS NULL
--     AND configure_lock_at IS NULL
--     AND configure_attempts > 0
--     AND health_status <> 'configure_failed';

-- ─── §1. ADD CONSTRAINT … NOT VALID ─────────────────────────────────
--
-- Constraint must be NOT VALID to land while vm-918 still violates it.
-- After vm-918 fix, the VALIDATE step at §3 converts to fully enforced.

ALTER TABLE public.instaclaw_vms
  ADD CONSTRAINT vms_assigned_has_gateway_token
  CHECK (
    -- Forbidden state: assigned to a user with no gateway token AND
    -- not in any legitimate transient marker state.
    NOT (
      status = 'assigned'
      AND assigned_to IS NOT NULL
      AND gateway_token IS NULL
      AND configure_lock_at IS NULL          -- configure not in flight
      AND configure_attempts > 0              -- has attempted configure
      AND health_status <> 'configure_failed' -- not in retry-queue state
    )
  )
  NOT VALID;

COMMENT ON CONSTRAINT vms_assigned_has_gateway_token ON public.instaclaw_vms IS
  'Rule 41: assigned VMs must have a gateway_token, except during '
  'legitimate transient states (configure_lock_at set, configure_attempts=0, '
  'or health_status=''configure_failed''). Added 2026-05-13 with NOT VALID '
  'so vm-918 stuck-state could be fixed before VALIDATE. See migration '
  '20260513170000_rule41_assigned_has_gateway_token.sql for the full '
  'rationale and edge-case enumeration.';

-- ─── §2. Trigger to enforce on INSERT (defense in depth) ────────────
--
-- The CHECK constraint above catches UPDATEs to bad state. Adding a
-- trigger isn't strictly necessary in Postgres (CHECK applies to both
-- INSERT and UPDATE), but documenting the intent here for clarity.
-- The CHECK already covers both paths.

-- ─── §3. VALIDATE — Cooper runs this AFTER vm-918 is fixed ─────────
--
-- DO NOT UNCOMMENT until §0's SELECT returns 0 rows. Otherwise this
-- statement errors with "check constraint violated by some row" and
-- you have to drop/re-add the constraint to land another change.
--
-- ALTER TABLE public.instaclaw_vms
--   VALIDATE CONSTRAINT vms_assigned_has_gateway_token;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- After both this migration AND the vm-918 fix are applied, run:
--
--   ALTER TABLE public.instaclaw_vms
--     VALIDATE CONSTRAINT vms_assigned_has_gateway_token;
--
-- This will scan all existing rows. If §0's SELECT returned 0, this
-- succeeds and the constraint is fully enforced thereafter. If it
-- returns "check constraint violated", investigate before unwinding.
-- ════════════════════════════════════════════════════════════════════
