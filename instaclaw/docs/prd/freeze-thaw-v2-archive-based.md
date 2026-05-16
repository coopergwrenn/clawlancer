# PRD: Archive-Based Freeze/Thaw (v2)

**Status:** Draft (2026-05-16)
**Author:** Claude Opus 4.7 + Cooper Wrenn
**Replaces:** `lib/vm-freeze-thaw.ts` Linode-image-based freeze (commit 2ce729f1, Rules 50/51/52)
**Resolves:** Freeze-pipeline $1,450/mo leak; zero successful freezes in system history; 6,144 MB Linode image cap blocks every production-aged VM

## 1. Problem

Every production-aged InstaClaw VM accumulates 15-28 GB of disk usage (workspace, plugin runtime deps, journal, skills, npm/pip caches). Linode private images cap at **6,144 MB** and silently fail on overflow. The Linode-image freeze model is structurally incompatible with our VMs.

Even our Rule 51 aggressive whitelist cleanup only drops a VM from ~22 GB → ~11-15 GB. The remaining ~10 GB is irreducible without touching user data: `/var/log` (~3 GB after vacuum-time=1d), `~/.openclaw/workspace/` (user memory, NEVER touchable), `~/.openclaw/plugin-runtime-deps/`, `~/.openclaw/skills/`, `~/scripts/`. We cannot get production VMs under 6 GB. Period.

Net effect: 51 paying-cancelled-customer VMs sit at `status='assigned' + health_status='suspended'` for weeks, each costing $29/mo on Linode. Current leak: **$1,479/mo**. Zero successful freezes since deployment. The Rule 51 skip-cleanly gate (commit 2ce729f1) prevents new zombies but doesn't drain the backlog.

## 2. The pivot

**Cooper's insight:** we don't need to snapshot the *entire VM*. We just need to preserve the user's *data*. Everything else is reproducible from the base snapshot + manifest reconciliation. The user data is < 50 MB compressed. We can put it anywhere.

**New model:**

```
FREEZE                                 THAW
══════                                 ════
1. Pre-freeze: continuous archive      1. Stripe webhook / admin: thaw request
   tarballs every 24h during grace     2. Provision fresh Linode from base snapshot
2. Final archive at freeze time           (standard provisioning flow — cloud-init)
3. Encrypt + upload to R2              3. Cloud-init callback → cron picks up
4. Verify upload integrity (sha256)    4. SSH in, download latest archive
5. Delete Linode instance              5. Decrypt + extract over fresh base
6. Mark row frozen + archive_path      6. Run rewire-only configureOpenClaw mode
                                       7. Start gateway, verify health
                                       8. Mark row assigned/healthy
```

**Why this is better:**

- No 6,144 MB cap. Tarball is ~5-30 MB (or up to ~50 MB with sessions/jsonl).
- No `disk_imagize` async-failure trap.
- No 17-zombie recovery problem (no shutdownInstance step that can fail).
- No Linode-image quota.
- $5-15/yr storage (R2 free tier covers ~200 VMs forever).
- Continuous archival during grace = resilient to crashes (game-server playbook).
- Generational backups (last 3-7) = recovery from accidental corruption.

**Why this is novel:**

Research confirmed no major PaaS uses tarball+rehydrate at our scale. Fly.io volume-snapshots ($0.08/GB-month, first 10 GB free) is the closest; we go further by archiving only data and rebuilding system state from a shared base.

## 3. Goals + non-goals

**Goals**

- Eliminate the 6,144 MB image cap as a freeze blocker (the actual bug).
- Make freeze idempotent and retry-safe — every step must be either reversible or stateless.
- Preserve every byte of user-perceivable state per Rule 22 (workspace, sessions, wallet, memory, brain.pglite).
- Maintain or improve user-visible thaw latency (current: 5-8 min from resub to working VM).
- Strict at-rest encryption of wallet keys (private-key material).
- Continuous archival during grace window (game-server discipline) so a crash mid-freeze loses seconds, not days.
- Be the canonical implementation across the fleet — no parallel models.

**Non-goals**

- Maintaining the Linode-image freeze model as a fallback. After ship + soak, the old code path is removed.
- "Hot" thaw (sub-minute resume). Acceptable target is parity with current 5-8 min.
- Migrating *active* user state mid-stream. Freeze always runs after suspension; user is offline by definition.
- Cross-region failover. R2 + Linode us-east is sufficient.

## 4. Background — research findings (concrete)

Synthesized from the platform/game-server/storage research conducted 2026-05-16:

1. **No PaaS does this pattern.** Render, Railway, Fly.io all snapshot full disks. Our 20-50 MB tarball+rehydrate model is novel and economically dominant at our scale.
2. **Game-server playbook**: blob serialization with CAS/version (✓), continuous saves during play (✓ — port to "continuous saves during grace"), exclusive locks per entity (✓ — use `instaclaw_cron_locks`), generational backups (✓ — keep 3-7 daily).
3. **R2 wins on storage**: 10 GB free forever; **$0 egress** to Linode/Vercel; S3-compatible (escape valve to S3 later if needed). At our scale (50-200 tarballs × ~30 MB × 3 generations = 5-20 GB total) we live in the free tier indefinitely.
4. **Supabase Storage second choice** if "zero new vendors" outweighs the $0 egress benefit. $5/mo flat for 250 GB, 1 TB egress included.

**Decision: R2 primary, Supabase Storage fallback.** Implementation uses the S3 SDK so swapping vendors later is trivial.

## 5. Architecture

