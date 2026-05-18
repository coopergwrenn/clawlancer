-- D14/D15 Phase 3.6 (Gap 3) — Spawn distribution via hash-derived spawn tile
--
-- PARKED in pending_migrations/ per CLAUDE.md Rule 56.
--
-- Today: every un-seeded edge_city attendee defaults to home_tile (30, 37) —
-- plaza gazebo. At scale (50+ attendees) this stacks 40+ sprites on one tile.
--
-- Fix: village.default_spawn_tile(uid, axis) — hashes user_id to one of 23
-- curated walkable tiles distributed across all major map landmarks (plaza,
-- hotels, restaurants, library, vineyards). Stable per-user (same UUID
-- always picks the same tile). Manual seeds in village_attendee_overlay
-- still override (COALESCE picks the explicit value first).
--
-- View updates: home_tile_x and home_tile_y COALESCEs replaced. Column list
-- unchanged → CREATE OR REPLACE VIEW works (no DROP needed unlike Phase 3.5
-- where we inserted display_name and forced a column-list reshape).

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Spawn-tile function
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION village.default_spawn_tile(uid UUID, axis TEXT)
  RETURNS INT
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
AS $$
  WITH tiles(x, y) AS (
    VALUES
      -- Plaza area (8 walkable spots around the gazebo at 30,37)
      (28, 35), (30, 35), (32, 35),
      (28, 37),           (32, 37),
      (28, 39), (30, 39), (32, 39),
      -- Hotels — Hotel Trio (north) + west cluster (5)
      (24, 6),  (22, 34), (22, 38), (22, 42), (22, 47),
      -- Restaurants / cafes (4)
      (35, 31), (37, 41), (36, 9),  (32, 28),
      -- Library / theater (2)
      (30, 43), (30, 31),
      -- Main hub (1)
      (36, 36),
      -- Vineyard edges + bridge (3)
      (2, 30),  (38, 14), (26, 58)
  ),
  indexed AS (
    SELECT x, y, ROW_NUMBER() OVER () - 1 AS idx FROM tiles
  )
  SELECT CASE axis WHEN 'x' THEN x ELSE y END
    FROM indexed
   WHERE idx = (ABS(hashtext(uid::text)) % (SELECT COUNT(*) FROM indexed));
$$;

COMMENT ON FUNCTION village.default_spawn_tile(UUID, TEXT) IS
  'Deterministic hash of user_id → curated walkable tile (one of 23 spread across map landmarks). Returns x or y coordinate per axis param. Used as the COALESCE fallback for home_tile_x / home_tile_y in the village_attendees views. Curated set guaranteed walkable per data/ambient-routines.ts landmark coords.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. village_attendees view — home_tile COALESCE → hash function
-- ═══════════════════════════════════════════════════════════════════════════
-- Column list unchanged. Only the home_tile_x / home_tile_y COALESCE
-- expressions changed. CREATE OR REPLACE VIEW is sufficient.

CREATE OR REPLACE VIEW public.village_attendees AS
  SELECT
    u.id                                                              AS user_id,
    u.name                                                            AS full_name,
    COALESCE(o.display_name, u.name, 'Agent')                         AS display_name,
    COALESCE(o.description, NULL)                                     AS description,
    COALESCE(o.larry_atlas_index, ABS(hashtext(u.id::text)) % 50)     AS larry_atlas_index,
    COALESCE(o.home_tile_x, village.default_spawn_tile(u.id, 'x'))    AS home_tile_x,
    COALESCE(o.home_tile_y, village.default_spawn_tile(u.id, 'y'))    AS home_tile_y,
    COALESCE(o.spectator_visible, true)                               AS spectator_visible
  FROM public.instaclaw_vms v
  INNER JOIN public.instaclaw_users u ON u.id = v.assigned_to
  LEFT JOIN public.village_attendee_overlay o ON o.user_id = u.id
  WHERE v.partner = 'edge_city'
    AND v.assigned_to IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. village_attendees_public view — same change, mirror
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.village_attendees_public AS
  SELECT
    village.anonymize_user_id(u.id)                                   AS agent_id,
    COALESCE(o.display_name, u.name, 'Agent')                         AS display_name,
    COALESCE(o.description, NULL)                                     AS description,
    COALESCE(o.larry_atlas_index, ABS(hashtext(u.id::text)) % 50)     AS larry_atlas_index,
    COALESCE(o.home_tile_x, village.default_spawn_tile(u.id, 'x'))    AS home_tile_x,
    COALESCE(o.home_tile_y, village.default_spawn_tile(u.id, 'y'))    AS home_tile_y,
    true                                                              AS spectator_visible
  FROM public.instaclaw_vms v
  INNER JOIN public.instaclaw_users u ON u.id = v.assigned_to
  LEFT JOIN public.village_attendee_overlay o ON o.user_id = u.id
  WHERE v.partner = 'edge_city'
    AND v.assigned_to IS NOT NULL
    AND COALESCE(o.spectator_visible, true) = true;

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. Function exists and returns in-range coordinates:
--      SELECT village.default_spawn_tile('00000000-0000-0000-0000-000000000001', 'x'),
--             village.default_spawn_tile('00000000-0000-0000-0000-000000000001', 'y');
--      Returns two integers in [0, 63] for that test UUID.
--
-- 2. Same UUID → same tile (determinism):
--      Run the SELECT above 3×. Output identical every time.
--
-- 3. Different UUIDs → distribution:
--      SELECT village.default_spawn_tile(id, 'x') AS x,
--             village.default_spawn_tile(id, 'y') AS y,
--             COUNT(*)
--        FROM instaclaw_users
--       GROUP BY 1, 2
--       ORDER BY 3 DESC
--       LIMIT 25;
--      Should show 23 distinct (x,y) pairs (matches the function's tile pool),
--      with users roughly evenly distributed.
--
-- 4. View still returns 9 rows with correct seeded home_tile (not hashed):
--      SELECT user_id, home_tile_x, home_tile_y FROM village_attendees ORDER BY home_tile_x;
--      Expected: same plaza-clustered tiles as before — seeded values
--      (28-32, 35-39) preserved because COALESCE picks o.home_tile_x first.
