# Snapshot Bake v101 — May 23-25 — Checklist

**Status:** PLAN. Bake window 2026-05-23 → 2026-05-25. Esmeralda go-live 2026-05-30.
**Target snapshot label:** `instaclaw-base-v101-2026-05-23-gbrain-http` (or similar dated label)
**Predecessor snapshot:** `private/38575292` (current `LINODE_SNAPSHOT_ID`)
**Rollback window:** keep `private/38575292` available for 1 week after v101 ships (2026-06-01 minimum)
**Single biggest delta vs v79:** gbrain v0.35.0.0 HTTP sidecar pre-installed

This document is the operational checklist FOR the May 23-25 bake. The general process lives in CLAUDE.md "Snapshot Creation Process (COMPLETE REFERENCE)". This doc adds: the specific changes since v79, the new gbrain verification, pre-bake validation gates, rollback playbook, and a per-step time estimate.

---

## §0 — Why this bake

1. **gbrain HTTP sidecar architecture** (Rule 35, 2026-05-15 canary) — new VMs from v79 boot with NO gbrain. Esmeralda attendees would hit the stdio cold-start (90+ s) or the missing-skill path on every memory-related agent invocation. **v101 fixes this for every new attendee VM provisioned from snapshot.**
2. **Rule 47 (continuous reconciliation)** — file-only changes (strip-thinking.py, install-gbrain.sh, verify-gbrain-mcp.py) propagate via `stepFiles` to reconciler-touched VMs, but NOT to VMs that boot fresh from snapshot and never reach the cv-stale candidate set. Baking forces these into the baseline.
3. **Manifest version drift since v79** — multiple version bumps (v82, v86, v87, v88, v96, v97, v99, v100) haven't been re-baked into the snapshot per Rule 7. Reconciler is the safety net but accumulating drift is costly.

## §1 — What's NEW in v101 vs v79

Material changes that justify the bake (in delta order — most important first):

| Component | v79 state | v101 state | Source |
|---|---|---|---|
| **gbrain** | not installed | v0.35.0.0 (commit baf1a47) at `~/gbrain`, bun installed, `bun link`'d, systemd unit installed (NOT started), fresh PGLite at schema v66, NO bearer token (per-VM mint at first reconcile) | Rule 35; `scripts/install-gbrain.sh` |
| **OpenClaw** | 2026.4.26 | latest stable (TBD at bake time — re-pin at start) | `lib/vm-manifest.ts:OPENCLAW_PINNED_VERSION` |
| **VM manifest** | v79 | v101 baseline (orphan-tool_use repair landed 2026-05-16 via commit `48af5075`; superseded earlier v100 plan) | `lib/vm-manifest.ts:VM_MANIFEST.version` |
| **Session-backup runaway** | broken (Rule 45 unfixed) | fixed in strip-thinking.py via cooldown + per-session cap | `lib/ssh.ts:STRIP_THINKING_SCRIPT` |
| **TasksMax** | 75 | 120 (v86) | systemd override |
| **prctl-subreaper** | absent | v0.1.1 installed (v87) | npm + systemd drop-in |
| **systemd KillSignal** | (unit absent for gbrain) | SIGKILL for gbrain.service (Rule 35 IR finding 2026-05-16) | install-gbrain.sh Phase E5 |
| **Snapshot disk usage** | ~5.8 GB | ~6.0 GB target (gbrain adds ~150 MB: ~30 MB repo + ~120 MB node_modules + ~5 MB fresh PGLite) — **must stay <6144 MB Linode hard limit** | df check at step 8 |

## §2 — Pre-bake gates (BEFORE provisioning the bake VM)

All must pass. If any fail, **do not start the bake** — fix first.

### §2.1 — Canary install proven on a real VM
- [x] vm-050 — proof-of-concept canary, HTTP sidecar live since 2026-05-15
- [x] vm-354 — bare-VM install via canonical `install-gbrain.sh` path, completed 2026-05-16 at 17:18 UTC, INSTALL_COMPLETE in 75s + 69s post-install probe + 63 gbrain__ tools live
- [ ] **vm-354 30-min soak verification complete** (5 checks: service active, bearer hash match, schema v66, put_page/get_page round-trip, openclaw.json transport=streamable-http) — gates the bake

