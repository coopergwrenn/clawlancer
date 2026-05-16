-- D14/D15 — agent_positions table (Phase 1 of village dual-channel broadcast)
--
-- ⚠️  RULE 55 NOTE — this file's content matches what's applied in production.
--    The original commit of this file contained the village schema, anonymize
--    helper, and 4 broadcast triggers as well. Those parts were never applied
--    to prod (verify-migrations.ts blocked the build until the schema caught
--    up). They were extracted to `pending_migrations/20260516210000_village_
--    dual_channel_triggers.sql` and will be applied via a separate, approved
--    rollout per `instaclaw/docs/village-dual-channel-migration-apply.md`.
--
--    DO NOT add functions or triggers back to this file — they belong in the
--    pending file until applied. See CLAUDE.md Rule 56 for the discipline.
--
-- WHAT THIS FILE CONTAINS (= what was hand-pasted into Supabase Studio against
-- production on 2026-05-16 to unblock the build pipeline):
--
--   1. `public.agent_positions` table + columns + CHECK constraints
--   2. `idx_agent_positions_updated_at` index
--   3. RLS enabled + three policies (select / self_update / service_insert)
--
-- The authoritative position snapshot for each agent in the village. Updated
-- by the backend after a walk completes (server-side commit after the
-- broadcast 'walk' event was emitted). Subscribers use this as the "resync on
-- reconnect" source of truth — clients that drop mid-tween fetch the current
-- row on reconnect to relocate the sprite.
--
-- Tile coordinates are tile-grid integers (NOT pixels). The renderer
-- multiplies by tileDim. Facing is a unit vector in {-1, 0, 1} on each axis;
-- 4-direction only per § 4.14.2.3 of the village direction doc.
--
-- Idempotent: every CREATE uses IF NOT EXISTS; every DROP POLICY uses IF
-- EXISTS. Safe to re-run against a target that already has the table.

CREATE TABLE IF NOT EXISTS public.agent_positions (
  user_id          UUID PRIMARY KEY REFERENCES public.instaclaw_users(id) ON DELETE CASCADE,
  tile_x           INT NOT NULL DEFAULT 0,
  tile_y           INT NOT NULL DEFAULT 0,
  facing_dx        INT NOT NULL DEFAULT 0  CHECK (facing_dx BETWEEN -1 AND 1),
  facing_dy        INT NOT NULL DEFAULT 1  CHECK (facing_dy BETWEEN -1 AND 1),
  is_moving        BOOLEAN NOT NULL DEFAULT false,
  is_thinking      BOOLEAN NOT NULL DEFAULT false,
  is_speaking      BOOLEAN NOT NULL DEFAULT false,
  activity_emoji   TEXT,
  activity_until   TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_positions_updated_at
  ON public.agent_positions (updated_at DESC);

ALTER TABLE public.agent_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_positions_select ON public.agent_positions;
CREATE POLICY agent_positions_select ON public.agent_positions
  FOR SELECT USING (auth.role() = 'authenticated' OR auth.role() = 'service_role');

DROP POLICY IF EXISTS agent_positions_self_update ON public.agent_positions;
CREATE POLICY agent_positions_self_update ON public.agent_positions
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS agent_positions_service_insert ON public.agent_positions;
CREATE POLICY agent_positions_service_insert ON public.agent_positions
  FOR INSERT WITH CHECK (auth.role() = 'service_role' OR auth.uid() = user_id);

-- Verification (paste in psql / Supabase SQL Editor):
--
--   SELECT column_name, data_type
--     FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='agent_positions'
--    ORDER BY ordinal_position;
--
-- Expected 11 rows: user_id, tile_x, tile_y, facing_dx, facing_dy, is_moving,
-- is_thinking, is_speaking, activity_emoji, activity_until, updated_at.
