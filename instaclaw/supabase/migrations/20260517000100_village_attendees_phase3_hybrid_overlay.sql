-- D14/D15 Phase 3 — Village Attendees (OPTION B — hybrid overlay + view) [RECOMMENDED]
--
-- PARKED in `pending_migrations/` per CLAUDE.md Rule 56. See companion doc:
--   `instaclaw/docs/prd/village-attendees-phase3.md`
--
-- This option creates a small overlay table for village-specific attendee
-- metadata (larry_atlas_index, home_tile, spectator_visible, description) +
-- three views that compose the client-facing schema contract:
--
--   public.village_attendees          (authenticated mode view)
--   public.village_attendees_public   (spectator mode view — anonymized)
--   public.agent_positions_public     (spectator mode view — anonymized positions)
--
-- The attendee identity is derived from `instaclaw_vms WHERE partner='edge_city'`
-- + `instaclaw_users` (for full_name). The overlay table holds only
-- village-specific metadata that doesn't belong on the base tables. LEFT JOIN
-- with COALESCE means edge_city attendees appear with default metadata even
-- before their overlay row is seeded (helpful for future attendees provisioned
-- post-launch).
--
-- VERIFY-MIGRATIONS COMPATIBILITY: this file contains ONE CREATE TABLE
-- (`village_attendee_overlay`). Once promoted to `migrations/`,
-- verify-migrations.ts will scan the table and refuse the build if it doesn't
-- exist in production. Per Rule 56: apply the SQL to prod via Supabase Studio
-- FIRST, then `git mv` the file into `migrations/`.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Overlay table: village-specific attendee metadata
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Narrow table, keyed by user_id. Holds ONLY the four columns that don't
-- live anywhere else. Base tables (instaclaw_users, instaclaw_vms) are
-- untouched. Pre-existing attendees inherit defaults via LEFT JOIN in the
-- view below; populated rows override.

