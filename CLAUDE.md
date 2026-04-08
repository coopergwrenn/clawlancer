# InstaClaw — Project Notes

## Quick Commands

- **"spots N"** or **"provision N VMs"** — Provision N new dedicated CPU VMs for the ready pool. Use the exact specs below. NEVER deviate.

## VM Provisioning Standard (MANDATORY)

ALL new VMs must use these exact specs:

- **Provider:** Linode ONLY (never Hetzner or DigitalOcean)
- **Type:** `g6-dedicated-2` (Dedicated 4GB — 2 dedicated vCPU, 4GB RAM, 80GB disk)
- **Region:** `us-east`
- **Snapshot:** `private/38069990` (instaclaw-base-v57-all-crons — OpenClaw v2026.4.5, all v57 scripts + 7/7 crons + gateway-watchdog v5 + 300s lock windows + exec-approvals.json + x11vnc service + memory filing system. Chromium, ffmpeg, Xvfb, x11vnc, websockify, node_exporter, jq, both SSH deploy keys. 21/21 verified.)
- **Cost:** $29/mo per VM (negotiated Linode rate)
- **DB status:** `provisioning` (cloud-init-poll cron auto-marks as `ready` in ~3-5 min)

NEVER use old snapshots (private/36895419 or private/38054012). NEVER provision shared CPU (g6-standard-2). NEVER provision on Hetzner or DigitalOcean.

## Project Structure

- `instaclaw/` — Next.js app (instaclaw.io)

## Key Info

- Git remote: https://github.com/coopergwrenn/clawlancer.git
- Branch: main
- Dev server: `npm run dev` from instaclaw/, runs on port 3001
- Production: https://instaclaw.io
- Admin email: coop@valtlabs.com

## Mandatory Rules

These are permanent rules. Never violate them.

### 1. Verify DB Schema Before Updates

NEVER add columns to a Supabase `.update()` call without first confirming the column exists on that table. Before adding any field, run:
```sql
select column_name from information_schema.columns where table_name = 'TABLE_NAME'
```
and confirm the column is present. The `consecutive_failures` bug happened because a column from one table was added to an update on a different table.

### 2. Verify Config Schema Before Changing Values

NEVER change an OpenClaw config value without checking the config validation/schema in the OpenClaw dist files on a VM. A runtime code path does NOT mean a value is accepted by the config schema validator. The `auth.mode: "none"` crash happened because the value exists in runtime code but is rejected by the config schema — crashing the gateway on startup.

### 3. Test on One VM Before Fleet-Wide Deploy

NEVER deploy a config change or patch to the entire fleet at once. Always:
1. Run on ONE VM first
2. Verify the gateway is active and health returns 200
3. Wait for manual confirmation before continuing to the rest

Fleet scripts must include a `--test-first` flag that patches one VM and pauses for approval.

### 4. Dry-Run Fleet Operations First

NEVER run a fleet operation without `--dry-run` first. All fleet scripts must support `--dry-run` and it must be run before the real execution. Review the dry-run output before proceeding.

### 5. Verify Gateway Health After Config Changes

After any config change + gateway restart via SSH, wait up to 30 seconds for the gateway to reach "active" state (`systemctl --user is-active openclaw-gateway` returns "active" AND health endpoint returns 200). If it doesn't come back:
1. REVERT the config change
2. Restart the gateway with the old config
3. Report the failure
Never leave a crash-looping gateway.

### 6. Snapshot Refresh After Manifest Bumps

Every time `VM_MANIFEST.version` is bumped in `vm-manifest.ts`, the base snapshot used for new VMs becomes stale. The reconciler fixes existing VMs automatically, but NEW VMs provisioned from the old snapshot start with outdated config until reconciler catches them.

**After every manifest version bump, STOP and tell Cooper:**

> "Manifest bumped to v{N}. The fleet reconciler will push this to existing VMs automatically. However, the base snapshot is now stale — new VMs provisioned from it won't have these changes until reconciler runs. Should we bake a new snapshot now, or wait until we've accumulated more changes?"

**When to bake a new snapshot:**
- After 3+ manifest bumps since last snapshot
- Before any large provisioning run (e.g., "spots 20")
- After major changes (new scripts, new crons, new workspace files, OpenClaw version upgrade)
- Cooper explicitly asks

NEVER provision a batch of VMs from a snapshot that's >3 manifest versions behind.

---

## Snapshot Creation Process (COMPLETE REFERENCE)

### Prerequisites

- `LINODE_API_TOKEN` in `.env.local` (or `.env.ssh-key`)
- `SSH_PRIVATE_KEY_B64` for SSH access to the bake VM
- SSH key ID `626767` (label: `instaclaw-deploy`) in Linode profile

### Step-by-Step Checklist

