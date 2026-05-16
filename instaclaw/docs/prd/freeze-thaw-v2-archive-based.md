# PRD: Archive-Based Freeze/Thaw (v2)

**Status:** Draft (2026-05-16, revised 2026-05-16-PM)
**Author:** Claude Opus 4.7 + Cooper Wrenn
**Replaces:** `lib/vm-freeze-thaw.ts` Linode-image-based freeze (commit 2ce729f1, Rules 50/51/52)
**Resolves:** Freeze-pipeline $1,450/mo leak; zero successful freezes in system history; 6,144 MB Linode image cap blocks every production-aged VM

---

> **REVISION 2026-05-16-PM — Path 2 pivot.** Empirical PGLite verification on
> vm-050 invalidated §6.2's stop+restart-based archival assumption. gbrain
> v0.35.0.0 + PGLite-WASM does not survive a SIGTERM-mediated graceful
> shutdown — the post-stop data dir fails to re-open ("PGLite failed to
> initialize its WASM runtime"). Counterintuitively, SIGKILL (used by
> install-gbrain.sh:340) produces a recoverable backup; SIGTERM does not.
> This is an upstream gbrain bug, not a config problem; no amount of
> ExecStop tuning fixes it.
>
> **Path 2 (online backup) is now the canonical design.** PGLite has a
> native `engine.db.dumpDataDir("gzip")` method (visible in
> `gbrain/scripts/build-pglite-snapshot.ts:53`) that produces a hot
> snapshot from a running engine — no stop, no checkpoint pragma, no
> downtime. The archive flow calls this via a new gbrain MCP `snapshot`
> tool. The rest of the user state (workspace, sessions, .env, wallet)
> remains a regular tar — those files don't have the WAL/data-dir
> recovery problem.
>
> The original §6.2 (stop → tar → restart) is **preserved below for
> historical context**. **§15 is the canonical design.** §16 records the
> locked design decisions including the refined Q5 retention policy.

---

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

## 15. CANONICAL ARCHITECTURE — Path 2 (dumpDataDir-based, revised 2026-05-16-PM)

This section supersedes §6.2 (brain.pglite stop-and-tar handling) and the §6.5/§6.7 SSH-dependent control flow. Where this section conflicts with anything above, **this section wins.**

### 15.1 Empirical foundation — why path 2 is mandatory

vm-050 verification on 2026-05-16, fully documented in the session log:

1. gbrain v0.35.0.0 ran cleanly for 15h.
2. `systemctl --user stop gbrain` completed in 75ms (clean exit, code 0). The shutdown code path (`serve.ts:beginShutdown` → `engine.disconnect()` → `db.close()` → `releaseLock()`) is well-formed; it does the right things.
3. Despite a textbook-clean graceful shutdown, the resulting on-disk PGLite data dir **could not be re-opened** by the next gbrain start. WASM init aborted with "PGLite failed to initialize its WASM runtime" / `Aborted()`.
4. Removing `postmaster.pid` did not help. Removing `.gbrain-lock/lock` did not help. The binary itself works on an empty data dir (proven with `HOME=/tmp/empty gbrain serve`). The corruption is in the post-shutdown data state.
5. `install-gbrain.sh:340` uses `pkill -KILL -f 'gbrain.*serve'` (SIGKILL). The resulting PRE-WIPE backup tarballs from yesterday's canary loaded cleanly when restored. Conclusion: **SIGKILL produces recoverable state; SIGTERM-with-graceful-cleanup does not.**

This is an upstream gbrain/PGLite bug. We do not own a fix for it. **The stop-and-tar architecture is dead.** Any design that requires gracefully stopping gbrain to take a backup is structurally broken.

### 15.2 New primitive — `dumpDataDir()`

PGLite exposes a native hot-backup method on the live engine:

```typescript
// From electric-sql/pglite — operates on a RUNNING engine, no stop needed
const dump: Blob = await db.dumpDataDir("gzip");  // also "none" | "auto"
const buffer = Buffer.from(await dump.arrayBuffer());
// buffer is a complete, consistent tar of the data dir
```

It's already used by gbrain's own `scripts/build-pglite-snapshot.ts:53` to produce test fixtures. The semantics: read-only iteration over the data dir from inside the engine's WAL-aware view, producing a consistent snapshot. No SIGTERM. No locks dropped. No service interruption.

The catch: PGLite exposes this on the JS engine object — there's no MCP tool, no HTTP endpoint. **gbrain needs a small feature to expose it.**

### 15.3 gbrain dependency — `snapshot` MCP tool

**Required gbrain feature for freeze-v2:** an authenticated `snapshot` MCP tool (or admin HTTP endpoint) on the running gbrain server that returns the output of `engine.db.dumpDataDir("gzip")` as a binary blob.

Two acceptable shapes (gbrain terminal picks):

