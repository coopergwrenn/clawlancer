-- APPLIED to production 2026-06-04 via Supabase Studio SQL Editor. Verified:
-- all 5 columns present (id/user_id uuid, session_type text, session_id uuid,
-- created_at timestamptz), RLS enabled, unique constraint + index present.
-- Promoted from pending_migrations/ to migrations/ per Rule 56 after apply.
--
-- Session pins for the dashboard sidebar Sessions index (Stage 2 — server-backed pins).
--
-- Stage 1 stored pins in localStorage (per-device). Stage 2 moves them to this
-- table so a user's pins follow them across devices. The PinStore interface in
-- components/dashboard/use-pins.ts is UNCHANGED; only its internals swap from
-- localStorage to /api/sessions/pins (GET/POST/DELETE) backed by this table,
-- with localStorage retained as an offline cache. The consuming component
-- (components/dashboard/sessions-section.tsx) does not change at all — the
-- PinStore interface is the seam. See docs/prd/sidebar-sessions-index-2026-06-04.md.
--
-- A "session" is one of two Command Center entities — a web chat conversation
-- (instaclaw_conversations.id) or a task (instaclaw_tasks.id). Both are UUIDs.
-- The pin is polymorphic: (session_type, session_id) names which one. There is
-- intentionally NO foreign key on session_id, because it points to one of two
-- tables depending on session_type. Integrity of the *target* is handled at
-- read time: the sidebar self-heals a pin whose target is deleted/archived by
-- unpinning it (see use-pins `usePinnedRows`). The user_id FK + ON DELETE
-- CASCADE still guarantees a user's pins vanish when the user is deleted.

CREATE TABLE IF NOT EXISTS instaclaw_session_pins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  session_type TEXT NOT NULL CHECK (session_type IN ('chat', 'task')),
  session_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One pin per (user, entity). Makes POST idempotent (ON CONFLICT DO NOTHING)
  -- and structurally prevents duplicate rows for the same pinned session.
  CONSTRAINT instaclaw_session_pins_unique UNIQUE (user_id, session_type, session_id)
);

-- Backs the GET list query: "all of this user's pins, newest first."
-- (The UNIQUE constraint above already provides the index used for the
-- existence/upsert/DELETE lookup by (user_id, session_type, session_id).)
CREATE INDEX IF NOT EXISTS idx_session_pins_user_created
  ON instaclaw_session_pins(user_id, created_at DESC);

-- RLS — defense-in-depth ONLY. This is NOT the enforcement layer for this app.
--
-- READ THIS before assuming RLS protects these rows: InstaClaw authenticates via
-- NextAuth (Google OAuth), NOT Supabase Auth, and the server accesses Supabase
-- with the SERVICE ROLE key — which BYPASSES RLS entirely. Under that access
-- pattern auth.uid() is NULL, so these policies would deny everything if they
-- were the gate. They are NOT the gate. The real authorization lives in the
-- route handler (app/api/sessions/pins/route.ts): it resolves the NextAuth
-- session -> user_id and scopes EVERY query to that user_id. These policies
-- mirror instaclaw_library's (good practice; the correct posture if we ever move
-- to Supabase Auth or expose anon-key access), but server-side user-scoping is
-- what actually keeps one user's pins private from another. See CLAUDE.md Rule 60.
ALTER TABLE instaclaw_session_pins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own session pins"
  ON instaclaw_session_pins FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can insert own session pins"
  ON instaclaw_session_pins FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own session pins"
  ON instaclaw_session_pins FOR DELETE USING (user_id = auth.uid());

-- (No UPDATE policy and no updated_at column/trigger: pins are insert/delete
--  only, never mutated.)

-- ── Post-apply verification (run in Supabase Studio after applying) ──────────
-- 1. Table + columns:
--    SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'instaclaw_session_pins' ORDER BY ordinal_position;
--    -- expect: id uuid | user_id uuid | session_type text | session_id uuid | created_at timestamptz
-- 2. RLS enabled:
--    SELECT relrowsecurity FROM pg_class WHERE relname = 'instaclaw_session_pins';   -- expect: t
-- 3. Unique constraint:
--    SELECT conname FROM pg_constraint
--    WHERE conrelid = 'instaclaw_session_pins'::regclass AND contype = 'u';
--    -- expect: instaclaw_session_pins_unique
-- 4. Indexes:
--    SELECT indexname FROM pg_indexes WHERE tablename = 'instaclaw_session_pins';
--    -- expect: instaclaw_session_pins_pkey | instaclaw_session_pins_unique | idx_session_pins_user_created
