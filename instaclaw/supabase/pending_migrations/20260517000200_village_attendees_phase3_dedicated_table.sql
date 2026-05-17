-- D14/D15 Phase 3 — Village Attendees (OPTION C — dedicated table)
--
-- PARKED in `pending_migrations/` per CLAUDE.md Rule 56. See companion doc:
--   `instaclaw/docs/prd/village-attendees-phase3.md`
--
-- This option creates a fully self-contained `village_attendees` TABLE
-- (not a view) with all attendee data including a copy of full_name.
-- Decoupled from instaclaw_vms / instaclaw_users — an attendee row survives
-- VM reassignment, user-name changes, partner field flips on the VM.
--
-- TRADE-OFF (per PRD): maximum flexibility, but introduces a sync problem
-- we don't have today. VM gets reassigned → village_attendees needs to
-- update; user changes name → village_attendees needs to update; partner
-- field on VM flips → village_attendees needs to know. Each sync is a
-- trigger or cron we'd have to write, test, and monitor. Nothing in the
-- Edge Esmeralda MVP requires this decoupling — there's no use case for
-- attendee identity outliving VM ownership today. PRD does NOT recommend
-- this option; reserve for when decoupling is actually needed.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Dedicated village_attendees table
-- ═══════════════════════════════════════════════════════════════════════════
--
-- user_id is the PK and FK to instaclaw_users. full_name is copied
-- (denormalized for self-containment). All village-specific metadata lives
-- here — no JOIN with instaclaw_vms needed at view time.

