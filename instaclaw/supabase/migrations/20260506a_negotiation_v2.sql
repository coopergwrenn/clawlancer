-- ─────────────────────────────────────────────────────────────────────
-- v2 Agent-to-Agent Negotiation schema.
--
-- Two new tables + an instaclaw_users ALTER. Models five envelope types
-- (PROPOSE, COUNTER, ACCEPT, DECLINE, CANCEL) over a 1-3 turn state
-- machine with strict server-side validation.
--
-- PRD: instaclaw/docs/prd/PRD-v2-agent-negotiation.md §4 (data model),
--      §3.3 (state machine), §3.4 (turn invariant), §3.6 (idempotency).
--
-- Key invariants enforced at the schema level:
--   - UNIQUE(initiator_user_id, receiver_user_id, anchor_v2): same
--     match cannot produce duplicate threads from a re-firing pipeline.
--   - UNIQUE(thread_id, turn): replay-safe at the message level. XMTP
--     V3 store-and-forward, sender retry, and server-poll fallback
--     can all replay the same envelope; the server treats a 23505
--     unique violation as no-op success.
--   - state ∈ {proposed, countered, accepted, declined, cancelled,
--     cancelled_by_user, expired} via CHECK.
--   - current_turn ∈ [1, 4] via CHECK. Turn 4 is reserved for the
--     1-hour USER_CANCEL grace window post-ACCEPTED.
--   - terminated_at NULL ⇔ state ∈ {proposed, countered}: prevents
--     an "accepted" thread without a termination timestamp (the grace
--     window's anchor).
--
-- v1 INTRO traffic continues to use agent_outreach_log unchanged.
-- This migration is purely additive.
--
-- Idempotent: re-running is safe. Uses CREATE TABLE IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────

-- Required for gen_random_uuid(). Already enabled in the matchpool
-- migration (20260504_matchpool_intent_matching.sql) but a no-op
-- to re-create.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── negotiation_threads ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS negotiation_threads (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_user_id       UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  receiver_user_id        UUID NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,

  -- Identity / origination
  initiator_xmtp_address  TEXT NOT NULL,
  receiver_xmtp_address   TEXT NOT NULL,
  initiator_vm_id         UUID REFERENCES instaclaw_vms(id) ON DELETE SET NULL,

  -- Idempotency anchor: "<initiator_pv>:<receiver_user_id>:<topic_hash>"
  -- where topic_hash is sha256 first 8 chars of normalized topic text.
  -- Prevents re-PROPOSE on top-1 churn within the same pipeline cycle.
  anchor_v2               TEXT NOT NULL,

  -- Negotiation content (denormalized from PROPOSE for fast reads).
  -- The authoritative source per turn lives in negotiation_messages;
  -- these fields exist so /my-threads + the dashboard /consensus/my-
  -- matches can render thread-level summaries without joining messages.
  topic                   TEXT,
  rationale               TEXT,
  proposed_windows        JSONB,
  deliberation_score      NUMERIC(4,3),

  -- State machine
  state                   TEXT NOT NULL DEFAULT 'proposed'
                          CHECK (state IN (
                            'proposed','countered','accepted','declined',
                            'cancelled','cancelled_by_user','expired'
                          )),
  current_turn            INT NOT NULL DEFAULT 1
                          CHECK (current_turn BETWEEN 1 AND 4),

  -- Outcome (set on ACCEPT). Mirrors what gets surfaced in the
  -- terminal Telegram confirmation.
  agreed_window           TEXT,

  -- Lifecycle timestamps
  started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  terminated_at           TIMESTAMPTZ,

  -- Active threads MUST have null terminated_at; terminal threads
  -- MUST have it set. The 1-hour USER_CANCEL grace window arithmetic
  -- depends on terminated_at being non-null when state='accepted'.
  CONSTRAINT chk_terminal_has_termination_ts
    CHECK (
      (state IN ('proposed','countered') AND terminated_at IS NULL)
      OR (state IN ('accepted','declined','cancelled','cancelled_by_user','expired')
          AND terminated_at IS NOT NULL)
    ),

  -- Idempotency: the same match from the same pipeline cycle cannot
  -- create two threads. PRD §3.6 layer 1.
  UNIQUE (initiator_user_id, receiver_user_id, anchor_v2)
);

-- Hot-path indexes. Partial-index strategy mirrors agent_outreach_log
-- (the v1 ledger): only index rows we actually query against.

-- Sender's pipeline polls: "do I have any active threads I started?"
CREATE INDEX IF NOT EXISTS idx_neg_threads_active_initiator
  ON negotiation_threads (initiator_user_id, state, started_at DESC)
  WHERE state IN ('proposed','countered');

-- Receiver's mjs polls: "do I have any active threads aimed at me?"
-- Used by the server-poll fallback path when XMTP delivery missed.
CREATE INDEX IF NOT EXISTS idx_neg_threads_active_receiver
  ON negotiation_threads (receiver_user_id, state, started_at DESC)
  WHERE state IN ('proposed','countered');

-- Cron expiry sweep: 30-min cron scans threads past expires_at.
CREATE INDEX IF NOT EXISTS idx_neg_threads_expiry_sweep
  ON negotiation_threads (expires_at)
  WHERE state IN ('proposed','countered');

-- /my-threads UI lookup by either party (initiator OR receiver).
CREATE INDEX IF NOT EXISTS idx_neg_threads_recent_either
  ON negotiation_threads (started_at DESC);

ALTER TABLE negotiation_threads ENABLE ROW LEVEL SECURITY;
-- No policies = service-role only. PostgREST anon + authenticated
-- callers cannot read or write. All client interactions go through
-- /api/match/v1/negotiation/* which uses the service-role client.

COMMENT ON TABLE negotiation_threads IS
  'v2 agent-to-agent negotiation threads. Each row is one PROPOSE→ACCEPT/COUNTER/DECLINE/CANCEL conversation between two users. State machine in lib/negotiation-types.ts. Server-only via /api/match/v1/negotiation/*.';

COMMENT ON COLUMN negotiation_threads.anchor_v2 IS
  'Idempotency: <initiator_pv>:<receiver_user_id>:<topic_hash[:8]>. Prevents duplicate threads on top-1 churn.';

COMMENT ON COLUMN negotiation_threads.expires_at IS
  'Auto-expire after 24h of inactivity. Cron /api/cron/negotiation-expire sweeps. Reset to NOW + 24h on each new turn.';

-- ─── negotiation_messages ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS negotiation_messages (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id               UUID NOT NULL REFERENCES negotiation_threads(id) ON DELETE CASCADE,
  turn                    INT NOT NULL CHECK (turn BETWEEN 1 AND 4),
  envelope_type           TEXT NOT NULL
                          CHECK (envelope_type IN (
                            'propose','counter','accept','decline','cancel'
                          )),

  sender_user_id          UUID NOT NULL REFERENCES instaclaw_users(id),
  sender_xmtp_address     TEXT NOT NULL,

  -- Type-specific payload. JSONB so /respond and /decide can write
  -- per-envelope-type fields without a per-type column.
  payload                 JSONB NOT NULL,

  -- Free-form prose body — what gets sent over XMTP after the
  -- JSON header line. Receiver-side mjs picks this for disk
  -- persistence and (when LLM-summarization fails) Telegram fallback.
  prose                   TEXT,

  -- Delivery state — mirror of v1 outreach pattern.
  status                  TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','sent','failed')),
  retry_count             INT NOT NULL DEFAULT 0,
  last_retry_at           TIMESTAMPTZ,
  ack_received_at         TIMESTAMPTZ,
  ack_channel             TEXT,
  error_message           TEXT,

  sent_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- THE replay-safety primitive. PRD §3.6 layer 2. Any duplicate
  -- envelope from XMTP store-and-forward, sender retry, or server
  -- poll fallback INSERTs and 23505s; server treats as success-no-op.
  UNIQUE (thread_id, turn)
);

-- Per-thread history reads (rendering thread state for /decide
-- prompt construction, conflict-checking on transition, /my-threads).
CREATE INDEX IF NOT EXISTS idx_neg_msgs_thread_turn
  ON negotiation_messages (thread_id, turn);

-- Sender retry sweep: "find my outbound messages that haven't ACKed".
CREATE INDEX IF NOT EXISTS idx_neg_msgs_unacked_outbound
  ON negotiation_messages (sender_user_id, sent_at ASC)
  WHERE status = 'sent' AND ack_received_at IS NULL;

-- Receiver server-poll: "find inbound messages on this thread that
-- haven't been delivered to the user yet".
CREATE INDEX IF NOT EXISTS idx_neg_msgs_unacked_target
  ON negotiation_messages (thread_id)
  WHERE status = 'sent' AND ack_received_at IS NULL;

ALTER TABLE negotiation_messages ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE negotiation_messages IS
  'v2 negotiation envelope ledger. UNIQUE(thread_id, turn) is the replay-safety primitive — duplicate envelopes from XMTP store-and-forward, sender retry, or server-poll fallback all 23505 → server treats as success-no-op.';

COMMENT ON COLUMN negotiation_messages.payload IS
  'Type-specific JSONB. propose: {topic, rationale, proposed_windows[], deliberation_score}. counter: {counter_window, counter_topic, user_facing_reason}. accept: {accepted_window, user_facing_message}. decline: {decline_category, user_facing_reason}. cancel: {cancelled_by, user_facing_reason}.';

-- ─── instaclaw_users ALTER ──────────────────────────────────────────

ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS availability TEXT,
  ADD COLUMN IF NOT EXISTS autonomy_preferences JSONB DEFAULT '{}'::JSONB;

COMMENT ON COLUMN instaclaw_users.availability IS
  'Free-text availability statement, e.g. "free Wed pm, busy Thu 2-4 keynote, prefer espresso bars". The /decide LLM interprets this against proposed windows. NULL = no stated availability (LLM treats as "always present to user, no autonomy guesses").';

COMMENT ON COLUMN instaclaw_users.autonomy_preferences IS
  'v2.1+ user-controlled autonomy. v2.0 always reads {} = no autonomy. Schema (v2.1): {auto_accept_threshold: 0.0-1.0, auto_decline_threshold: 0.0-1.0, scopes: ["consensus_2026", ...]}. NEVER auto-set; only changeable via explicit user action (dashboard toggle or "auto-accept above 0.85" command).';
