# Snapshot Bake v112 — Execution Brief

**Status: PRE-EXECUTION (awaiting Cooper sign-off before bake fires)**

| Field | Value |
|---|---|
| Date authored | 2026-05-22 |
| Operator | Cooper (with this terminal as co-pilot) |
| Manifest target | v112 (current — bumped 2026-05-20 with v112: intelligent reasoning router + watchdog v2) |
| Source snapshot | `private/38575292` (v79, baked 2026-05-03) |
| Bake VM type | `g6-nanode-1` (per Snapshot Creation Process — 25GB disk keeps image small) |
| Bake VM region | `us-east` |
| Bake VM label convention | `snapshot-bake-v112` |
| Stakeholder count | ~500 Edge Esmeralda attendees onboarding starting **2026-05-30 (8 days from now)** |
| Buffer days available | 2026-05-23 → 2026-05-29 (7 days; bake → soak → cutover before launch) |

This brief consolidates every lesson and gotcha relevant to today's bake into a single self-contained document. The intent is "cleanest snapshot bake ever" (Cooper's framing): every known failure mode anticipated, every recovery path documented, every authority boundary explicit.

---

## §0 — Source materials consulted

This brief synthesizes the following workspace documents. Each is referenced where relevant in the sections below. The brief does NOT replace these docs — operators should consult the originals if a question isn't answered here.

### Tier 1 (canonical operator references)
- `docs/snapshot-bake-runbook.md` (1,159 lines) — the canonical step-by-step runbook with §3a additions from 2026-05-21.
- `docs/snapshot-bake-v105-checklist.md` (1,097 lines) — prep notes from the previous v105 bake attempt. Includes §4 Soak, §5 Cutover, §6 Rollback, §7 Cooper-action checklist, §9 Timeline, §10 Success criteria, §11 Pre-bake-check findings + resolution log.
- `CLAUDE.md` "Snapshot Creation Process (COMPLETE REFERENCE)" — 12-step canonical procedure + "Snapshot Gotchas (Lessons Learned)" subsection.
- `CLAUDE.md` "OpenClaw Upgrade Playbook (MANDATORY)" — institutional memory from v67 incident; pre-flight + canary + fleet rollout + wave audit gates + rollback + NEVER list + the watchdog interaction.
- `CLAUDE.md` Rules 1-60 — every rule that has fired during the development history of the platform. Especially load-bearing for this bake: Rules 5 (gateway-health-after-config), 6 (no trailing newlines), 7 (snapshot refresh), 22 (trim-over-nuke), 23 (sentinel-grep), 32 (hot-reload), 34 (DB↔disk drift), 35 (gbrain HTTP sidecar), 47 (continuous reconciliation), 54 (PGLite SIGKILL gotcha), 58 (token cross-consumer sync), 60 (RLS-in-file).

### Tier 2 (bake-prep & cloud-init reference)
- `docs/bake-readiness-audit-2026-05-13.md` — source of the 7 runbook additions (HEAD == origin/main gate, NODE_PATH alignment check, 10 strip-thinking sentinels, Rule 32 hot-reload journal check, §5 expanded validation, §11 stale-Node-path risk class).
- `docs/cloud-init-snapshot-bake-requirements-2026-05-13.md` §17b — 22 SNAPSHOT_BAKED items the §17b probe found missing on the v79 snapshot. My §3a additions address these.
- `docs/cloud-init-builder-plan-2026-05-13.md`, `docs/cloud-init-self-test-runbook.md`, `docs/cloud-init-wrapper-contracts-2026-05-13.md` — cloud-init architecture context. Cloud-init is the post-bake ONBOARDING path that uses the new snapshot.
- `docs/prd/autonomous-bake-system-design-2026-05-19.md` (884 lines) — `scripts/_autonomous-bake.ts` was built for this workflow. Pre-existing tool that captures most of the bake automation; needs companion §3a + `_bake-gap-fixes.sh` invocation around it.

### Tier 3 (canary + incident post-mortems)
- `docs/canary-snapshots/2026-05-20T0048-post-enable-vm-733-validated.json` — first successful v107 canary (vm-733). Confirms gbrain v0.36.3.0 install path works end-to-end.
- `docs/canary-snapshots/2026-05-20T1600-post-remediation-5-bugs-fixed.json` — **5 bugs found in the v107 canary, 2 fleet-wide blockers fixed.** Critical reading; the 5 bugs are §6 of this brief.
- `docs/incidents/2026-05-16-stale-bundle-23h-cron-halt.md` — Vercel @vercel/nft cache halted reconciles for ~23h; cache-bust hot-fix in place.
- `docs/incidents/2026-05-17-vm911-4day-silent-down.md` — 4-day silent VM down; informs the post-bake monitoring discipline.

### Tier 4 (memory + feedback)
- `/Users/cooperwrenn/.claude/projects/-Users-cooperwrenn-wild-west-bots/memory/feedback_snapshot_refresh.md` — Cooper's standing guidance: "After every manifest version bump, STOP and remind Cooper about stale snapshot."
- `/Users/cooperwrenn/.claude/projects/-Users-cooperwrenn-wild-west-bots/memory/MEMORY.md` (191 lines) — index of all auto-memory; deployment workflow rules (always feature branches, NEVER push to main without approval).

---

## §1 — Target state (what the new snapshot WILL contain)

### Pinned versions (verified fresh from `lib/vm-reconcile.ts:180-181` + `lib/ssh.ts` constants)

| Constant | Value | Source |
|---|---|---|
| `VM_MANIFEST.version` | **112** | `lib/vm-manifest.ts` |
| `NODE_PINNED_VERSION` | `22.22.2` | `lib/ssh.ts` |
| `OPENCLAW_PINNED_VERSION` | `2026.4.26` | `lib/ssh.ts` |
| `BANKR_CLI_PINNED_VERSION` | `0.3.1` | `lib/ssh.ts` |
| `AGENTKIT_CLI_PINNED_VERSION` | `0.1.3` | `lib/ssh.ts:121` |
| `GBRAIN_PINNED_VERSION` | `0.36.3.0` | `lib/vm-reconcile.ts:181` |
| `GBRAIN_PINNED_COMMIT` | `1d5f69f` | `lib/vm-reconcile.ts:180` |
| `BUN_PINNED_VERSION` | `1.3.13` | embedded in `install-gbrain.sh` |

