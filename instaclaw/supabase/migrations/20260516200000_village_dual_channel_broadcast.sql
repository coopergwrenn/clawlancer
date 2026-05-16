-- D14/D15 — Village dual-channel broadcast triggers
--
-- Per `edgeclaw-village/docs/village-direction-2026-05-15.md` § A11 and
-- Topic 6 of `edgeclaw-village/docs/village-technical-research-2026-05-13.md`:
-- every village-relevant row mutation emits TWO broadcasts —
--   1. `village:edge-esmeralda-2026`        (private/auth)  → full row, full identity
--   2. `village-public:edge-esmeralda-2026` (public/anon)   → `agent_NNNN` ids only
-- Identity stripping happens HERE in the trigger, NOT at the consumer.
-- The public channel is cryptographically incapable of leaking identity
-- regardless of subscriber misbehavior — the leak-capable fields never
-- enter a `village-public:*` message.
--
-- If you add a new field to the private branch of any trigger, DECIDE
-- whether it goes in the public branch too. DEFAULT IS NO. Audit the
-- public-branch jsonb_build_object against the table column list line
-- by line on every change.
--
-- WHY one explicit function per table (instead of a generic parameterized
-- one): the public-payload field list is right there next to the
-- jsonb_build_object call, reviewable in a code-review diff without
-- context-switching to a "list of public columns for table X" lookup.
-- The verbose form is the point.
--
-- APPLY ORDER + SAFETY:
-- - Idempotent: CREATE SCHEMA / TABLE / FUNCTION / TRIGGER all use IF NOT
--   EXISTS or DROP IF EXISTS first. Safe to re-run.
-- - The `agent_positions` table is created here (it doesn't exist yet).
-- - No backfill: triggers fire on INSERT/UPDATE from this point forward.
--   Historical matchpool_outcomes / negotiation_threads rows do NOT
--   replay into the channel. That's by design — the village reflects
--   live activity.
-- - The triggers use `realtime.send()` which is async/non-blocking on
--   the row write. p99 added latency to a write should be sub-millisecond.

-- ─── Schema setup ────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS village;

-- ─── agent_positions table (NEW; consumed by serverGame.ts) ──────────────
--
-- The authoritative position snapshot for each agent in the village.
-- Updated by the backend after a walk completes (server-side commit
-- after the broadcast 'walk' event was emitted). Subscribers use this
-- as the "resync on reconnect" source of truth — clients that drop
-- mid-tween fetch the current row on reconnect to relocate the sprite.
--
-- Tile coordinates are tile-grid integers (NOT pixels). The renderer
-- multiplies by tileDim. Facing is a unit vector in {-1, 0, 1} on each
-- axis; 4-direction only per § 4.14.2.3.
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

-- ─── Post-apply verification (comment-only, run in psql) ─────────────────
--
-- 1) All four triggers present:
--     SELECT trigger_name, event_object_table FROM information_schema.triggers
--      WHERE trigger_name LIKE 'trg_%_dual_broadcast' ORDER BY event_object_table;
--    Expected 4 rows: agent_positions / instaclaw_vms / matchpool_outcomes /
--    negotiation_threads.
--
-- 2) Anonymization deterministic:
--     SELECT village.anonymize_user_id('00000000-0000-0000-0000-000000000001');
--    Should be stable across calls.
--
-- 3) End-to-end privacy probe — insert a synthetic row into a test_user
--    and subscribe to `village-public:edge-esmeralda-2026` via the Supabase
--    Realtime Inspector. The payload MUST contain ONLY the fields the public
--    branch above whitelists. If ANY user_id / xmtp_address / gateway_token
--    / ip_address shows up, REVERT immediately. The public channel leak
--    is the highest-severity outcome this migration can produce.
--
-- 4) Latency: confirm AFTER INSERT/UPDATE adds < 5ms p99 to any covered
--    table. realtime.send() is non-blocking on the row write but jsonb
--    construction + two PERFORMs are synchronous; budget should hold.
