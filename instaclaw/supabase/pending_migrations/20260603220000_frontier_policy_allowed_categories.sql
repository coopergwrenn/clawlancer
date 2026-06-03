-- Frontier — per-VM autonomous-spend category allowlist override (dashboard-set).
--
-- Adds the category dimension to the existing per-VM policy override row. The
-- band columns (just_do_it_per_tx, …) answer "how much" the agent may spend
-- autonomously; this answers "on WHAT KINDS of things". Both are human-set
-- safety boundaries enforced by the same gate (lib/frontier-policy.ts).
--
-- NULL = use the tier default (DEFAULT_ALLOWED_CATEGORIES_BY_TIER). A non-null
-- array is the user's chosen allowlist; enforcement is TIGHTEN-ONLY and resolved
-- at read time by lib/frontier-policy.ts:effectiveAllowedCategories (effective =
-- tierDefault ∩ stored), so a stored value can only ever REMOVE categories from
-- the tier default — never widen (an agent can never autonomously buy a category
-- above its tier, and "market" — in no tier default — can never be enabled here).
-- text[] (not an enum) so adding a future SpendCategory doesn't need a type
-- migration; values are validated against ALL_CATEGORIES at the API layer and
-- intersected with the tier default at the gate, so an out-of-taxonomy string is
-- inert (it simply never matches a real category).
--
-- ALTER ADD COLUMN (not a new table) → Rule 60 (RLS) N/A; the table's RLS posture
-- (service-role-only, set in 20260601130000_frontier_policy_overrides.sql) is
-- unchanged. Adding a NULLABLE column with no default is metadata-only (no rewrite).
--
-- Rule 56: lives in pending_migrations/ until applied to prod, THEN git-mv to
-- migrations/ in the same commit. Both /api/agent-economy/policy and the authorize
-- gate read the row with select("*") and pull allowed_categories defensively, so
-- they keep working before this column lands (category override simply no-ops →
-- agent uses the tier default until the column exists).

ALTER TABLE frontier_policy_overrides
  ADD COLUMN IF NOT EXISTS allowed_categories text[];

COMMENT ON COLUMN frontier_policy_overrides.allowed_categories IS
  'Per-VM autonomous-spend category allowlist override. NULL = tier default. Tighten-only: effective = tierDefault ∩ stored (lib/frontier-policy.ts:effectiveAllowedCategories). Cannot widen / opt into "market".';
