-- D14/D15 Phase 3.5 — display_name + user self-toggle + sprite hash default
--
-- PARKED in `pending_migrations/` per CLAUDE.md Rule 56. Apply via Supabase
-- Studio against production, then `git mv` into `migrations/`.
--
-- Three product changes in one migration (Cooper directive 2026-05-17):
--
--   1. NEW COLUMN: village_attendee_overlay.display_name TEXT
--      - User-facing label for the spectator view. Defaults to instaclaw_users.name
--        via the view COALESCE chain; falls back to 'Agent' if both are null.
--      - Length-bounded 1..30 chars. Null is allowed (use real name).
--
--   2. SELF-TOGGLE RLS: authenticated users can INSERT/UPDATE their OWN
--      overlay row (auth.uid() = user_id). Enables dashboard toggle UI for
--      display_name + spectator_visible. service_role retains full access.
--
--   3. SPRITE HASH DEFAULT: replace COALESCE(larry_atlas_index, 0) with a
--      deterministic hash over user_id mod 50. Auto-onboarded edge_city
--      attendees get a stable, distinct sprite without manual seeding.
--
-- All three are pure view definitions + one ALTER TABLE ADD COLUMN +
-- two RLS policies + one GRANT. No table drop/recreate. Idempotent.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. ADD display_name column with length CHECK
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.village_attendee_overlay
  ADD COLUMN IF NOT EXISTS display_name TEXT;

ALTER TABLE public.village_attendee_overlay
  DROP CONSTRAINT IF EXISTS village_attendee_overlay_display_name_length;

ALTER TABLE public.village_attendee_overlay
  ADD CONSTRAINT village_attendee_overlay_display_name_length
  CHECK (display_name IS NULL OR (length(display_name) >= 1 AND length(display_name) <= 30));

COMMENT ON COLUMN public.village_attendee_overlay.display_name IS
  'User-set nickname (1..30 chars). If NULL, view falls back to instaclaw_users.name. Public-facing label on the spectator view.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. RLS policies — authenticated users self-INSERT + self-UPDATE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Pattern: a user can create OR modify their OWN overlay row but no one
-- else's. service_role retains the existing full-write policy. anon role
-- still has NO access on the raw table — only the anonymized public view.
--
-- Column-level: this RLS allows updating all columns of one's own row.
-- The dashboard UI exposes only display_name + spectator_visible. If a
-- user uses raw PostgREST to flip larry_atlas_index or home_tile, that's
-- self-customization, not a security boundary issue.

DROP POLICY IF EXISTS village_attendee_overlay_self_insert ON public.village_attendee_overlay;
CREATE POLICY village_attendee_overlay_self_insert ON public.village_attendee_overlay
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS village_attendee_overlay_self_update ON public.village_attendee_overlay;
CREATE POLICY village_attendee_overlay_self_update ON public.village_attendee_overlay
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

GRANT INSERT, UPDATE ON public.village_attendee_overlay TO authenticated;
-- (SELECT was already granted to authenticated via the existing
-- village_attendee_overlay_select policy; this adds write permissions
-- gated by the two policies above.)

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Updated village_attendees view — adds display_name; hash sprite default
-- ═══════════════════════════════════════════════════════════════════════════
--
-- display_name precedence: overlay.display_name → instaclaw_users.name → 'Agent'
-- larry_atlas_index default: ABS(hashtext(u.id::text)) % 50 — stable per-user,
--   distributes evenly across all 50 sprite indices. Manual seeds still win.

CREATE OR REPLACE VIEW public.village_attendees AS
  SELECT
    u.id                                                          AS user_id,
    u.name                                                        AS full_name,
    COALESCE(o.display_name, u.name, 'Agent')                     AS display_name,
    COALESCE(o.description, NULL)                                 AS description,
    COALESCE(o.larry_atlas_index, ABS(hashtext(u.id::text)) % 50) AS larry_atlas_index,
    COALESCE(o.home_tile_x, 30)                                   AS home_tile_x,
    COALESCE(o.home_tile_y, 37)                                   AS home_tile_y,
    COALESCE(o.spectator_visible, true)                           AS spectator_visible
  FROM public.instaclaw_vms v
  INNER JOIN public.instaclaw_users u ON u.id = v.assigned_to
  LEFT JOIN public.village_attendee_overlay o ON o.user_id = u.id
  WHERE v.partner = 'edge_city'
    AND v.assigned_to IS NOT NULL;