### 5.1 Components

```
┌───────────────────────────────────────────────────────────────────┐
│  Vercel Cron + Webhook tier                                       │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  /api/cron/vm-archive-snapshot   (NEW — every 24h)                │
│    walks suspended VMs, takes archive, uploads to R2              │
│                                                                   │
│  /api/cron/vm-lifecycle          (CHANGED — Pass 1 v3)            │
│    once grace exceeded + recent archive present → destroy         │
│                                                                   │
│  /api/billing/webhook            (CHANGED — thaw handler)         │
│    subscription.created/updated/resumed → thaw request            │
│                                                                   │
│  /api/cron/vm-thaw-rewire        (NEW — every 5 min)              │
│    polls thaw-pending rows, downloads archive, rewires            │
│                                                                   │
└─────────────────────┬─────────────────────────────────────────────┘
                      │
        ┌─────────────┴──────────────┐
        ▼                            ▼
┌──────────────────┐         ┌──────────────────────────────┐
│  R2 bucket       │         │  Supabase: instaclaw_vms     │
│  frozen-archives │         │  + frozen_archive_path       │
│                  │         │  + frozen_archive_sha256     │
│  <vm-id>/        │         │  + frozen_archive_size_kb    │
│   <ts>.tar.enc   │         │  + frozen_archive_manifest   │
│                  │         │  + freeze_state              │
│  (encrypted      │         │    (idle|archiving|archived  │
│   AES-256-GCM)   │         │     |destroying|frozen       │
│                  │         │     |thawing|thawed_pending) │
└──────────────────┘         └──────────────────────────────┘
```

### 5.2 New state machine

VM lifecycle states relevant to freeze/thaw (this is `freeze_state`, NEW column — distinct from existing `status` + `health_status`):

```
                          (user cancels sub)
healthy ─────────────────────────────────────► suspended (gateway stopped, Linode running)
                                                    │
                          (grace: 3 days)           │
                                                    ▼
                                              archive_pending ◄──────┐
                                                    │                │
                          (vm-archive-snapshot)     │                │ (retry on
                                                    ▼                │  upload fail)
                                              archiving (lock held)  │
                                                    │                │
                          (success)                 │                │
                                                    ▼                │
                                              archived (latest in R2)│
                                                    │                │
                          (freeze trigger)          │                │
                                                    ▼                │
                                              destroying (lock held) │
                                                    │                │
                          (Linode delete OK)        │                │
                                                    ▼                │
                                              frozen                 │
                                                    │                │
                          (user resub)              │                │
                                                    ▼                │
                                              thaw_pending           │
                                                    │                │
                          (vm-thaw-rewire)          │                │
                                                    ▼                │
                                              thawing (new Linode,   │
                                                       lock held)    │
                                                    │                │
                          (rewire success)          │                │
                                                    ▼                │
                                              healthy ───────────────┘
                                                  (back to top)
```

Each transition must be **idempotent** and **resumable from any state**. The cron must crash-safely converge.

### 5.3 Why this is better than what was proposed initially

Cooper's initial sketch had freeze do tar+upload+destroy in one shot. The game-server research surfaced a better pattern: **decouple archival from destruction**. Archives happen continuously during the suspension grace window; freeze itself is just "destroy the now-already-archived instance." This means:

- A crash during freeze loses seconds (last archive interval), not the whole conversation history.
- The 3-day grace window becomes useful — by day 3 we have 3+ archive generations.
- Freeze becomes a stateless decision: "is there a fresh archive? then destroy."
- Thaw doesn't depend on freeze having succeeded — if archive exists but instance still alive, thaw skips provisioning and just reactivates.

## 6. Detailed design

### 6.1 Tarball manifest

**Tier 1 — must save (loss = catastrophic):**

| Path | Contents | Approx size |
|---|---|---|
| `~/.openclaw/wallet/` | Agent private keys (crypto funds) | < 1 KB |
| `~/.openclaw/workspace/MEMORY.md` | Agent's long-term memory | 5-50 KB |
| `~/.openclaw/workspace/memory/` | session-log.md, active-tasks.md, custom memories | 10-200 KB |
| `~/.openclaw/agents/main/agent/auth-profiles.json` | Anthropic API key (BYOK) | < 1 KB |
| `~/.openclaw/brain.pglite/` | gbrain accumulated PGLite DB | 1-50 MB |

**Tier 2 — should save (regeneratable but disruptive loss):**

| Path | Contents | Approx size |
|---|---|---|
| `~/.openclaw/.env` | Gateway token, BANKR_WALLET_KEY, partner secrets | < 5 KB |
| `~/.openclaw/openclaw.json` | Gateway config (channel tokens) | 50-100 KB |
| `~/.openclaw/workspace/SOUL.md` | Identity (manifest + user customization between markers) | 30-40 KB |
| `~/.openclaw/agents/main/sessions/*.jsonl` | Conversation history (Rule 22) | 1-10 MB |
| `~/.openclaw/agents/main/sessions/sessions.json` | Session index | < 100 KB |

**Excluded — regeneratable from manifest + base:**

