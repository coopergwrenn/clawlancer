-- Add 'frozen' to instaclaw_vms.status AND .health_status CHECK constraints.
--
-- THE BUG (2026-06-11): the freeze flow (lib/vm-freeze-thaw.ts:743-755) writes
-- BOTH status='frozen' AND health_status='frozen' in one atomic .update(), but
-- NEITHER value was permitted by its CHECK constraint. Every freeze that got
-- past the upstream gates (safety checks → Rule 51 6GB disk cap → shutdown →
-- imagize → image verified available) then failed 23514 at this final DB write,
-- booted the instance back up (Rule 52 recovery), and returned failure — leaving
-- an orphan Linode image. This is the LAST blocker in the freeze chain; it has
-- been masked because most production VMs bail earlier at the 6GB cap (0 orphan
-- frozen-* images on Linode today proves imagize is rarely reached). A small-disk
-- VM (cleans under 6GB) DOES reach it and fails here. Confirmed empirically:
-- status='frozen' → 23514 and health_status='frozen' → 23514 on a throwaway row.
--
-- A status-only fix would be INSUFFICIENT — the .update() is atomic and fails
-- wholesale on whichever CHECK rejects first. Both constraints must gain 'frozen'.
--
-- WHY THIS MATTERS BEYOND the current Linode-image freeze flow:
--  1. Small-disk VMs can now COMPLETE a freeze instead of dying at the DB write.
--  2. freeze-v2 (R2 archive-based, docs/prd/freeze-thaw-v2-archive-based.md) will
--     ALSO set status='frozen' (a frozen VM is frozen regardless of where its
--     archive lives) — so this is a prerequisite for freeze-v2 too.
--  3. It makes Rule-F4's lifecycle trigger 'frozen' branch REACHABLE — that branch
--     (clear frontier_spend_enabled on status IN ('frozen','terminated')) is
--     forward-correct-but-dead precisely because no VM could reach status='frozen'.
--
-- DEFINITIONS REPRODUCED BYTE-FOR-BYTE from prod (Studio pg_get_constraintdef,
-- 2026-06-11) + 'frozen' appended to each. NOTHING ELSE NARROWED:
--  - status_check          add 'frozen' to {provisioning,ready,assigned,failed,terminated}
--  - health_status_check   add 'frozen' to {healthy,unhealthy,unknown,degraded,
--                          suspended,hibernating,configure_failed}
--    NOTE: 'degraded' is preserved. It is currently a LATENT/vestigial value —
--    no code writes or reads instaclaw_vms.health_status='degraded' and zero live
--    rows carry it (same class as 'destroyed' being referenced by the unique-IP
--    index WHERE clause yet absent from the status_check). Kept because narrowing
--    a constraint as a side effect of widening it would break the next degraded
--    write fleet-wide. Flagged for separate review, not removed here.
--
-- The api_mode_check and vms_assigned_has_gateway_token constraints are LEFT
-- UNTOUCHED. The cross-column gateway_token check is verified non-tripped by the
-- freeze (status leaves 'assigned') and thaw (gateway_token/configure_attempts/
-- configure_lock_at preserved unchanged; freeze gate refuses configure_failed VMs)
-- transitions — see the F4-freeze interaction analysis.
--
-- Wrapped in a transaction so a DROP+ADD is atomic: if any ADD CONSTRAINT fails
-- validation against existing rows, the whole migration rolls back and the OLD
-- constraints stay in place (never leave the table with no status/health check).
--
-- Rule 56: constraint-only (no CREATE TABLE, no ALTER ... ADD COLUMN) — verify-
-- migrations does not parse ALTER ... DROP/ADD CONSTRAINT, so it is safe in
-- migrations/ once applied. Per the standard flow this lands in pending_migrations/,
-- Cooper applies via Studio, then git-mv to migrations/.

BEGIN;

ALTER TABLE instaclaw_vms DROP CONSTRAINT IF EXISTS instaclaw_vms_status_check;
ALTER TABLE instaclaw_vms ADD CONSTRAINT instaclaw_vms_status_check
  CHECK (status = ANY (ARRAY[
    'provisioning'::text,
    'ready'::text,
    'assigned'::text,
    'failed'::text,
    'terminated'::text,
    'frozen'::text
  ]));

ALTER TABLE instaclaw_vms DROP CONSTRAINT IF EXISTS instaclaw_vms_health_status_check;
ALTER TABLE instaclaw_vms ADD CONSTRAINT instaclaw_vms_health_status_check
  CHECK (health_status = ANY (ARRAY[
    'healthy'::text,
    'unhealthy'::text,
    'unknown'::text,
    'degraded'::text,
    'suspended'::text,
    'hibernating'::text,
    'configure_failed'::text,
    'frozen'::text
  ]));

COMMIT;