**A. MCP tool** — fits the existing tool-registration pattern:
```typescript
{
  name: "snapshot_brain",
  description: "Hot snapshot of PGLite data dir. Returns base64-encoded gzipped tar. " +
               "No service interruption. Bearer-token auth (same as other write tools).",
  inputSchema: { type: "object", properties: { compression: { type: "string", enum: ["none","gzip","auto"], default: "gzip" } } },
  handler: async (args, ctx) => {
    const dump = await ctx.engine.db.dumpDataDir(args.compression ?? "gzip");
    const buffer = Buffer.from(await dump.arrayBuffer());
    return { content: [{ type: "resource", mimeType: "application/gzip", blob: buffer.toString("base64") }] };
  }
}
```

**B. Admin HTTP endpoint** — leaner for our cron, but a new route shape gbrain may not want:
```typescript
// GET /admin/snapshot.tar.gz with Authorization: Bearer ...
// Streams gzipped tar directly. No base64 wrapping.
```

**My recommendation: A.** MCP tool fits the existing patterns, doesn't introduce a new auth surface, and gbrain already has the bearer-token middleware for tool calls. The base64 overhead (~33% size inflation) is trivial at our scale (5-50 MB raw → 7-67 MB transit). Tool response shape may need adjustment if MCP can't carry binary cleanly — gbrain terminal decides.

**If neither A nor B ships:** freeze-v2 is BLOCKED. We cannot work around this from our side. There is no other PGLite hot-backup mechanism available without modifying gbrain.

### 15.4 Archive bundle composition (REVISED)

A complete archive bundle is now TWO tarballs combined, not one:

| Component | How produced | Size (typ) | Source |
|---|---|---|---|
| **PGLite snapshot** (`brain.pglite.tar.gz`) | gbrain MCP `snapshot_brain` tool returning `dumpDataDir("gzip")` | 5-50 MB | Hot, from running engine |
| **User state tarball** (`user-state.tar.gz`) | Regular `tar czf` via SSH (these files don't have the WAL recovery problem — they're regular files, not databases) | 1-15 MB | Tar over the live VM, no service stop |

User-state tarball contents (from the original §6.1 tarball manifest, MINUS the PGLite dir):
- `~/.openclaw/wallet/`
- `~/.openclaw/workspace/MEMORY.md`, `~/.openclaw/workspace/memory/`, `~/.openclaw/workspace/SOUL.md`
- `~/.openclaw/agents/main/agent/auth-profiles.json`
- `~/.openclaw/.env`
- `~/.openclaw/openclaw.json`
- `~/.openclaw/agents/main/sessions/*.jsonl` + `sessions.json`
- `~/.gbrain/openclaw-bearer-token.txt` (the gbrain MCP token — restored alongside the PGLite data so token-hash match is preserved)

The two tarballs are combined into a single outer tar with a `manifest.json` at the root (the encryption wrapper described in §6.4 applies to the outer tar):

```
archive-bundle.tar
├── manifest.json                      # version, vm_id, generated_at, both inner sha256s, sizes
├── brain.pglite.tar.gz                # produced by dumpDataDir
└── user-state.tar.gz                  # produced by tar over live filesystem
```

The outer tar is then encrypted (AES-256-GCM, per §6.4) and uploaded to R2.

### 15.5 Continuous archival cron — REVISED flow

`/api/cron/vm-archive-snapshot`, schedule `0 */6 * * *` (every 6h). For each candidate VM (suspended/hibernating, archive missing OR older than 24h):

1. Acquire `instaclaw_cron_locks` key `freeze-thaw:<vm-id>` (TTL 30 min).
2. Set `freeze_state = 'archiving'`.
3. SSH connect to VM.
4. **HTTP call to gbrain's MCP `snapshot_brain` tool over localhost:3131** with bearer token from `~/.gbrain/openclaw-bearer-token.txt`. Receive base64-encoded gzipped tar of brain.pglite.
5. Decode base64 → `brain.pglite.tar.gz` in VM `/tmp`.
6. `tar czf /tmp/user-state.tar.gz` over the user-state file list (NOT touching brain.pglite, which is in the other tarball).
7. Produce `/tmp/archive-bundle.tar` combining both inner tarballs + manifest.json.
8. scp the bundle to cron `/tmp`.
9. Cron encrypts with AES-256-GCM, uploads to R2 at `<vm-id>/<unix-ts>-<sha256-prefix>.tar.enc`.
10. DB update: `frozen_archive_path`, `frozen_archive_sha256`, `frozen_archive_size_kb`, `frozen_archive_manifest`, `frozen_archive_taken_at`, `freeze_state = 'archived'`.
11. Release lock.
12. Retention sweep: keep last 3 archives per VM in R2; delete older.

**Crucial property: gbrain is NEVER STOPPED.** The MCP `snapshot_brain` call returns within seconds and the engine continues serving traffic. The user-state tarball captures regular files that don't need quiescence.

**Concurrency cap:** `MAX_ARCHIVES_PER_RUN = 5`. Same as original PRD. Probably bumpable now that we removed the most expensive step (graceful stop/restart cycle).