### §2.2 — Install script bug-fixes landed in main
- [x] commit `5d69baeb` (HTTP sidecar architecture)
- [x] commit `aaded493` (regex anchor + stderr capture bugfixes caught on vm-354)

### §2.3 — Pre-bake verifications on the existing snapshot

Run before provisioning the bake VM:
```bash
# Confirm current snapshot ID
grep LINODE_SNAPSHOT_ID instaclaw/.env.local
# Should match CLAUDE.md "VM Provisioning Standard" value (private/38575292 as of 2026-05-12)

# Confirm we have a stable install-gbrain.sh
cd /Users/cooperwrenn/wild-west-bots/instaclaw
bash -n scripts/install-gbrain.sh && echo "syntax OK"
python3 -m py_compile scripts/verify-gbrain-mcp.py && echo "syntax OK"

# Confirm pinned constants are aligned
grep "GBRAIN_PINNED_" lib/vm-reconcile.ts | head -2
grep "GBRAIN_PINNED_" scripts/_install-gbrain-on-vm.ts | head -2
# All must show: COMMIT=baf1a47 VERSION=0.35.0.0
```

### §2.4 — Anthropic project-key spending cap
- [ ] Confirm `$300/mo` cap on the `GBRAIN_ANTHROPIC_API_KEY` project key at console.anthropic.com (Cooper action; per May-12 PRD §5.1)

### §2.5 — No in-flight critical alerts
- [ ] Confirm no P0/P1 alerts in `instaclaw_admin_alert_log` for the last 24h
- [ ] Confirm reconcile-fleet cron is running cleanly (last 3 cycles successful, no quarantined VMs added in last 24h)

### §2.6 — Run the pre-bake-check script (automated go/no-go)
- [ ] `npx tsx scripts/_pre-bake-check.ts` returns exit 0 (or all CRITICAL blockers explicitly understood and accepted)

The script verifies every §2 gate above plus:
  - HEAD aligned with origin/main (Rule 12 — must not bake against stale code)
  - LINODE_SNAPSHOT_ID matches expected source snapshot
  - `GBRAIN_PINNED_*` aligned between `lib/vm-reconcile.ts` and `scripts/_install-gbrain-on-vm.ts`
  - install-gbrain.sh + verify-gbrain-mcp.py parse cleanly
  - Linode API reachable
  - Supabase reachable
  - Fleet cv distribution (warns if >20% of VMs at cv ≤ manifest-2)
  - No quarantined VMs (watchdog OR reconcile-step)
  - No stale cron locks (>2h)
  - No STALE_BUNDLE alerts in 24h (Vercel cache freshness, P1-4 integrity check)
  - No ENOSPC alerts in 24h (Rule 37)
  - No VMs with `last_disk_pct ≥ 80%` (Rule 46)
  - gbrain edge_city coverage 100% (Rule 35) — surfaces specific missing VMs

See `§11` below for the script's findings as of 2026-05-16.

---

## §3 — The bake (May 23, ~3-4 hours wall-clock)

Follows CLAUDE.md "Snapshot Creation Process" with v101-specific overrides marked **[v101]**.

### §3.1 — Provision the bake VM (15 min)

```bash
# Linode API — provision g6-nanode-1 from current snapshot
# Use g6-nanode-1 (NOT g6-dedicated-2) per CLAUDE.md — 25GB disk keeps image small
curl -X POST -H "Authorization: Bearer $LINODE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "label": "snapshot-bake-v101",
    "region": "us-east",
    "type": "g6-nanode-1",
    "image": "private/38575292",
    "root_pass": "<random>",
    "authorized_keys": ["<SSH_KEY>"],
    "booted": true,
    "tags": ["instaclaw", "snapshot-bake"]
  }' \
  https://api.linode.com/v4/linode/instances
```

Wait for status=running. Note the IP. SSH in as `openclaw`. Verify base state matches expected (gbrain NOT installed, V=missing per the four-state check).

### §3.2 — Upgrade OpenClaw + system packages (10 min)

Per CLAUDE.md step 2:
```bash
source ~/.nvm/nvm.sh
npm install -g openclaw@latest
openclaw --version  # confirm latest
```

Install/update system packages per CLAUDE.md step 3 if needed.

### §3.3 — Extract + deploy manifest files (15 min)