### What's new in v112 vs v79 (manifest delta)

Per the CLAUDE.md "Manifest Version Changelog" section, the source snapshot v79 → v112 spans **33 manifest versions** of accumulated changes. Highlights (newest first):

- **v112** (2026-05-20): intelligent reasoning router + watchdog v2 for ChatGPT OAuth. `agents.defaults.timeoutSeconds` raised from 300 → 1800. New `stepPiAiReasoningPatch` injects the router into pi-ai's `openai-codex-responses.js`.
- **v111** (2026-05-20): `stepEdgeOSApiKey` mints per-VM `eos_live_*` keys for Edge Esmeralda 2026 calendar (events:read scope).
- **v108** (2026-05-19): EDGE_INSTACLAW_OVERLAY_MD fixes stale "Social Layer" reference → EdgeOS canonical.
- **v106** (2026-05-19): `stepDeployGbrainSoulRouting` — gbrain-first SOUL.md section on edge_city VMs.
- **v105** (2026-05-18): `stepIndexProvision` — Index Network MCP for edge_city.
- **v103/v104** (2026-05-18): `stepUfwRules` enforces ufw 9100/tcp fleet-wide; closes the Rule 57 anti-pattern in dispatch-server.
- **v102** (2026-05-17): canonical gbrain memory protocol in AGENTS.md fleet-wide.
- **v101** (2026-05-16): startup orphan tool_use repair via strip-thinking.py `--startup-repair-active`.
- **v100** (2026-05-15): removed RuntimeMaxSec — no more scheduled 24h gateway restarts.
- **v99** (2026-05-14): gateway-health textfile-collector promoted to manifest.
- **v95** (2026-05-12): three-layer Telegram ack UX (reactions + streaming preview + ack-watchdog).
- **v92** (2026-05-11): partner SOUL.md sections moved out of bootstrap context.
- **v91** (2026-05-07): SOUL.md Platform block V1 → V2.
- **v90** (2026-05-07): four-layer session-overflow reliability fix (compaction).
- **v87** (2026-05-05): `stepPrctlSubreaper` — node zombie reaping.
- **v86** (2026-05-05): TasksMax 75 → 120.

### Source-snapshot known concerns (v79 baseline)

Per `CLAUDE.md` "VM Provisioning Standard":
> **NOTE: vm-watchdog + silence-watchdog crons present (carried from v64 — production fleet has these manually disabled; new VMs from this snapshot will re-enable them unless removed during configureOpenClaw).**

