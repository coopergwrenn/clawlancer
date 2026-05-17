-- D14/D15 Phase 3 — Village Attendees (OPTION A — columns on base tables)
--
-- PARKED in `pending_migrations/` per CLAUDE.md Rule 56. See companion doc:
--   `instaclaw/docs/prd/village-attendees-phase3.md`
--
-- This option adds village-specific columns directly to `instaclaw_users`.
-- The `village_attendees` view filters `instaclaw_vms WHERE partner='edge_city'`
-- + joins `instaclaw_users` for all metadata. No overlay table.
--
-- TRADE-OFF (per PRD): simplest schema, fewest moving parts. But pollutes
-- `instaclaw_users` with 5 columns meaningful only to the 9 edge_city
-- attendees out of hundreds of users. Future partner expansion either reuses
-- these columns (forces "one home_tile across all events" — wrong for any
-- multi-event scenario) or adds more partner-specific columns. PRD does NOT
-- recommend this option.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Add village columns to instaclaw_users
-- ═══════════════════════════════════════════════════════════════════════════
--
-- All NOT NULL with DEFAULT so existing rows backfill cleanly without any
-- explicit UPDATE. Defaults match the PRD §3 / §4 sensible-default choices.

ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS village_larry_atlas_index INT  NOT NULL DEFAULT 0  CHECK (village_larry_atlas_index >= 0 AND village_larry_atlas_index <= 49);

ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS village_home_tile_x       INT  NOT NULL DEFAULT 30 CHECK (village_home_tile_x >= 0 AND village_home_tile_x <= 99);

ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS village_home_tile_y       INT  NOT NULL DEFAULT 37 CHECK (village_home_tile_y >= 0 AND village_home_tile_y <= 99);

ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS village_spectator_visible BOOL NOT NULL DEFAULT true;

ALTER TABLE public.instaclaw_users
  ADD COLUMN IF NOT EXISTS village_description       TEXT;

COMMENT ON COLUMN public.instaclaw_users.village_larry_atlas_index IS
  'Village sprite index (0..49). Village-specific. See instaclaw/docs/prd/village-attendees-phase3.md.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Authenticated village view — `village_attendees`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Aliases the village_* columns to the names serverGame.ts expects.
-- No overlay table to JOIN — simpler than Option B, at the cost of base-
-- table pollution.

CREATE OR REPLACE VIEW public.village_attendees AS
  SELECT
    u.id                              AS user_id,
    u.full_name                       AS full_name,
    u.village_description             AS description,
    u.village_larry_atlas_index       AS larry_atlas_index,
    u.village_home_tile_x             AS home_tile_x,
    u.village_home_tile_y             AS home_tile_y,
    u.village_spectator_visible       AS spectator_visible
  FROM public.instaclaw_vms v
  INNER JOIN public.instaclaw_users u ON u.id = v.assigned_to
  WHERE v.partner = 'edge_city'
    AND v.assigned_to IS NOT NULL;

GRANT SELECT ON public.village_attendees TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Public (anonymized) village view
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.village_attendees_public AS
  SELECT
    village.anonymize_user_id(u.id)   AS agent_id,
    u.village_description             AS description,
    u.village_larry_atlas_index       AS larry_atlas_index,
    u.village_home_tile_x             AS home_tile_x,
    u.village_home_tile_y             AS home_tile_y,
    true                              AS spectator_visible
  FROM public.instaclaw_vms v
  INNER JOIN public.instaclaw_users u ON u.id = v.assigned_to
  WHERE v.partner = 'edge_city'
    AND v.assigned_to IS NOT NULL
    AND u.village_spectator_visible = true;

GRANT SELECT ON public.village_attendees_public TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Public (anonymized) position view
-- ═══════════════════════════════════════════════════════════════════════════

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
  INNER JOIN public.instaclaw_users u ON u.id = p.user_id
  INNER JOIN public.instaclaw_vms v ON v.assigned_to = u.id
  WHERE v.partner = 'edge_city'
    AND u.village_spectator_visible = true;

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
-- 1. New columns on instaclaw_users:
--      SELECT column_name FROM information_schema.columns
--       WHERE table_schema='public' AND table_name='instaclaw_users'
--         AND column_name LIKE 'village_%' ORDER BY column_name;
--    Expected 5 rows: village_description, village_home_tile_x,
--    village_home_tile_y, village_larry_atlas_index, village_spectator_visible.
--
-- 2. All three views resolve against current edge_city cohort:
--      SELECT COUNT(*) FROM village_attendees;             -- expect 9
--      SELECT COUNT(*) FROM village_attendees_public;      -- expect 9 (defaults are spectator_visible=true)
--      SELECT COUNT(*) FROM agent_positions_public;        -- expect 0
--
-- 3. activity_emoji CHECK exists:
--      SELECT conname FROM pg_constraint
--       WHERE conname = 'agent_positions_activity_emoji_bounded';

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED BLOCK (apply AFTER migration; Cooper-edits)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Under Option A, attendee metadata is updated by UPDATE-ing instaclaw_users
-- rows directly. Note: this touches the same table as every other user record,
-- so be careful about WHERE clauses.
--
-- UPDATE public.instaclaw_users SET
--   village_larry_atlas_index = 30, village_home_tile_x = 30, village_home_tile_y = 37,
--   village_spectator_visible = false, village_description = 'cooper timmy'
--  WHERE id = '4e0213b3-c9e8-4812-9385-827786900b66';
-- … repeat per attendee per PRD §"Seed data" …
