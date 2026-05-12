# Memory Backup — Setup, Status, Roadmap

**Status:** v0 shipped. Local-only encrypted snapshots, 24-hour rolling retention. S3 upload is the v1 follow-up; user-owned keys is v2.
**Date:** 2026-05-12
**PRD context:** Edge strategy doc Bet #3 (Privacy Mode is the trust narrative). Step 7 of `instaclaw/docs/prd/matching-engine-competitive-research-2026-05-11.md` §5.2.

---

## What v0 does today

Per-VM bash script (`instaclaw/scripts/backup-memory.sh`) that hourly:

1. Tars `~/.openclaw/workspace/` + `~/.openclaw/sessions/`.
2. Encrypts with AES-256-CBC + PBKDF2 (100K iter) keyed on the VM's `GATEWAY_TOKEN`.
3. Writes to `~/.openclaw/backups/<timestamp>.tar.gz.enc`.
4. Sweeps backups older than 24h via `find -mmin +1440 -delete`.
5. Logs to `~/.openclaw/backup.log`.

What it **does** deliver:
- Encryption-at-rest. The plaintext is never on disk after the script runs (the unencrypted `.tar.gz` intermediate is deleted before the script exits).
- Bounded disk footprint (~120 MB worst case at 24 hourly files × 5 MB).
- Idempotent re-runs.
- Logged failures (no silent drops).

What it **does NOT** deliver:
- Off-VM durability — if the VM dies, the local backups die with it. (Fixed by v1.)
- User-owned keys — `GATEWAY_TOKEN` is InstaClaw-issued, so a motivated operator could decrypt. (Fixed by v2.)

**This is honest about the trust narrative**: v0 is "encryption at rest"; v2 is "we genuinely can't decrypt your backups."

---

## Restore (v0)

`instaclaw/scripts/_restore-memory.sh BACKUP_FILE [TARGET_DIR]`

Reads `GATEWAY_TOKEN` from `~/.openclaw/.env` (or env override), decrypts, untars to `TARGET_DIR` (default: `/tmp/openclaw-restore-<ts>`). Does NOT overwrite the live workspace — that's manual after inspection.

```bash
# List available local backups
ls -la ~/.openclaw/backups/

# Restore one to /tmp/inspect
bash ~/.openclaw/scripts/_restore-memory.sh ~/.openclaw/backups/2026-05-12T03-00-00Z.tar.gz.enc

# Inspect what was restored
ls -la /tmp/openclaw-restore-*/workspace/
diff -r /tmp/openclaw-restore-*/workspace/ ~/.openclaw/workspace/

# If looks good, manually overwrite live state (destructive)
cp -a /tmp/openclaw-restore-*/workspace/. ~/.openclaw/workspace/
```

---

## Wiring v0 to the fleet (NOT done in this PR)

The backup script lands in the repo at `instaclaw/scripts/backup-memory.sh` but is **not yet wired to vm-manifest.ts**. Reason: other terminals are actively modifying `vm-manifest.ts` (gbrain rollout, reconciler step ordering); a same-file edit from this PR would conflict.

To wire it (next session, or another terminal):

1. Add `backup-memory.sh` to `VM_MANIFEST.files` so the reconciler deploys it to `~/.openclaw/scripts/backup-memory.sh` on every VM. Pattern is the same as `strip-thinking.py` / `push-heartbeat.sh`.

2. Add a cron entry to install on each VM:
   ```cron
   0 * * * * bash ~/.openclaw/scripts/backup-memory.sh >/dev/null 2>&1
   ```
   Pattern is the same as the existing cron entries enumerated in `CLAUDE.md` ("Snapshot Creation Process" → "Install cron jobs").

3. Once both land, the next reconciler tick deploys the script + installs the cron on every VM. The hourly backup starts on the next `0 * * * *` boundary.

Verification after fleet rollout:
```bash
# On any deployed VM:
ssh -i <key> openclaw@<ip> 'ls -la ~/.openclaw/backups/'
ssh -i <key> openclaw@<ip> 'tail ~/.openclaw/backup.log'
```

---

## v1: S3 upload via per-call presigned URLs (next PR)

**Problem v1 solves:** VM dies → backups die with it.

**Design:**

1. **New backend endpoint** `POST /api/match/v1/backup/presign`:
   - Auth: `gateway_token` Bearer
   - Body: `{filename, size_bytes}`
   - Returns: `{presigned_url, expires_at}` (5-min validity)
   - Backend signs the URL with InstaClaw's IAM credentials, scoped to `s3://${BUCKET}/${vm_id}/<filename>`. Per-VM prefix isolation means a compromised gateway_token only exposes that VM's backups.