GRANT SELECT ON public.village_attendees TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Updated village_attendees_public — adds display_name; hash sprite default
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Critical design call: the public view exposes BOTH `agent_id` (anonymized,
-- used as the routing key for realtime broadcasts) AND `display_name` (the
-- human-facing label). The COALESCE chain means:
--
--   - User set a nickname        → "TimourK"
--   - User opted in, no nickname → "Timour Kosters" (real name)
--   - Both null                  → "Agent" (fallback string)
--   - spectator_visible = false  → row absent from view entirely
--
-- This is the BIG change from the prior privacy model: real names are
-- exposed by default on the public channel. Edge attendees signed up
-- knowing this; the spectator_visible opt-out is the safety valve.
--
-- Note: `agent_id` REMAINS in the view because it's the deterministic
-- routing key the realtime broadcasts emit (Phase 2 triggers send agent_id
-- in payloads; the client maps agent_id → Player → display_name at render
-- time). display_name is not unique-per-user (two users can pick "Cooper");
-- agent_id is. Both columns serve distinct roles.

CREATE OR REPLACE VIEW public.village_attendees_public AS
  SELECT
    village.anonymize_user_id(u.id)                               AS agent_id,
    COALESCE(o.display_name, u.name, 'Agent')                     AS display_name,
    COALESCE(o.description, NULL)                                 AS description,
    COALESCE(o.larry_atlas_index, ABS(hashtext(u.id::text)) % 50) AS larry_atlas_index,
    COALESCE(o.home_tile_x, 30)                                   AS home_tile_x,
    COALESCE(o.home_tile_y, 37)                                   AS home_tile_y,
    true                                                          AS spectator_visible
  FROM public.instaclaw_vms v
  INNER JOIN public.instaclaw_users u ON u.id = v.assigned_to
  LEFT JOIN public.village_attendee_overlay o ON o.user_id = u.id
  WHERE v.partner = 'edge_city'
    AND v.assigned_to IS NOT NULL
    AND COALESCE(o.spectator_visible, true) = true;

GRANT SELECT ON public.village_attendees_public TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- POST-APPLY VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. Column exists with CHECK constraint:
--      SELECT column_name, data_type FROM information_schema.columns
--       WHERE table_name='village_attendee_overlay' AND column_name='display_name';
--      SELECT conname FROM pg_constraint
--       WHERE conname='village_attendee_overlay_display_name_length';
--
-- 2. RLS policies present (3 total now: select + service_write + self_insert + self_update):
--      SELECT policyname FROM pg_policies
--       WHERE tablename='village_attendee_overlay' ORDER BY policyname;
--
-- 3. Authenticated GRANT on table:
--      SELECT privilege_type FROM information_schema.table_privileges
--       WHERE table_name='village_attendee_overlay' AND grantee='authenticated';
--      Expect SELECT, INSERT, UPDATE.
--
-- 4. village_attendees + village_attendees_public have display_name column:
--      SELECT column_name FROM information_schema.columns
--       WHERE table_name='village_attendees_public' ORDER BY column_name;
--      Expect: agent_id, description, display_name, home_tile_x, home_tile_y,
--      larry_atlas_index, spectator_visible.
--
-- 5. Existing 5 visible attendees now have non-null display_name:
--      SELECT agent_id, display_name FROM village_attendees_public;
--      Expect 5 rows. display_name should be the user's real name
--      (overlay.display_name is null for all 9 seed rows, so falls back
--      to instaclaw_users.name): Timour Kosters, Seref Yarar, Seren
--      Sandikci, Katherine Jones, Carter Cleveland.
--
-- 6. Hash-derived sprite indices for unseeded rows: this is harder to
--    verify directly since all 9 currently-seeded rows have explicit
--    larry_atlas_index values that override the hash. The hash will only
--    kick in for future un-seeded attendees. Smoke-test by deleting one
--    overlay row and re-reading the view:
--      -- (do not actually run this in prod; smoke-test on a fresh attendee)
--      -- DELETE FROM village_attendee_overlay WHERE user_id = '<test>';
--      -- SELECT larry_atlas_index FROM village_attendees WHERE user_id = '<test>';
--      -- Expect a stable value in 0..49 derived from the user_id hash.
