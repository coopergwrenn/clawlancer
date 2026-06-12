-- Travala booking per-VM opt-in (the "Travel Agent" card toggle).
--
-- FAIL-CLOSED by design: DEFAULT false means booking is OFF for every existing
-- and future VM until the owner explicitly turns it on. lib/travala-kill-switch.ts
-- `isTravalaBookingEnabled(vm)` reads this with a strict `=== true` check, so NULL
-- (the column-add default before any write) is also treated as OFF. The backend
-- book-quote op refuses to mint a Travala OAuth token unless this is true.
--
-- ADD COLUMN only (no CREATE TABLE) — Rule 60 RLS-on-create does not apply;
-- instaclaw_vms already has RLS enabled. Idempotent (IF NOT EXISTS).
--
-- Rule 56: lives in pending_migrations/ until applied to prod via Supabase Studio,
-- THEN git-mv'd to migrations/ in the same commit that promotes it. Do NOT commit
-- to migrations/ before apply — verify-migrations.ts would hard-fail the build.
--
-- Rule 34: a per-VM column with an on-disk consumer? No — the per-VM enable lives
-- ONLY in the DB (read by the backend gate); there is no on-disk equivalent to
-- drift against, so no reconciler verify step is required for THIS column. (The
-- on-disk artifacts — the skill + scripts — are covered by extraSkillFiles +
-- file-drift, not by this flag.)
--
-- PRD: instaclaw/docs/prd/travala-x402-booking-2026-06-10.md §14-F, §14-J.

ALTER TABLE public.instaclaw_vms
  ADD COLUMN IF NOT EXISTS travala_booking_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.instaclaw_vms.travala_booking_enabled IS
  'Per-VM opt-in for real-money Travala hotel booking (the Travel Agent card toggle). Fail-closed: false/absent = booking disabled. Read by lib/travala-kill-switch.ts:isTravalaBookingEnabled.';