CREATE TABLE IF NOT EXISTS public.village_attendee_overlay (
  user_id           UUID PRIMARY KEY REFERENCES public.instaclaw_users(id) ON DELETE CASCADE,
  larry_atlas_index INT  NOT NULL DEFAULT 0  CHECK (larry_atlas_index >= 0 AND larry_atlas_index <= 49),
  home_tile_x       INT  NOT NULL DEFAULT 30 CHECK (home_tile_x >= 0  AND home_tile_x <= 99),
  home_tile_y       INT  NOT NULL DEFAULT 37 CHECK (home_tile_y >= 0  AND home_tile_y <= 99),
  spectator_visible BOOL NOT NULL DEFAULT true,
  description       TEXT,                                -- public-safe bio line; PII-free
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.village_attendee_overlay IS
  'Village-specific metadata overlay for attendees. JOIN with instaclaw_vms (filter partner) + instaclaw_users in the village_attendees view. See instaclaw/docs/prd/village-attendees-phase3.md.';

CREATE INDEX IF NOT EXISTS idx_village_attendee_overlay_spectator
  ON public.village_attendee_overlay (spectator_visible)
  WHERE spectator_visible = true;
-- Partial index — most queries filter on spectator_visible=true (the public
-- view). For 9 attendees this is overkill but the index is cheap insurance.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. RLS on the overlay table
-- ═══════════════════════════════════════════════════════════════════════════
--
-- - service_role: full access (system writes attendee metadata; no UI yet)
-- - authenticated: SELECT only (auth'd village view reads these rows)
-- - anon: NO access on raw table — only the anonymized public view

ALTER TABLE public.village_attendee_overlay ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS village_attendee_overlay_select ON public.village_attendee_overlay;
CREATE POLICY village_attendee_overlay_select ON public.village_attendee_overlay
  FOR SELECT USING (auth.role() IN ('authenticated', 'service_role'));

DROP POLICY IF EXISTS village_attendee_overlay_service_write ON public.village_attendee_overlay;
CREATE POLICY village_attendee_overlay_service_write ON public.village_attendee_overlay
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Authenticated village view — `village_attendees`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Composes attendee identity + metadata for the village client running in
-- `mode='authenticated'`. Filters partner='edge_city' for Edge Esmeralda;
-- future partners get their own view (e.g., village_attendees_eclipse) or
-- a parameterized variant.
--
-- LEFT JOIN against overlay so edge_city attendees appear even before their
-- overlay row is seeded. COALESCE applies sensible defaults: sprite 0,
-- plaza center spawn, spectator_visible TRUE, null description.
--
-- The auth-mode client reads `full_name` from instaclaw_users. PII stays in
-- this view; the public view below strips it.

CREATE OR REPLACE VIEW public.village_attendees AS
  SELECT
    u.id                                            AS user_id,
    u.full_name                                     AS full_name,
    COALESCE(o.description, NULL)                   AS description,
    COALESCE(o.larry_atlas_index, 0)                AS larry_atlas_index,
    COALESCE(o.home_tile_x, 30)                     AS home_tile_x,
    COALESCE(o.home_tile_y, 37)                     AS home_tile_y,
    COALESCE(o.spectator_visible, true)             AS spectator_visible
  FROM public.instaclaw_vms v
  INNER JOIN public.instaclaw_users u ON u.id = v.assigned_to
  LEFT JOIN public.village_attendee_overlay o ON o.user_id = u.id
  WHERE v.partner = 'edge_city'
    AND v.assigned_to IS NOT NULL;

GRANT SELECT ON public.village_attendees TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Public (anonymized) village view — `village_attendees_public`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The spectator-mode client reads this. user_id is replaced by agent_id
-- (deterministic anonymized label via village.anonymize_user_id). full_name
-- is DROPPED. Filtered on spectator_visible = true — opted-out users
-- disappear at the view layer; the public render is structurally incapable
-- of leaking their identity.

CREATE OR REPLACE VIEW public.village_attendees_public AS
  SELECT
    village.anonymize_user_id(u.id)                 AS agent_id,
    COALESCE(o.description, NULL)                   AS description,
    COALESCE(o.larry_atlas_index, 0)                AS larry_atlas_index,
    COALESCE(o.home_tile_x, 30)                     AS home_tile_x,
    COALESCE(o.home_tile_y, 37)                     AS home_tile_y,
    true                                            AS spectator_visible
  FROM public.instaclaw_vms v
  INNER JOIN public.instaclaw_users u ON u.id = v.assigned_to
  LEFT JOIN public.village_attendee_overlay o ON o.user_id = u.id
  WHERE v.partner = 'edge_city'
    AND v.assigned_to IS NOT NULL
    AND COALESCE(o.spectator_visible, true) = true;

GRANT SELECT ON public.village_attendees_public TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Public (anonymized) position view — `agent_positions_public`
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Mirrors `agent_positions` with user_id stripped → agent_id. INNER JOINs
-- with village_attendees_public on agent_id so opted-out users' positions
-- are unreachable. The serverGame.ts client at loadInitialPositions reads
-- this in spectator mode.
--
-- Defense in depth: user_id is the leak vector. Even a strict RLS policy
-- letting anon SELECT agent_positions would expose UUIDs in row payloads.
-- The view strips the column at the schema level — anon literally cannot
-- ask for user_id.

CREATE OR REPLACE VIEW public.agent_positions_public AS
  SELECT
    village.anonymize_user_id(p.user_id)            AS agent_id,
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
  LEFT JOIN public.village_attendee_overlay o ON o.user_id = u.id
  WHERE v.partner = 'edge_city'
    AND COALESCE(o.spectator_visible, true) = true;

GRANT SELECT ON public.agent_positions_public TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. activity_emoji length cap (Phase 2 carryover follow-up)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `agent_positions.activity_emoji` is bare TEXT. The trigger forwards it to
-- the public payload. If app code ever wrote a non-emoji string (e.g., a
-- username or any free-form text), it would leak via the public broadcast.
-- 8 chars is enough for any emoji + a couple of variation selectors; stops
-- free-form text at the schema boundary.

ALTER TABLE public.agent_positions
  DROP CONSTRAINT IF EXISTS agent_positions_activity_emoji_bounded;

ALTER TABLE public.agent_positions
  ADD CONSTRAINT agent_positions_activity_emoji_bounded
  CHECK (activity_emoji IS NULL OR length(activity_emoji) <= 8);

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION (paste in Studio SQL Editor)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. Overlay table exists with the expected schema:
--      SELECT column_name, data_type, is_nullable, column_default
--        FROM information_schema.columns
--       WHERE table_schema='public' AND table_name='village_attendee_overlay'
--       ORDER BY ordinal_position;
--    Expected 8 columns: user_id, larry_atlas_index, home_tile_x, home_tile_y,
--    spectator_visible, description, created_at, updated_at.
--
-- 2. RLS enabled on the overlay table:
--      SELECT relrowsecurity FROM pg_class
--       WHERE oid = 'public.village_attendee_overlay'::regclass;
--    Expected: t
--
-- 3. All three views resolve cleanly against current edge_city cohort:
--      SELECT COUNT(*) FROM village_attendees;             -- expect 9
--      SELECT COUNT(*) FROM village_attendees_public;      -- expect 9 (all spectator_visible)
--      SELECT COUNT(*) FROM agent_positions_public;        -- expect 0 (no positions yet)
--
-- 4. agent_positions activity_emoji constraint exists:
--      SELECT conname FROM pg_constraint
--       WHERE conname = 'agent_positions_activity_emoji_bounded';
--    Expected: 1 row.
--
-- 5. Spectator view excludes user_id and full_name:
--      SELECT column_name FROM information_schema.columns
--       WHERE table_name = 'village_attendees_public' AND table_schema='public';
--    Expected: agent_id, description, larry_atlas_index, home_tile_x,
--    home_tile_y, spectator_visible (NO user_id, NO full_name).
--
-- 6. anon role can read the public view (without a JWT):
--      SET ROLE anon;
--      SELECT count(*) FROM village_attendees_public;
--      SELECT count(*) FROM agent_positions_public;
--      RESET ROLE;
--    Both should return numbers, not permission errors. anon CANNOT read
--    the overlay table:
--      SET ROLE anon;
--      SELECT count(*) FROM village_attendee_overlay;
--      RESET ROLE;
--    Expected: permission denied (or 0 rows due to RLS).

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED BLOCK (apply AFTER the migration; Cooper-edits per PRD §"Seed data")
-- ═══════════════════════════════════════════════════════════════════════════
-- COPY THIS BLOCK INTO A SEPARATE Studio query, edit spectator_visible flags
-- and descriptions to taste, then run. Do NOT include in the migration file
-- itself (data seed lives separately from schema for clarity).
--
-- INSERT INTO public.village_attendee_overlay
--   (user_id, larry_atlas_index, home_tile_x, home_tile_y, spectator_visible, description)
-- VALUES
--   ('4e0213b3-c9e8-4812-9385-827786900b66', 30, 30, 37, false, 'cooper timmy'),
--   ('cc1d7227-345d-48a5-8a87-7c1ae451956e', 32, 28, 35, false, 'edge default'),
--   ('a8344b7a-d0a0-45df-8e00-675ae2d0d71a', 34, 30, 35, true,  null),
--   ('3a2c2392-83cd-4635-b70c-51a67fac7b53', 36, 32, 35, true,  null),
--   ('0a102415-75e4-4fff-b792-773609c63ff0', 38, 28, 37, false, 'cooper edge bot'),
--   ('1d1df916-2679-4ac5-9cee-1de542859f22', 40, 32, 37, true,  null),
--   ('ef612ac6-f9a7-4e2c-ac22-aa3cc42a4180', 42, 28, 39, true,  'carter cleveland'),
--   ('520e8d15-6f48-4150-a6d3-91022da09203', 44, 30, 39, false, 'charlie test'),
--   ('6f8882be-8713-4948-93e3-f6b043e67b86', 46, 32, 39, false, 'charlie test 2')
-- ON CONFLICT (user_id) DO UPDATE SET
--   larry_atlas_index = EXCLUDED.larry_atlas_index,
--   home_tile_x       = EXCLUDED.home_tile_x,
--   home_tile_y       = EXCLUDED.home_tile_y,
--   spectator_visible = EXCLUDED.spectator_visible,
--   description       = EXCLUDED.description,
--   updated_at        = now();
