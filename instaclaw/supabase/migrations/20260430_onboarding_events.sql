-- Per-user onboarding journey event log.
--
-- Applied to production: 2026-04-27 (via Supabase dashboard SQL editor;
-- the supabase CLI db push path is currently blocked by orphan migrations
-- 20260332/20260333 left over from the AgentBook rollout).
--
-- Captures each step of a user's signup → first-message journey so we can:
--   1. Compute funnel conversion (verify → pay → assigned → configured → greeted)
--   2. Diagnose where users drop off
--   3. Time-bound each step (e.g., "p50 time from payment to first-message")
--   4. Drill into individual stuck users (filter by user_id)
--
-- Single append-only log, never updated. Each event is its own row.
-- Multiple rows of the same event_type for one user are allowed (e.g.,
-- configure_started can fire multiple times if a VM is reconfigured).
-- Funnel/conversion queries use MIN(created_at) for first occurrence.
--
-- Insert paths (current):
--   world_id_verified     → instaclaw-mini markWorldIdVerified()
--   payment_completed     → instaclaw-mini agent/provision after delegation confirm
--   vm_assigned           → instaclaw vm/assign route
--   configure_started     → top of instaclaw vm/configure POST handler
--   configure_completed   → just before successful configure response
--   xmtp_setup_completed  → inside vm/configure after() block when setupXMTP returns success
--   first_message_sent    → instaclaw admin/xmtp-greeting-recorded when wasNew=true

CREATE TABLE IF NOT EXISTS instaclaw_onboarding_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES instaclaw_users(id) ON DELETE CASCADE,
  vm_id       uuid        REFERENCES instaclaw_vms(id) ON DELETE SET NULL,
  event_type  text        NOT NULL,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Most common query: a user's full journey, ordered.
CREATE INDEX IF NOT EXISTS idx_onboarding_events_user_time
  ON instaclaw_onboarding_events(user_id, created_at DESC);

-- Funnel queries: count distinct users who hit a given event in a time window.
CREATE INDEX IF NOT EXISTS idx_onboarding_events_type_time
  ON instaclaw_onboarding_events(event_type, created_at DESC);

-- Time-only index for any global rollup / pruning.
CREATE INDEX IF NOT EXISTS idx_onboarding_events_created
  ON instaclaw_onboarding_events(created_at);

COMMENT ON TABLE instaclaw_onboarding_events IS
  'Append-only user-journey event log for the signup → first-message funnel. Inserted by the relevant route handlers; never updated. Source of truth for onboarding analytics. Failures to insert are non-fatal (logged but do not break the user flow).';
COMMENT ON COLUMN instaclaw_onboarding_events.event_type IS
  'Event class. Current taxonomy: world_id_verified, payment_completed, vm_assigned, configure_started, configure_completed, xmtp_setup_completed, first_message_sent. New event types may be added without migration; the column is intentionally unconstrained text for forward compatibility.';
COMMENT ON COLUMN instaclaw_onboarding_events.metadata IS
  'Free-form JSON context for the event: vm_name, payment_method, error details, durations, etc. Schema is per-event-type and lives in the TypeScript helper.';