**1. Provision a fresh nanode from the CURRENT snapshot:**
```
POST https://api.linode.com/v4/linode/instances
{
  "label": "snapshot-bake-v{VERSION}",
  "region": "us-east",
  "type": "g6-nanode-1",
  "image": "{CURRENT_SNAPSHOT_ID}",
  "root_pass": "{RANDOM}",
  "authorized_keys": ["{SSH_KEY}"],
  "booted": true,
  "tags": ["instaclaw", "snapshot-bake"]
}
```
Wait for status=running. Note the IP address.

**2. SSH in and upgrade OpenClaw:**
```bash
source ~/.nvm/nvm.sh
npm install -g openclaw@latest
openclaw --version  # Verify latest
```

**3. Install/update system and Python packages:**
```bash
# pip may not be installed on base image
curl -sS https://bootstrap.pypa.io/get-pip.py | sudo python3 - --break-system-packages
python3 -m pip install --break-system-packages openai
```

**4. Extract and deploy manifest files from the codebase:**

The scripts, workspace files, and SOUL.md sections are embedded as template string constants in `lib/ssh.ts`, `lib/agent-intelligence.ts`, `lib/vm-manifest.ts`, and `lib/earn-md-template.ts`.

To extract them, run the extraction script from the project root:
```bash
node /tmp/extract-manifest-files.mjs .
```
This writes all files to `/tmp/snapshot-files/`. For `strip-thinking.py`, use Node.js `eval` to process `${...}` template expressions:
```javascript
// The regex extraction doesn't evaluate ${200 * 1024} expressions
// Use: eval('`' + templateBody + '`') to get the actual Python script
```

Then SCP the files to the bake VM and deploy:
- `~/.openclaw/scripts/` — strip-thinking.py, auto-approve-pairing.py, vm-watchdog.py, silence-watchdog.py, push-heartbeat.sh, generate_workspace_index.sh
- `~/scripts/` — deliver_file.sh, notify_user.sh
- `~/.openclaw/workspace/` — SOUL.md (built from components: base + intelligence supplement + learned preferences + memory filing system), MEMORY.md, CAPABILITIES.md, QUICK-REFERENCE.md, TOOLS.md, EARN.md
- `~/.openclaw/workspace/memory/` — session-log.md, active-tasks.md
- All scripts `chmod +x`

**5. Install cron jobs (7 total):**

| Schedule | Command | Marker |
|----------|---------|--------|
| `0 * * * *` | `ipcs -m ... SHM_CLEANUP` | SHM_CLEANUP (already in snapshot) |
| `* * * * *` | `python3 ~/.openclaw/scripts/strip-thinking.py` | strip-thinking.py |
| `* * * * *` | `python3 ~/.openclaw/scripts/auto-approve-pairing.py` | auto-approve-pairing.py |
| `* * * * *` | `python3 ~/.openclaw/scripts/vm-watchdog.py` | vm-watchdog.py |
| `0 * * * *` | `bash ~/.openclaw/scripts/push-heartbeat.sh` | push-heartbeat.sh |
| `* * * * *` | `python3 ~/.openclaw/scripts/silence-watchdog.py ...; sleep 30 && ...` | silence-watchdog.py |
| `0 4 * * *` | `/home/openclaw/.nvm/.../openclaw memory index` | openclaw memory index |

Use marker-based idempotent install: check `crontab -l | grep -q "MARKER"` before adding.

**6. Clean caches aggressively:**
```bash
source ~/.nvm/nvm.sh && npm cache clean --force
sudo apt-get clean && sudo rm -rf /var/lib/apt/lists/*
python3 -m pip cache purge; sudo rm -rf /root/.cache/pip ~/.cache/pip
rm -rf /tmp/* ~/.nvm/.cache
sudo journalctl --vacuum-time=1d
sudo rm -rf /var/log/*.gz /var/log/*.1 /var/log/*.old
```

**7. Run 15-point verification (ALL must pass):**

