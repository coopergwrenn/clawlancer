-- Frontier — per-VM autonomy spend-band overrides (dashboard-set).
--
-- Storage for /api/agent-economy/policy PUT. A separate table (not columns on
-- instaclaw_vms) deliberately: the Frontier economy migration explicitly kept
-- additions to that hot, central table minimal. Policy overrides are isolated
-- here and cascade-deleted with the VM.
--
-- All band columns are NULLABLE — a row stores only the bands the user chose to
-- override; absent = use the tier (×staker) default. Enforcement is tighten-only
-- and clamped at read time in lib/frontier-policy.ts:clampOverrides, so even an
-- out-of-policy stored value can never make an agent LESS safe than its tier.
-- The CHECK (>= 0) is a defensive backstop to that clamp.
--
-- Rule 56: lives in pending_migrations/ until applied to prod, THEN moves to
-- migrations/ in the same commit. /policy GET tolerates this table being absent
-- (treats it as "no overrides") so it keeps working before the migration lands;
-- PUT returns 503 until then.
-- Rule 60: RLS enabled in-file; service-role-only (the route holds the authz),
-- matching every other frontier_* table.

CREATE TABLE IF NOT EXISTS frontier_policy_overrides (
  vm_id              uuid PRIMARY KEY REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  just_do_it_per_tx  numeric(14,2) CHECK (just_do_it_per_tx  IS NULL OR just_do_it_per_tx  >= 0),
  just_do_it_per_day numeric(14,2) CHECK (just_do_it_per_day IS NULL OR just_do_it_per_day >= 0),
  never_per_tx       numeric(14,2) CHECK (never_per_tx       IS NULL OR never_per_tx       >= 0),
  never_per_day      numeric(14,2) CHECK (never_per_day      IS NULL OR never_per_day      >= 0),
  min_wallet_balance numeric(14,2) CHECK (min_wallet_balance IS NULL OR min_wallet_balance >= 0),
  updated_at         timestamptz NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS frontier_policy_overrides_touch ON frontier_policy_overrides;
CREATE TRIGGER frontier_policy_overrides_touch BEFORE UPDATE ON frontier_policy_overrides
  FOR EACH ROW EXECUTE FUNCTION frontier_touch_updated_at();

ALTER TABLE frontier_policy_overrides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS frontier_policy_overrides_service ON frontier_policy_overrides;
CREATE POLICY frontier_policy_overrides_service ON frontier_policy_overrides
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');