| Path | Why excluded |
|---|---|
| `~/.openclaw/workspace/CAPABILITIES.md` | Manifest-deployed via stepFiles |
| `~/.openclaw/workspace/QUICK-REFERENCE.md` | Manifest-deployed |
| `~/.openclaw/workspace/TOOLS.md` | Manifest-deployed |
| `~/.openclaw/workspace/EARN.md` | Manifest-deployed |
| `~/.openclaw/workspace/backups/` | Pre-trim snapshots; recoverable from MEMORY.md trim |
| `~/.openclaw/skills/` | Reinstalled by stepSkills + skillsFromRepo |
| `~/.openclaw/scripts/` | Manifest-deployed |
| `~/scripts/` | Bot scripts; installed by configureOpenClaw setup paths |
| `~/.openclaw/plugin-runtime-deps/` | `npm install` regenerable |
| `~/.openclaw/logs/`, `~/.openclaw/browser/` | Runtime state |
| Everything outside `~/.openclaw/` and `~/scripts/` | System/OS state |

**Estimated tarball sizes:**

- p50 user (light): 5-10 MB
- p90 user (heavy sessions + gbrain): 30-50 MB
- p99 outlier: up to ~80 MB

Even p99 fits in R2's per-object 5 GB cap with massive headroom.

**Tarball internal layout:**

```
manifest.json                # version, sha256s, generated_at, source_vm_id
data/
  home/openclaw/.openclaw/wallet/
  home/openclaw/.openclaw/workspace/MEMORY.md
  home/openclaw/.openclaw/workspace/memory/
  home/openclaw/.openclaw/agents/main/agent/auth-profiles.json
  home/openclaw/.openclaw/brain.pglite/
  home/openclaw/.openclaw/.env
  home/openclaw/.openclaw/openclaw.json
  home/openclaw/.openclaw/workspace/SOUL.md
  home/openclaw/.openclaw/agents/main/sessions/
```

`manifest.json` schema (versioned for forward-compat):

```json
{
  "schema_version": "1",
  "vm_id": "uuid",
  "vm_name": "instaclaw-vm-NNN",
  "user_id": "uuid|null",
  "generated_at": "2026-05-16T...",
  "source_openclaw_version": "2026.4.26",
  "source_manifest_version": 100,
  "files": [
    { "path": "data/home/openclaw/.openclaw/wallet/agent.key", "size": 256, "sha256": "..." },
    ...
  ],
  "total_uncompressed_size": 12345678,
  "total_compressed_size": 4567890,
  "encryption": "aes-256-gcm"
}
```

The manifest enables (a) integrity verification on download, (b) schema evolution without breaking older archives, (c) operator-friendly inspection.

### 6.2 brain.pglite handling — SQLite locking

gbrain MCP holds a fcntl/flock on the PGLite database while running. Three options:

**A) Stop gbrain MCP, then tar.** Clean snapshot, simplest. Acceptable because we're destroying the instance after. `systemctl --user stop gbrain || true` before tar.

**B) SQLite online-backup API.** `sqlite3 ~/.openclaw/brain.pglite/db.sqlite ".backup /tmp/brain.backup"`. Works under WAL mode without stopping anything. Produces a consistent snapshot.

**C) SIGSTOP gbrain → tar → SIGCONT.** Pauses without unwinding state. Risky if gbrain has pending writes.

**Decision: A.** Simplest, safest, and the instance is being destroyed anyway. The archive-snapshot cron (during grace, instance still alive) also uses A but with `systemctl --user start gbrain` after tar to restore service. Acceptable few-second gbrain downtime per snapshot.

**Subtlety:** PGLite stores data as `db.sqlite` + WAL/SHM sidecars (`db.sqlite-wal`, `db.sqlite-shm`). The tar must include all three. After stop + before tar, run `sqlite3 ... "PRAGMA wal_checkpoint(TRUNCATE)"` to merge WAL into main DB (eliminates the sidecar files entirely). Cleanest restore.

### 6.3 Storage: R2 with S3-compatible SDK

**Vendor: Cloudflare R2.**

