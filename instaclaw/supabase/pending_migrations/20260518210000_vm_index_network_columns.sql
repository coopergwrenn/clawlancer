-- Index Network integration — per-VM provisioning state.
--
-- Adds 4 nullable columns to instaclaw_vms storing the response from
-- `POST https://protocol.index.network/api/networks/<NETWORK_ID>/signup`
-- (see instaclaw/docs/prd/village-index-network-integration.md §6 + §7).
--
-- All columns are NULLABLE — only edge_city VMs are provisioned (per the
-- partner gate in stepIndexProvision), and even there the provisioning is
-- optional (warnings-only on failure per Rule 39). Non-edge_city VMs stay
-- NULL forever; this is the design.
--
-- Idempotency contract (read Yanek's guide before changing):
--   Calling signup again for the same email returns the SAME user.id but
--   issues a FRESH apiKey, revoking the previous one. stepIndexProvision
--   MUST skip the network call when the local mirror (index_user_id +
--   index_api_key) is already populated — otherwise every reconciler tick
--   would rotate the in-use key. The local cache IS the idempotency layer;
--   the API has none of its own.
--
-- Sensitivity:
--   `index_api_key` is per-agent and grants agent-level access to the Index
--   discovery protocol on behalf of the user. Treat it like gateway_token:
--   - Service-role-only at the PostgREST layer (existing RLS posture for
--     instaclaw_vms already restricts client access; service role is the
--     only writer/reader for tokens of this class).
--   - Never logged with full value — prefix-only in any forensic output.
--   - Rotated on the next provision run by re-NULL-ing index_api_key
--     (rotation path documented in stepIndexProvision).
--
-- Forensic columns:
--   `index_provisioned_at` is set on successful signup (201 or 200).
--   `index_provisioned_failed_at` is set on the most recent failure for
--   visibility into stuck-provisioning VMs. Cleared on subsequent success.
--
-- Rollback:
--   Drop the 4 columns. No data loss outside the keys themselves (which
--   can be re-issued by hitting signup again on next reconcile cycle).

ALTER TABLE public.instaclaw_vms
  ADD COLUMN IF NOT EXISTS index_user_id UUID,
  ADD COLUMN IF NOT EXISTS index_api_key TEXT,
  ADD COLUMN IF NOT EXISTS index_provisioned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS index_provisioned_failed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.instaclaw_vms.index_user_id IS
  'Index Network user.id returned by POST /networks/<NETWORK_ID>/signup. Stable per email; safe to log.';
COMMENT ON COLUMN public.instaclaw_vms.index_api_key IS
  'Per-agent Index Network API key (ix_...). SENSITIVE — service-role-only, prefix-only in logs, rotated by re-NULL-ing this column and letting stepIndexProvision re-run.';
COMMENT ON COLUMN public.instaclaw_vms.index_provisioned_at IS
  'Wall-clock timestamp of last successful signup call. Cleared by rotation; presence + non-null index_api_key together gate the stepIndexProvision skip path.';
COMMENT ON COLUMN public.instaclaw_vms.index_provisioned_failed_at IS
  'Wall-clock timestamp of last failed signup call. Cleared on next success. Forensic only — never gates reconcile behavior.';