Per CLAUDE.md step 4. Run `node /tmp/extract-manifest-files.mjs .` from project root to get all manifest files to `/tmp/snapshot-files/`, then SCP to the bake VM.

### §3.4 — Install all crons (5 min)

Per CLAUDE.md step 5. All 7 cron jobs must be present. **[v101]** No new crons added for gbrain — gbrain.service is a systemd unit, not a cron.

### §3.5 — **[v101 NEW]** Install gbrain HTTP sidecar (~80s)

**This is the headline change for v101.** Run the canonical install path:

```bash
# From local laptop (not on the bake VM):
cd /Users/cooperwrenn/wild-west-bots/instaclaw
# Bake VM doesn't have a DB row — bypass DB pre-flight by SSHing directly
BAKE_VM_IP="<from step 3.1>"
scp -i $SSH_KEY scripts/install-gbrain.sh scripts/verify-gbrain-mcp.py \
  openclaw@$BAKE_VM_IP:/tmp/

ssh -i $SSH_KEY openclaw@$BAKE_VM_IP \
  "GBRAIN_PINNED_COMMIT=baf1a47 GBRAIN_PINNED_VERSION=0.35.0.0 bash /tmp/install-gbrain.sh"
```

Watch for `INSTALL_COMPLETE`. Expected output:
```
PHASE_A_OK ... existing: V=missing T= S=missing P=0
PHASE_B_OK bun=<version>
PHASE_C_OK head=baf1a47 path=/home/openclaw/gbrain
PHASE_D_OK gbrain=0.35.0.0 ...
PHASE_E_OK bearer_prefix=gbrain_... main_pid=... port=127.0.0.1:3131
PHASE_F_OK tools=<≥40> ext_refused=yes loopback_health=200
PHASE_G_OK transport=streamable-http gw_health=200 hot_reload_hits=<≥0>
PHASE_H_OK RESULT_OK marker_ts=... put_tool=put_page retrieve_tool=get_page tools_count=<≥40>
INSTALL_COMPLETE
```

**[v101 GATE]** If install fails, stop. Investigate. Bake is not gateable until install completes cleanly on the bake VM.

### §3.6 — Strip the bake-VM-specific bearer token from the snapshot

**Critical:** the bearer token minted on the bake VM is per-VM and MUST NOT propagate to other VMs via the snapshot. Per-VM mint happens at first reconcile via stepGbrain.

```bash
ssh openclaw@$BAKE_VM_IP <<'EOF'
# Wipe the per-VM bearer token + access_tokens row
rm -f ~/.gbrain/openclaw-bearer-token.txt
rm -f ~/.gbrain/openclaw-bearer-token.txt.*
# Empty the access_tokens table (sidecar must be stopped first to release PGLite lock)
systemctl --user kill --signal=SIGKILL gbrain.service
systemctl --user stop gbrain.service
cd ~/gbrain
bun -e "
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite('/home/openclaw/.gbrain/brain.pglite');
await db.waitReady;
await db.query('DELETE FROM access_tokens');
console.log('access_tokens cleared');
await db.close();
"
# Also clear the marker page from Phase H verify
bun -e "
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite('/home/openclaw/.gbrain/brain.pglite');
await db.waitReady;
await db.query(\"DELETE FROM pages WHERE slug = '_gbrain-install-verify'\");
console.log('marker page cleared');
await db.close();
"
# Leave gbrain.service stopped — first boot will start it, but it needs the per-VM token first
# Actually: leave service stopped + disabled so configureOpenClaw can run its mint+flip flow
systemctl --user disable gbrain.service
# Also strip the openclaw.json mcp.servers.gbrain entry (will be re-added per-VM)
TS=$(date -u +%Y%m%dT%H%M%SZ)
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.pre-bake-strip-$TS.bak
jq 'del(.mcp.servers.gbrain)' ~/.openclaw/openclaw.json > /tmp/openclaw.json.stripped
mv /tmp/openclaw.json.stripped ~/.openclaw/openclaw.json
chmod 600 ~/.openclaw/openclaw.json
EOF
```

