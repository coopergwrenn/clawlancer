-- The Floor — `instaclaw_agent_activity` (the real-time activity read-model)
--
-- This is the table that drives The Floor (docs/prd/the-floor.md §18). Every
-- row is one SANITIZED, real agent activity event. Larry's on-screen behavior
-- is a faithful echo of these rows; if there is no row, Larry idles honestly
-- (PRD §9 — the honesty thesis is the whole moat).
--
-- ── RULE 56 (migration discipline) ──────────────────────────────────────────
-- This file lives in `pending_migrations/` ON PURPOSE. It contains a
-- `CREATE TABLE`, and `scripts/verify-migrations.ts` (which runs first in
-- `npm run build`) scans `migrations/` for CREATE TABLE / ALTER ADD COLUMN and
-- HARD-FAILS the Vercel build until the prod schema has caught up. Putting a
-- not-yet-applied CREATE TABLE in `migrations/` takes the whole deploy pipeline
-- offline. So: apply this to prod via Supabase Studio FIRST, verify, THEN
-- `git mv` it into `migrations/` in the same commit that promotes it.
--
-- ── RULE 60 (self-contained RLS) ────────────────────────────────────────────
-- RLS is ENABLED in this same file, with explicit policies. The table is
-- DEFAULT-PRIVATE (PRD §13): an owner may read only their own agent's rows;
-- writes are service-role only (the webhook/proxy producers run server-side).
-- The PUBLIC (anonymized, opt-in) projection is a SEPARATE view shipped later,
-- when the public Floor / embed lands — it is intentionally NOT in this file,
-- so the first cut cannot leak anything publicly by construction.
--
-- ── SANITIZATION INVARIANT (PRD §13.1 #4 — load-bearing) ────────────────────
-- This table NEVER stores message content, prompt text, `prompt_hint`, tool
-- inputs/outputs, or any secret. The only producers (lib/floor-activity.ts)
-- have NO parameter that accepts message text, so content cannot leak even by
-- accident. `meta` is jsonb for sanitized structured extras ONLY. The worst-
-- case blast radius of any future RLS bug is "abstract activity leaks", never
-- "a stranger reads your messages".
--
-- Idempotent: IF NOT EXISTS / DROP POLICY IF EXISTS throughout. Safe to re-run.

CREATE TABLE IF NOT EXISTS public.instaclaw_agent_activity (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id       UUID NOT NULL REFERENCES public.instaclaw_vms(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES public.instaclaw_users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The behavior class. Maps to Larry's animation register (PRD §9.3, App. A).
  --   message_in  — a user message just ARRIVED (the perk-up trigger; §35.2)
  --   working     — the agent is generating (intensity-tiered desk work)
  --   tool        — a tool call (station walk, gated by `station`)
  --   complete    — a user request resolved (celebrate)
  --   error       — a proxy/tool error (comedic stumble, never an alarm)
  --   heartbeat   — background system tick (minor; NOT user work)
  --   idle        — explicit idle marker (rare; idle is usually inferred)
  --   skill_added — a new skill installed (a new station materializes)
  kind        TEXT NOT NULL CHECK (kind IN (
                'message_in','working','tool','complete','error',
                'heartbeat','idle','skill_added'
              )),

  -- Which station the agent visited, if any. Whitelist-mapped by the producer
  -- (PRD §26); NULL until tool-name → station mapping lands. Larry only walks
  -- to a station that exists in his office (gated on installed skills, §7).
  station     TEXT CHECK (station IS NULL OR station IN (
                'browser','trading','mailroom','memory','studio','workbench'
              )),

  -- Effort tier from cost_weight/model: 1 light (haiku) · 2 focused (sonnet)
  -- · 3 deep (opus). Drives lamp brightness / "thinking hard" / deep-work aura.
  intensity   SMALLINT CHECK (intensity IS NULL OR intensity BETWEEN 1 AND 3),

  -- The originating channel for message_in (telegram/imessage/discord/web).
  -- Abstract, non-PII — useful for "you messaged from Telegram" framing.
  channel     TEXT CHECK (channel IS NULL OR channel IN (
                'telegram','imessage','discord','web'
              )),

  -- Whitelisted tool name ONLY (PRD §26). Raw/unknown tool names → NULL.
  -- Never a free-form string from the model.
  tool_name   TEXT,

  -- True once the row has passed sanitization and is safe for the (future)
  -- public projection. Producers set this explicitly; the public view will
  -- read only public_safe = true rows.
  public_safe BOOLEAN NOT NULL DEFAULT true,

  -- Sanitized structured extras ONLY. NEVER message content / prompt / secrets.
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Primary access pattern: "the recent activity for THIS agent, newest first"
-- (the Floor feed + the polling fallback, PRD §10.1, §19).
CREATE INDEX IF NOT EXISTS idx_floor_activity_vm_created
  ON public.instaclaw_agent_activity (vm_id, created_at DESC);

-- Owner-by-user lookups (resolve handle → user → their agent's feed).
CREATE INDEX IF NOT EXISTS idx_floor_activity_user_created
  ON public.instaclaw_agent_activity (user_id, created_at DESC);

-- ── RLS (Rule 60) — default-private ─────────────────────────────────────────
ALTER TABLE public.instaclaw_agent_activity ENABLE ROW LEVEL SECURITY;

-- Owner may read only their own agent's activity. (service_role bypasses RLS,
-- so the server-side producers in lib/floor-activity.ts write freely.)
DROP POLICY IF EXISTS floor_activity_owner_select ON public.instaclaw_agent_activity;
CREATE POLICY floor_activity_owner_select ON public.instaclaw_agent_activity
  FOR SELECT USING (auth.uid() = user_id);

-- No anon/authenticated INSERT/UPDATE/DELETE policies: writes are service-role
-- only, by design. The public (anonymized) read path is a separate view
-- shipped with the public Floor — intentionally absent here so v1 cannot leak.

-- ── Retention (follow-up) ───────────────────────────────────────────────────
-- The Floor is "now", not an archive. A pg_cron job should prune rows older
-- than ~7–30 days (mirror 20260509_usage_log_retention_pgcron.sql). Deferred to
-- a sibling migration so this one stays a clean, reviewable CREATE TABLE.

-- Verification (paste into Supabase SQL Editor after apply):
--   SELECT column_name, data_type
--     FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='instaclaw_agent_activity'
--    ORDER BY ordinal_position;
--   -- expect 11 columns.
--   SELECT polname FROM pg_policies WHERE tablename='instaclaw_agent_activity';
--   -- expect: floor_activity_owner_select
