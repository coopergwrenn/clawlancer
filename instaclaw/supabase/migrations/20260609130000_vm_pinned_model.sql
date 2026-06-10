-- Credit model pinning (Stage 0).
-- Adds the single source of truth for a deliberate model pin on all-inclusive VMs.
--
-- NULL = Automatic: the proxy content-routes (today's behavior, byte-identical for
--   every existing row — this column defaults NULL, so the migration is inert on
--   apply; no backfill, no behavior change).
-- Non-null = a deliberate honored pick. Validated against ALLOWED_MODEL_IDS at
--   write time. The proxy resolves it BEFORE the governor (so the grant bills the
--   pin's true weight flat, every message) and serves it by overriding
--   parsedBody.model — no SSH, no gateway restart, no fleet touch. It NEVER writes
--   default_model (which the reconciler syncs to the on-disk primary + would
--   restart the gateway on drift — see stepEnforceModelPrimary).
--
-- instaclaw_vms already has RLS enabled (Rule 60); adding a nullable column needs
-- no policy change. Additive + nullable + no backfill = safest migration class.
-- Idempotent.

ALTER TABLE public.instaclaw_vms
  ADD COLUMN IF NOT EXISTS pinned_model TEXT NULL DEFAULT NULL;

COMMENT ON COLUMN public.instaclaw_vms.pinned_model IS
  'Credit model pinning. NULL = Automatic (proxy content-routes). Non-null = a deliberate honored pick (validated vs ALLOWED_MODEL_IDS at write); the proxy serves + bills this model flat every message, bypassing the content classifier. all-inclusive only. Never touches default_model.';
