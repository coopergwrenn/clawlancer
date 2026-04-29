-- 20260429_research_schema.sql
--
-- Research data schema for the Edge Esmeralda 2026 Agent Village experiment.
-- Defined in PRD section 4.10.3 (instaclaw/docs/prd/edgeclaw-partner-integration.md).
--
-- These tables are populated DURING THE VILLAGE by the agent runtime
-- (signals submitted, matches returned, briefings sent, governance events,
-- cohort assignments). They are then exported via the anonymization pipeline
-- in lib/research-export/ and delivered to Vendrov + research collaborators.
--
-- Privacy guarantees (see PRD 4.9.5 + 4.10.3 + 6):
--   - agent_id columns are POPULATED WITH RAW BANKR WALLET ADDRESSES at
--     write time, then HASHED at export time using a per-export salt.
--     The raw wallet never leaves InstaClaw infrastructure.
--   - free-text fields (interests, goals) are filtered through a PII
--     regex sweep at export time before reaching researchers.
--   - per-human longitudinal study requires explicit consent (captured
--     via instaclaw_users.research_longitudinal_consent column added below).
--
-- Schema lives in its own `research` schema for clean separation from
-- the platform schema (public.*).

CREATE SCHEMA IF NOT EXISTS research;

-- ─────────────────────────────────────────────────────────────────────
-- Table 1: research.agent_signals
-- Every nightly availability signal an agent submitted to Index Network +
-- the XMTP plaza.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS research.agent_signals (
  signal_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bankr_wallet           TEXT NOT NULL,           -- hashed at export time
  night_of               DATE NOT NULL,
  interests              TEXT[] NOT NULL DEFAULT '{}',
  goals                  TEXT[] NOT NULL DEFAULT '{}',
  looking_for            TEXT[] NOT NULL DEFAULT '{}',
  available_slot_count   INT NOT NULL DEFAULT 0,
  week                   INT NOT NULL CHECK (week >= 1 AND week <= 4),
  submitted_to_index_network_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_signals_night ON research.agent_signals (night_of);
CREATE INDEX IF NOT EXISTS idx_agent_signals_wallet ON research.agent_signals (bankr_wallet);

COMMENT ON TABLE research.agent_signals IS
  'EE26: Nightly availability signals. PII-relevant column: bankr_wallet (hashed at export).';

-- ─────────────────────────────────────────────────────────────────────
-- Table 2: research.match_outcomes
-- Every Index Network match candidate that was returned + what the agent did with it.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS research.match_outcomes (
  outcome_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id               UUID NOT NULL REFERENCES research.agent_signals(signal_id) ON DELETE CASCADE,
  candidate_bankr_wallet  TEXT NOT NULL,           -- hashed at export time
  match_score             FLOAT NOT NULL CHECK (match_score >= 0 AND match_score <= 1),
  agent_action            TEXT NOT NULL CHECK (agent_action IN ('dm_sent', 'skipped', 'cluster_added')),
  counterpart_response    TEXT CHECK (counterpart_response IN ('accepted', 'declined', 'counter', 'no_reply')),
  human_confirmed         BOOLEAN,
  meeting_actually_happened BOOLEAN,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_match_outcomes_signal ON research.match_outcomes (signal_id);
CREATE INDEX IF NOT EXISTS idx_match_outcomes_candidate ON research.match_outcomes (candidate_bankr_wallet);

COMMENT ON TABLE research.match_outcomes IS
  'EE26: Per-candidate Index Network match outcomes. PII-relevant: candidate_bankr_wallet (hashed at export).';

-- ─────────────────────────────────────────────────────────────────────
-- Table 3: research.briefing_outcomes
-- What each morning briefing contained and how the human responded.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS research.briefing_outcomes (
  briefing_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bankr_wallet            TEXT NOT NULL,
  briefing_date           DATE NOT NULL,
  proposed_intro_count    INT NOT NULL DEFAULT 0,
  proposed_event_count    INT NOT NULL DEFAULT 0,
  proposed_governance_count INT NOT NULL DEFAULT 0,
  human_response          TEXT CHECK (human_response IN ('approved_all', 'approved_partial', 'declined_all', 'no_response', 'modified')),
  response_latency_minutes INT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_briefing_outcomes_date ON research.briefing_outcomes (briefing_date);
CREATE INDEX IF NOT EXISTS idx_briefing_outcomes_wallet ON research.briefing_outcomes (bankr_wallet);

COMMENT ON TABLE research.briefing_outcomes IS
  'EE26: Morning briefing composition + human response. PII-relevant: bankr_wallet (hashed at export).';

-- ─────────────────────────────────────────────────────────────────────
-- Table 4: research.governance_events
-- Per-proposal, per-agent participation.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS research.governance_events (
  event_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id             TEXT NOT NULL,            -- shared across all agents for the same proposal
  bankr_wallet            TEXT NOT NULL,
  agent_surfaced_to_human BOOLEAN NOT NULL,
  human_voted             BOOLEAN NOT NULL DEFAULT FALSE,
  vote_value              TEXT CHECK (vote_value IN ('yes', 'no', 'abstain')),
  vote_latency_minutes    INT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_governance_events_proposal ON research.governance_events (proposal_id);
CREATE INDEX IF NOT EXISTS idx_governance_events_wallet ON research.governance_events (bankr_wallet);

COMMENT ON TABLE research.governance_events IS
  'EE26: Per-proposal, per-agent governance participation. PII-relevant: bankr_wallet (hashed at export).';

-- ─────────────────────────────────────────────────────────────────────
-- Table 5: research.cohort_assignments
-- Treatment/control assignments for Vendrov's experiments.
-- Vendrov populates this directly during the village.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS research.cohort_assignments (
  assignment_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bankr_wallet            TEXT NOT NULL,
  experiment_id           TEXT NOT NULL,           -- Vendrov's pre-registered experiment slug
  cohort                  TEXT NOT NULL,           -- 'treatment' / 'control' / 'cohort_A' / etc.
  assigned_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                   TEXT,
  UNIQUE (bankr_wallet, experiment_id)
);

CREATE INDEX IF NOT EXISTS idx_cohort_assignments_experiment ON research.cohort_assignments (experiment_id);
CREATE INDEX IF NOT EXISTS idx_cohort_assignments_wallet ON research.cohort_assignments (bankr_wallet);

COMMENT ON TABLE research.cohort_assignments IS
  'EE26: Per-experiment cohort assignments. PII-relevant: bankr_wallet (hashed at export).';

-- The longitudinal-consent column on instaclaw_users (referenced by
-- lib/research-export/extractors.ts:fetchLongitudinalConsentWallets)
-- is added in a separate migration (20260429b_research_consent_column.sql)
-- so it can be applied via the standard public-schema verification flow.
-- Apply this file's migration first, then the consent-column migration.