2. **Per-VM script** (extend `backup-memory.sh`):
   - After encrypting, POST to `/api/match/v1/backup/presign` to obtain a presigned URL.
   - `curl -X PUT --data-binary @<enc_file>` to the presigned URL.
   - Local copy retained (rolling 24-hour); S3 has its own lifecycle policy for longer retention.

3. **S3 bucket setup (Cooper):**
   - Bucket: e.g. `instaclaw-memory-backups-us-east-1`
   - Versioning: enabled (defense-in-depth against accidental delete)
   - Lifecycle: hourly → 30-day rolling; daily snapshot kept for 1 year; weekly forever
   - Server-side encryption: SSE-S3 (AES-256, AWS-managed keys — defense-in-depth on top of our client-side encryption)
   - IAM policy (backend-only, no VM-side credentials):
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Action": ["s3:PutObject", "s3:GetObject"],
         "Resource": "arn:aws:s3:::instaclaw-memory-backups-us-east-1/*"
       }]
     }
     ```
   - IAM access key + secret stored in Vercel env (`AWS_BACKUP_BUCKET_ACCESS_KEY_ID`, `AWS_BACKUP_BUCKET_SECRET_ACCESS_KEY`, `AWS_BACKUP_BUCKET_REGION`, `AWS_BACKUP_BUCKET_NAME`).

4. **Restore CLI update:**
   - Add `--from-s3 <vm_id> [timestamp]` mode that downloads from S3 then runs the existing decrypt + untar.

**Estimated effort:** 1 day (presign endpoint + script extension + Cooper's AWS setup).

---

## v2: User-owned age keypair (post-Edge)

**Problem v2 solves:** "Trust narrative" is partially marketing — v0/v1 keys are InstaClaw-derivable. v2 makes the claim cryptographically meaningful.

**Design:**

1. **At VM provisioning:**
   - Generate an `age` keypair (`age-keygen` produces public + private).
   - Public key stored in `instaclaw_vms.backup_public_key`.
   - Private key emailed once to the user's verified email at signup.
   - Private key also written to `~/.openclaw/keys/backup-private.age` (file mode 0600, openclaw-user only). The user can opt to delete this VM-side copy after backing up the email.

2. **Backup script:** encrypts with `age -r <public_key>` (public-key crypto — even the VM doesn't have the private key after the user deletes the local copy).

3. **Restore script:** requires the user's private key (from email or VM-side copy). InstaClaw operators CANNOT decrypt v2 backups without that key.

4. **Backwards compat:** v2 backups are tagged `.tar.gz.age` (different extension); restore script auto-detects v0/v1 (`.enc`) vs v2 (`.age`) and uses the right key.

**Estimated effort:** 2-3 days (key generation flow + email delivery + age library integration + docs).

**Why post-Edge:** v0 is good enough for Edge Esmeralda 2026. v2's user-owned key flow needs user-facing UX work (email delivery, key recovery messaging) that's not on the May 30 critical path.

---

## File reference

| File | Description |
|---|---|
| `instaclaw/scripts/backup-memory.sh` | Per-VM hourly backup. v0 ships in this PR. |
| `instaclaw/scripts/_restore-memory.sh` | Decrypt + untar a single backup. v0 ships in this PR. |
| `instaclaw/lib/vm-manifest.ts` | NOT touched in this PR. Wiring is a follow-up. |
| `instaclaw/docs/memory-backup-setup.md` | This file. |

---

## What you (Cooper) need to do next

**For v0 to actually run on the fleet:**
1. Add `backup-memory.sh` to `VM_MANIFEST.files` + a `0 * * * *` cron entry. Either you or another terminal touching `vm-manifest.ts` should land it.
2. Reconciler picks up the change on next tick; cron starts firing within an hour.

**For v1 (S3 upload):**
1. Create S3 bucket + lifecycle + IAM as documented above.
2. Add the 4 env vars to Vercel.
3. I'll ship the presign endpoint + script extension in the next PR.

**For v2 (user-owned keys):**
1. Decide on email delivery mechanism for the private key (existing transactional email infra fine).
2. I'll ship the keypair generation + age integration when you're ready.

No action items are blocking — v0 already gives you "encryption at rest." Each layer adds a real privacy guarantee on top of the previous.