These crons need handling on the bake VM (or accept they're disabled by configureOpenClaw + cloud-init setup.sh §1.0.5 per commit `7eaf4bfe`).

---

## §2 — Pre-flight (Cooper's 4 steps + the §0.5.1 gates)

Cooper's mandate from his most recent prompt:
> "follow the documented sequence: 1. git pull --ff-only origin main in both repos 2. npx vercel env pull --environment=production 3. confirm GBRAIN_ANTHROPIC_API_KEY exists in refreshed .env.local (hard blocker) 4. wait for any active reconcile-fleet cron lock to release"

### 2.1 — Git pull in BOTH repos

```bash
cd /Users/cooperwrenn/wild-west-bots && git pull --ff-only origin main
cd /Users/cooperwrenn/wild-west-bots-changelog && git pull --ff-only origin main
```

**Why both**: per `docs/multi-terminal-git-worktree-setup.md`, the `wild-west-bots-changelog` directory is a SIBLING worktree (not a clone). It shares `.git/` with the main repo but has its own index. To ensure both terminals see the same main, both must pull explicitly.

**Gate**: after pull, in BOTH repos: `git rev-parse origin/main == HEAD`. If diverged, investigate before proceeding.

### 2.2 — Vercel env pull (refresh local .env.local)

```bash
cd /Users/cooperwrenn/wild-west-bots/instaclaw
npx vercel env pull --environment=production
```

Per Cooper's note: this resolves the 3 RED items from yesterday's pre-flight audit (`GBRAIN_ANTHROPIC_API_KEY`, `GBRAIN_PINNED_COMMIT`, `GBRAIN_PINNED_VERSION`, `RECONCILE_SOUL_MIGRATION_ENABLED`, `EDGEOS_EVENTS_BEARER_TOKEN`) which were missing from the stale `.env.local`.

### 2.3 — Verify GBRAIN_ANTHROPIC_API_KEY (HARD BLOCKER)

This is the single critical gate. `install-gbrain.sh:201` reads this from `~/.openclaw/.env`. Phase E exits with `FATAL_NO_ANTHROPIC_KEY` (code 2) if missing.

```bash
grep -c '^GBRAIN_ANTHROPIC_API_KEY=' /Users/cooperwrenn/wild-west-bots/instaclaw/.env.local
# Expected output: 1
```

**If 0**: bake STOPS. Cooper must set in Vercel (per Rule 6: `printf 'key' | npx vercel env add GBRAIN_ANTHROPIC_API_KEY production` — never `<<<` or `echo`). Re-pull. Re-verify.

### 2.4 — Wait for reconcile-fleet cron lock

The reconcile-fleet cron runs every 3 min and holds a lock for ~5 min. Provisioning a bake VM while this is running is fine (the bake VM isn't yet in the fleet), but the §2.1 step of the runbook ("Acquire the reconcile-fleet cron lock") needs the lock to be released:

```sql
SELECT name, holder, acquired_at, expires_at FROM instaclaw_cron_locks WHERE name = 'reconcile-fleet';
```

If `expires_at > NOW()`, wait. Should be < 5 min.

### 2.5 — Additional pre-flight gates per `docs/snapshot-bake-runbook.md` §0.5.1

These shipped with the 7 audit additions (commit `4844f749`):

| Gate | Check |
|---|---|
| HEAD == origin/main (main repo) | `[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]` |
| HEAD == origin/main (changelog repo) | same in `wild-west-bots-changelog` |
| LINODE_SNAPSHOT_ID match | `grep LINODE_SNAPSHOT_ID .env.local` returns `private/38575292` |
| `npx tsx scripts/_pre-bake-check.ts` | Exit 0 = GO; Exit 1 = NO-GO with named blockers; Exit 2 = connectivity |

Per `docs/snapshot-bake-v105-checklist.md` §11.3 — these operator-action items must be confirmed:

| Cooper-action | Status |
|---|---|
| Vercel env: `GBRAIN_ANTHROPIC_API_KEY` (per §2.3 above) | ⬜ verify after env pull |
| Anthropic console: $300/mo cap on `GBRAIN_ANTHROPIC_API_KEY` (spending limit) | ⬜ Cooper-action (manual) |
| HEAD aligned with origin/main (per §2.1) | ⬜ verify after pull |

### 2.6 — Concurrent terminal coordination

Per `docs/multi-terminal-git-worktree-setup.md` §11: the 2026-05-16 incident showed multiple terminals operating in the same working tree caused commit cross-contamination. Verify which terminal is operating on the bake:

```bash
git worktree list
```

Expected: `wild-west-bots` is current main, `wild-west-bots-changelog` is the bake-prep tree. Confirm no other Claude Code terminals are also running bake operations concurrently.

---

## §3 — Bake sequence (§0–§7 of the runbook + §3a + _bake-gap-fixes.sh)

This section maps the canonical runbook to today's bake. Source: `docs/snapshot-bake-runbook.md`.

### §3.1 — §0 Bake parameters

Set environment variables for the session:

```bash
export BAKE_LABEL="snapshot-bake-v112"
export BAKE_REGION="us-east"
export BAKE_TYPE="g6-nanode-1"
export SOURCE_SNAPSHOT="private/38575292"
export EXPECTED_MANIFEST_VERSION=112
```

### §3.2 — §1 Provision the bake VM

Per `docs/snapshot-bake-runbook.md` §1.1, use Linode API to create a fresh nanode from the SOURCE snapshot. Wait for `status=running` (~3-5 min). SSH-connect and record the public IP.

```bash
export BAKE_IP=<the_provisioned_ip>
```

**Gate**: SSH-reachable. `ssh -i /tmp/vm-050-key -o StrictHostKeyChecking=no openclaw@$BAKE_IP 'echo OK'` returns `OK`.

### §3.3 — §2 Reconcile bake VM v79 → v112

The bake VM provisioned from v79 starts at `config_version=0`. We need to reconcile it to v112 so all 33 versions of accumulated manifest changes land.

Per `docs/snapshot-bake-runbook.md` §2.1: acquire the reconcile-fleet cron lock to prevent Vercel cron racing.

Per `docs/snapshot-bake-runbook.md` §2.2: run `npx tsx scripts/_install-gbrain-on-vm.ts <BAKE_VM_NAME>` or use the canary-reconcile script for one-VM operation. Expected duration: ~15-30 min for a bake VM at cv=0.

**Gate**: bake VM reaches `config_version=112`. The reconciler's logs confirm zero `result.errors`.

### §3.4 — §3 Install gbrain (via _install-gbrain-on-vm.ts)

Per `docs/snapshot-bake-runbook.md` §3.2: `npx tsx scripts/_install-gbrain-on-vm.ts <BAKE_VM_NAME>`.

The wrapper now (post-Bug A fix, commit `57eb3ee0`) uploads ALL 4 companion files via SSH stdin:
1. `install-gbrain.sh`
2. `verify-gbrain-mcp.py`
3. `pglite-checkpoint.sh` (per Rule 54)
4. `0001-add-checkpoint-mcp-tool.patch` (per Rule 54)

Expected output ends with `INSTALL_COMPLETE`. Wait ~3-5 min.

**Gates** (per runbook §3.3):
- `~/.bun/bin/gbrain` symlink exists
- `openclaw mcp show gbrain` lists the entry
- `GBRAIN_ANTHROPIC_API_KEY` + `OPENAI_API_KEY` in `~/.openclaw/.env`
- `~/.gbrain/` directory created
- `gbrain.service` active (`systemctl --user is-active gbrain`)
- pg_control freshness <60s (per Rule 54 — 30-min CHECKPOINT cron must be installed)

### §3.5 — §3a Snapshot baseline fill-in (22 §17b items + install-gbrain.sh placement)

Per the new §3a (commit `4844f749`, `91016d3c`), execute these phases on the bake VM:

**3a.1 — pre-flight verify source files exist locally** (in repo): install-gbrain.sh, 3 SKILL.md (frontier/agent-status/clawlancer), browser-relay-server.js, check-skill-updates.sh.

**3a.2 — Python packages**: `sudo python3 -m pip install --break-system-packages "crawlee[beautifulsoup,playwright]==1.5.0" web3 "solders==0.27.1" eth-account websockets base58`. Verify all 6 import.

**3a.3 — NPM globals**: `npm install -g "@worldcoin/agentkit-cli@0.1.3" usecomputer mcporter`. Verify with `npm list -g --depth=0`.

**3a.4 — install-gbrain.sh placement (item 23 — BE-14 dependency)**: scp `install-gbrain.sh` to `~/.openclaw/scripts/install-gbrain.sh` on the bake VM, `chmod 755`. **Load-bearing for the cloud-init BE-14 step on every future cloud-init VM.**

**3a.5 — skill-integrity-check.sh** at `~/.openclaw/scripts/skill-integrity-check.sh` (Rule 24).

**3a.6 — Outer scripts**: scp browser-relay-server.js to `~/scripts/browser-relay-server.js`, check-skill-updates.sh to `~/scripts/check-skill-updates.sh`. Chmod 755.

**3a.7 — Systemd unit files**: write xvfb.service, x11vnc.service, websockify.service to `/etc/systemd/system/`. Enable + start each.

**3a.8 — Skills**: scp 3 SKILL.md files to `~/.openclaw/skills/{frontier,agent-status,clawlancer}/SKILL.md`.

**3a.9 — privacy-bridge.sh** (edge_city only — skip-by-default unless this snapshot serves edge_city VMs; reconciler installs lazily).

**3a.10 — Verify BE-14 dependency chain + install-gbrain.sh side effects (8 gates)**:
1. install-gbrain.sh executable at `~/.openclaw/scripts/install-gbrain.sh`
2. gbrain.service active (`systemctl --user is-active gbrain.service`)
3. openclaw.json: `.mcp.servers.gbrain.transport == "streamable-http"`
4. install-gbrain.sh pinned to `0.36.3.0`
5. install-gbrain.sh pinned to commit `1d5f69f`
6. `~/.bun/bin/bun --version == "1.3.13"` (gap #2)
7. `~/.openclaw/scripts/pglite-checkpoint.sh` present + executable (gap #5)
8. CHECKPOINT cron entry: `crontab -l | grep pglite-checkpoint.sh` matches (gap #6)
9. ExecStop drop-in: `~/.config/systemd/user/gbrain.service.d/20-execstop-checkpoint.conf` exists (gap #7)

### §3.6 — Audit's _bake-gap-fixes.sh (9 post-doc gaps)

Per `scripts/_bake-gap-fixes.sh` (commit `41e8373f`), runs AFTER §3a:

```bash
ssh -i /tmp/vm-050-key openclaw@$BAKE_IP 'bash _bake-gap-fixes.sh --dry-run'  # always dry-run first per Rule 4
# review output, then:
ssh -i /tmp/vm-050-key openclaw@$BAKE_IP 'bash _bake-gap-fixes.sh'
```

Fixes:
1. dispatch-server.service Node-path alignment (gap #1)
2. Bun install (gap #2 — defensive)
3. gbrain MCP entry verification (gap #3 — verify only)
4. pglite-checkpoint.sh deployment (gap #5 — Rule 54)
5. PGLite CHECKPOINT crontab entry (gap #6 — Rule 54)
6. gbrain.service ExecStop hook (gap #7 — Rule 54)
7. imagemagick apt install (gap #8)
8. nodejs apt-mark hold + nodesource.sources removal (gap #9 — vm-748 defense)
9. openclaw-gateway.service.d/30-bun-path.conf drop-in (gap #10)

Exit codes: 0 = all fixes applied (idempotent); 4 = one or more failed verification.

### §3.7 — §4 Prebake cleanup (`_prebake-cleanup.sh`)

Per `docs/snapshot-bake-runbook.md` §4: marks VM as bake-mode, then runs cleanup. Wipes per-VM secrets, user data, partner state, caches, logs, /tmp, browser cookies, stale locks, shell history, etc.

```bash
# 4.1 Mark VM as bake-mode (required)
ssh -i /tmp/vm-050-key openclaw@$BAKE_IP 'touch /tmp/.bake-mode'

# 4.2 DRY RUN first per Rule 4
ssh -i /tmp/vm-050-key openclaw@$BAKE_IP 'bash _prebake-cleanup.sh --dry-run' | tee /tmp/prebake-dryrun.txt
# Review dry-run output carefully

# 4.3 Real wipe (after Cooper reviews dry-run)
ssh -i /tmp/vm-050-key openclaw@$BAKE_IP 'bash _prebake-cleanup.sh'

# 4.4 Spot-check that critical wipes happened (gateway token, telegram bot token, openai key, etc.)
```

**Critical: this is a destructive operation. Cooper-review of dry-run output is mandatory.**

### §3.8 — §5 Postbake validation (--mode=bake)

Per `docs/snapshot-bake-runbook.md` §5: run the 27-category validation script in `--mode=bake` against the bake VM (after `_prebake-cleanup.sh`, before image creation).

```bash
npx tsx scripts/_postbake-validation.ts --vm-ip=$BAKE_IP --mode=bake
```

Exit codes:
- 0 = all pass — proceed to image creation
- 1 = P0 fail (don't ship — investigate)
- 2 = SSH fatal
- 3 = arg error

**Gate**: exit code 0. If any P0 fails, halt and investigate.

### §3.9 — §6 Bake the image

Per `docs/snapshot-bake-runbook.md` §6:

```bash
# 6.1 Disk usage check — MUST be < 5900 MB
ssh -i /tmp/vm-050-key openclaw@$BAKE_IP 'df -h / | tail -1'

# 6.2 Power off (Linode requires offline for snapshot)
# Use Linode API to shutdown; poll status=offline (~30s)

# 6.3 Get ext4 disk ID via Linode API

# 6.4 Create image
# POST /v4/images with disk_id, label="instaclaw-base-v112-2026-05-22"

# 6.5 Wait for image to become available (~5 min)
# Verify size < 6144 MB
```

**Gates**: image status=available, size <6144 MB. Record new image ID:

```bash
export NEW_SNAPSHOT_ID="private/<NEW_ID>"
```

### §3.10 — §7 Verify the image (provision a test VM)

Per `docs/snapshot-bake-runbook.md` §7: provision a test VM from the new image, run `_postbake-validation.ts --mode=test`. This proves the snapshot produces working VMs.

```bash
# 7.1 Provision test VM from new image (via Linode API)
export TEST_VM_IP=<test_vm_ip>

# 7.2 Wait for setup + reconciler to complete (~10 min)

# 7.3 Run --mode=test validation
npx tsx scripts/_postbake-validation.ts --vm-ip=$TEST_VM_IP --mode=test
```

**Gates**: exit 0. Plus: test VM gateway active, /health 200, gbrain.service active, openclaw mcp show gbrain works, real chat completion via Telegram returns response in <30s.

---

## §4 — Critical decision points (operator sign-offs)

The bake has **5 explicit decision points** where the operator must consciously approve before proceeding. Cooper, you should pause at each one and confirm:

### DP1 — After §2.3 GBRAIN_ANTHROPIC_API_KEY confirmation
- If absent in `.env.local` after `vercel env pull`: STOP. Confirm Vercel env state via `npx vercel env ls production`. Either set the key OR investigate why it's missing.

### DP2 — After §3.3 reconcile completes
- Confirm bake VM reaches cv=112 cleanly.
- Confirm `result.errors` was empty across the reconcile (no Rule 39 critical failures).
- If lying-DB-LOW (cv held by optional-step failures per Rule 39): manually verify on-disk state matches manifest before proceeding.

### DP3 — After §3a + _bake-gap-fixes.sh complete
- All 8 gates from §3a.10 pass (BE-14 dependency chain).
- _bake-gap-fixes.sh exits 0.
- Spot-check 5 random items from the §17b inventory exist on disk.

### DP4 — After §4 prebake-cleanup DRY-RUN (mandatory per Rule 4)
- Review dry-run output. Look for: critical files NOT being touched (workspace/, sessions/, env/wallet) per Rule 22 / Rule 50 protected-files list.
- Look for: deletion of files we wanted preserved (e.g., `/tmp/snapshot-files/` if we extracted manifest files there).
- ONLY after review: approve real wipe.

### DP5 — After §7 test-VM verification
- Test VM provisioned from new image is FULLY FUNCTIONAL.
- Real chat completion test passes (not just /health 200 — per OpenClaw Upgrade Playbook).
- gbrain end-to-end test passes (put_page round-trip).
- **This is the GO/NO-GO gate for flipping LINODE_SNAPSHOT_ID in Vercel.**

---

## §5 — Verification gates (what CAN'T fail silently)

### 5.1 — The 15-point bake verification (CLAUDE.md "Snapshot Creation Process" §7)

| # | Check | Command |
|---|-------|---------|
| 1 | OpenClaw installed | `openclaw --version` matches 2026.4.26 |
| 2 | Node.js v22.22.2 | `node --version \| grep v22.22.2` |
| 3 | Chromium | `test -x /usr/local/bin/chromium-browser` |
| 4 | ffmpeg | `which ffmpeg` |
| 5 | jq | `which jq` |
| 6 | node_exporter | `which node_exporter` |
| 7 | Xvfb + x11vnc + websockify | `which Xvfb && which x11vnc && which websockify` |
| 8 | exec-approvals.json (security=full) | parse and check JSON |
| 9 | SSH deploy keys (≥2) | `wc -l < ~/.ssh/authorized_keys` |
| 10 | loginctl linger enabled | `loginctl show-user openclaw \| grep Linger=yes` |
| 11 | strip-thinking.py has session-end hook | `grep -q run_session_end_hook ~/.openclaw/scripts/strip-thinking.py` |
| 12 | SOUL.md has memory filing system | `grep -q MEMORY_FILING_SYSTEM ~/.openclaw/workspace/SOUL.md` |
| 13 | memory/session-log.md exists | `test -f ~/.openclaw/workspace/memory/session-log.md` |
| 14 | memory/active-tasks.md exists | `test -f ~/.openclaw/workspace/memory/active-tasks.md` |
| 15a-g | All 7 crons installed | `crontab -l` greps for each marker |

### 5.2 — Strip-thinking.py 10 sentinels (commit `22a5df69`)

Per the audit additions, `_postbake-validation.ts` checks for 10 specific strings in `strip-thinking.py`:
1. `def trim_failed_turns` (Rule 22 sentinel)
2. `SESSION TRIMMED:`
3. `compact_session_in_place_lines` (v90 Layer 1)
4. `SESSION COMPACTED:`
5. `_extract_large_tool_results_to_cache` (v90 Layer 3)
6. `LAYER3_EXTRACTED:`
7. `def run_startup_orphan_repair` (v101)
8. `ORPHAN_REPAIR:`
9. `SESSION_BACKUP_COOLDOWN_SEC = 300` (Rule 45)
10. `SESSION_BACKUP_MAX_PER_SESSION = 50` (Rule 45)

### 5.3 — Rule 32 hot-reload journal check

For `messages.*` config keys: after gateway restart, the journal MUST show `[reload] config hot reload applied (messages.<key>)` lines. Without these, the runtime is still using the value it captured at process init.

### 5.4 — _postbake-validation.ts (27 check categories)

The script catches §17b's gaps via P0 severity. Per `docs/snapshot-bake-runbook.md` §5 (~78 individual checks across P0/P1/P2 tiers). Exit code matters:

- **P0 fails** = bake NOT shippable, halt
- **P1 fails** = warning, can ship with explicit acknowledgment
- **P2 fails** = nits, don't block

---

## §6 — Lessons learned from past attempts (5 bugs from v107 canary)

Per `docs/canary-snapshots/2026-05-20T1600-post-remediation-5-bugs-fixed.json`, the v107 canary surfaced 5 bugs. All 5 are CLOSED but documented here so the operator recognizes the patterns if they recur.

### Bug A — Phase I silent degradation (FIXED commit `57eb3ee0`)

**Symptom**: install-gbrain.sh emitted WARN+exit-0 when companion files (pglite-checkpoint.sh, 0001-add-checkpoint-mcp-tool.patch) missing. Reported `INSTALL_COMPLETE` despite half-installed state. 15/15 active canary VMs lacked checkpoint-operation.ts + ExecStop hook + 30-min cron. pg_control aged 268-815 min stale.

**Root cause**: Reconciler stepGbrain uploaded ONLY 2 of 4 needed files. Phase C2 + Phase I always fell into for-candidate-loop fallback.

**Fix**: Reconciler now uploads ALL 4 companion files via SSH stdin. Phase C2 hard-fails with exit 36 if patch file missing. Phase I hard-fails with exit 35 if cron script missing.

**Relevance to today's bake**: `_install-gbrain-on-vm.ts` (used by §3) now does the upload correctly. My BE-14 step on cloud-init VMs depends on the snapshot already having gbrain installed (Phase A short-circuits via "already installed" branches without needing the companion files at /tmp/). Test-VM verification in §7 will confirm.

### Bug B — vm-watchdog SIGKILL'ing gbrain (FIXED commit `f14199e0`)

**Symptom**: 8/9 fleet VMs had gbrain restart 12-18 times every 8h. Pattern: gbrain runs 30 min → vm-watchdog SIGKILL → systemd Restart=always → repeat.

**Root cause**: vm-watchdog.py's `check_runaway_processes()` unconditionally SIGKILL's processes older than `PROCESS_MAX_AGE_MIN=30` not in protected_pids. gbrain runs as `comm=bun`, wasn't protected.

**Fix**: Added gbrain.service MainPID lookup to vm-watchdog.py. Added to protected_pids.

**Relevance to today's bake**: The fix propagates via file-drift cron (Rule 47). Verify the bake VM's vm-watchdog.py has the fix: `grep -c "gbrain_pid" ~/.openclaw/scripts/vm-watchdog.py` should return at least 1.

### Bug C — vm-602 missing OPENAI_API_KEY (one-shot fixed; P2 followup queued)

**Symptom**: 1 VM (vm-602) had `gbrain install blocked at Phase A NO_OPENAI_KEY check`.

**Root cause**: configureOpenClaw at lib/ssh.ts:6692 writes OPENAI_API_KEY ONCE at VM assignment. Not in SECRET_ENV_VAR_SOURCES. No self-healing.

**Fix (P2 followup, not yet implemented)**: Add OPENAI_API_KEY to SECRET_ENV_VAR_SOURCES.

**Relevance to today's bake**: After the bake, every test VM should have OPENAI_API_KEY in `~/.openclaw/.env`. Verify in §7. If missing: Cooper must investigate why configureOpenClaw didn't write it.

### Bug D — vm-634 half-installed (one-shot fixed)

**Symptom**: Prior install hit Phase E TOKEN_MINT_FAILED, leaving ~/gbrain (340 MB) + ~/.gbrain/brain.pglite (41 MB) on disk but no bearer, no service.

**Fix**: rm -rf ~/gbrain (per Cooper); preserved ~/.gbrain per Rule 22 (even though no real user data). Reconciler retries fresh install with new Bug A+F upload paths.

**Relevance to today's bake**: Bake VM is fresh, no half-install state. Not directly relevant. But noted for the muscle memory: half-installs are the BUG-D failure mode.

### Bug E — vm-517 GATEWAY_UNHEALTHY_POST_HOT_RELOAD (quarantine cleared; P2 followup queued)

**Symptom**: vm-517 was healthy on the VM (gbrain active, /health 200) but DB stuck at rcf=10, excluded from candidate pool.

**Root cause**: stepGbrain Phase G hot-reload health check fired before gateway finished post-reload state, returning 000. Repeated attempts → rcf escalated → quarantined.

**Fix (P2 followup)**: stepGbrain Phase G should retry the /health probe with brief backoff (3 attempts × 3s).

**Relevance to today's bake**: Could affect the test VM in §7 if Phase G health-check fires too early. If test VM hits this: clear quarantine + verify on-disk state matches manifest manually.

### Other lessons from earlier bake attempts (v101 → v106)

Per `docs/snapshot-bake-v105-checklist.md` §11 + commit history:

- **STALE_BUNDLE alerts** (2026-05-16 incident) — Vercel @vercel/nft cache served stale manifest to the reconcile-fleet route. 3-layer defense in place (manual touch-route comment, .husky/pre-commit hook, lib/manifest-integrity.ts runtime hash compare). If we see this fire during the bake, the husky hook should auto-cache-bust on the next commit; if not, manual cache-bust comment in `app/api/cron/reconcile-fleet/route.ts`.
- **gbrain edge_city coverage drift** — every new edge_city VM between manifest version changes needs `_install-gbrain-on-vm.ts` to run manually unless `GBRAIN_INSTALL_ENABLED=true` in Vercel env (Cooper-action per §7). After today's bake, every fresh VM from the new snapshot will have gbrain installed in the snapshot, but the reconciler still needs to finalize per-VM bearer + openclaw.json wiring.

---

## §7 — Rollback plan (multi-tier)

### Tier A — During §1-§3 (no impact yet)

If the bake VM fails reconcile or gbrain install:
- Power off + destroy the bake VM via Linode API.
- No production impact (bake VM never reaches the snapshot).
- Investigate root cause. Fix. Retry from §1.

### Tier B — After §6 image creation but BEFORE LINODE_SNAPSHOT_ID flip

If §7 test-VM verification fails:
- Don't update `LINODE_SNAPSHOT_ID` in Vercel. New VMs continue using v79.
- Delete the failed image:
  ```bash
  curl -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" \
    https://api.linode.com/v4/images/private/<FAILED_ID>
  ```
- Investigate. Re-bake.

### Tier C — After LINODE_SNAPSHOT_ID flip (production fleet affected)

If new VMs from v112 are misbehaving:
1. **Immediate**: flip `LINODE_SNAPSHOT_ID` back to `private/38575292` in Vercel. New VMs revert to v79 baseline within 5 min (next replenish-pool tick).
2. **For VMs already provisioned from v112 in the window**: they're stuck on v112 until reconciler heals them OR until manual intervention. Triage by querying VMs created between cutover-time and rollback-time.
3. **Keep `private/38575292` for 1 full week** (until 2026-06-01 minimum) per Rule 7.

### Tier D — gbrain-specific rollback (without full snapshot rollback)

If gbrain is broken on v112 but everything else is fine: set `GBRAIN_INSTALL_ENABLED=false` in Vercel env. stepGbrain in the reconciler returns early on the feature flag. Existing gbrained VMs continue working (state isn't reverted); new VMs from snapshot have `gbrain.service` inactive until manual intervention.

### Tier E — Per-step / per-rule rollback references

- Rule 22: never destructively modify user state. If we need to rollback a fix that did so, restore from `~/.openclaw/session-backups/`.
- Rule 34: DB↔disk drift recovery via `_db-reset-config-version-from-disk.ts` (v67 incident reference).
- Rule 54: PGLite recovery via `pg_resetwal -f` (Rule 54 §"Recovery procedure").

---

## §8 — Esmeralda timeline (May 30, 500 attendees)

Per `docs/snapshot-bake-v105-checklist.md` §9 Timeline (adjusted for today's bake target date 2026-05-22):

```
  May 22 (Thu, TODAY)  ──● Provision bake VM + reconcile + gbrain install
                          ── §3a fill-in + _bake-gap-fixes.sh
                          ── Prebake cleanup + postbake validation
                          ── Bake image; get new snapshot ID
  May 23 (Fri)         ──○ Provision a soak VM from the new snapshot
                          ── Run real install via _install-gbrain-on-vm.ts
                          ── Send test Telegram messages, verify put_page works
                          ── Soak begins
  May 24-25 (Sat-Sun)  ──○ Soak continues; monitor admin alerts
                          ── If 36-48h clean, prepare for cutover
  May 26 (Mon)         ──● Cooper flips LINODE_SNAPSHOT_ID in Vercel
                          ── First production provision from v112
                          ── 24h watch
  May 27-29 (Tue-Thu)  ──○ Buffer days
                          ── Monitor for any anomalies
  May 30 (Fri)         ──● Esmeralda Day 1 — attendees arrive
                          ── New attendee VMs provisioned from v112 via cloud-init
                          ── BE-14 in setup.sh re-wires gbrain MCP per Rule 58
                          ── stepGbrain finalizes each within 3-5 min of partner-tag
```

**Critical path**: May 22 bake → May 23-25 soak → May 26 cutover. Buffer days: May 27-29. Esmeralda is May 30.

---

## §9 — Open questions for Cooper before bake fires

### Q1 — Soak period: skip or honor?

Cooper's instruction was: "after bake completes: update LINODE_SNAPSHOT_ID in Vercel with the new image ID."

This implies IMMEDIATE cutover after §7 verify passes. But `docs/snapshot-bake-v105-checklist.md` §4 prescribes a 24-36h soak period before flipping.

**Recommendation**: HONOR the soak. The §7 test-VM verify proves the snapshot produces a working VM in the §1 flow. The soak proves the snapshot produces a working VM in the cloud-init flow (which is what 500 Edge attendees will use). Skipping the soak means we discover any cloud-init-specific issue with paying customers.

If Cooper insists on immediate cutover: at minimum, complete a 30-minute cloud-init "mini-soak" by manually triggering a cloud-init provision (CLOUD_INIT_ONDEMAND_ENABLED=true) with a fresh test account, send a Telegram message, verify the agent responds with gbrain memory working.

### Q2 — Vercel CLI version

The Vercel hook noted: `Vercel CLI is outdated (54.2.0 → 54.4.0)`. Recommend upgrading before §2.2:

```bash
npm i -g vercel@latest
```

Per the hook: "significant agentic features and improvements." Not a hard blocker but worth doing.

### Q3 — Anthropic spending cap on GBRAIN_ANTHROPIC_API_KEY

Per `docs/snapshot-bake-v105-checklist.md` §11.3 — Cooper-action that's listed but not auto-verified. Cooper should manually confirm the $300/mo cap is set at console.anthropic.com on the GBRAIN project key.

### Q4 — Multi-terminal coordination

If any other terminals are currently running bake operations (e.g., still iterating on §3a), the bake should pause. Verify via `git worktree list` + check current branch state in each worktree.

### Q5 — BE-14 dependency: does cloud-init setup.sh's BE-14 step work cleanly with the new snapshot?

My BE-14 step (added today, commit `f79937f2`) calls `~/.openclaw/scripts/install-gbrain.sh` on cloud-init VMs to re-wire gbrain MCP after setup.sh overwrites openclaw.json.

**Assumption**: the new snapshot has gbrain pre-installed (via §3), so install-gbrain.sh's Phase A 5-invariant check finds `transport=""` (because setup.sh erased the mcp.servers.gbrain entry), fails Phase A → reinstall path fires → but each phase short-circuits via "already installed" branches → fast (~10-15s) re-mint of bearer + Phase G writes new mcp.servers.gbrain entry to openclaw.json.

**Verification**: in §7 test VM (which uses LEGACY provisioning, not cloud-init), this path isn't exercised. The cloud-init mini-soak in Q1 is the only way to confirm BE-14 works end-to-end with the new snapshot.

---

## §10 — Post-bake actions

After §7 test-VM verify passes (and ideally after soak in Q1):

### 10.1 — Update LINODE_SNAPSHOT_ID in Vercel

```bash
# Per Rule 6: use printf, NOT <<< or echo
printf 'private/<NEW_ID>' | npx vercel env add LINODE_SNAPSHOT_ID production --force
# Then redeploy to pick up the new env var
```

### 10.2 — Tell Cooper the new ID

Cooper's instruction: "after bake completes: update LINODE_SNAPSHOT_ID in Vercel with the new image ID. tell me the new ID so i can verify."

Output format:
- Image ID: `private/<NEW_ID>`
- Image label: `instaclaw-base-v112-2026-05-22`
- Image size: `<MB>` (must be <6144)
- Build status: available
- Vercel env: updated
- Verification: Cooper independently checks

### 10.3 — Monitor first replenish-pool tick

The replenish-pool cron runs every 5 min. Next tick after Vercel env update will provision the FIRST production VM from the new snapshot. Watch for:
- Successful provision (status=provisioning → ready)
- Cloud-init-poll cron marks ready
- No errors in vm_lifecycle_log

### 10.4 — Verify a fresh production VM

After the first replenish-pool tick:
- Query the latest provisioning event in `vm_lifecycle_log`
- Confirm the new VM has:
  - `~/gbrain/.git` HEAD = `1d5f69f`
  - `gbrain.service` installed (active or inactive — reconciler will finalize)
  - `~/.openclaw/scripts/install-gbrain.sh` at the expected path (per BE-14 dependency)
- The reconciler picks it up and finalizes within ~3-5 min.

### 10.5 — Update CLAUDE.md "VM Provisioning Standard"

Per `docs/snapshot-bake-runbook.md` §6.5: update `CLAUDE.md` with the new snapshot ID + description. Include:
- New snapshot ID
- Bake date (2026-05-22)
- Source version (v79)
- Target version (v112)
- Pinned constants at bake time
- Rollback snapshot (private/38575292, keep for 1 week minimum)

### 10.6 — Monitor for 24h

Watch:
- `instaclaw_admin_alert_log` for any new P0/P1
- Vercel cron logs for reconcile-fleet
- Resend dashboard for any [P0] freeze-recovery-failed alerts
- `instaclaw_vms` for any quarantined VMs

If anomalies in 24h: investigate. If quiet: bake is stable.

### 10.7 — Delete the temp bake VM

After everything verified:

```bash
# Delete the temp bake nanode
curl -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" \
  https://api.linode.com/v4/linode/instances/<BAKE_VM_ID>
```

Keep the new snapshot (`private/<NEW_ID>`) AND the old snapshot (`private/38575292`) for 1 week minimum per Rule 7.

---

## Appendix A — Quick reference commands

```bash
# === Bootstrap (extract SSH key if not on disk) ===
[ -f /tmp/ic_ssh_key ] || (grep '^SSH_PRIVATE_KEY_B64=' /Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key | head -1 | sed 's/^SSH_PRIVATE_KEY_B64=//' | sed 's/"//g' | base64 -d > /tmp/ic_ssh_key && chmod 600 /tmp/ic_ssh_key)

# === SSH to bake VM ===
SSH_OPTS="-i /tmp/ic_ssh_key -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes"
ssh $SSH_OPTS openclaw@$BAKE_IP '...'

# === Pre-bake-check (idempotent, safe to re-run) ===
cd /Users/cooperwrenn/wild-west-bots/instaclaw
npx tsx scripts/_pre-bake-check.ts

# === Autonomous bake (alternative to manual step-by-step) ===
npx tsx scripts/_autonomous-bake.ts --action=preflight
npx tsx scripts/_autonomous-bake.ts --action=dry-run
npx tsx scripts/_autonomous-bake.ts --action=full

# === Manual reconcile single VM ===
npx tsx scripts/_install-gbrain-on-vm.ts <BAKE_VM_NAME>

# === Postbake validation ===
npx tsx scripts/_postbake-validation.ts --vm-ip=$BAKE_IP --mode=bake
npx tsx scripts/_postbake-validation.ts --vm-ip=$TEST_VM_IP --mode=test

# === Linode API: create image ===
curl -X POST -H "Authorization: Bearer $LINODE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"disk_id": <DISK_ID>, "label": "instaclaw-base-v112-2026-05-22", "description": "..."}' \
  https://api.linode.com/v4/images

# === Linode API: instance state ===
curl -H "Authorization: Bearer $LINODE_API_TOKEN" \
  https://api.linode.com/v4/linode/instances/<ID>

# === Linode API: delete image (rollback) ===
curl -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" \
  https://api.linode.com/v4/images/<ID>

# === Vercel env update (Rule 6: printf, not <<<) ===
printf 'private/<NEW_ID>' | npx vercel env add LINODE_SNAPSHOT_ID production --force
```

---

## Appendix B — CLAUDE.md Rules cross-reference (rules most relevant to this bake)

| Rule | Title | Bake relevance |
|---|---|---|
| 1 | Verify DB schema before updates | If any reconciler step adds a column, ensure prod has it |
| 2 | Verify config schema before changing values | Manifest config keys validated against OpenClaw dist files |
| 4 | Dry-run fleet operations first | _prebake-cleanup.sh DRY RUN before real |
| 5 | Verify gateway health after config changes | Mandatory after every restart |
| 6 | No trailing newlines in environment variables | `printf` not `<<<` for `vercel env add` |
| 7 | Snapshot refresh after manifest bumps | The reason we're doing this bake |
| 10 | Reconciler must verify every config set | Source of lying-DB-HIGH bugs |
| 22 | Never destructively modify user state | Trim-over-nuke; protect workspace files |
| 23 | Sentinel-grep required templates before writing | All 10 strip-thinking sentinels checked |
| 32 | openclaw config set exit-0 ≠ runtime applied | `messages.*` keys need restart |
| 34 | DB ↔ disk drift | Reconciler must verify per-VM critical state |
| 35 | gbrain MCP must run as persistent HTTP sidecar | The Rule the whole gbrain rollout enforces |
| 39 | Distinguish critical-step failures from optional-sidecar failures | Reconciler errors vs warnings |
| 45 | Cooldown over mtime equality for idempotency on self-mutating data | strip-thinking session-backup fix |
| 46 | Disk monitoring is mandatory | Disk-fill prevention |
| 47 | Continuous reconciliation, not version-gated | File-drift cron + manifest version bumps |
| 50 | Freeze silence check uses DB user-activity | Not directly bake-relevant but in the protected-files canon |
| 54 | gbrain `systemctl stop` corrupts PGLite data dir | Bake VM gbrain operations use SIGKILL |
| 58 | Token regeneration MUST synchronize every consumer atomically | BE-14 + Phase A6 surgical recovery |
| 60 | Migration files MUST be self-contained | RLS-in-file for any new tables |

---

## Sign-off checklist

Before kicking off the bake, Cooper confirms:

- [ ] §2.1 — git pull --ff-only in both repos done
- [ ] §2.2 — npx vercel env pull --environment=production done
- [ ] §2.3 — GBRAIN_ANTHROPIC_API_KEY confirmed in .env.local (HARD BLOCKER)
- [ ] §2.4 — reconcile-fleet cron lock released
- [ ] §2.5 — pre-bake-check.ts exits 0
- [ ] §2.5 — Anthropic $300/mo cap confirmed (Cooper-action)
- [ ] §2.6 — No other terminal running bake operations
- [ ] §9.Q1 — Soak vs immediate-cutover decision made (recommend HONOR soak)
- [ ] §9.Q2 — Vercel CLI upgrade decision made
- [ ] §9.Q5 — Cloud-init mini-soak plan agreed

Once all boxes ✓: **proceed with §3.1 — provision the bake VM.**

---

## Document changelog

- **2026-05-22** (initial authoring) — synthesized from CLAUDE.md, snapshot-bake-runbook.md, snapshot-bake-v105-checklist.md, bake-readiness-audit, cloud-init-snapshot-bake-requirements §17b, canary post-mortems, recent incident docs, autonomous-bake design PRD, multi-terminal-git-worktree doc, and the auto-memory feedback files. Comprehensive workspace research per Cooper's "cleanest snapshot bake ever" directive.