- **Bucket:** `instaclaw-frozen-archives`
- **Path:** `<vm-id>/<unix-ts>-<sha256-prefix-8>.tar.enc`
- **Per-object size:** typically 5-30 MB; cap at 100 MB (hard-fail freeze if tarball exceeds)
- **Lifecycle policy:** none. Retention managed by our cron (Section 6.6).
- **Access:** server-side only via S3 SDK with R2 API token in Vercel env (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`). No public access.
- **Versioning:** disabled on the bucket. We do generational naming via path suffix.
- **CORS:** none (no browser access).

**Why R2 over Supabase Storage:**

- $0 egress to Linode VM (downloads during thaw) — vs $0.09/GB on S3, capped 2 GB/mo free on Supabase.
- Free 10 GB storage forever; we'll never approach it.
- S3-compatible API — escape valve to AWS S3 later requires only env var swap.
- Lower latency from Vercel functions (Cloudflare edge anycast).

**Code:** `lib/r2-storage.ts` using `@aws-sdk/client-s3`. Single file, ~150 LOC. R2 endpoint: `https://<account_id>.r2.cloudflarestorage.com`.

**Fallback plan:** if R2 has an outage during the rollout window, swap `S3_ENDPOINT` env var to Supabase Storage's S3-compatible endpoint. Bucket name stays the same. Zero code change.

### 6.4 Encryption at rest

**Server-side AES-256-GCM in the Vercel cron, with key in Vercel env.**

- Tar runs on the VM in plaintext (the VM holds the plaintext data already; no marginal exposure).
- scp pulls the plaintext tarball into the Vercel cron's `/tmp` (ephemeral, gone in seconds).
- Cron encrypts with `crypto.createCipheriv("aes-256-gcm", key, iv)` before uploading.
- Encrypted blob format: `[12-byte IV][16-byte auth tag][ciphertext]`.
- Key: `FREEZE_ARCHIVE_KEY` env var, 32-byte random hex string.

**Why server-side (cron) not VM-side:**

- Key never lands on a VM. If a VM is compromised, the encryption keys aren't.
- Vercel function `/tmp` is ephemeral, not snapshotted, gone on every cold start.
- Centralized key rotation (rotate env var → new freezes encrypt with new key → old freezes still decrypt with old key via key-id stamp in manifest.json).

**Key rotation runway:** add `encryption_key_id` to manifest.json (current = `"v1"`). Rotation: bump to `"v2"`, add `FREEZE_ARCHIVE_KEY_V1` + `FREEZE_ARCHIVE_KEY_V2` env vars. New encrypts use v2; decrypt path picks the right key from manifest.

**Why this matters more than typical:** wallet private keys are in the tarball. Theft = funds gone. Defense in depth: R2 server-side encryption is already on (vendor default) + we add app-level encryption on top.

### 6.5 Continuous archival (the game-server pattern)

**New cron: `/api/cron/vm-archive-snapshot`, schedule `0 */6 * * *` (every 6 hours).**

Picks up VMs in `freeze_state IN ('archive_pending', 'archived')` AND `(latest archive > 24h old OR no archive yet)`. For each:

1. Acquire `instaclaw_cron_locks` key `freeze-thaw:<vm-id>`.
2. Set `freeze_state = 'archiving'`.
3. SSH to VM, build tarball (per Section 6.1, gzip).
4. scp tarball to Vercel /tmp.
5. Compute sha256.
6. Encrypt → upload to R2 at `<vm-id>/<unix-ts>-<sha256-prefix>.tar.enc`.
7. Update DB: `frozen_archive_path`, `frozen_archive_sha256`, `frozen_archive_size_kb`, `frozen_archive_manifest`, `frozen_archive_taken_at`, `freeze_state = 'archived'`.
8. Release lock.
9. Run retention sweep: keep last 3 archives per VM; delete older ones from R2.

**Concurrency cap:** `MAX_ARCHIVES_PER_RUN = 5` (configurable). At 5/run × 4 runs/day = 20/day. Backlog of 51 VMs clears in ~3 days even with retries. Linode rate limits don't apply (no Linode API calls).

**Crash safety:** if cron dies mid-archive, `freeze_state = 'archiving'` + stale lock. Next run sees stale lock (>15min) → takeover → retry from scratch. Idempotent.

### 6.6 Freeze (Pass 1 v3)

**Triggers:** existing vm-lifecycle Pass 1 v2 logic, but the action changes.

For each candidate (status=assigned + suspended/hibernating past grace + safety checks pass):

1. **Precondition:** `frozen_archive_taken_at` exists AND is within 48 hours.
   - If no archive yet: skip (let archive-snapshot cron catch up first). Don't try to archive synchronously here.
   - If archive > 48h old: skip (force a fresh archive first).
2. Acquire lock `freeze-thaw:<vm-id>`.
3. Set `freeze_state = 'destroying'`.
4. Verify Linode instance state is `running` or `offline` (defensive — not in a transitional state).
5. **`linodeFetch DELETE /linode/instances/<id>`** — destroys the instance, releases the IP.
6. Update DB:
   - `status = 'frozen'`
   - `health_status = 'frozen'`
   - `provider_server_id = null`
   - `ip_address = null` (per the eec2cf95 fix — null IP at terminal flip)
   - `frozen_at = now()`
   - `freeze_state = 'frozen'`
7. Release lock.

**No SSH at freeze time** (archive was taken earlier). No `disk_imagize`. No 6 GB cap. No `bootInstance` recovery path. The simplification is dramatic.

**What if step 5 fails?** Linode delete failed but DB hasn't flipped. Lock released. Next cycle retries. The instance stays running and billing for the gap. Worst case: a few hours of extra billing. Pass 1.5 retry quota for stuck destroys; if 5 retries fail → P0 admin alert.

**What if step 6 fails after step 5?** Instance is gone, DB still says assigned. **DANGEROUS** — admin probes might think it's a live VM. Mitigation: write DB FIRST, then call Linode delete. If Linode delete fails after DB flip, we have a "DB thinks frozen, Linode thinks running" state. A reverse-zombie. Pass 1.5 reconciler scans frozen rows for non-null Linode instances and retries deletion.

**Ordering decision: DB write BEFORE Linode delete.** Reasons:

- DB write failure pre-Linode-delete is benign (nothing changed).
- Linode-delete failure post-DB-write needs reconciliation (Pass 1.5), but the instance is contained — billing-only issue, not data loss.
- The inverse (Linode-delete-before-DB) risks: instance gone, DB still says assigned → cron might re-attempt thaw on a non-existent provider_server_id → harder to recover.

### 6.7 Thaw (rewire-only)

**Trigger:** Stripe webhook `customer.subscription.created/updated/resumed` OR admin `/api/admin/thaw-vm`.

**Synchronous part (in webhook):**

1. Verify Stripe sub is live (defense in depth).
2. Acquire lock `freeze-thaw:<vm-id>`.
3. Verify `freeze_state IN ('frozen', 'archived')`. If state is `'archived'` (instance not yet destroyed): set `freeze_state = 'thawed_pending'` and exit. Pass 1 v3 will see the state change and skip destruction. (Instance never died.) Cron picks up on next tick.
4. Set `freeze_state = 'thawing'` AND `thaw_requested_at = now()`.
5. Release lock.

**Asynchronous part (`/api/cron/vm-thaw-rewire`, every 5 min):**

Picks up VMs in `freeze_state = 'thawing'` AND `provider_server_id IS NULL`. For each:

1. Acquire lock `freeze-thaw:<vm-id>`.
2. **Provision new Linode** from `LINODE_SNAPSHOT_ID` (the base snapshot, fresh).
3. Wait for status=running.
4. Wait for cloud-init callback (existing mechanism).
5. Update DB: `provider_server_id = new id`, `ip_address = new ip`. Keep `freeze_state = 'thawing'`.
6. SSH in.
7. Download archive from R2 (sha256-verified during download).
8. Decrypt (in cron /tmp, transient).
9. scp encrypted+decrypted tarball to VM /tmp.
10. On VM: `tar xzf /tmp/freeze.tar -C /` (manifest paths are absolute, restores to /home/openclaw/.openclaw/...).
11. Per-file sha256 verify against `manifest.json`.
12. Run **`rewireThawedVM(ssh, vm)`** (new function in `lib/ssh.ts`, NOT configureOpenClaw):
    - Set hostname
    - Run `npm ci` if `~/.openclaw/plugin-runtime-deps` is missing (regenerable)
    - Reinstall skills via stepSkills logic (NOT git-clone-from-scratch — use cached if base snapshot has them)
    - Reconcile the manifest non-destructively (templateKey-driven file writes only fill in CAPABILITIES.md, etc. — files we excluded from the archive)
    - `systemctl --user daemon-reload && systemctl --user start openclaw-gateway`
    - Poll `/health` for up to 60s
13. Update DB: `status = 'assigned'`, `health_status = 'healthy'`, `freeze_state = 'idle'`, `frozen_at = null`, `last_user_activity_at` unchanged (preserves prior signal).
14. Release lock.

**Archive deletion:** do NOT delete the archive at thaw time. Keep for 30 days post-thaw as recovery option. Garbage-collect via separate retention cron.

**Rewire failure modes:**

- Tar extract fails: refuse to start gateway, alert P0, leave VM in `freeze_state = 'thawing'` for retry.
- npm ci fails: same.
- Health probe fails: same.
- sha256 mismatch: P0 alert, do NOT extract. Archive is corrupt. Retry from N-1 generation if it exists. If all generations fail: admin investigation.

### 6.8 Lock semantics

Reuse `instaclaw_cron_locks` table (per Rule 8). One key per VM lifecycle:

- `freeze-thaw:<vm-id>` — exclusive across archive-snapshot, freeze, thaw, and rewire crons.
- TTL: 30 min (longer than max operation duration to avoid stuck-lock races during a long thaw).
- Stuck-lock takeover after 30 min, conditional SQL UPDATE per existing `tryAcquireCronLock` helper.

This solves the "user resubscribes mid-freeze" race:

- Freeze cron holds lock → starts destroying → mid-call, webhook fires.
- Webhook tries to acquire lock → fails (busy).
- Webhook sets `freeze_state = 'thawed_pending'` in a separate quick UPDATE that doesn't need the lock (just changes intent).
- Freeze cron finishes destruction. Sees freeze_state changed? Actually no — freeze cron already loaded the row at the start. Race: freeze writes `freeze_state = 'frozen'` AFTER webhook wrote `'thawed_pending'`. Lost update.

**Fix:** every freeze-side DB write uses conditional UPDATE: `... WHERE freeze_state IN ('archived', 'destroying') AND id = ?`. If the webhook flipped to `'thawed_pending'` in between, the freeze's conditional UPDATE matches 0 rows. Freeze logs "raced with thaw, abandoning destroy."

But Linode is already deleted at this point. Awkward. The conditional check must happen BEFORE the destroy too:

1. Re-read row inside the lock right before Linode delete.
2. If `freeze_state != 'destroying'` (e.g., webhook flipped to thawed_pending): abort destroy, release lock, log race.
3. Otherwise proceed with Linode delete and DB flip.

The re-read + conditional check is the standard compare-and-swap pattern. Acceptable extra DB read.

### 6.9 DB schema changes

Add to `instaclaw_vms` (NEW columns, NULLABLE for backward compat):

```sql
ALTER TABLE instaclaw_vms
  ADD COLUMN freeze_state TEXT,                          -- state machine
  ADD COLUMN frozen_archive_path TEXT,                   -- R2 path
  ADD COLUMN frozen_archive_sha256 TEXT,                 -- integrity check
  ADD COLUMN frozen_archive_size_kb INTEGER,             -- monitoring
  ADD COLUMN frozen_archive_manifest JSONB,              -- per-file metadata
  ADD COLUMN frozen_archive_taken_at TIMESTAMPTZ,        -- archive freshness
  ADD COLUMN thaw_requested_at TIMESTAMPTZ;              -- webhook trigger
```

Index for cron query efficiency:

```sql
CREATE INDEX instaclaw_vms_freeze_state_idx ON instaclaw_vms (freeze_state)
  WHERE freeze_state IS NOT NULL;
```

**Deprecation of old columns:**

- `frozen_image_id`, `frozen_image_size_mb` — currently 0 rows have these set. Leave them in for one release cycle, mark as deprecated in TS types. Drop in v2 of the migration.

**Migration plan:**

- Migration 1: ADD COLUMN IF NOT EXISTS (idempotent, additive).
- Migration 2 (one week later): backfill `freeze_state = 'idle'` on all VMs with no freeze state.
- Migration 3 (after all-quiet for 2 weeks): drop deprecated columns.

### 6.10 New cron: vm-archive-snapshot

`vercel.json` addition:

```json
{
  "path": "/api/cron/vm-archive-snapshot",
  "schedule": "0 */6 * * *"
}
```

Why 6 hours: provides 4 archive opportunities per day. Backlog of 51 VMs at 5 per tick = 11 ticks = 3 days to fully cover the suspended cohort.

### 6.11 Updated cron: vm-lifecycle Pass 1 v3

Replace existing `freezeVM(supabase, vm, ...)` call with `freezeVMArchive(supabase, vm, ...)`. The new function lives in `lib/vm-freeze-thaw-v2.ts` (NEW file) and does:

1. Read row state.
2. Verify `frozen_archive_taken_at` is recent (< 48h).
3. Acquire lock.
4. Re-read row inside lock, conditional check.
5. DB write: `freeze_state = 'destroying'`, `provider_server_id = null` (defensive — the instance is about to go away).
6. Linode delete.
7. DB write: `status = 'frozen'`, `health_status = 'frozen'`, `frozen_at = now()`, `freeze_state = 'frozen'`.
8. Release lock.

The old `lib/vm-freeze-thaw.ts` stays as a reference and may be useful for partner/policy edge cases later, but its `freezeVM` is no longer called by the cron.

## 7. Failure modes + recovery

### 7.1 Freeze-side

| Failure | Detection | Recovery |
|---|---|---|
| Tar fails on VM (disk-full, fs corruption) | tar exit code ≠ 0 | Mark `freeze_state = 'archive_pending'`, leave VM running, retry next cron tick (game-server continuous-save discipline). Alert if same VM fails 3 cycles. |
| scp pull fails | error from `ssh.getFile` | Same as above. |
| Encryption fails (key missing) | cron throws | P0 alert. Halt all freezes until key restored. |
| R2 upload fails | S3 SDK error | Same as tar failure — retry next cron. R2 SLA: 99.9% monthly. |
| Upload succeeds, DB write fails | post-write check returns no rows | Orphan tarball in R2 with no DB pointer. Garbage-collection cron (sweep R2 for paths with no matching DB row, delete after 7d). |
| Linode DELETE fails (5xx, rate limit) | linodeFetch throws | Lock released, freeze_state stays 'destroying'. Pass 1.5 sweep retries every 30 min for up to 5 attempts. After 5: P0 alert. |
| Linode DELETE succeeds, DB write fails | post-write check | "Reverse zombie" — instance gone, DB says assigned. Pass 1.5 sweep: scan rows with provider_server_id NOT NULL where Linode 404s → flip status to frozen. |

### 7.2 Thaw-side

| Failure | Detection | Recovery |
|---|---|---|
| Linode provision fails | API error | Leave `freeze_state = 'thawing'`, retry next cron. Alert after 3 tries. |
| Cloud-init callback times out | row stays at `thawing` for > 15 min after Linode running | Manual investigation. The VM is provisioned but unbootstrapped. |
| R2 download fails | S3 SDK error | Same as provision fail. Verify R2 is up. |
| sha256 mismatch on download | computed sha ≠ manifest sha | DO NOT decrypt. P0 alert. Try N-1 generation archive. If all fail: admin investigation. |
| Decrypt fails (wrong key, bad IV) | crypto throws | P0 alert. Verify FREEZE_ARCHIVE_KEY. Try older key version. |
| Tar extract fails (out of space, perms) | tar exit code ≠ 0 | Don't start gateway. Alert. The new instance is unusable — destroy and retry with fresh Linode. |
| rewire npm ci fails | npm exit code ≠ 0 | Same as above. |
| Gateway health probe fails | curl /health returns ≠ 200 in 60s | Mark VM `health_status = 'unhealthy'`. Watchdog v2 attempts restart per its own rules. |

### 7.3 Cross-cutting failures

| Failure | Detection | Recovery |
|---|---|---|
| User resubscribes mid-freeze | webhook fires while cron holds lock | Webhook can't acquire lock; writes `freeze_state = 'thawed_pending'` via non-locked UPDATE. Freeze re-reads inside lock, sees state changed, aborts destroy (per Section 6.8). |
| Concurrent freeze attempts (cron retry race) | lock contention | Conditional SQL UPDATE atomically lets only one win. |
| Stuck lock (cron died mid-flight) | lock_at > 30 min old | tryAcquireCronLock takeover (existing mechanism). |
| Archive cron and freeze cron disagree on freshness | freeze sees archive > 48h, archive cron didn't yet run | Acceptable — freeze skips this tick, archive runs next tick. Self-healing. |
| R2 partial outage (some reads work, some fail) | unpredictable | Halt new freezes (no fresh archives possible). Retry queues drain when R2 recovers. |

### 7.4 Recovery scripts to ship alongside

- `scripts/_audit-frozen-archives.ts` — verify every `frozen_archive_path` is downloadable and sha256-matches.
- `scripts/_recover-from-archive.ts <vm-id>` — manual thaw from specified archive generation.
- `scripts/_gc-orphan-archives.ts` — sweep R2 for paths with no DB pointer.

## 8. Implementation plan (phased)

### Phase 0 — research + design (THIS DOC)

✅ Cleared. Cooper signs off on the PRD.

### Phase 1 — infrastructure foundation

1. Create R2 account + bucket + API token.
2. Add Vercel env vars: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`, `FREEZE_ARCHIVE_KEY` (run `openssl rand -hex 32`).
3. Ship `lib/r2-storage.ts` (S3 SDK wrapper, ~150 LOC).
4. Migration `20260516_freeze_v2_columns.sql` — add new DB columns.
5. Test: upload + download a synthetic 10MB tarball end-to-end.

### Phase 2 — archive cron

1. Ship `lib/vm-archive-v2.ts` — tar, encrypt, upload, DB write, retention sweep.
2. Ship `app/api/cron/vm-archive-snapshot/route.ts`.
3. Add cron entry to `vercel.json`.
4. Canary: hand-trigger on 3 suspended VMs (the recovered zombies — vm-552, vm-866, vm-873). Verify archives appear in R2, DB rows updated, sha256 valid, manifest.json correct.
5. Soak 24h. Monitor cost (should be near-zero) + per-cycle wall-clock.

### Phase 3 — freeze v3

1. Ship `lib/vm-freeze-thaw-v2.ts:freezeVMArchive`.
2. Replace call in `app/api/cron/vm-lifecycle/route.ts` Pass 1 v2 → Pass 1 v3.
3. Canary: hand-trigger freeze on ONE archived VM (a recently-cancelled non-paying user, ideally one of the v97-era chronic-failers). Verify Linode is destroyed and DB shows frozen + archive_path.
4. Verify the same VM can be thawed in Phase 4 below.
5. Soak 48h before enabling for the full backlog.

### Phase 4 — thaw v2

1. Ship `lib/vm-freeze-thaw-v2.ts:thawVMArchive`.
2. Ship `lib/ssh.ts:rewireThawedVM` — minimal post-extract setup.
3. Ship `app/api/cron/vm-thaw-rewire/route.ts`.
4. Update billing webhook (`app/api/billing/webhook/route.ts`) to set `freeze_state = 'thawing'` + `thaw_requested_at`.
5. Canary: thaw the VM frozen in Phase 3. End-to-end: webhook → cron → new Linode → SSH in → restore → gateway healthy.
6. Compare conversation history pre-freeze vs post-thaw on the canary user — every session intact? MEMORY.md byte-identical? Wallet keys match?

### Phase 5 — fleet rollout

1. Enable for the existing 51-VM backlog. Archive-snapshot cron walks through ~17/day. Freeze v3 follows after archives land.
2. Monitor leak count daily until < 5.
3. After 7 days clean: deprecate `lib/vm-freeze-thaw.ts:freezeVM` (the old image-based path). The Rule 51 cleanup remains as a defensive fallback if anyone reintroduces image-based freezing.

### Phase 6 — cleanup

1. After 14 days no incidents: drop deprecated `frozen_image_id`, `frozen_image_size_mb` columns (Migration 3).
2. Remove dead code in old `lib/vm-freeze-thaw.ts`.
3. Update CLAUDE.md Rules 50/51/52 to note the new model is canonical. Rule 51 (disk cleanup) becomes "moot for freeze; still relevant for general disk hygiene." Rule 52 (recovery retry) becomes "moot; freeze no longer creates zombies."

## 9. Test plan (per Rule 31)

**Synthetic failure-mode tests:**

| Scenario | Setup | Expected |
|---|---|---|
| Archive of cold-start VM (light data) | New VM, < 1 MB workspace | Tarball ~500 KB, full restore succeeds |
| Archive of heavy VM | VM with 5 GB session jsonl | Tarball 5-30 MB; sessions intact post-restore |
| Archive with brain.pglite locked by gbrain | gbrain MCP running | Stop hook fires, snapshot taken, restart hook fires |
| Archive while gbrain unavailable | `systemctl --user is-active gbrain` returns inactive | Tarball still succeeds; brain.pglite included if file exists |
| Upload to R2 fails | Mock R2 SDK to return 500 | Cron logs error, freeze_state stays 'archiving', retry next tick |
| Linode delete fails mid-freeze | Mock linodeFetch to throw on DELETE | freeze_state = 'destroying' persists, Pass 1.5 retries |
| Thaw with corrupted tarball | Modify a byte in R2 object | sha256 mismatch caught; refuses to decrypt; tries N-1 |
| Thaw with all generations corrupt | Corrupt all generations | P0 alert, admin investigation marker |
| User resub mid-freeze | Trigger webhook while archive_snapshot cron holds lock | webhook sets thawed_pending; freeze cron sees on re-read, aborts |
| Concurrent archive + freeze cron | Both fire on same VM | Lock contention; one wins atomically |
| Vercel function timeout mid-upload | Force cron to hit 300s limit during R2 upload | Lock auto-expires after 30 min; next tick retries from scratch |

**Acceptance criteria for Phase 5 (fleet rollout):**

1. Archive cron runs cleanly for 7 days with < 5% failure rate.
2. Backlog of 51 VMs successfully frozen (Linode billing drops by $1,479/mo).
3. At least 3 end-to-end thaws verified byte-identical on user data.
4. No P0 alerts during the soak window.
5. R2 storage cost < $0.50/mo total (way under free tier).

## 10. Cost analysis

**Steady state (mature system, ~200 VMs):**

- Storage: 200 × 30 MB × 3 generations = 18 GB. R2 free tier 10 GB → ~$0.12/mo (8 GB over). Negligible.
- Egress: thaw downloads from R2 to Linode = $0 (free egress).
- API operations: ~10k Class A + 100k Class B/mo. R2 free tier 1M / 10M. Free.
- Vercel function compute: ~10-15 min/day of archive cron. Pro tier, no impact.

**Savings:**

- Eliminates 51 × $29/mo = $1,479/mo Linode bill for current backlog.
- Going forward, every freeze saves $29/mo per VM until thaw.
- At 5% monthly cancellation × 200 VMs = 10 VMs/mo getting frozen = $290/mo growing savings.

**Net first-year impact: ~$15,000-$18,000 savings.**

## 11. Security considerations

- **Wallet private keys in transit:** plaintext on the source VM during tar (acceptable — already there); plaintext briefly in cron `/tmp` during encrypt step (Vercel-isolated, ephemeral); ciphertext during R2 upload + at rest.
- **Encryption key:** stored only in Vercel env, never on a VM. Rotate annually or on incident. Backup the key offline (a lost FREEZE_ARCHIVE_KEY = all archives unrecoverable).
- **R2 bucket access:** server-side-only via API token. No public read. Token scoped to single bucket.
- **Tarball integrity:** sha256 in DB matches in-file manifest sha256s on every file; sha256 verified end-to-end on download. AES-GCM provides authenticated encryption (tampering detected).
- **Thaw VM identity:** new Linode has a new IP and host keys. The `~/.openclaw/agents/main/sessions/` files are restored from tarball, so conversation history is preserved with the new IP. Telegram bot tokens are in the restored `.env`, so the bot identity is preserved.
- **GDPR / data deletion:** user-initiated delete → wipe DB row + R2 archives + Linode instance (if exists). Implementation: `/api/admin/delete-user-data` route. Out of scope for this PRD but design supports it (R2 deletes are immediate; no soft-delete state).

## 12. Open questions / decisions Cooper should weigh in on

1. **R2 vs Supabase Storage final call.** I recommend R2 based on the $0 egress benefit. Supabase Storage is the no-new-vendor fallback. Either works; R2 saves us $5/mo flat and possibly more at scale.

2. **Archive retention post-thaw.** I propose 30 days, then auto-delete. Alternative: keep indefinitely (user could resub again). Tradeoff: 30d retention = $0.50/mo at fleet scale; indefinite = $5-10/yr per long-dormant user. Probably indefinite is fine given absolute cost.

3. **Should we archive non-suspended VMs too?** Current design only archives `health_status IN ('suspended','hibernating')`. Argument for archiving healthy VMs: disaster-recovery snapshot, even if user is active. Argument against: storage cost (200 healthy × 30 MB × 3 generations = 18 GB), more crons running, more bytes in motion. **My recommendation:** archive only sleeping VMs (as designed). Add a "user-initiated backup" endpoint later if needed.

4. **Should we encrypt the manifest.json too?** It contains sha256s but not user data. Currently designed plaintext (inside the encrypted tarball, so already encrypted by Section 6.4). Keep simple.

5. **What happens to a frozen VM the user never thaws?** Indefinite storage. Add a 1-year auto-delete policy with user notification? Or leave indefinitely? My take: leave for v1, decide later based on actual long-dormant data.

6. **PGLite checkpoint pragma — is `wal_checkpoint(TRUNCATE)` actually safe for a running gbrain?** Need to confirm with gbrain code path. If gbrain is reading WAL when we truncate, we could lose recently-written data. Safer: stop gbrain first, then checkpoint+truncate, then tar.

7. **Cloud-init callback for thaw vs polling:** the existing cloud-init callback writes `cloud_init_callback_consumed_at`. Should thaw cron poll for this column being set, or use a fresh callback specifically for thaw? My take: reuse existing callback; flip `freeze_state` from `'thawing'` to `'thawing_provisioned'` on first callback, then rewire runs after.

8. **Should rewire run a full reconcile or just stepFiles + start?** Full reconcile is safe but slow (5+ min). stepFiles + start is faster (~30s) but might miss manifest drift. **My take:** stepFiles + start for the thaw critical path; let the next regular reconcile cron pick up any manifest drift naturally.

## 13. Rollout summary

| Phase | Duration | Risk | Reversible? |
|---|---|---|---|
| 0: PRD sign-off | Now | Low | n/a |
| 1: R2 + DB migration | 1 day | Low | Yes (drop columns) |
| 2: Archive cron | 3 days canary + 4 days soak | Low (read-only effect; tarballs sit in R2) | Yes |
| 3: Freeze v3 | 1 VM canary + 48h soak | Medium (destroys a Linode) | Partial (thaw recovers from archive) |
| 4: Thaw v2 | 1 VM end-to-end | Medium (recovery code path) | Yes (don't release the new Linode if rewire fails) |
| 5: Fleet rollout | 7 days | Medium | Per-VM reversible via thaw |
| 6: Deprecation cleanup | 14 days post-rollout | Low | Yes (revert deletion) |

Total time from sign-off to clean fleet: **~3 weeks** to fully drain the backlog and remove the deprecated image-based code.

## 14. What we're NOT doing

- Not maintaining two freeze models in parallel. After Phase 5, the image-based path is dead.
- Not building hot thaw (sub-minute). 5-8 min is acceptable.
- Not building cross-region failover for R2. us-east-only is fine.
- Not building user-facing "I want a backup of my agent now" UX. Server-side cron-driven only.
- Not building a multi-tenant key management system. One key per environment (production, staging) is enough.
- Not migrating active healthy VMs. Only suspended/hibernating cohort enters the freeze pipeline.

---

**Ready for Cooper review.** Open questions in Section 12 need decisions before Phase 1 can ship. Recommended decisions (my picks) in each Q's body. After sign-off, Phase 1 is ~1 day of work.