**Crash safety:** if the cron dies mid-archive, `freeze_state = 'archiving'` remains. Lock auto-expires after 30 min, next cron tick retries from scratch. PGLite state is unaffected by our crash because we never touched it (just read via MCP). Worst case: a wasted `dumpDataDir` call on the VM, ~5 GB of throwaway bytes.

### 15.6 Freeze (Pass 1 v3) — REVISED, simpler

For each candidate VM at grace expiration:

1. **Precondition:** `frozen_archive_taken_at` exists AND ≤ 48h old.
   - If no archive: skip; archive cron will catch up.
   - If archive stale: skip; force a fresh archive first.
2. Acquire lock `freeze-thaw:<vm-id>`.
3. Re-read VM row inside lock. Conditional check: if `freeze_state` is NOT `'archived'` (e.g., webhook flipped to `'thawed_pending'` between archive and freeze), **abort cleanly**. Don't destroy. Release lock. Game-server-pattern resub race is handled here.
4. DB write: `freeze_state = 'destroying'`. (Conditional UPDATE: `WHERE freeze_state = 'archived' AND id = ?`. If 0 rows match, abort.)
5. **Linode DELETE** the instance directly. No SSH at freeze time. No graceful gbrain stop. The instance is going away anyway; no recovery path is needed because there's no in-flight failure mode that produces a zombie.
6. DB write: `status = 'frozen'`, `health_status = 'frozen'`, `frozen_at = now()`, `freeze_state = 'frozen'`, `provider_server_id = null`, `ip_address = null`. Single conditional UPDATE.
7. Release lock.

