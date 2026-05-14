-- 2026-05-14: secret_version column for decoupled secret distribution.
--
-- Background: the reconcile-fleet cron filters candidates with
-- `lt(config_version, VM_MANIFEST.version)`, so VMs at the current manifest
-- version are excluded from reconcile entirely. This means any rotation of a
-- value in `SECRET_ENV_VAR_SOURCES` (Vercel → VM .env) silently fails to
-- propagate to caught-up VMs — only newly-stale VMs receive the new value.
--
-- The 2026-05-14 EDGEOS_BEARER_TOKEN incident hit this: 8 edge_city VMs at
-- cv=95 (= MANIFEST.version) carried a stale token for ~1h. Manual SQL
-- cv-decrement + direct-SSH fleet patch unblocked the customer but the
-- structural gap remained.
--
-- This column decouples secret distribution from config_version. The cron
-- selects VMs where `secret_version < SECRET_VERSION` OR `config_version <
-- MANIFEST.version`. Operators bump `lib/vm-reconcile.ts:SECRET_VERSION`
-- when they rotate a value in SECRET_ENV_VAR_SOURCES; the reconciler
-- redistributes to all assigned+healthy VMs on the next tick.
--
-- Default 0: all existing rows become eligible immediately when the code
-- ships with SECRET_VERSION=1. The first fleet-wide sweep brings every VM
-- up to current via stepEnvVarPush (idempotent: no-op if already correct).
--
-- See CLAUDE.md "Lesson: Telegram line breaks in JWT tokens" + "Operational
-- runbook: rotating secrets" inside the Incident Response Runbook.

ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS secret_version INTEGER NOT NULL DEFAULT 0;

-- Index supports the cron's candidate query filter
-- (`secret_version.lt.<N>` OR-ed with the cv filter).
CREATE INDEX IF NOT EXISTS idx_instaclaw_vms_secret_version
  ON instaclaw_vms (secret_version);

COMMENT ON COLUMN instaclaw_vms.secret_version IS
  'Distribution-state cursor for SECRET_ENV_VAR_SOURCES in lib/vm-reconcile.ts. '
  'Cron picks up VMs where this < lib/vm-reconcile.ts:SECRET_VERSION. '
  'Bumped per-VM after a successful stepEnvVarPush. Decoupled from '
  'config_version so secret rotations propagate independently of manifest '
  'drift. See CLAUDE.md Incident Response Runbook §Operational runbook: '
  'rotating secrets.';
