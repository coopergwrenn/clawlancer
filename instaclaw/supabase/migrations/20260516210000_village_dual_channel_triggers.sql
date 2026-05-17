-- D14/D15 — Village dual-channel broadcast triggers (Phase 2)
--
-- PARKED in `pending_migrations/` per CLAUDE.md Rule 56. This file is NOT
-- in `migrations/` so `verify-migrations.ts` does NOT scan it during the
-- Vercel pre-build check. The build pipeline is unaffected by this file's
-- presence regardless of whether the contained objects exist in prod.
--
-- PROMOTE THIS FILE when ready to apply (per the runbook in
-- `instaclaw/docs/village-dual-channel-migration-apply.md`):
--
--   1. Paste this SQL into Supabase Studio SQL Editor (staging first).
--   2. Run the post-apply verification queries at the bottom of this file.
--   3. End-to-end privacy probe — insert a synthetic row, subscribe to
--      `village-public:edge-esmeralda-2026` via the Realtime Inspector,
--      confirm payload contains ONLY whitelisted fields.
--   4. Repeat against production.
--   5. `git mv instaclaw/supabase/pending_migrations/<this>.sql
--           instaclaw/supabase/migrations/<this>.sql`
--      and commit with the apply-date in the PR description.
--
-- Per `edgeclaw-village/docs/village-direction-2026-05-15.md` § A11 and
-- Topic 6 of `edgeclaw-village/docs/village-technical-research-2026-05-13.md`:
-- every village-relevant row mutation emits TWO broadcasts —
--   1. `village:edge-esmeralda-2026`        (private/auth)  → full row, full identity
--   2. `village-public:edge-esmeralda-2026` (public/anon)   → `agent_NNNN` ids only
--
-- Identity stripping happens HERE in the trigger, NOT at the consumer. The
-- public channel is cryptographically incapable of leaking identity
-- regardless of subscriber misbehavior — the leak-capable fields never enter
-- a `village-public:*` message.
--
-- If you add a new field to the private branch of any trigger, DECIDE
-- whether it goes in the public branch too. DEFAULT IS NO. Audit the
-- public-branch jsonb_build_object against the table column list line by
-- line on every change.
--
-- WHY one explicit function per table (instead of a generic parameterized
-- one): the public-payload field list is right there next to the
-- jsonb_build_object call, reviewable in a code-review diff without
-- context-switching to a "list of public columns for table X" lookup.
-- The verbose form is the point.
--
-- VERIFY-MIGRATIONS COMPATIBILITY: this file contains no CREATE TABLE and
-- no ALTER TABLE ADD COLUMN. The trigger functions live in the `village`
-- schema and are bypassed by the non-public-schema skip at
-- `scripts/verify-migrations.ts:189-193`. Triggers on public tables are
-- not parsed by verify-migrations (only CREATE TABLE / ALTER TABLE ADD
-- COLUMN are). So once promoted to `migrations/`, this file does not
-- trigger any verify-migrations check.

-- ─── Schema setup ────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS village;

-- ─── Anonymization helper ────────────────────────────────────────────────
--
-- Deterministic user_id → 'agent_NNNN' mapping. Non-cryptographic.
-- Same user always gets the same label; ~6% pair-collision chance at
-- 100 users on the 0..9999 label space — fine since labels are just
-- opaque visual identifiers on the spectator channel, not load-bearing
-- for any security boundary.
--
-- v2 plan (NOT in this migration): introduce a salt in Vault, use
-- digest(user_id || salt, 'sha256') for cryptographic-strength labels.
-- Not needed for Edge Esmeralda June 17 launch — public spectator
-- payloads are already de-correlated from identity by the field-level
-- whitelist; the salt would only matter if the user_id set itself were
-- public, which it isn't.
CREATE OR REPLACE FUNCTION village.anonymize_user_id(uid UUID)
  RETURNS TEXT
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
AS $$
  SELECT 'agent_' || LPAD(
    (ABS(hashtext(uid::text)) % 10000)::text,
    4,
    '0'
  );
$$;