**No `cleanupDiskForFreeze` step** (the Rule 51 6 GB gate no longer applies — we're not creating a Linode image). **No `recoverInstanceAfterFailedFreeze` step** (Rule 52 doesn't apply — there's no in-flight imagize to recover from). The freeze path is now ~15 lines of code. The original PRD's failure-mode matrix collapses correspondingly.

### 15.7 Thaw — REVISED, archive-before-first-start

Trigger: Stripe webhook `subscription.created|updated|resumed`, OR `/api/admin/thaw-vm`.

Synchronous webhook side (idempotent, fast):
1. Verify Stripe sub is live.
2. Acquire lock `freeze-thaw:<vm-id>`.
3. Verify `freeze_state IN ('frozen', 'archived')`.
4. Set `freeze_state = 'thawing'`, `thaw_requested_at = now()`. Release lock.
5. Return 200 to Stripe.

Async cron side (`/api/cron/vm-thaw-rewire`, every 5 min):

1. Acquire lock.
2. **Provision new Linode** from `LINODE_SNAPSHOT_ID` (base snapshot). NEW provider_server_id, NEW IP. DB row updated to point at new instance.
3. Wait for cloud-init callback (existing mechanism — `cloud_init_callback_consumed_at` gets set).
4. Set `freeze_state = 'thawing_provisioned'`.
5. SSH to new VM.
6. **CRITICAL ORDERING — archive layered BEFORE first gbrain start:**
   - `systemctl --user stop gbrain` (stops the freshly-provisioned-but-empty gbrain). Safe because there's no user data to lose — the data dir is the base-snapshot template (or empty).
   - Download archive from R2 to VM `/tmp` via scp from cron.
   - Decrypt the outer tar (AES-256-GCM, key from Vercel env). Verify sha256.
   - Extract outer tar → `brain.pglite.tar.gz` + `user-state.tar.gz` + `manifest.json`.
   - Validate manifest.json (sha256 of each inner tar matches manifest).
   - `rm -rf ~/.gbrain/brain.pglite` (delete the base-snapshot's empty/template version).
   - Extract `brain.pglite.tar.gz` → fresh, complete `~/.gbrain/brain.pglite/` (this is what `dumpDataDir` produced; PGLite knows how to reload it).
   - Extract `user-state.tar.gz` → restores `~/.openclaw/...` and `~/.gbrain/openclaw-bearer-token.txt`.
7. `systemctl --user start gbrain`. Poll `/health=200` (≤60s).
8. Verify with authenticated put_page + get_page MCP round-trip (Cooper's standard from Item 1/2 — non-negotiable).
9. **Manifest-version-aware rewire** (Q8 refined; see §16):
   - Compute `version_gap = VM_MANIFEST.version - archive.manifest.source_manifest_version`.
   - `gap ≤ 10`: stepFiles only + restart gateway. Fast thaw (~30s).
   - `10 < gap ≤ 30`: stepFiles + stepConfigSettings + stepGatewayRestart. Medium thaw (~90s).
   - `gap > 30`: full reconcile path (stepSystemPackages + stepFiles + stepConfigSettings + stepSkills + stepGatewayRestart). Slow thaw (~5 min). Treat the archived VM as effectively fresh-provisioned + with user data layered on top.
10. Update DB: `status = 'assigned'`, `health_status = 'healthy'`, `freeze_state = 'idle'`, `frozen_at = null`. **DO NOT clear** `frozen_archive_path` — archive stays in R2 for 30 days post-thaw as recovery (Q2).
11. Release lock.

**Crucial property:** the archive is layered onto an empty PGLite data dir BEFORE the first start. PGLite never has to recover from a graceful-shutdown state (the gbrain bug). It's loading a fresh `dumpDataDir` output, which is exactly the input format it knows how to load.

### 15.8 Failure modes — REVISED matrix

The archive flow is simpler now; the failure surface shrinks. Only the deltas from §7:

| New / changed failure | Detection | Recovery |
|---|---|---|
| gbrain MCP `snapshot_brain` tool returns error (engine busy, dumpDataDir crashes) | non-2xx from MCP call | Mark `freeze_state = 'archive_pending'`, retry next cron. Three failures → alert ("gbrain snapshot tool failing on vm-X — investigate"). |
| `dumpDataDir` output is too large (PGLite has accumulated >100 MB of pages) | size check on received blob | Cap at 200 MB raw; alert and skip if exceeded. Unlikely at our scale (typical brain is < 50 MB) but defends against runaway. |
| Bearer-token auth fails to MCP (token rotated, file out of sync) | 401 from gbrain | Read freshly from `~/.gbrain/openclaw-bearer-token.txt` (don't cache in cron memory). If still 401: alert; need to re-mint. |
| Thaw extract fails (corrupt archive, sha256 mismatch) | sha256 check | Try N-1 generation. If all generations fail: P0 alert, manual investigation. |
| Thaw: `dumpDataDir` extracted output won't open in fresh PGLite | gbrain logs WASM error after `systemctl start gbrain` | Same as freeze-time WASM bug — but here the input is fresh-from-dumpDataDir which IS gbrain's canonical reload format. If this fails, gbrain has a more serious bug. Alert P0; freeze-v2 is blocked. |

**Deleted failure modes (no longer relevant):**
- ENOSPC during shutdown checkpoint (no shutdown)
- WAL replay failure on restart (no restart)
- Cleanup whitelist incomplete (no cleanup; full archive captured by dumpDataDir)
- imagize size cap exceeded (no imagize)
- offline-billing zombie from boot-recovery failure (no boot recovery; no Linode delete-before-archive)

### 15.9 What changes from the original §6.1 manifest

The "Tier 1 / Tier 2 / Excluded" file lists in §6.1 are still right for the **user-state tarball**. The PGLite tarball replaces what `~/.openclaw/brain.pglite/` would have been in §6.1 (and it's actually at `~/.gbrain/brain.pglite/` per empirical inspection — §6.1's path was wrong; updated below).

**Corrected path (replaces §6.1 row for brain.pglite):**
- Old `~/.openclaw/brain.pglite/` (from §6.1) → **`~/.gbrain/brain.pglite/`** (correct path; from vm-050 empirical inspection 2026-05-16). Now archived via dumpDataDir tool, not file-system tar.

### 15.10 gbrain dependency timeline

This PRD blocks on the gbrain terminal shipping the `snapshot_brain` MCP tool. Phasing:

- **Day 0 (today): coordinate with gbrain terminal.** Cooper relays this PRD to that terminal. They estimate effort + acceptable shape (MCP tool vs admin HTTP).
- **Day 1-3: gbrain terminal ships the snapshot tool** to a canary VM. Tested manually against vm-050 (or a sister VM with comparable data).
- **Day 3-4: I ship Phase 1 (R2 + migration + encryption + smoke test) in parallel.** None of this needs the snapshot tool yet — it's substrate.
- **Day 4-5: Phase 2 (archive cron) once snapshot tool is on the fleet.**
- **Day 5-7: Phase 3 (freeze v3) one-VM canary.**
- **Day 7-10: Phase 4 (thaw v2) end-to-end on a canary user.**
- **Day 10-17: Phase 5 (fleet rollout) — drain the 51-VM backlog.**

If gbrain terminal can't ship the snapshot tool in 1-3 days, the freeze-v2 timeline pushes by however long they need.

### 15.11 What survives from §6.2 (the original)

The encryption (§6.4), R2 storage (§6.3), DB schema (§6.9), lock semantics (§6.8), and the lifecycle log / lifecycle_locked_at fields are **all unchanged**. Path 2 changes only the snapshot mechanism + the freeze/thaw control flow. Substrate stays.

---

## 16. LOCKED DESIGN DECISIONS — 3-year scale-debt audit

Cooper's 8 questions from §12, with refinements after the empirical PGLite test and the 1000-VM-3-year-out lens. Where this section differs from §12, **this section is canonical.**

### 16.1 Q1 — R2 vs Supabase Storage → **R2** (locked)

Cooper's override: clean separation of concerns (storage ≠ database). S3-compatible SDK preserves swap-out path. $0 egress matters more at scale than I initially estimated.

**3-year scale check (1000 VMs, 200 frozen):** total storage ~30 GB. R2 free tier covers 10 GB; remaining 20 GB at $0.015/GB-month = $0.30/mo. Egress $0. Operational debt: R2 dashboard to monitor (low), API tokens to rotate annually (low). **No scaling concerns.**

### 16.2 Q2 — Post-thaw archive retention → **30 days, auto-delete** (locked)

**3-year scale check:** 1000 thaws/year × 30 MB × 30d retention = 2.5 GB peak. Trivial. The 30-day window covers (a) disaster-recovery rollback if a thaw was botched, (b) 30 days of support investigation. After 30 days, the user is actively using the new VM and the archive is stale.

**One refinement:** the post-thaw archive auto-delete is **per-archive-generation**, not per-VM. We keep the latest pre-thaw archive for 30 days but older generations (from earlier archive-snapshot cron runs) can be deleted earlier. Storage savings minor but operationally clean.

### 16.3 Q3 — Archive healthy VMs too → **No** (locked)

**3-year scale check:** At 1000 healthy VMs, archiving all of them would cost 4 archives/day × 1000 = 4000 archives/day. Even at 5 seconds each (via dumpDataDir, much faster than the old stop/tar/restart), that's 5.5 hours of cron compute per day. Multiple parallel workers required. Big cron complexity.

Marginal value: disaster-recovery snapshot for healthy VMs. We've operated without it for years. If we need it, build it as a separate "essential-data backup" feature with different cadence (daily, not 6h) and different retention (last 1, not 3). Don't conflate with freeze-archive.

### 16.4 Q4 — Encrypt manifest.json beyond outer tar → **No** (locked)

The outer tar is AES-256-GCM encrypted. manifest.json lives INSIDE that. No additional encryption needed. **3-year scale: unchanged.** No reason to revisit.

### 16.5 Q5 — Long-dormant retention → **Indefinite v1, but schema-prepared for v2** (refined)

Cooper's call: indefinite retention for v1 as a trust signal ("we never lose your data"). Skip auto-delete cron.

**My refinement (additive, no behavior change to v1):** add **`frozen_retention_policy TEXT` column** to `instaclaw_vms` in the v1 migration. Default NULL (= indefinite). When we ship v2's auto-delete cron in 6-18 months, the column already exists and can be populated:

- `NULL` (default) — indefinite retention. v1 behavior.
- `'standard'` — 24-month retention with 18mo + 23mo email warnings (matches Google's pattern).
- `'vip'` — indefinite retention (carveout: bankr token launchers, paid >12mo lifetime, partner-tagged users).
- `'compliance_delete'` — pending GDPR deletion; cron runs the 30-day wait + delete within a week.

The auto-delete cron filters on `frozen_retention_policy = 'standard'` only when it ships. NULL rows are skipped. VIP rows are preserved indefinitely.

**3-year scale check:** at 1000 frozen users, indefinite retention = 30 GB storage = $0.30/mo. **Cost is not the problem.** Real concerns:
- GDPR Article 17 — we MUST be able to delete an individual user's archive on request. Build a `/api/admin/delete-user-archives/<userId>` endpoint NOW; it's a 20-line handler and unblocks compliance forever.
- Security blast radius — 1000 wallet keys (encrypted) sitting in cold storage. Encryption key rotation is the lever; we should rotate `FREEZE_ARCHIVE_KEY` annually. Build the key-versioning in v1's encryption (key_id in manifest.json) so rotation doesn't require re-encrypting old archives.
- Operational visibility — at 1000 frozen archives, a "where is my data" support query needs a fast lookup. The DB row's `frozen_archive_path` provides this; just need to make sure we DON'T null it on delete (until we actually delete the R2 object).

**v1 deliverables for this question (all small):**
1. Schema column `frozen_retention_policy TEXT` (NULL default).
2. Admin endpoint `POST /api/admin/delete-user-archives/<userId>` for GDPR.
3. Key-versioning in the encryption helper (`key_id: "v1"` in manifest.json).
4. **No auto-delete cron in v1.** Defer.

**Confidence: 85%.** Cooper might want a stricter v1 (e.g., 24mo standard retention as default). The above is the most generous reasonable v1 that unblocks v2 without operational debt.

### 16.6 Q6 — PGLite hot snapshot → **OBSOLETED by §15** (locked)

The original Q6 asked whether `wal_checkpoint(TRUNCATE)` is safe with gbrain running. Empirically: irrelevant. PGLite isn't SQLite — it's Postgres-WASM — and the WAL behavior wasn't the bug anyway. The new design uses `dumpDataDir` which is hot by design and bypasses all the shutdown/checkpoint concerns.

**Phase 1 PGLite verification gate: PASSED with negative result.** The gate proved Path 1 doesn't work, motivating Path 2. Phase 1 implementation can now proceed without re-running the original verification (it would just reconfirm the bug).

### 16.7 Q7 — Cloud-init callback reuse → **Yes, reuse** (locked)

**3-year scale check:** thaw rate at 1000 VMs / 5% monthly cancellation × 50% return rate = ~25 thaws/mo. Polling overhead trivial. Cloud-init callback has been load-bearing for years. No issues. ✓

### 16.8 Q8 — Rewire scope → **Version-gap-aware** (refined)

Original recommendation: stepFiles + start for thaw critical path.

**Refinement for 3-year scale:** archives can be very old (manifest version 100 today; in 3 years, manifest could be at 200+). A 3-year-old archive thawing into the current fleet has a 100+ version gap. stepFiles alone won't be enough — config keys, system packages, plugin runtime deps may have all drifted.

Tiered rewire (locked in §15.7):
- **gap ≤ 10** — stepFiles + start (~30s thaw). Most thaws.
- **10 < gap ≤ 30** — stepFiles + stepConfigSettings + stepGatewayRestart (~90s).
- **gap > 30** — full reconcile path (~5 min). Treat as fresh-provision + user-data layer.

**Confidence: 70%.** Thresholds need empirical tuning after 3-5 real thaws. The shape (tiered) is right; the boundaries are guesses.

### 16.9 Cross-cutting scale-debt summary

| Concern | At 1000 VMs / 200 frozen / 3 yrs | Mitigation in v1 |
|---|---|---|
| R2 storage cost | $0.30/mo | None needed |
| GDPR compliance | Right-to-erasure requests | Admin delete endpoint in v1 (§16.5) |
| Encryption key rotation | Annual best practice | key_id versioning in v1 (§16.5) |
| Long-dormant data hoarding | 1000s of wallet keys in cold storage | `frozen_retention_policy` column unblocks v2 auto-delete (§16.5) |
| Cron throughput | 5 archives/run × 4 runs/day = 20/day; backlog drain ~3 days | Bump `MAX_ARCHIVES_PER_RUN` to 10 once empirically validated |
| Storage observability | "where is my archive" support queries | DB column `frozen_archive_path` + `frozen_archive_taken_at` answer this directly |
| R2 vendor lock-in | S3-compatible SDK | Swap to S3 or Supabase Storage via env var change if R2 ever degrades |
| gbrain `snapshot_brain` tool dependency | Single point of feature dependence | Acceptable — gbrain is core infrastructure already; if it breaks, freeze is the least of our problems |

**No scaling bottleneck identified.** No undue operational debt. The architecture is bounded and operates within R2 free tier (or near-free) for the foreseeable future.

---

**Ready for Cooper review.** Open questions in Section 12 need decisions before Phase 1 can ship. Recommended decisions (my picks) in each Q's body. After sign-off, Phase 1 is ~1 day of work.

---

## 17. PHASE 4 — Thaw cron implementation design (2026-05-16-PM)

The inverse of Phase 3. Picks up `freeze_state='thaw_pending'` rows (set by the billing webhook hook in commit `7180cf3b`), provisions a fresh Linode via cloud-init, layers the user's archive on top, marks the row healthy. The capstone of freeze-v2.

### 17.1 Trigger

`freeze_state='thaw_pending'` set by `markThawPendingForV2User()` in `lib/freeze-v2-thaw-entry.ts`, called from:
- `app/api/billing/webhook/route.ts` on `customer.subscription.created`
- `app/api/billing/webhook/route.ts` on `customer.subscription.updated`

Both cases set `thaw_requested_at = now()` and flip state via CAS (only flips if state was `'frozen'` AND `frozen_archive_path IS NOT NULL`). Idempotent on re-fires.

### 17.2 Candidate query

Rows are eligible when:
- `freeze_state = 'thaw_pending'` (entry point)
- `frozen_archive_path IS NOT NULL` (we have something to restore from)
- `provider_server_id IS NULL` (no Linode yet — we provision a new one)
- `assigned_to IS NOT NULL` (defensive — orphaned thaw-pending rows skip)

Ordered by `thaw_requested_at ASC` so oldest wait gets served first (FIFO is the right UX for "user resubscribed N minutes ago, I want my agent").

### 17.3 Per-VM flow

This is the load-bearing logic. Stages and their state transitions:

```
thaw_pending → thawing → thawing_provisioned → idle
```

Each transition is a conditional CAS UPDATE. State at the start of each function call is verified — any mismatch aborts the function (the row was advanced or reverted by another process).

**Stage 1: thaw_pending → thawing** (mark intent + provision)
1. Acquire `freeze-thaw:<vm-id>` lock (30 min TTL).
2. Re-read row inside lock. Verify `freeze_state='thaw_pending'`.
3. CAS UPDATE: `freeze_state='thawing'` WHERE `freeze_state='thaw_pending'`.
4. Mint fresh cloud-init tokens (config + callback) — same pattern as `createUserVM`. The OLD tokens from the original VM provisioning are stale; the new cloud-init flow needs fresh ones.
5. UPDATE row: `cloud_init_config_token`, `cloud_init_callback_token`, status='provisioning'.
6. Call `linodeProvider.createInstance()` with cloud-init userdata pointing at our config endpoint. **Same path as new VMs** — Cooper's design directive.
7. On success: UPDATE row with `provider_server_id`, `ip_address`. State stays `'thawing'`.
8. On failure: UPDATE row `freeze_state='thaw_pending'` (revert), release lock. Next tick retries.
9. Release lock. Return — cloud-init runs async.

**Stage 2: thawing → thawing_provisioned** (cloud-init done; ready for restore)
1. Polled by cron each tick. Condition: `freeze_state='thawing'` AND `cloud_init_callback_consumed_at > thaw_requested_at`. The cloud-init callback handler is unchanged (`app/api/vm/cloud-init-callback/route.ts`) — it sets `cloud_init_callback_consumed_at` regardless of fresh-provision vs thaw context.
2. Acquire lock.
3. Re-read. Verify `freeze_state='thawing'`. Verify cloud-init callback timestamp.
4. CAS UPDATE: `freeze_state='thawing_provisioned'`.
5. Release lock. (Restore in the next stage.)

**Stage 3: thawing_provisioned → idle** (restore archive + verify)
1. Acquire lock.
2. Re-read. Verify `freeze_state='thawing_provisioned'`.
3. SSH connect to new VM.
4. `systemctl --user stop gbrain` (safe — fresh VM has empty PGLite from base snapshot).
5. `rm -rf ~/.gbrain/brain.pglite` (delete base-snapshot's empty version).
6. Download `frozen_archive_path` from R2.
7. Decrypt outer tar via `lib/freeze-encryption:decrypt(buffer, manifest.encryption_key_id)`.
8. Parse outer tar (ustar): manifest.json, brain.pglite.tar.gz, user-state.tar.gz.
9. Verify sha256 of each inner blob against `manifest.inner.{brain_pglite_sha256, user_state_sha256}`. Mismatch → P0 alert, halt.
10. scp brain.pglite.tar.gz to VM. `tar xzf` over `~/.gbrain/`. [STUB: actual gbrain auto-detect of restored data dir is unverified until snapshot_brain ships and produces a real archive — see §17.7.]
11. scp user-state.tar.gz to VM. `tar xzf -C $HOME`. Regular files (workspace, sessions, .env, wallet) — no special handling.
12. `systemctl --user start gbrain`. Poll `/health=200` for up to 60s.
13. Verify with authenticated `put_page` + `get_page` MCP round-trip (Cooper's standard for any brain operation).
14. Version-gap-aware rewire (§17.4) — bring config + system state to current.
15. CAS UPDATE: `status='assigned'`, `health_status='healthy'`, `freeze_state='idle'` (NULL also acceptable; treat as semantically equivalent), `frozen_at=null`. **Do NOT clear `frozen_archive_path`** — keep for 30-day post-thaw retention (Q2).
16. Lifecycle log entry: `action='thawed'`, `reason='archive_path=<...>; gap=<N>; rewire=<scope>'`.
17. Release lock.

### 17.4 Version-gap-aware rewire (Q8 PRD §15.7 step 9)

Computed once at the top of Stage 3:
```
version_gap = VM_MANIFEST.version - frozen_archive_manifest.source_manifest_version
```

Three tiers (locked Q8):
- `gap ≤ 10`: stepFiles + stepGatewayRestart (~30s).
- `10 < gap ≤ 30`: stepFiles + stepConfigSettings + stepGatewayRestart (~90s).
- `gap > 30`: full reconcile path — stepSystemPackages + stepFiles + stepConfigSettings + stepSkills + stepGatewayRestart (~5 min).

If `source_manifest_version` is missing (e.g., older archive predates the field), treat as gap=∞ → full reconcile.

### 17.5 Stuck-state recovery (mirrors Phase 3 pattern)

Two mid-states can be stranded:

**Stuck `thawing`** — a previous cron tick provisioned Linode but didn't reach `thawing_provisioned`. Or didn't provision at all (network failure mid-call).
Recovery (top of GET, before normal candidate query):
- Query: `freeze_state='thawing' AND updated_at < now() - lock_TTL`.
- If `provider_server_id IS NULL`: never provisioned. Revert to `'thaw_pending'`. Next tick retries from Stage 1.
- If `provider_server_id IS NOT NULL`: probe Linode.
  - Linode 404: instance gone. Revert to `'thaw_pending'` AND clear `provider_server_id`. Retry from Stage 1.
  - Linode running + cloud-init callback already consumed: advance to `'thawing_provisioned'` (next tick will do Stage 3).
  - Linode running + no callback yet: leave alone; cloud-init may still be in flight.
  - Linode in transient error state (`other`, 5xx): leave alone, retry next tick.

**Stuck `thawing_provisioned`** — restore step failed mid-flight (SSH crashed, sha256 mismatch, gbrain wouldn't start).
Recovery:
- Query: `freeze_state='thawing_provisioned' AND updated_at < now() - lock_TTL`.
- Acquire lock.
- SSH probe. If reachable, re-run Stage 3 from scratch (extracts overwrite). If unreachable for 3 consecutive retries, P0 alert ("thaw blocked on unreachable VM").

### 17.6 Resub-mid-thaw race

The thaw cron holds the per-VM lock during each stage. If the user cancels their sub mid-thaw:
- Stripe webhook for `subscription.deleted` tries to update the row, but doesn't need the lock (it's just metadata writes).
- The downstream cron (`vm-lifecycle` past_due Pass 3 in 7-day grace) eventually sets `health_status='suspended'`.
- Then the archive cron archives the new VM (which has just-restored data).
- Then the freeze cron freezes again after 3-day grace.

Net: the user gets a brief active VM, then gets re-frozen along the normal path. **No mid-thaw abort logic needed.** The cost is ~5 days of Linode billing for a paid-then-immediately-cancelled customer. Bounded and rare; not worth the complexity of aborting in-flight.

### 17.7 Stubs (gbrain-dependent verifications)

Three places where the Phase 4 cron has "code that will need verification once snapshot_brain ships":

1. **brain.pglite tar extract** (Stage 3, step 10). The extract is a standard `tar xzf` — code works. But verifying that gbrain correctly auto-loads the restored data dir requires a real archive produced by `snapshot_brain` (not yet shipped). Until then, the extract code path is correct-by-construction but unverified end-to-end.
2. **`put_page` + `get_page` round-trip** (Stage 3, step 13). Cooper's standard verification. Will work the moment gbrain MCP responds — already-proven mechanism from our 2026-05-16 vm-050 work.
3. **`source_manifest_version` defaulting** (§17.4 gap calc). Manifest.json schema includes the field, but if an archive was produced by a future gbrain `snapshot_brain` that doesn't populate it, we fall back to "treat as gap=∞ → full reconcile." Defensive.

These are NOT throw-stubs (like Phase 2's `callSnapshotBrain`). They're code that runs, but Cooper's directive "stub it like Phase 2 stubs" applies to the brain-specific verification — we don't ASSERT that gbrain loaded the data successfully, just that it responded to `/health=200`. The full snapshot_brain↔restore round-trip verification (write data, snapshot, restore, read same data) is a post-Esmeralda integration test.

### 17.8 Failure mode matrix (new for thaw)

| Failure | Detection | Recovery |
|---|---|---|
| Linode provision fails | linodeProvider throws | Revert state to `thaw_pending`. Next tick retries. Alert after 3 consecutive failures (operator investigates Linode account quota / region capacity). |
| Cloud-init never callbacks | `cloud_init_callback_consumed_at` stays null for >20 min after `thaw_requested_at` | Stuck-state recovery (§17.5) catches via timestamp comparison. Eventually times out → P0 alert. |
| R2 download fails | `getObject` throws | Stage 3 aborts; lock released; state stays `thawing_provisioned`; next tick retries. After 3 failures, P0 alert (R2 outage or corrupted archive). |
| Decryption fails (sha256 mismatch or auth-tag failure) | `decrypt` throws `DecryptError`; sha256 verify fails on inner blobs | P0 alert ("archive corrupt for user X"). Halt this row. Do NOT auto-retry — corrupt archive can't be auto-fixed. Operator investigates: maybe an older generation in R2 (we keep 3) is valid; thaw from there. |
| Outer tar parse fails | `buildOuterTar` inverse fails | Same as decryption fail. P0 alert. |
| gbrain won't start after restore | `/health` never returns 200 within 60s poll | Try journal grep for the underlying error. Revert state to `'thawing_provisioned'` for re-attempt. After 3 attempts: P0 alert. |
| Terminal CAS UPDATE fails | Supabase write error | This IS reverse-zombie territory like freeze — Linode + restored data are correct, DB still says `thawing_provisioned`. P0 alert with manual-fix SQL embedded. |

### 17.9 Cron schedule + concurrency

**Schedule**: `*/5 * * * *` (every 5 min). Latency from webhook to active VM: ~5-10 min worst case.

**Concurrency caps**:
- `MAX_THAW_PROVISIONS_PER_RUN = 1` — provisioning is the slow step (~3-5 min). One per cron tick keeps function under maxDuration. Higher throughput available by lowering the cron interval.
- `MAX_THAW_RESTORES_PER_RUN = 2` — restore is fast (~30s); can do a couple per run.
- Both bounded so a run completes in ≤120s wall-clock even under worst-case Linode latency.

`maxDuration = 800` (Vercel Pro cap). Allows one slow provision + a couple restores + recovery passes.

### 17.10 vercel.json entry

Adding to the schedule list:

```json
{
  "path": "/api/cron/vm-thaw",
  "schedule": "*/5 * * * *"
}
```

Until archives exist (which requires gbrain shipping `snapshot_brain`), the candidate query returns empty and every cron tick is a no-op. Safe to wire from day one — no destructive operations gate on data we don't have.

### 17.11 What this completes

After Phase 4 ships and gbrain ships `snapshot_brain`:
- Full freeze→thaw lifecycle: archive (every 6h) → freeze (eligible after grace) → thaw (on resub).
- `$1,479/mo leak` from 2026-05-15 is structurally closed.
- New cancellations enter the pipeline → fresh archives → frozen → resub thaws back.

The vm-freeze-v2 build-out is complete.

---
