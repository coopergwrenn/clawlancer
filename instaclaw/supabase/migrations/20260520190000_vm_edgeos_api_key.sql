-- Per-VM EdgeOS API key (D3, 2026-05-20).
--
-- Each edge_city VM gets a per-VM `eos_live_*` API key minted at
-- configureOpenClaw time via mintOrReuseApiKey (lib/edgeos-mint.ts).
-- The key is scoped to events:read and lives in EdgeOS under
-- name = "instaclaw-edge-{vmName}" (deterministic) or
-- "instaclaw-edge-{vmName}-{Date.now()}" (suffix on name conflict).
--
-- Persisted because EdgeOS shows the secret once at create time —
-- if we don't capture it, the key is unrecoverable and we'd have to
-- mint fresh on every reconcile (creating orphan keys forever).
--
-- Distinct from EDGEOS_BEARER_TOKEN (the shared user-level bearer
-- in Vercel env that authenticates ATTENDEE directory reads against
-- api-citizen-portal.simplefi.tech): edgeos_api_key is the per-VM
-- key used by the agent's edge-esmeralda skill for CALENDAR /
-- events reads. See CLAUDE.md Rule 34 (DB↔disk drift) — the on-disk
-- counterpart is `~/.openclaw/.env:EDGEOS_API_KEY`, kept in sync by
-- configureOpenClaw + (future) reconciler verify step.
--
-- Schema:
--   `edgeos_api_key TEXT NULL` — full `eos_live_*` secret. NULL means
--     "not yet minted for this VM" (the universe of non-edge_city
--     VMs, and edge_city VMs configured before this migration shipped).
--
-- No UNIQUE constraint:
--   - Deterministic name + suffix on conflict guarantees per-VM
--     uniqueness at mint time.
--   - Following the telegram_bot_token precedent — uniqueness is
--     enforced at the application layer (configureOpenClaw mint
--     path), not the DB. A UNIQUE here would block legitimate
--     short-lived overlap during a future rotate-and-replace flow.
--
-- Rollback: ALTER TABLE … DROP COLUMN edgeos_api_key. Safe — the
-- only consumer is the configureOpenClaw mint block, which guards
-- on column-not-found.

ALTER TABLE public.instaclaw_vms
  ADD COLUMN IF NOT EXISTS edgeos_api_key TEXT NULL;

COMMENT ON COLUMN public.instaclaw_vms.edgeos_api_key IS
  'Per-VM EdgeOS API key (eos_live_*) for events:read scope on the Edge Esmeralda 2026 calendar. Minted once during configureOpenClaw for partner=edge_city VMs. Persisted because EdgeOS shows the secret once. See lib/edgeos-mint.ts and CLAUDE.md Rule 34.';