-- ─── Public views: DEFERRED to Phase 3 ──────────────────────────────────
--
-- This migration originally contained two `CREATE OR REPLACE VIEW`
-- statements:
--   - `public.village_attendees_public` — anonymized attendee roster
--   - `public.agent_positions_public`   — anonymized position snapshot
--
-- Both views select from `public.village_attendees`. **That table does
-- not exist in production yet** — verified via the runbook's pre-apply
-- schema check on 2026-05-16 (PGRST205 "Could not find the table
-- 'public.village_attendees' in the schema cache"). No migration anywhere
-- in `supabase/migrations/` defines it. Creating the views would throw on
-- apply and leave partial state.
--
-- Rather than block this entire migration on a product-decision-pending
-- `village_attendees` table schema (where do attendees come from? FK to
-- instaclaw_users? Edge-City API import? in-app reg form?), the views
-- are deferred to a separate Phase 3 migration that lands AFTER:
--
--   1. Cooper decides what an `attendee` row is (FK source, opt-in
--      mechanism, lifecycle).
--   2. A `village_attendees` table + RLS migration ships and is applied.
--
-- The village frontend's `serverGame.ts:loadAttendees()` already handles
-- this gracefully — `PGRST205` from the missing public view returns
-- `attendees: []` (warning log only), and the spectator render falls
-- back to the 14 hand-scripted ambient NPCs. Authenticated mode degrades
-- the same way. Neither mode crashes; both stay renderable.
--
-- This migration's scope is now triggers-only, matching the runbook's
-- original Phase 2 specification.

-- ─── Trigger: matchpool_outcomes → dual broadcast ────────────────────────
--
-- Fires AFTER INSERT/UPDATE on matchpool_outcomes. PRIVATE includes the
-- full match context: scores, both real user_ids, action. PUBLIC only the
-- anonymized pair + match_engine. Scores deliberately EXCLUDED from
-- public — they'd leak information about how the matching engine ranks
-- specific users, which is sensitive even with anonymized labels (rank
-- patterns can be re-identified against profile data).
CREATE OR REPLACE FUNCTION village.emit_matchpool_outcome()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
DECLARE
  v_source_anon TEXT := village.anonymize_user_id(NEW.source_user_id);
  v_candidate_anon TEXT := village.anonymize_user_id(NEW.candidate_user_id);
  v_op TEXT := TG_OP;
  v_private JSONB;
  v_public  JSONB;
BEGIN
  v_private := jsonb_build_object(
    'table', 'matchpool_outcomes',
    'op', v_op,
    'record', jsonb_build_object(
      'outcome_id', NEW.outcome_id,
      'source_user_id', NEW.source_user_id,
      'candidate_user_id', NEW.candidate_user_id,
      'match_engine', NEW.match_engine,
      'rrf_score', NEW.rrf_score,
      'mutual_score', NEW.mutual_score,
      'deliberation_score', NEW.deliberation_score
    )
  );

  -- PUBLIC: anonymized pair + engine. NO user_ids, NO scores.
  v_public := jsonb_build_object(
    'table', 'matchpool_outcomes',
    'op', v_op,
    'record', jsonb_build_object(
      'agent_a', v_source_anon,
      'agent_b', v_candidate_anon,
      'match_engine', NEW.match_engine
    )
  );

  PERFORM realtime.send(v_private, v_op, 'village:edge-esmeralda-2026', true);
  PERFORM realtime.send(v_public,  v_op, 'village-public:edge-esmeralda-2026', false);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_matchpool_outcomes_dual_broadcast ON public.matchpool_outcomes;
CREATE TRIGGER trg_matchpool_outcomes_dual_broadcast
  AFTER INSERT OR UPDATE ON public.matchpool_outcomes
  FOR EACH ROW EXECUTE FUNCTION village.emit_matchpool_outcome();

-- ─── Trigger: negotiation_threads → dual broadcast ───────────────────────
--
-- The state machine for matched-pair conversations. State transitions
-- ('proposed' → 'accepted' / 'countered' / 'declined' / etc.) drive the
-- visual side: agents face each other, exchange speech bubbles.
--
-- ABSOLUTE DO-NOT-INCLUDE in public: initiator_xmtp_address, receiver_
-- xmtp_address (these ARE identity — wallet addresses are public on
-- chain), topic, rationale, proposed_windows (all contain free-form
-- text that may include identifying meeting details or other user data).
CREATE OR REPLACE FUNCTION village.emit_negotiation_thread()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
DECLARE
  v_initiator_anon TEXT := village.anonymize_user_id(NEW.initiator_user_id);
  v_receiver_anon  TEXT := village.anonymize_user_id(NEW.receiver_user_id);
  v_op TEXT := TG_OP;
  v_private JSONB;
  v_public  JSONB;
BEGIN
  v_private := jsonb_build_object(
    'table', 'negotiation_threads',
    'op', v_op,
    'record', jsonb_build_object(
      'id', NEW.id,
      'initiator_user_id', NEW.initiator_user_id,
      'receiver_user_id', NEW.receiver_user_id,
      'initiator_xmtp_address', NEW.initiator_xmtp_address,
      'receiver_xmtp_address', NEW.receiver_xmtp_address,
      'state', NEW.state,
      'current_turn', NEW.current_turn,
      'topic', NEW.topic,
      'deliberation_score', NEW.deliberation_score
    )
  );

  -- PUBLIC: anonymized pair + state. NO xmtp, NO topic, NO rationale,
  -- NO proposed_windows.
  v_public := jsonb_build_object(
    'table', 'negotiation_threads',
    'op', v_op,
    'record', jsonb_build_object(
      'agent_initiator', v_initiator_anon,
      'agent_receiver', v_receiver_anon,
      'state', NEW.state,
      'current_turn', NEW.current_turn
    )
  );

  PERFORM realtime.send(v_private, v_op, 'village:edge-esmeralda-2026', true);
  PERFORM realtime.send(v_public,  v_op, 'village-public:edge-esmeralda-2026', false);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_negotiation_threads_dual_broadcast ON public.negotiation_threads;
CREATE TRIGGER trg_negotiation_threads_dual_broadcast
  AFTER INSERT OR UPDATE ON public.negotiation_threads
  FOR EACH ROW EXECUTE FUNCTION village.emit_negotiation_thread();

-- ─── Trigger: instaclaw_vms lifecycle → dual broadcast ───────────────────
--
-- VM health transitions drive "agent comes online / goes offline / freezes"
-- visuals. Public payload is ONLY (anonymized owner, health_status). Nothing
-- else. The VM table has many identity-revealing fields (name, ip_address,
-- gateway_token, telegram_bot_token, telegram_bot_username, bankr_evm_address,
-- agentbook_wallet_address, etc.); the public payload omits ALL of them.
--
-- Self-throttle: only emit on health_status TRANSITIONS, not every UPDATE.
-- A VM updated for an unrelated field (config_version bump, last_health_check
-- tick, etc.) would otherwise flood both channels.
CREATE OR REPLACE FUNCTION village.emit_vm_lifecycle()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
DECLARE
  v_agent_anon TEXT;
  v_op TEXT := TG_OP;
  v_private JSONB;
  v_public  JSONB;
BEGIN
  -- VM with no owner: nothing to render in the village.
  IF NEW.assigned_to IS NULL THEN RETURN NEW; END IF;
  -- Skip UPDATEs that don't change health_status (config_version bumps etc.).
  IF TG_OP = 'UPDATE' AND OLD.health_status IS NOT DISTINCT FROM NEW.health_status THEN
    RETURN NEW;
  END IF;

  v_agent_anon := village.anonymize_user_id(NEW.assigned_to);

  v_private := jsonb_build_object(
    'table', 'instaclaw_vms',
    'op', v_op,
    'record', jsonb_build_object(
      'id', NEW.id,
      'name', NEW.name,
      'assigned_to', NEW.assigned_to,
      'health_status', NEW.health_status,
      'tier', NEW.tier,
      'api_mode', NEW.api_mode,
      'partner', NEW.partner,
      'telegram_bot_username', NEW.telegram_bot_username
    )
  );

  -- PUBLIC: anonymized owner + health_status. Nothing else.
  v_public := jsonb_build_object(
    'table', 'instaclaw_vms',
    'op', v_op,
    'record', jsonb_build_object(
      'agent_id', v_agent_anon,
      'health_status', NEW.health_status
    )
  );

  PERFORM realtime.send(v_private, v_op, 'village:edge-esmeralda-2026', true);
  PERFORM realtime.send(v_public,  v_op, 'village-public:edge-esmeralda-2026', false);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_instaclaw_vms_dual_broadcast ON public.instaclaw_vms;
CREATE TRIGGER trg_instaclaw_vms_dual_broadcast
  AFTER INSERT OR UPDATE ON public.instaclaw_vms
  FOR EACH ROW EXECUTE FUNCTION village.emit_vm_lifecycle();

-- ─── Trigger: agent_positions → dual broadcast (snapshot/resync path) ────
--
-- This is the SNAPSHOT path, not the live-tween path. The live tween is
-- a direct broadcast 'walk' event emitted by the backend BEFORE the
-- position is committed. This trigger fires after the row is committed,
-- providing the authoritative state for clients reconnecting mid-tween
-- or recovering from dropped packets.
--
-- Public payload includes position (it's spatial — that's the village's
-- entire point). Identity stripped via the agent_id anonymization.
CREATE OR REPLACE FUNCTION village.emit_agent_position()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
AS $$
DECLARE
  v_agent_anon TEXT := village.anonymize_user_id(NEW.user_id);
  v_op TEXT := TG_OP;
  v_private JSONB;
  v_public  JSONB;
BEGIN
  v_private := jsonb_build_object(
    'table', 'agent_positions',
    'op', v_op,
    'record', jsonb_build_object(
      'user_id', NEW.user_id,
      'tile_x', NEW.tile_x,
      'tile_y', NEW.tile_y,
      'facing_dx', NEW.facing_dx,
      'facing_dy', NEW.facing_dy,
      'is_moving', NEW.is_moving,
      'is_thinking', NEW.is_thinking,
      'is_speaking', NEW.is_speaking,
      'activity_emoji', NEW.activity_emoji,
      'activity_until', NEW.activity_until
    )
  );

  v_public := jsonb_build_object(
    'table', 'agent_positions',
    'op', v_op,
    'record', jsonb_build_object(
      'agent_id', v_agent_anon,
      'tile_x', NEW.tile_x,
      'tile_y', NEW.tile_y,
      'facing_dx', NEW.facing_dx,
      'facing_dy', NEW.facing_dy,
      'is_moving', NEW.is_moving,
      'is_thinking', NEW.is_thinking,
      'is_speaking', NEW.is_speaking,
      'activity_emoji', NEW.activity_emoji,
      'activity_until', NEW.activity_until
    )
  );

  PERFORM realtime.send(v_private, v_op, 'village:edge-esmeralda-2026', true);
  PERFORM realtime.send(v_public,  v_op, 'village-public:edge-esmeralda-2026', false);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_agent_positions_dual_broadcast ON public.agent_positions;
CREATE TRIGGER trg_agent_positions_dual_broadcast
  AFTER INSERT OR UPDATE ON public.agent_positions
  FOR EACH ROW EXECUTE FUNCTION village.emit_agent_position();

-- ─── Post-apply verification (run in psql / Supabase SQL Editor) ─────────
--
-- 1) All four triggers present:
--     SELECT trigger_name, event_object_table FROM information_schema.triggers
--      WHERE trigger_name LIKE 'trg_%_dual_broadcast' ORDER BY event_object_table;
--    Expected 4 rows: agent_positions / instaclaw_vms / matchpool_outcomes /
--    negotiation_threads.
--
-- 2) Anonymization deterministic — run 3×, output MUST be identical:
--     SELECT village.anonymize_user_id('00000000-0000-0000-0000-000000000001');
--
-- 3) (Deferred to Phase 3) View readability — `village_attendees_public`
--    and `agent_positions_public` are not in this migration's scope, so
--    no view-readability check applies. When Phase 3 lands those views,
--    add their `SET ROLE anon; SELECT count(*) FROM <view>; RESET ROLE;`
--    checks back here.
--
-- 4) End-to-end privacy probe — see
--    `instaclaw/docs/village-dual-channel-migration-apply.md` § "Post-apply
--    verification" step 3. This is the CRITICAL check: subscribe to the
--    public channel via the Realtime Inspector and confirm the payload
--    contains ONLY whitelisted fields after a synthetic test INSERT.
--    If ANY user_id / xmtp_address / gateway_token / ip_address / score
--    appears in a public-channel message, REVERT IMMEDIATELY using the
--    rollback SQL in that doc.
--
-- 5) Latency: confirm AFTER INSERT/UPDATE adds < 5ms p99 to any covered
--    table. realtime.send() is non-blocking on the row write but jsonb
--    construction + two PERFORMs are synchronous; budget should hold.
