-- frontier_spend_enabled — the user-owned autonomous-spend opt-in (the §8.7 "mandate").
--
-- WHY: the authorize gate has NO opt-in — every agent defaults to spend-enabled at the
-- $0.10/day earned-budget floor the moment frontier-spend.mjs lands, with a SOUL directive
-- that says "spend, don't refuse." Autonomous money-spending MUST be user-opt-in by default:
-- many users won't want their agent freely buying things, and defaulting it ON is a trust
-- violation. This column is the explicit, default-OFF, user-controlled switch. The authorize
-- gate denies (reason `spend_not_enabled`) unless this is explicitly TRUE — fail-closed:
-- absent/null/false ⇒ no autonomous spend.
--
-- Per-VM (per-agent) because spend authority is inherently per-agent (each VM has its own
-- Bankr wallet); the user owns the toggle for their agent. This is the first of what becomes
-- the per-user/per-agent spend preferences (future: budget override, category allowlist —
-- §5 Q1–Q4); only the boolean opt-in is built now.
--
-- ALTER ADD COLUMN (not a new table) → Rule 60 (RLS) N/A; the table's RLS posture is unchanged.
-- Adding a NOT NULL column with a constant DEFAULT is metadata-only on PG11+ (no table rewrite).
-- Rule 56: lives in pending_migrations/ until applied to prod, then git-mv to migrations/.
-- The gate is fail-closed BEFORE this is applied too: select("*") simply won't return the
-- column, so vm.frontier_spend_enabled is undefined → `=== true` is false → deny. Safe either way.

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS frontier_spend_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN instaclaw_vms.frontier_spend_enabled IS
  'User-owned autonomous-spend opt-in (Frontier §8.7 mandate). Default false. The /api/agent-economy/authorize gate denies (spend_not_enabled) unless explicitly true. Fail-closed.';