| # | Check | Command |
|---|-------|---------|
| 1 | OpenClaw installed | `openclaw --version` |
| 2 | Node.js v22 | `node --version \| grep v22` |
| 3 | Chromium | `test -x /usr/local/bin/chromium-browser` |
| 4 | ffmpeg | `which ffmpeg` |
| 5 | jq | `which jq` |
| 6 | node_exporter | `which node_exporter` |
| 7 | Xvfb + x11vnc + websockify | `which Xvfb && which x11vnc && which websockify` |
| 8 | exec-approvals.json (security=full) | `cat ~/.openclaw/exec-approvals.json \| python3 -c "..."` |
| 9 | SSH deploy keys (≥2) | `wc -l < ~/.ssh/authorized_keys` |
| 10 | loginctl linger enabled | `loginctl show-user openclaw \| grep Linger=yes` |
| 11 | strip-thinking.py has session-end hook | `grep -q run_session_end_hook ~/.openclaw/scripts/strip-thinking.py` |
| 12 | SOUL.md has memory filing system | `grep -q MEMORY_FILING_SYSTEM ~/.openclaw/workspace/SOUL.md` |
| 13 | memory/session-log.md exists | `test -f ~/.openclaw/workspace/memory/session-log.md` |
| 14 | memory/active-tasks.md exists | `test -f ~/.openclaw/workspace/memory/active-tasks.md` |
| 15a | Cron: strip-thinking.py | `crontab -l \| grep -q "strip-thinking.py"` |
| 15b | Cron: auto-approve-pairing.py | `crontab -l \| grep -q "auto-approve-pairing.py"` |
| 15c | Cron: vm-watchdog.py | `crontab -l \| grep -q "vm-watchdog.py"` |
| 15d | Cron: push-heartbeat.sh | `crontab -l \| grep -q "push-heartbeat.sh"` |
| 15e | Cron: silence-watchdog.py | `crontab -l \| grep -q "silence-watchdog.py"` |
| 15f | Cron: openclaw memory index | `crontab -l \| grep -q "openclaw memory index"` |
| 15g | Cron: SHM cleanup | `crontab -l \| grep -q "SHM_CLEANUP"` |

**CRITICAL: ALL 7 crons (15a-15g) must be present.** Missing crons caused a P0 incident on 2026-04-08 where sessions grew to 4MB+ and burned credits 20x faster (see commit 68e9e4c). The reconciler does NOT catch missing crons on freshly configured VMs — configureOpenClaw() now installs them, but they must also be in the snapshot as defense-in-depth.

**8. Check disk usage — MUST be under 5.9GB:**
```bash
df -h / | tail -1
# Used must be < 5.9GB. Image limit is 6144MB.
# If over, clean more aggressively: rm -rf ~/.cache, check /usr/local for bloat
```

**9. Power off VM cleanly:**
```
POST /v4/linode/instances/{ID}/shutdown
```
Poll until status=offline. **DO NOT delete SSH host keys or machine-id** — cloud-init regenerates them on first boot.

**10. Create image:**
```
# Get disk ID (ext4 disk, not swap)
GET /v4/linode/instances/{ID}/disks

# Create image
POST /v4/images
{
  "disk_id": {DISK_ID},
  "label": "instaclaw-base-v{VERSION}-{description}",
  "description": "OpenClaw {version} + {changes}. 15/15 verified."
}
```
Poll `GET /v4/images/{IMAGE_ID}` until status=available. Verify size < 6144MB.

**11. Update all references:**
- `CLAUDE.md` — snapshot ID and description in "VM Provisioning Standard"
- `.env.local` — `LINODE_SNAPSHOT_ID="private/{NEW_ID}"`
- `reference_vm_provisioning.md` (project memory) — snapshot ID + contents list
- `MEMORY.md` (project memory) — snapshot ID
- **Vercel environment variables** — Cooper must update `LINODE_SNAPSHOT_ID` in Vercel dashboard

**12. Clean up:**
- Delete the temp nanode: `DELETE /v4/linode/instances/{ID}`
- Keep the OLD snapshot for 1 week as rollback
- After 1 week with no issues, delete the old snapshot

### Snapshot Gotchas (Lessons Learned)

- **6144MB hard limit** — Linode images over this silently fail. Current images are ~5.8GB. Always check `df -h` before imaging.
- **DO NOT delete SSH host keys or machine-id** — cloud-init regenerates these on first boot from snapshot. Deleting them before imaging breaks SSH access on deployed VMs.
- **DO NOT use ready-pool VMs as the base** — they were provisioned from the OLD snapshot and may have inconsistent state from partial reconciler runs, failed health checks, or stale cron output. Always provision a FRESH nanode from the current snapshot.
- **Always use a nanode (g6-nanode-1)** for baking — 25GB disk keeps the image small. Dedicated-2 VMs have 80GB disks which produce larger images that may exceed the 6144MB limit.
- **Template string extraction needs eval** — scripts like strip-thinking.py use JavaScript template expressions (`${200 * 1024}`) that must be evaluated by Node.js, not extracted as raw text.
- **strip-thinking.py modifies all session files** — it touches every .jsonl file on every run (strips thinking blocks), which equalizes their mtimes. The session-end hook uses sessions.json session IDs for transition detection, NOT file modification times.
- **OpenClaw caches MEMORY.md at session creation** — changes to MEMORY.md during an active session are NOT visible until the next session starts. This is by design for cross-session memory.
- **Image creation takes ~5 minutes** — poll status every 20 seconds. Size field shows disk size (25088MB) during creation, then actual image size after completion.
- **Old images can pile up** — Linode had 196 orphaned images (2TB) from deleted VMs. Periodically audit with `GET /v4/images` and delete unused ones.
