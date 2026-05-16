-- 2026-05-16: freeze-v2 substrate columns (Path 2 / dumpDataDir architecture).
--
-- Background: the 2026-05-15 incident report ($1,479/mo leak, zero successful
-- freezes ever) identified that Linode private images cap at 6,144 MB,
-- structurally blocking every production-aged VM from freezing. The v97
-- (freeze_consecutive_failures) and Rules 50/51/52 fixes guarded against
-- new zombie creation but didn't unblock the actual leak.
--
-- Empirical PGLite verification on vm-050 on 2026-05-16 further revealed that
-- gbrain v0.35.0.0's SIGTERM-mediated graceful shutdown corrupts the on-disk
-- data dir (counterintuitively — SIGKILL produces recoverable state, SIGTERM
-- does not). The stop+restart-based archival approach in the initial PRD
-- draft is therefore broken at the gbrain layer.
--
-- The canonical design (PRD §15, Path 2) bypasses gbrain shutdown entirely
-- by using PGLite's native `engine.db.dumpDataDir("gzip")` hot-snapshot
-- method, called via a new gbrain MCP `snapshot_brain` tool. The archive
-- bundle (PGLite snapshot + user-state tarball) is AES-256-GCM encrypted
-- and uploaded to Cloudflare R2. On thaw, the bundle is layered onto a
-- fresh VM provisioned from the base snapshot BEFORE the first gbrain start.
--
-- This migration adds the 8 columns + partial index that the new freeze/thaw
-- flow needs. All columns are NULLABLE — existing rows are unaffected. The
-- freeze v2 code uses NULL freeze_state as semantically equivalent to
-- 'idle' / "not in freeze lifecycle", so adding the column has zero behavior
-- impact on the existing fleet until the new code paths ship.
--
-- See:
--   - instaclaw/docs/prd/freeze-thaw-v2-archive-based.md §15 (canonical design)
--   - instaclaw/docs/prd/freeze-thaw-v2-archive-based.md §16 (locked decisions)
--   - CLAUDE.md "Freeze pipeline — $1,450/mo leak" incident report

-- ─── Column 1: freeze_state (state machine) ──────────────────────────────
--
-- Tracks where a VM is in the freeze/thaw lifecycle. Distinct from `status`
-- (assigned/frozen/destroyed) and `health_status` (healthy/suspended/...).
--
-- Values (NULL = 'idle' / not in lifecycle; code treats NULL ≡ idle):
--   idle                — not in any freeze/thaw operation
--   archive_pending     — eligible; archive cron will pick up next cycle
--   archiving           — archive cron has the lock; mid-snapshot
--   archived            — fresh archive uploaded to R2
--   destroying          — freeze cron has the lock; mid-Linode-DELETE
--   frozen              — instance deleted; archive in R2 is canonical state
--   thaw_pending        — webhook flipped intent; thaw cron will provision next cycle
--   thawing             — thaw cron has the lock; mid-provision or mid-restore
--   thawing_provisioned — new Linode booted + cloud-init done; awaiting rewire step
--
-- No CHECK constraint (kept open for state-machine evolution). State
-- transitions are policed in code via conditional SQL UPDATEs.
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS freeze_state TEXT;

COMMENT ON COLUMN instaclaw_vms.freeze_state IS
  'freeze-v2 state machine. NULL = not in freeze/thaw lifecycle. '
  'Other values: idle, archive_pending, archiving, archived, destroying, '
  'frozen, thaw_pending, thawing, thawing_provisioned. See PRD §15.';

-- ─── Column 2: frozen_archive_path (R2 object key) ───────────────────────
--
-- The R2 path of the canonical archive for this frozen VM. Set after
-- successful upload by the archive cron. Format:
--   <vm-id>/<unix-ts>-<sha256-prefix-8>.tar.enc
--
-- Set during archive_pending → archived transition.
-- Preserved through frozen → thawing → idle (archive kept for 30 days
-- post-thaw per Q2 / PRD §16.2 for disaster-recovery rollback).
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS frozen_archive_path TEXT;

COMMENT ON COLUMN instaclaw_vms.frozen_archive_path IS
  'R2 object key for the canonical freeze archive. NULL means no archive yet. '
  'Preserved 30d post-thaw for DR rollback (Q2 / PRD §16.2).';

-- ─── Column 3: frozen_archive_sha256 (integrity) ─────────────────────────
--
-- SHA-256 of the encrypted outer tar (the on-disk format in R2). Verified
-- on every download before decrypt is attempted. Mismatch → refuse decrypt,
-- try N-1 generation, alert P0 if all generations fail.
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS frozen_archive_sha256 TEXT;

COMMENT ON COLUMN instaclaw_vms.frozen_archive_sha256 IS
  'SHA-256 of the encrypted outer tar at frozen_archive_path. Verified on '
  'download before decrypt. PRD §15.7 thaw step 6.';

-- ─── Column 4: frozen_archive_size_kb (monitoring) ───────────────────────
--
-- Size of the encrypted outer tar in KB. Used for:
--   - Storage cost monitoring (sum across fleet)
--   - Sanity gates (refuse to write >100 MB archives per PRD §15.4)
--   - Operator visibility ("which user's archive is the largest")
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS frozen_archive_size_kb INTEGER;

COMMENT ON COLUMN instaclaw_vms.frozen_archive_size_kb IS
  'Size of the encrypted archive tar at frozen_archive_path, in KB. '
  'Operator monitoring + sanity gate.';

