-- ════════════════════════════════════════════════════════════════════
-- billing_exempt — first-class comp/founder exemption on instaclaw_users
-- ════════════════════════════════════════════════════════════════════
--
-- Replaces the hardcoded PROTECTED_USER_IDS set in
-- app/api/cron/vm-lifecycle/route.ts, which had drifted dangerously:
--   - its "coopergrantwrenn@gmail.com" entry (24b0b73a) actually points at
--     jwrenn@me.com; the real coopergrantwrenn account is 66afc149, which
--     was NOT in the set (drifted the day that account was created);
--   - its coop@instaclaw.io entry (afb3ae69) has no live account at all.
-- A hardcoded UUID set in one cron is exactly how the drift happened, and it
-- only protected the FREEZE path — suspend-check Pass 2 (hibernate) never
-- honored it. This makes the exemption a first-class column read by
-- lib/billing-status.ts:classify() Path 0, so EVERY billing-gated path
-- (guard, freeze, the upcoming reaper, suspend-check once rewritten) honors
-- it through the single source of truth.
--
-- The three flagged uuids were verified against the LIVE users table on
-- 2026-06-10 (the stale labels were NOT trusted). Reasons are recorded so the
-- next audit doesn't have to reverse-engineer who/why like this one did.
--
-- ALTER ADD COLUMN — gated by verify-migrations (Rule 56): lives in
-- pending_migrations/ until applied in Studio, then promoted to migrations/.
-- No new table, so no RLS step needed (instaclaw_users RLS already enabled).
-- ════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS billing_exempt BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS billing_exempt_reason TEXT;

COMMENT ON COLUMN public.instaclaw_users.billing_exempt IS
  'Comp/founder exemption. When true, lib/billing-status.ts:classify() Path 0 '
  'returns isPaying=true so freeze/suspend/reaper never reclaim the VM. '
  'Replaces vm-lifecycle PROTECTED_USER_IDS. See migration '
  '20260610210000_user_billing_exempt.sql.';
COMMENT ON COLUMN public.instaclaw_users.billing_exempt_reason IS
  'Why this account is billing_exempt (founder_primary / founder_secondary / '
  'family_comp / partner_comp / ...). Recorded so audits do not have to guess.';

-- Verified founder/family accounts (live-table-verified 2026-06-10).
UPDATE public.instaclaw_users
  SET billing_exempt = true, billing_exempt_reason = 'founder_primary'
  WHERE id = '66afc149-5597-49a0-ad09-eeac7e6dcf1d';  -- coopergrantwrenn@gmail.com (current)

UPDATE public.instaclaw_users
  SET billing_exempt = true, billing_exempt_reason = 'founder_secondary'
  WHERE id = '4e0213b3-c9e8-4812-9385-827786900b66';  -- coopgwrenn@gmail.com

UPDATE public.instaclaw_users
  SET billing_exempt = true, billing_exempt_reason = 'family_comp'
  WHERE id = '24b0b73a-84a8-4f97-9230-577bdca68e43';  -- jwrenn@me.com (Cooper's dad)

-- afb3ae69 (old PROTECTED_USER_IDS coop@instaclaw.io) intentionally NOT
-- carried forward — no live account.

-- Verification (raises if the three didn't take).
DO $verify$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM public.instaclaw_users WHERE billing_exempt = true;
  IF n < 3 THEN
    RAISE EXCEPTION 'Expected >=3 billing_exempt users after this migration, found %.', n;
  END IF;
  RAISE NOTICE 'billing_exempt applied to % users (expected the 3 founder/family accounts).', n;
END
$verify$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-APPLY proof (run in Studio):
--   SELECT id, email, billing_exempt, billing_exempt_reason
--   FROM instaclaw_users
--   WHERE billing_exempt = true ORDER BY billing_exempt_reason;
--   -- expect exactly the 3 rows above.
-- ════════════════════════════════════════════════════════════════════