**Verify the strip:**
```bash
ssh openclaw@$BAKE_VM_IP "
  echo '--- bearer token file (should be absent) ---'
  ls ~/.gbrain/openclaw-bearer-token.txt 2>&1
  echo '--- mcp.servers.gbrain (should be null) ---'
  jq '.mcp.servers.gbrain // \"absent\"' ~/.openclaw/openclaw.json
  echo '--- gbrain.service state (should be inactive + disabled) ---'
  systemctl --user is-active gbrain.service
  systemctl --user is-enabled gbrain.service
  echo '--- access_tokens row count (should be 0) ---'
  cd ~/gbrain
  bun -e \"import {PGlite} from '@electric-sql/pglite'; const db=new PGlite('/home/openclaw/.gbrain/brain.pglite'); await db.waitReady; const r=await db.query('SELECT count(*) FROM access_tokens'); console.log(r.rows[0]); await db.close();\"
"
```

Expected: file absent, gbrain entry absent, service inactive + disabled, access_tokens count 0.

### §3.7 — Clean caches (5 min)

Per CLAUDE.md step 7. Aggressive cleanup to stay under 6144 MB image limit.

```bash
ssh openclaw@$BAKE_VM_IP <<'EOF'
source ~/.nvm/nvm.sh && npm cache clean --force
sudo apt-get clean && sudo rm -rf /var/lib/apt/lists/*
python3 -m pip cache purge; sudo rm -rf /root/.cache/pip ~/.cache/pip
rm -rf /tmp/* ~/.nvm/.cache
sudo journalctl --vacuum-time=1d
sudo rm -rf /var/log/*.gz /var/log/*.1 /var/log/*.old
# [v101 NEW] gbrain-specific cache cleanup
rm -rf ~/.bun/install/cache/*  # bun's download cache (~50 MB)
rm -rf ~/gbrain/.git/logs ~/gbrain/.git/objects/pack/*.idx
EOF
```

### §3.8 — Run verification (10 min)

#### CLAUDE.md's 15-point verification — all must pass:

| # | Check | Command |
|---|---|---|
| 1 | OpenClaw installed | `openclaw --version` |
| 2 | Node.js v22 | `node --version \| grep v22` |
| 3 | Chromium | `test -x /usr/local/bin/chromium-browser` |
| 4 | ffmpeg | `which ffmpeg` |
| 5 | jq | `which jq` |
| 6 | node_exporter | `which node_exporter` |
| 7 | Xvfb + x11vnc + websockify | `which Xvfb && which x11vnc && which websockify` |
| 8 | exec-approvals.json (security=full) | `cat ~/.openclaw/exec-approvals.json` |
| 9 | SSH deploy keys (≥2) | `wc -l < ~/.ssh/authorized_keys` |
| 10 | loginctl linger enabled | `loginctl show-user openclaw \| grep Linger=yes` |
| 11 | strip-thinking.py has cooldown gate | `grep -q SESSION_BACKUP_COOLDOWN_SEC ~/.openclaw/scripts/strip-thinking.py` |
| 12 | SOUL.md has memory filing system | `grep -q MEMORY_FILING_SYSTEM ~/.openclaw/workspace/SOUL.md` |
| 13 | memory/session-log.md exists | `test -f ~/.openclaw/workspace/memory/session-log.md` |
| 14 | memory/active-tasks.md exists | `test -f ~/.openclaw/workspace/memory/active-tasks.md` |
| 15a-g | All 7 crons | `crontab -l` |

#### **[v101 NEW] 16-point verification — gbrain HTTP sidecar pre-bake state**

The bake's headline change. All 6 sub-checks must pass:

| # | Check | Expected | Command |
|---|---|---|---|
| 16a | gbrain repo at canonical path | `~/gbrain/.git` exists, HEAD = baf1a47 | `cd ~/gbrain && git rev-parse --short HEAD` returns `baf1a47` |
| 16b | gbrain binary symlink | `~/.bun/bin/gbrain` exists, points at `~/gbrain/src/cli.ts` | `readlink ~/.bun/bin/gbrain` |
| 16c | gbrain --version returns pinned | `0.35.0.0` (in output) | `gbrain --version \| grep -oE '[0-9]+(\.[0-9]+){3}'` |
| 16d | PGLite initialized + clean | brain.pglite exists, config.json present, access_tokens empty | `test -d ~/.gbrain/brain.pglite && jq -r .engine ~/.gbrain/config.json` returns `pglite` |
| 16e | systemd unit installed but INACTIVE | unit file exists, KillSignal=SIGKILL, service NOT active | `grep KillSignal ~/.config/systemd/user/gbrain.service && systemctl --user is-active gbrain.service` returns `inactive` |
| 16f | openclaw.json has NO gbrain entry | `mcp.servers.gbrain` absent | `jq '.mcp.servers.gbrain // "absent"' ~/.openclaw/openclaw.json` returns `"absent"` |