-- ─── Column 5: frozen_archive_manifest (per-file metadata) ───────────────
--
-- JSONB blob containing per-file sha256 + sizes from inside the encrypted
-- archive. Lets operators inspect what's in an archive without decrypting.
-- Schema (also stored in plaintext manifest.json inside the tarball):
--   {
--     "schema_version": "1",
--     "vm_id": "uuid",
--     "vm_name": "instaclaw-vm-NNN",
--     "user_id": "uuid|null",
--     "generated_at": "ISO-8601",
--     "source_openclaw_version": "2026.4.26",
--     "source_manifest_version": 100,
--     "encryption_key_id": "v1",
--     "inner": {
--       "brain_pglite_sha256": "...",
--       "brain_pglite_size_bytes": 12345678,
--       "user_state_sha256": "...",
--       "user_state_size_bytes": 1234567
--     }
--   }
--
-- The full schema lives in PRD §15.4. The DB column is plaintext (zero
-- user data — just sha256s + sizes), Supabase-encrypted at rest.
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS frozen_archive_manifest JSONB;

COMMENT ON COLUMN instaclaw_vms.frozen_archive_manifest IS
  'Per-file metadata from inside the encrypted archive (sha256s, sizes, '
  'manifest version, encryption_key_id). Plaintext — no user data. '
  'PRD §15.4 has the full schema.';

-- ─── Column 6: frozen_archive_taken_at (freshness) ───────────────────────
--
-- When the latest archive was created. Used by:
--   - Freeze gate (refuse to destroy if archive >48h old; force re-archive
--     first per PRD §15.6)
--   - Archive cron (skip VMs with recent archives; pick up VMs with stale
--     ones)
--   - Operator visibility ("when did this user last get a fresh archive")
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS frozen_archive_taken_at TIMESTAMPTZ;

COMMENT ON COLUMN instaclaw_vms.frozen_archive_taken_at IS
  'When the latest archive at frozen_archive_path was created. Freeze refuses '
  'to proceed if older than 48h (PRD §15.6 precondition).';

-- ─── Column 7: thaw_requested_at (webhook trigger timestamp) ─────────────
--
-- Set by the Stripe webhook handler when the user resubscribes. The async
-- thaw cron polls for rows where freeze_state='thawing' AND thaw_requested_at
-- is recent. Decouples the webhook (must be fast, idempotent) from the
-- actual thaw provisioning (slow, multi-step).
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS thaw_requested_at TIMESTAMPTZ;

COMMENT ON COLUMN instaclaw_vms.thaw_requested_at IS
  'Timestamp from the Stripe webhook (or admin endpoint) that triggered thaw. '
  'Async thaw cron picks these up. PRD §15.7.';

-- ─── Column 8: frozen_retention_policy (Q5 refinement, PRD §16.5) ────────
--
-- Long-dormant retention policy class for this user's archive. Values:
--   NULL                — indefinite retention (v1 default; Cooper's "we
--                          never lose your data" trust signal)
--   'standard'          — 24-month retention with 18mo + 23mo warning
--                          emails (v2 default, ships when auto-delete cron
--                          ships in 6-18 months)
--   'vip'               — indefinite retention (carveout: bankr token
--                          launchers, paid >12mo lifetime, partner-tagged)
--   'compliance_delete' — GDPR Article 17 right-to-erasure pending; the
--                          admin delete endpoint sets this and a 30-day
--                          grace cron does the actual delete
--
-- v1 ships with all rows defaulting to NULL (no automated deletion). The
-- column unblocks v2's auto-delete cron without requiring a follow-up
-- migration. See PRD §16.5 for the full policy + v2 roadmap.
--
-- No CHECK constraint: same reasoning as freeze_state (state-machine
-- evolution). Policed in code.
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS frozen_retention_policy TEXT;

COMMENT ON COLUMN instaclaw_vms.frozen_retention_policy IS
  'Retention policy class for frozen_archive_path. NULL = indefinite (v1). '
  'Future values: standard (24mo), vip (indefinite carveout), '
  'compliance_delete (GDPR pending). PRD §16.5.';

-- ─── Partial index for cron queries ──────────────────────────────────────
--
-- The archive-snapshot cron, freeze cron, and thaw cron each filter rows
-- by freeze_state. Partial index on non-NULL freeze_state keeps the index
-- small (only VMs actually in freeze/thaw lifecycle) while supporting
-- fast lookup of candidates for each state-machine transition.
CREATE INDEX IF NOT EXISTS idx_instaclaw_vms_freeze_state
  ON instaclaw_vms (freeze_state)
  WHERE freeze_state IS NOT NULL;

-- ─── Partial index for archive-freshness queries ─────────────────────────
--
-- Archive cron filters: WHERE freeze_state IN ('archive_pending', 'archived')
--                       AND (frozen_archive_taken_at IS NULL
--                            OR frozen_archive_taken_at < NOW() - INTERVAL '24h')
-- Partial index supports the second clause. Small (only sleeping VMs).
CREATE INDEX IF NOT EXISTS idx_instaclaw_vms_archive_freshness
  ON instaclaw_vms (frozen_archive_taken_at)
  WHERE freeze_state IN ('archive_pending', 'archived');

-- Note: we do NOT drop the existing frozen_image_id / frozen_image_size_mb
-- columns in this migration. Those represent the old Linode-image-based
-- freeze and currently contain 0 rows fleet-wide (per 2026-05-15 audit).
-- We leave them in place for one release cycle to give operator scripts +
-- old `lib/vm-freeze-thaw.ts` code time to be updated. Migration to drop
-- them ships separately after the v2 fleet rollout has soaked for 14 days.
