-- ════════════════════════════════════════════════════════════════════════
-- public.assign_cohort — SECURITY DEFINER wrapper for cross-schema writes
-- ════════════════════════════════════════════════════════════════════════
--
-- Context: the research.* schema is not in PostgREST's exposed_schemas
-- list (Supabase project config). The default supabase-js client can
-- only query public.* tables. We don't want to expose the entire
-- research schema (it'd let any service-role-key caller read raw
-- pre-anonymization signal data). Instead we expose a single, narrow
-- public function that INSERTs into research.cohort_assignments with
-- ON CONFLICT DO NOTHING semantics.
--
-- Callers: scripts/_assign-cohorts.ts (via sb.rpc("assign_cohort", ...)).
--
-- SECURITY DEFINER: the function runs with the privileges of its owner
-- (the supabase admin role), so it can write to research.* even when
-- called by a client that doesn't have research.* in its search_path.
-- This is the standard PostgREST pattern for cross-schema writes per
-- the Supabase docs.
--
-- Idempotency: ON CONFLICT DO NOTHING preserves prior assignments —
-- including Vendrov's manual overrides (the auto-assigner never
-- overwrites a row that's already there).
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.assign_cohort(
  p_bankr_wallet TEXT,
  p_experiment_id TEXT,
  p_cohort TEXT,
  p_notes TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, research
AS $$
DECLARE
  v_inserted BOOLEAN;
BEGIN
  -- Validate inputs upfront so we get clear errors instead of cryptic
  -- constraint violations.
  IF p_bankr_wallet IS NULL OR length(p_bankr_wallet) < 10 THEN
    RAISE EXCEPTION 'p_bankr_wallet must be a non-empty wallet address';
  END IF;
  IF p_experiment_id IS NULL OR length(p_experiment_id) = 0 THEN
    RAISE EXCEPTION 'p_experiment_id must be non-empty';
  END IF;
  IF p_cohort IS NULL OR length(p_cohort) = 0 THEN
    RAISE EXCEPTION 'p_cohort must be non-empty';
  END IF;

  INSERT INTO research.cohort_assignments (bankr_wallet, experiment_id, cohort, notes)
  VALUES (lower(p_bankr_wallet), p_experiment_id, p_cohort, p_notes)
  ON CONFLICT (bankr_wallet, experiment_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION public.assign_cohort IS
  'Cross-schema wrapper: INSERTs into research.cohort_assignments with ON CONFLICT DO NOTHING. Used by scripts/_assign-cohorts.ts via sb.rpc(). SECURITY DEFINER so PostgREST clients can write without exposing the full research schema. Idempotent — preserves manual overrides.';

-- Read-side helper: count assignments per experiment (cohort balance check).
-- Exposed in public so the dashboard / scripts can query without research-
-- schema access. Returns aggregate counts only — no per-row PII.

CREATE OR REPLACE FUNCTION public.cohort_assignment_counts(
  p_experiment_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  experiment_id TEXT,
  cohort TEXT,
  n BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, research
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ca.experiment_id::TEXT,
    ca.cohort::TEXT,
    COUNT(*)::BIGINT AS n
  FROM research.cohort_assignments ca
  WHERE (p_experiment_id IS NULL OR ca.experiment_id = p_experiment_id)
  GROUP BY ca.experiment_id, ca.cohort
  ORDER BY ca.experiment_id, ca.cohort;
END;
$$;

COMMENT ON FUNCTION public.cohort_assignment_counts IS
  'Aggregate cohort counts per experiment. Read via PostgREST RPC. No per-row PII exposed.';

-- ════════════════════════════════════════════════════════════════════════
-- Done.
-- ════════════════════════════════════════════════════════════════════════