### §3.9 — Disk usage check (CRITICAL — 5 min)

```bash
ssh openclaw@$BAKE_VM_IP "df -h / | tail -1"
```

**Must be < 6.0 GB used (5.9 GB safe target).** Linode image hard limit is 6144 MB; previous bakes have been ~5.8 GB. gbrain adds ~150 MB so we should land at ~5.95 GB.

If over: investigate aggressive cleanup (`/usr/local`, `~/.cache`, `/root/.cache`, `npm cache`).

### §3.10 — Power off + bake image (15 min including poll)

Per CLAUDE.md step 9-10. **DO NOT delete SSH host keys or machine-id** — cloud-init regenerates on first boot from snapshot.

```bash
# Shutdown
curl -X POST -H "Authorization: Bearer $LINODE_API_TOKEN" \
  https://api.linode.com/v4/linode/instances/$BAKE_VM_ID/shutdown
# Poll until status=offline (typically 30-60s)

# Get the ext4 disk ID (not swap)
curl -H "Authorization: Bearer $LINODE_API_TOKEN" \
  https://api.linode.com/v4/linode/instances/$BAKE_VM_ID/disks

# Create image
curl -X POST -H "Authorization: Bearer $LINODE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"disk_id\": $DISK_ID,
    \"label\": \"instaclaw-base-v101-2026-05-23-gbrain-http\",
    \"description\": \"OpenClaw <latest> + gbrain v0.35.0.0 HTTP sidecar pre-installed. 21/21 verified (15 base + 6 gbrain). Disk usage <6.0GB.\"
  }" \
  https://api.linode.com/v4/images

# Poll image status until 'available' (typically 3-5 min)
```

### §3.11 — Update references

Per CLAUDE.md step 11. **CRITICAL**: do NOT update `LINODE_SNAPSHOT_ID` in Vercel env yet — soak first (§4).

Files to update locally + commit:
- [ ] `CLAUDE.md` — "VM Provisioning Standard" snapshot ID + bake date + contents description
- [ ] `.env.local` — `LINODE_SNAPSHOT_ID="private/<NEW_ID>"` (local only, NOT pushed to Vercel yet)

### §3.12 — Cleanup

```bash
# Delete the bake VM (we don't keep the disk around; the image is what matters)
curl -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" \
  https://api.linode.com/v4/linode/instances/$BAKE_VM_ID
```

---

## §4 — Soak (May 24-25, ~36 hours)

**Do NOT flip LINODE_SNAPSHOT_ID in production Vercel env until soak completes.**