CREATE TABLE IF NOT EXISTS public.village_attendees (
  user_id           UUID PRIMARY KEY REFERENCES public.instaclaw_users(id) ON DELETE CASCADE,
  full_name         TEXT,                                 -- denormalized copy from instaclaw_users (manual sync)
  description       TEXT,                                 -- public-safe bio line
  larry_atlas_index INT  NOT NULL DEFAULT 0  CHECK (larry_atlas_index >= 0 AND larry_atlas_index <= 49),
  home_tile_x       INT  NOT NULL DEFAULT 30 CHECK (home_tile_x >= 0  AND home_tile_x <= 99),
  home_tile_y       INT  NOT NULL DEFAULT 37 CHECK (home_tile_y >= 0  AND home_tile_y <= 99),
  spectator_visible BOOL NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.village_attendees IS
  'Dedicated village attendee table. Denormalized from instaclaw_users + instaclaw_vms; requires sync logic for full_name/partner changes. See instaclaw/docs/prd/village-attendees-phase3.md.';

CREATE INDEX IF NOT EXISTS idx_village_attendees_spectator
  ON public.village_attendees (spectator_visible)
  WHERE spectator_visible = true;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. RLS on the village_attendees table
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.village_attendees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS village_attendees_select ON public.village_attendees;
CREATE POLICY village_attendees_select ON public.village_attendees
  FOR SELECT USING (auth.role() IN ('authenticated', 'service_role'));

DROP POLICY IF EXISTS village_attendees_service_write ON public.village_attendees;
CREATE POLICY village_attendees_service_write ON public.village_attendees
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

GRANT SELECT ON public.village_attendees TO authenticated;

-- Note: the table IS the auth-mode interface. No CREATE VIEW village_attendees
-- needed (the client reads `village_attendees` directly via PostgREST).

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Public (anonymized) village view
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.village_attendees_public AS
  SELECT
    village.anonymize_user_id(user_id) AS agent_id,
    description,
    larry_atlas_index,
    home_tile_x,
    home_tile_y,
    true                               AS spectator_visible
  FROM public.village_attendees
  WHERE spectator_visible = true;

GRANT SELECT ON public.village_attendees_public TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Public (anonymized) position view
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Different shape from Option B: filters via village_attendees membership
-- (INNER JOIN), not via instaclaw_vms.partner filter. So an attendee who's
-- in village_attendees but whose VM has changed partner field still appears
-- in the public render. That's the decoupling Option C buys.

CREATE OR REPLACE VIEW public.agent_positions_public AS
  SELECT
    village.anonymize_user_id(p.user_id) AS agent_id,
    p.tile_x,
    p.tile_y,
    p.facing_dx,
    p.facing_dy,
    p.is_moving,
    p.is_thinking,
    p.is_speaking,
    p.activity_emoji,
    p.activity_until,
    p.updated_at
  FROM public.agent_positions p
  INNER JOIN public.village_attendees va ON va.user_id = p.user_id
  WHERE va.spectator_visible = true;

GRANT SELECT ON public.agent_positions_public TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. activity_emoji length cap (Phase 2 carryover)
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.agent_positions
  DROP CONSTRAINT IF EXISTS agent_positions_activity_emoji_bounded;

ALTER TABLE public.agent_positions
  ADD CONSTRAINT agent_positions_activity_emoji_bounded
  CHECK (activity_emoji IS NULL OR length(activity_emoji) <= 8);

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. Table exists:
--      SELECT column_name FROM information_schema.columns
--       WHERE table_schema='public' AND table_name='village_attendees'
--       ORDER BY ordinal_position;
--    Expected 9 columns.
--
-- 2. RLS enabled:
--      SELECT relrowsecurity FROM pg_class WHERE oid = 'public.village_attendees'::regclass;
--    Expected: t
--
-- 3. Views resolve cleanly (empty initially — no seed yet):
--      SELECT COUNT(*) FROM village_attendees;             -- expect 0
--      SELECT COUNT(*) FROM village_attendees_public;      -- expect 0
--      SELECT COUNT(*) FROM agent_positions_public;        -- expect 0
--
-- 4. activity_emoji CHECK exists:
--      SELECT conname FROM pg_constraint
--       WHERE conname = 'agent_positions_activity_emoji_bounded';

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED BLOCK (apply AFTER migration; Cooper-edits)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Under Option C, attendees are INSERTed directly into the village_attendees
-- table. full_name is copied from instaclaw_users (manual lookup or a
-- one-shot UPDATE FROM JOIN after the INSERT).
--
-- INSERT INTO public.village_attendees
--   (user_id, full_name, description, larry_atlas_index,
--    home_tile_x, home_tile_y, spectator_visible)
-- SELECT
--   u.id, u.full_name, NULL, 30, 30, 37, false
--   FROM instaclaw_users u
--  WHERE u.id IN (
--    '4e0213b3-c9e8-4812-9385-827786900b66',  -- cooper timmy
--    'cc1d7227-345d-48a5-8a87-7c1ae451956e',  -- edge default
--    'a8344b7a-d0a0-45df-8e00-675ae2d0d71a',
--    '3a2c2392-83cd-4635-b70c-51a67fac7b53',
--    '0a102415-75e4-4fff-b792-773609c63ff0',  -- cooper edge bot
--    '1d1df916-2679-4ac5-9cee-1de542859f22',
--    'ef612ac6-f9a7-4e2c-ac22-aa3cc42a4180',  -- carter cleveland
--    '520e8d15-6f48-4150-a6d3-91022da09203',  -- charlie test
--    '6f8882be-8713-4948-93e3-f6b043e67b86'   -- charlie test 2
--  )
--  ON CONFLICT (user_id) DO NOTHING;
--
-- Then per-attendee UPDATE for the curated larry_atlas_index, spawn tile,
-- spectator_visible flag, and description per PRD §"Seed data" recommendation.
--
-- IMPORTANT (sync caveat — Option C only):
-- - If an attendee's full_name changes in instaclaw_users, this table's copy
--   becomes stale. Manual UPDATE required, OR add a trigger:
--      CREATE TRIGGER sync_full_name_to_village
--      AFTER UPDATE OF full_name ON instaclaw_users
--      FOR EACH ROW EXECUTE FUNCTION sync_village_full_name();
--   (Trigger function not included in this migration; design it before
--   shipping Option C if name-sync matters.)
-- - If an attendee's VM is reassigned to a different partner, this table
--   row remains in place. That's the decoupling Option C buys — but it
--   means "village attendees" diverges from "current edge_city VM owners"
--   over time. Decide intentionally.
