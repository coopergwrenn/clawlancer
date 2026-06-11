-- Composite uniqueness for instaclaw_travala_bookings: at most one booking row
-- per (vm_id, package_id, session_id). Closes the select-then-insert TOCTOU race
-- in lib/travala-bookings.ts recordConfirmedBooking — two concurrent records
-- (the 3x retry racing a --retry, say) could both pass the existence check and
-- both insert, creating a duplicate row for one booking.
--
-- The app code ALREADY handles the resulting unique violation by re-selecting +
-- updating the winning row (see recordConfirmedBooking's insert catch, keyed on
-- this index name). So applying this index ACTIVATES the race fix with ZERO code
-- change — it is the only missing step. Pre-apply, the violation never fires and
-- behaviour is unchanged (degraded to the existing app-level idempotency).
--
-- NULLs are distinct in a unique index, so the rare degraded ref-less rows (which
-- still carry non-null package/session) remain correctly constrained; a row with
-- a null package_id/session_id (shouldn't happen — book-record requires both)
-- would simply not conflict.
--
-- Rule 56: lives in pending_migrations/ until applied in Studio (Cooper batches
-- it with frontier's logging migration), then git-mv'd to migrations/.

CREATE UNIQUE INDEX IF NOT EXISTS instaclaw_travala_bookings_vm_pkg_sess_uniq
  ON public.instaclaw_travala_bookings (vm_id, package_id, session_id);