Soak protocol:
1. **Provision a test VM from the new snapshot.** Use the existing replenish-pool flow or a manual provision:
```bash
curl -X POST ... \
  -d "{\"label\":\"snapshot-soak-v101\",\"image\":\"private/<NEW_ID>\",...}"
```
2. **SSH in. Run the 16-point verification (full, fresh — not relying on the bake VM's state).**
3. **Manually run stepGbrain via the dry-run script** to confirm the four-state idempotency check reports `[dry-run] gbrain HTTP sidecar install (V=0.35.0.0 T=(none) S=inactive P=0)` — meaning V is correct (baked) but T/S/P need to be set per-VM.
4. **Run the real install on the test VM** via `_install-gbrain-on-vm.ts` to validate the per-VM finalization path:
   - Phase A: idempotency mismatch → re-install
   - Phases B (Bun already present, no-op), C (git pull, no-op since at pinned commit), D (bun install fast)
   - Phase E: stop pre-baked sidecar → wipe pre-baked PGLite → fresh init → mint per-VM token → write systemd unit → start
   - Phases F, G, H normal
   - **Expected timing: ~30-45 seconds** (vs ~75s on a completely cold VM)
5. **Send a real test message to the agent via Telegram.** Verify `gbrain__put_page` fires in the session jsonl, page persists, retrieval works.
6. **Soak for ≥24h.** Monitor `instaclaw_admin_alert_log` for any new P0/P1 from the test VM. If quiet, proceed.

---

## §5 — Production cutover (May 25-26)

Once soak is clean:

1. **Cooper action:** update `LINODE_SNAPSHOT_ID` in Vercel env (production scope only) to `private/<NEW_ID>`. Per Rule 6: use `printf`, NOT `<<<` or `echo`, to avoid trailing newline.
2. **Wait one provisioning cycle** — the next `cron/replenish-pool` run (every 5 min) will pick up new VMs from the new snapshot.
3. **Verify a fresh provision** — query the latest provisioning event in `vm_lifecycle_log`. Confirm the new VM:
   - Has `~/gbrain/.git` HEAD = baf1a47
   - Has `gbrain.service` installed but inactive (needs first reconcile to mint token + flip openclaw.json)
   - The reconciler picks it up and finalizes within ~3-5 min

4. **Monitor for 24h.** Watch for any anomalous reconcile failures, gbrain-related stuck-onboarding states (Rule 33), or disk-full alerts.

---

## §6 — Rollback plan

If anything goes wrong during soak or after cutover:

### §6.1 — During soak (no production impact yet)
Just don't flip `LINODE_SNAPSHOT_ID`. The old snapshot stays canonical. Delete the failed image:
```bash
curl -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" \
  https://api.linode.com/v4/images/private/<FAILED_ID>
```

### §6.2 — After cutover (production fleet affected)

If new VMs from v101 are misbehaving:

1. **Immediate:** flip `LINODE_SNAPSHOT_ID` back to `private/38575292` in Vercel. New VMs revert to v79 baseline within 5 min (next replenish-pool tick).
2. **For VMs already provisioned from v101 in the window:** they're stuck on v101 until reconciler heals them OR until manual intervention. Triage by querying VMs created between cutover-time and rollback-time.
3. **Keep `private/38575292` for 1 full week** (until 2026-06-01 minimum) per Rule 7. After that, if v101 is stable, the old snapshot can be deleted.

### §6.3 — gbrain-specific rollback (without full snapshot rollback)

If gbrain is broken on v101 but everything else is fine: set `GBRAIN_INSTALL_ENABLED=false` in Vercel env. stepGbrain in the reconciler returns early on the feature flag. Existing gbrained VMs continue working (their state isn't reverted); new VMs from snapshot have `gbrain.service` inactive until manual intervention.

---

## §7 — Cooper-action checklist

Things ONLY Cooper can do (not me):

- [ ] Vercel env: set/confirm `GBRAIN_ANTHROPIC_API_KEY` (already done; spot-check it's still there)
- [ ] Anthropic console: confirm $300/mo cap on the gbrain project key
- [ ] **After soak:** flip `LINODE_SNAPSHOT_ID` to `private/<NEW_ID>` in Vercel production env
- [ ] (Optional) flip `GBRAIN_INSTALL_ENABLED=true` in Vercel env to enable reconciler-driven stepGbrain on edge_city VMs

---

## §8 — Known issues / followups (not blocking)

1. **`snapshot_brain` MCP tool upstream** — required to bump `GBRAIN_PINNED_VERSION` post-Esmeralda without wiping user memory. Tracking in P1 followups.
2. **gbrain-coverage cron** — deep-health check separate from cheap V+T+S+P idempotency. Catches broken-but-appears-healthy VMs that the reconciler's cheap check misses. P1 followup; aim to land before Esmeralda go-live for monitoring.
3. **`uninstall-gbrain.sh` for HTTP era** — current uninstall is stdio-era only; leaves a stranded systemd unit + PGLite. Not blocking but operationally relevant.
4. **Future version bumps** — until `snapshot_brain` lands upstream, DO NOT bump `GBRAIN_PINNED_VERSION` on production VMs with non-empty PGLite. Per CLAUDE.md Rule 35 §"Version-bump preservation gap".

---

## §9 — Timeline (May 23-30)

```
  May 23 (Sat)  ──● Provision bake VM + run install-gbrain.sh
                  ── 15-point verify + 6-point gbrain verify
                  ── Strip per-VM bearer + openclaw.json gbrain entry
                  ── Bake the image; get new snapshot ID
  May 24 (Sun)  ──○ Provision a soak VM from the new snapshot
                  ── Run real install via _install-gbrain-on-vm.ts
                  ── Send test messages via Telegram, verify put_page works
                  ── Soak begins
  May 25 (Mon)  ──○ Soak continues; monitor admin alerts
                  ── If 24h clean, prepare for cutover
  May 26 (Tue)  ──● Cooper flips LINODE_SNAPSHOT_ID in Vercel env
                  ── First production provision from v101
                  ── 24h watch
  May 27 (Wed)  ──○ Buffer
  May 28 (Thu)  ──○ Esmeralda monitoring dashboard finalized
  May 29 (Fri)  ──○ Buffer
  May 30 (Sat)  ──● Esmeralda Day 1 — attendees arrive
                  ── New attendee VMs provisioned from v101
                  ── stepGbrain finalizes each within 3-5 min of partner-tag
```

**Critical path:** May 23 bake → May 24 soak → May 26 cutover. Buffer days: May 27, 29. Esmeralda is May 30.

---

## §10 — What "success" looks like

By May 30:
- ✓ Every newly-provisioned edge_city VM has gbrain HTTP sidecar live within 5 min of partner-tag
- ✓ `put_page` round-trip latency < 1s
- ✓ Zero cold-start "Something went wrong" complaints from new attendees
- ✓ Esmeralda dashboard shows 100% gbrain coverage on edge_city VMs
- ✓ `gbrain-coverage` cron (if shipped) reports 0 broken-state VMs over the 5-day conference

Failure scenarios we MUST avoid:
- ✗ New VM boots but gbrain.service crash-loops (systemd Restart=always masks the issue)
- ✗ Attendee sends "remember X" but the agent silently hallucinates the save (Rule 29)
- ✗ Per-VM bearer token mint fails silently, openclaw.json has Bearer but DB doesn't recognize it
- ✗ PGLite from snapshot has stale schema (the v36 wedge we hit on vm-050 earlier)
- ✗ Two VMs provisioned with the same bearer (bake-VM bearer not stripped) — operationally weird, not a security issue on loopback but still wrong

Each is covered by the verification gates above. If we hit any of them in soak, halt cutover.

---

## §11 — Pre-bake-check findings (2026-05-16, T-7 days)

This section captures the result of running `scripts/_pre-bake-check.ts` against current prod state on 2026-05-16. Re-run the script at T-3 days (2026-05-20) and T-1 day (2026-05-22) to confirm none of the GO state has regressed.

### §11.1 — Verified clean (CRITICAL gates passing)

- [x] **Integrity fix landed.** `f49b4e68 fix(manifest-integrity): strip JS comments before parsing cronMarkers` on origin/main.
- [x] **LINODE_SNAPSHOT_ID matches expected source.** `private/38575292` in `.env.local`.
- [x] **GBRAIN_PINNED_* alignment.** Both `lib/vm-reconcile.ts` and `scripts/_install-gbrain-on-vm.ts` resolve to `0.35.0.0`/`baf1a47`.
- [x] **gbrain install scripts parse cleanly.** Both `install-gbrain.sh` and `verify-gbrain-mcp.py` pass syntax check.
- [x] **Linode API reachable.** `/v4/account` returns 200 for `coopergrantwrenn@gmail.com`.
- [x] **Supabase reachable.** Fleet queries respond.
- [x] **No quarantined VMs.** Neither `watchdog_quarantined_at` nor `reconcile_quarantined_at` set on any VM.
- [x] **No ENOSPC alerts in 24h.** Rule 37 wrapper hasn't fired.
- [x] **No VMs with `last_disk_pct ≥ 80%`.** Max observed = 79% (close to threshold but within bounds — monitor; no immediate action).
- [x] **Disk-data coverage 100%.** 149/149 healthy+assigned VMs have a `last_disk_pct` reading; Rule 46 health-check is fully populated.
- [x] **No stale cron locks.** Two `vercel-cron` rows, both <5 min old.
- [x] **No stuck-onboarding alerts (Rule 33) in 24h.**
- [x] **No `[P0] Freeze recovery FAILED` alerts (Rule 52) in 24h.**

### §11.2 — Open blockers (must resolve before bake)

- [ ] **STALE_BUNDLE alerts firing every ~6 hours in 24h.** Hash `9a4afc5c8d0e5348` triggered at 2026-05-15T23:51, 2026-05-16T05:54, 2026-05-16T11:57, 2026-05-16T19:27 UTC. Each indicates the Vercel-bundled reconcile-fleet cron is running with a stale manifest cache; the P1-4 integrity check is correctly halting reconciliation. **Impact:** 0/149 VMs advanced to cv=101 for the first ~4h after the manifest bump (only 6/149 have caught up by 2026-05-16 late evening). **Fix:** touch `app/api/cron/reconcile-fleet/route.ts` with a cache-bust comment + push, OR trigger a fresh Vercel production deploy. The husky pre-commit hook is supposed to auto-touch on `vm-manifest.ts` changes — if it hasn't fired, investigate the hook OR do the manual touch.
- [ ] **gbrain edge_city coverage at 7/8 (88%).** `instaclaw-vm-923` reports `missing_gbrain` (architecture=none, V=missing, T=absent, S=inactive, P=0, K=109 — env var present but install never ran). Likely a fresh provision waiting for stepGbrain to land or for a manual install. **Fix:**
    ```bash
    cd /Users/cooperwrenn/wild-west-bots/instaclaw
    npx tsx scripts/_install-gbrain-on-vm.ts instaclaw-vm-923
    ```
- [ ] **vm-354 30-min soak verification (§2.1).** Checkbox still open. Run the 5 soak checks manually: service active, bearer hash match, schema v66, put_page/get_page round-trip, openclaw.json transport=streamable-http. Cooper-action.

### §11.3 — Operator-only action items (Cooper, not scriptable)

- [ ] **Anthropic project-key spending cap on `GBRAIN_ANTHROPIC_API_KEY`.** Verify $300/mo cap at console.anthropic.com.
- [ ] **HEAD aligned with origin/main in the bake-source repo.** Pre-bake-check on 2026-05-16 found drift on `/Users/cooperwrenn/wild-west-bots/`: HEAD=e6f16c57, main=2381503e (auto-changelog keeps moving origin/main, so this is a moving target). Before clicking Provision on May 23, run `git pull --ff-only origin main` from the main repo. Re-run the pre-bake-check after the pull.

### §11.4 — Fleet state snapshot (2026-05-16)

- Manifest: **v101** (bumped 2026-05-16 19:07 EDT via commit `48af5075`)
- Fleet size: 149 healthy+assigned VMs
- cv distribution: cv=101:6 (4%), cv=100:142 (95%), cv=95:1 (1%) — 95% lag is the visible result of the stale_bundle block; reconciler will converge once Vercel is redeployed
- Disk-data coverage: 149/149 (100%) — Rule 46 health-check fully populated
- Disk-pct: max 79% (one VM at the warning edge)
- Last admin alert: 2026-05-16T23:07 `usage-anomaly-check:cost_spike` (not blocking the bake)
- Active cron locks: 2 vercel-cron rows, both <5 min old (healthy)
- gbrain edge_city: 7/8 (vm-923 needs install)

### §11.5 — Re-run cadence

Run `scripts/_pre-bake-check.ts` at these checkpoints:

- **T-7 days (2026-05-16, today)** — initial sweep ✓ (recorded above)
- **T-3 days (2026-05-20)** — confirm blockers in §11.2 are resolved
- **T-1 day (2026-05-22)** — final go/no-go before provisioning the bake VM
- **T+0 (2026-05-23, morning)** — last sanity check before clicking Provision

The script is fast (~5s) and idempotent. Run as many times as needed. Exit code 0 = GO, 1 = NO-GO with named blockers, 2 = connectivity error.

### §11.6 — Companion script

Pre-bake-check lives at `instaclaw/scripts/_pre-bake-check.ts`. It is read-only — no mutations, no SSH writes. Safe to run from any operator's workstation as long as:

- `instaclaw/.env.local` is loaded (has `LINODE_API_TOKEN`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`)
- `instaclaw/.env.ssh-key` is loaded (has `SSH_PRIVATE_KEY_B64`) — required by the delegated `_coverage-gbrain-sidecar.ts` SSH probe
- `node_modules` are installed (script uses `@supabase/supabase-js`)

Falls back to the canonical `/Users/cooperwrenn/wild-west-bots/instaclaw/.env*` paths if relative .env loading fails, so it works from both the main repo and the changelog clone.
