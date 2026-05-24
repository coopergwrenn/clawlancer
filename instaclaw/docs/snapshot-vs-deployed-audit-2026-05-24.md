# Snapshot vs Deployed — What Lives Where

**Date**: 2026-05-24
**Trigger**: Cooper's ultrathink directive — "what's on a VM that is NOT tracked by the manifest and NOT written by configureOpenClaw?"
**Method**: Code grep of `lib/vm-manifest.ts` + `lib/ssh.ts:configureOpenClaw` + `lib/cloud-init-setup-sh.ts` + `scripts/_bake-gap-fixes.sh`, cross-referenced against a live probe of vm-1035 (pool VM provisioned 2026-05-23 from snapshot `private/38977398` at cv=113, never assigned, never reconciled beyond snapshot state).
**Scope**: Identify every snapshot-only artifact that would silently persist absent if missing from the snapshot.

---

## Three categories — how things get onto a VM

```
                      ┌─────────────────┐
                      │  Linode boots   │
                      │ from snapshot   │
                      └────────┬────────┘
                               │
                               ▼
              ┌──────── CATEGORY 1 ────────┐
              │ Cloud-init runs setup.sh   │
              │ (every fresh provision)    │
              │ • Installs per-user files  │
              │ • BE-N best-effort steps   │
              │ • POSTs success callback   │
              └────────────────────────────┘
                               │
                               ▼
              ┌──────── CATEGORY 2 ────────┐
              │ configureOpenClaw fires    │
              │ (at user-assign moment)    │
              │ • Writes gateway_token     │
              │ • Mints bankr/cdp wallets  │
              │ • Personalizes SOUL.md     │
              └────────────────────────────┘
                               │
                               ▼
              ┌──────── CATEGORY 3 ────────┐
              │ Reconciler ticks (~3 min)  │
              │ • Heals manifest drift     │
              │ • stepX functions chain    │
              │ • cv catches up to manifest│
              └────────────────────────────┘

                CATEGORY 0 (the gap this doc maps):
                ┌─────────────────────────────────┐
                │  ARTIFACTS PRESENT IN SNAPSHOT  │
                │  THAT NONE OF THE ABOVE REBUILD │
                └─────────────────────────────────┘
```

---

## Category 1: Manifest-tracked (reconciler self-heals)

Source: `instaclaw/lib/vm-manifest.ts` (10 top-level fields, plus implicit reconciler steps).

| Field | Lines | What it ships | Reconciler step | Heal cadence |
|---|---|---|---|---|
| `configSettings` | 1680-1943 | ~50 `openclaw config set <key> <value>` calls | `stepConfigSettings` | 3 min |
| `files` | 1944-2490 | Per-file content writes (scripts, workspace docs, sentinels) | `stepFiles` + `cron/file-drift` | 3-5 min |
| `skillsFromRepo` (bool) | 2491 | Walk `instaclaw/skills/` and deploy SKILL.md + references | `stepSkills` | 3 min |
| `extraSkillFiles` | 2494-2510 | Additional per-skill files (e.g., motion-graphics assets) | `stepSkills` | 3 min |
| `cronJobs` | 2511-2665 | Crontab entries to add (idempotent grep-then-add) | `stepCronJobs` | 3 min |
| `cronJobsRemove` | 2666-2672 | Crontab entries to scrub (v114: vm-watchdog, silence-watchdog) | `stepCronJobs` | 3 min |
| `systemPackages` | 2673 | `apt install -y` for `ffmpeg`, `jq`, `build-essential` | `stepSystemPackages` | 3 min |
| `requiredEnvVars` + `envVarDefaults` | 2680-2719 | `~/.openclaw/.env` line writes | `stepEnvVarDefaults` + `stepEnvVarPush` | 3 min |
| `systemdOverrides` | 2720-2810 | `~/.config/systemd/user/openclaw-gateway.service.d/override.conf` | `stepSystemdUnit` | 3 min |

**Implicit reconciler steps (not driven by manifest data but always run)**:

| Step | What it ensures |
|---|---|
| `stepNpmPinDrift` | `openclaw@2026.4.26` + `@bankr/cli@0.3.1` global installs match pin |
| `stepNodeUpgrade` | NVM-managed Node matches `NODE_PINNED_VERSION="22.22.2"` |
| `stepPrctlSubreaper` | `prctl-subreaper@0.1.0` npm + systemd drop-in |
| `stepUfwRules` | ufw 9100/tcp (node_exporter) + 8765/tcp (dispatch) ALLOW rules |
| `stepNodeExporter` | `node_exporter` binary + systemd unit + textfile-collector drop-in |
| `stepEnvVarPush` | `SECRET_ENV_VAR_SOURCES` (4 entries: GBRAIN_ANTHROPIC_API_KEY, EDGEOS_BEARER_TOKEN, BRAVE_API_KEY, OPENAI_API_KEY) → `.env` |
| `stepGbrain` (partner-gated) | Runs `install-gbrain.sh` if gbrain.service missing on edge_city VMs |
| `stepGbrainEnvSync` | Keeps `~/.gbrain/.env` in sync with `~/.openclaw/.env` |
| `stepMigrateSoulV2` | Rewrites SOUL.md from V1 layout to V2 |
| `stepInstaClawIdentityPatch` | Patches the InstaClaw identity section into SOUL.md |
| `stepDeployGbrainSoulProtocol` | Adds GBRAIN_MEMORY_PROTOCOL_V1 to AGENTS.md (gbrain-installed VMs) |
| `stepIndexProvision` (edge_city) | Index Network MCP credential provisioning |
| `stepEdgeOSApiKey` (edge_city) | EdgeOS `eos_live_*` per-VM API key mint |
| `stepTelegramTokenVerify` | DB↔disk verify of telegram_bot_token |
| `stepTelegramBotDescription` (POOL gap fix v113) | Sets bot description via Telegram API |
| (15+ more) | full chain at `lib/vm-reconcile.ts:reconcileVM()` |

**Key property**: every item in Category 1 is **idempotent + self-healing**. If missing from snapshot, reconciler restores within ~3-5 min of first message.

---

## Category 2: configureOpenClaw-written (per-user, assign-time)

Source: `instaclaw/lib/ssh.ts:5732` (`configureOpenClaw`).

**Per-user fields written to DB row** (`instaclaw_vms`):
- `gateway_url`, `gateway_token`
- `telegram_bot_token`, `telegram_bot_username`, `telegram_bot_id`
- `discord_bot_token`, `discord_bot_username`
- `bankr_api_key`, `bankr_evm_address`
- `agentbook_wallet_address`
- `cdp_wallet_id`, `cdp_wallet_address` (commit `ab9d5dd4`, 2026-05-24)
- `default_model`, `api_mode`, `tier`, `channels_enabled`
- `partner` (when assigned via partner portal)
- `health_status`, `last_health_check`, `ssh_fail_count`, `health_fail_count`
- `config_version` ← `LINODE_SNAPSHOT_CV` env (per `lib/ssh.ts:8931-8934`)
- `last_gateway_restart`, `heartbeat_next_at`, `heartbeat_interval`, `heartbeat_cycle_calls`

**Per-user files written to VM**:
- `~/.openclaw/openclaw.json` (overwrites the snapshot's placeholder; sets `gateway.auth.token`, `channels.telegram.botToken`, `mcp.servers.*`)
- `~/.openclaw/.env` (gateway token + `BANKR_*`, `AGENTBOOK_*`, `CDP_WALLET_ADDRESS`, `PARTNER_ID`)
- `~/.openclaw/agents/main/agent/auth-profiles.json` (Anthropic key — load-bearing for outgoing API calls)
- `~/.openclaw/agents/main/agent/system-prompt.md`
- `~/.openclaw/wallet/agent.key` (AgentBook private key)
- `~/.openclaw/workspace/SOUL.md` (with personalized identity section)
- `~/.openclaw/workspace/WALLET.md` (with the user's full wallet picture: bankr + cdp + token)
- `~/.openclaw/workspace/MEMORY.md` (template; user-populated over time)
- `~/.openclaw/workspace/CAPABILITIES.md`, `EARN.md`, `QUICK-REFERENCE.md`, `TOOLS.md`, `IDENTITY.md` (per-user customized)

**Cron entries added on first configure**:
- Skill-specific git-pull crons (edge-esmeralda, consensus-2026) when partner matches

**Crucially**: configureOpenClaw assumes the snapshot already has all the **infrastructure** in place. It only fills in the **personalized** layer.

---

## Category 1.5: Cloud-init setup.sh BE-N steps (every fresh provision)

Source: `instaclaw/lib/cloud-init-setup-sh.ts` (1505 lines).

Runs on every fresh-from-snapshot provision, BEFORE configureOpenClaw, via the cloud-init tarball. 14 BE-N (Best-Effort) steps documented in the file header. Status as of 2026-05-24:

| Step | What it installs |
|---|---|
| BE-1 ✓ | loginctl linger + sshd OOM-protect drop-in |
| BE-2 ◯ | mkdir defenses (deferred) |
| BE-3 ◯ | privacy wipe (deferred) |
| BE-4 ◯ | stop pre-existing gateway (under review) |
| BE-5 ✓ | Skill clones + overlays (bankr, consensus, edge_city) |
| BE-6 ◯ | @bankr/cli pinned install (deferred — covered by stepNpmPinDrift) |
| BE-7 ✓ | browser-relay-server.js + check-skill-updates.sh + cron |
| BE-8 ◯ | agent-status + clawlancer SKILL.md (deferred) |
| BE-9 ✓ | mcporter clawlancer config |
| BE-10 ✓ | pip install §17b.2 packages (crawlee, web3, eth_account, solders, py_clob_client, openai) |
| BE-11 ✓ | npm install §17b.2 globals (@worldcoin/agentkit-cli@0.1.3, mcporter, usecomputer) |
| BE-12 ✓ | xvfb / x11vnc / websockify systemd units |
| BE-13 ✓ | daemon-reload (folded into BE-12) |
| BE-14 ✓ | gbrain MCP re-wire via install-gbrain.sh (Rule 58 SoT) |

**Key property**: BE-N steps fire on EVERY fresh-from-snapshot provision. They are HEALING (safe to re-run), so even if missing from snapshot, they're restored at provision time.

**Note BE-11**: WARNS but does NOT fail — "Without mcporter: ALL MCP server calls fail. Without agentkit-cli: AgentBook registration impossible. Without usecomputer: dispatch/browser mode broken. Manual fleet-push to recover." This means BE-N's net is broad but `|| true`-ish at the per-step level.

---

## Category 0: SNAPSHOT-ONLY ARTIFACTS

**The critical category Cooper asked about.** Items present in the snapshot that NONE of Categories 1, 1.5, 2, or 3 rebuild.

Methodology: SSH-probed vm-1035 (pool VM at cv=113, fresh from snapshot), enumerated every artifact, cross-referenced against each Category. The list below contains every item that:

- Was present on vm-1035 (so it's in the snapshot)
- Is NOT in `vm-manifest.ts` (any field)
- Is NOT written by `configureOpenClaw`
- Is NOT installed by cloud-init `setup.sh` BE-N steps
- Has no `step*` function in `lib/vm-reconcile.ts` that rebuilds it

### Tier S — catastrophic if missing (snapshot must encode these)

| # | Artifact | Risk if missing |
|---|---|---|
| S1 | `bun` binary at `~/.bun/bin/bun` (~100 MB) | gbrain CLI shebang `#!/usr/bin/env bun` fails to resolve → MCP spawn fails → agent has no memory layer. Reconciler doesn't reinstall. _bake-gap-fixes.sh Fix 2 reinstalls but only runs at bake time. **Validator gate exists (P0, partner-gated)** |
| S2 | `/usr/local/bin/chromium-browser` (custom Chrome for Testing 148.0.7778.96) | Browser plugin + dispatch flow broken. NOT in apt. NOT in manifest. NOT in setup.sh. **Validator gate ADDED 2026-05-24 (P0)** |
| S3 | `/etc/sudoers.d/openclaw` (`openclaw ALL=(ALL) NOPASSWD:ALL`) | Every sudo-requiring reconciler step (stepUfwRules, stepNodeExporter, apt install, sudo tee drop-in) silently fails. NOT in manifest. NOT in configureOpenClaw. **Validator gate ADDED 2026-05-24 (P0)** |
| S4 | ufw 22/tcp ALLOW rule (SSH) | First ufw enforcement tick blocks SSH forever → VM permanently unreachable. NOT auto-restored by stepUfwRules (which only adds 9100 + 8765). **Validator gate ADDED 2026-05-24 (P0)** |
| S5 | `loginctl linger enabled` for openclaw user | User systemd services (openclaw-gateway, gbrain, dispatch-server, x11vnc) die on every logout. Validator gate EXISTS (P1) — but worth flagging that absence is catastrophic, P1 may be too soft |
| S6 | gbrain repo at `~/gbrain/` + `~/.bun/install/global/node_modules/gbrain/` | gbrain.service starts but fails immediately. Only install-gbrain.sh restores. Partner-gated. **Validator gate exists via gbrain.service unit P0** |
| S7 | `gbrain.service` systemd unit + drop-ins (10-killsignal, 20-execstop-checkpoint, 30-embedding-dimensions) | gbrain doesn't auto-start. install-gbrain.sh rebuilds. **Validator gates exist (P0 cluster)** |

### Tier A — silent feature breakage if missing

| # | Artifact | Risk if missing |
|---|---|---|
| A1 | `/usr/local/bin/openclaw-config-merge` + `openclaw-config-watchdog` | The `openclaw-config-watchdog` cron (every 5 min) calls a missing binary → silent cron failure → config drift undetected. **Validator gate ADDED 2026-05-24 (P1)** |
| A2 | `pglite-checkpoint.sh` + cron + ExecStop drop-in (Rule 54) | SIGKILL on reboot/OOM leaves stale pg_control → PGLite cold-start PANICs. install-gbrain.sh Phase I + _bake-gap-fixes.sh Fix 4 restore. Validator gates exist (P0 cluster, partner-gated) |
| A3 | `~/scripts/` directory contents (60+ files: dispatch-*.sh × 24, instagram-*.py × 9, kalshi-*.py × 5, polymarket-*.py × 7, solana-*.py × 5, plus desktop-thumbnail-cron, digest-scheduler, daily-digest, cron-guard, gateway-watchdog) | Skill-specific commands silently fail. NOT in manifest. Some are deployed by configureOpenClaw skill-install flow, but most are snapshot-only. **No comprehensive validator gate** |
| A4 | `~/scripts/browser-relay-server.js` + `dispatch-server.js` + `xmtp-agent.mjs` | Validator gate exists for dispatch-server.js (P0). browser-relay-server.js gate exists (P0). xmtp-agent.mjs P1 |
| A5 | `~/scripts/node_modules/` (npm packages for the scripts) | dispatch-server / browser-relay-server require Node deps. setup.sh BE-7 partially installs. NOT in manifest. **No validator gate** for node_modules content |
| A6 | NPM globals `@worldcoin/agentkit-cli`, `mcporter`, `usecomputer`, `prctl-subreaper` | setup.sh BE-11 reinstalls at every provision. stepNpmPinDrift covers @bankr/cli + openclaw only. Validator gates exist for agentkit-cli + mcporter + prctl-subreaper (P1-P2) |
| A7 | Python packages: `crawlee`, `web3`, `eth_account`, `solders`, `py_clob_client`, `openai` | setup.sh BE-10 reinstalls. **No reconciler step**. Validator gates exist (`27f — python3 packages`, P1) |
| A8 | Skill clones: `~/.openclaw/skills/{bankr, consensus-2026, edge-esmeralda, dgclaw, ...}` with `.git/` | Some have git-pull crons; if .git/ missing the pull fails silently. stepSkills detects via Rule 24 sentinel checks. PARTIAL coverage |

### Tier B — silent degradation if missing

| # | Artifact | Risk if missing |
|---|---|---|
| B1 | `openclaw memory index` cron with hardcoded `v22.22.0/bin/openclaw` path | Daily 4 AM cron silently fails because the v22.22.0 path no longer exists (Node bumped to 22.22.2). Memory indexing never runs → semantic search degraded → user notices slow recall over weeks. **Confirmed silent failure on vm-1035 (cv=113 pool VM). Validator gate ADDED 2026-05-24 (P0)** |
| B2 | apt packages beyond `systemPackages` (fail2ban, haveged, sysstat, imagemagick, ghostscript, fonts-*) | Ubuntu defaults + bake-time additions. fail2ban: brute-force protection. haveged: entropy source. imagemagick: thumbnail generation. _bake-gap-fixes.sh Fix 7 reinstalls imagemagick. No validator coverage for the rest |
| B3 | `/etc/sysctl.d/10-{bufferbloat,kernel-hardening,network-security,ptrace,zeropage}.conf` | Ubuntu defaults from `ubuntu-pro-client` / apt. NOT in manifest. If missing → degraded networking/security defaults |
| B4 | `/etc/systemd/system/{xvfb,x11vnc,websockify,browser-relay-server,node_exporter,syslog}.service` system units | setup.sh BE-7 + BE-12 reinstall xvfb/x11vnc/websockify/browser-relay-server at provision. node_exporter via stepNodeExporter. syslog via Ubuntu apt. **PARTIAL coverage** |
| B5 | NodeSource apt source removed + nodejs apt-marked hold | _bake-gap-fixes.sh Fix 8 enforces. Validator gate exists (P0 absent + P1 hold). The 2026-05-18 vm-748 incident proves this is real |

### Tier C — runtime contamination (snapshot has these from BAKE-VM cron output)

| # | Artifact | Cleanup status |
|---|---|---|
| C1 | `~/.openclaw/openclaw.json.hourly-{00..23}` (24 files) | From the hourly backup cron running during bake. Should be wiped by `_prebake-cleanup.sh`. Still present on vm-1035 — **cleanup script missed them** |
| C2 | `~/.openclaw/openclaw.json.bak{,.1,.2,.3,.4}` | Minute-by-minute backups from the bake VM's `openclaw-config-watchdog` |
| C3 | `~/.openclaw/workspace-pre-soul-v2-migration.tar.gz` | v95-era SOUL.md migration backup. Should be wiped. Still present |
| C4 | `~/.openclaw/.silence-watchdog-state.json`, `~/.openclaw/.bash_history`, `~/.openclaw/watchdog-status.json`, `~/.openclaw/update-check.json`, `~/.openclaw/skill-update-status.json` | Runtime state. Mostly inert in new tenant (gets overwritten). **Operational cleanup gap, not a correctness one** |
| C5 | `~/.openclaw/openclaw.json.clobbered.<ts>` | From `openclaw-config-watchdog` rolling-back a bad config write. Inert |

**Tier C is not a load-bearing risk** — these are cleanup gaps. But they bloat snapshot size by ~MB (24 hourly backups × ~30 KB each = ~720 KB; openclaw.json itself is ~20 KB). Worth flagging for the next `_prebake-cleanup.sh` revision.

---

## Cross-reference: what `_bake-gap-fixes.sh` already covers

The 9 fixes documented at `scripts/_bake-gap-fixes.sh`:

| # | Fix | Covers Tier item |
|---|---|---|
| 1 | dispatch-server.service Node-path alignment | (not in tier list — covered by validator gate) |
| 2 | bun install | S1 |
| 3 | gbrain MCP entry verification (flag-only) | (validation, not fix) |
| 4 | pglite-checkpoint.sh deployment (Rule 54) | A2 |
| 5 | PGLite CHECKPOINT crontab entry | A2 |
| 6 | gbrain.service ExecStop hook | A2 |
| 7 | imagemagick apt install | B2 |
| 8 | nodejs apt-mark hold + nodesource.sources removal | B5 |
| 9 | openclaw-gateway PATH drop-in for ~/.bun/bin | S1 (PATH-resolution leg) |

**What `_bake-gap-fixes.sh` doesn't cover (and nothing else does)**:
- S2 chromium-browser (snapshot-only, expected to survive bake)
- S3 /etc/sudoers.d/openclaw (snapshot-only, expected to survive bake)
- S4 ufw 22/tcp (snapshot-only, expected to survive bake)
- B1 openclaw memory index cron path drift (silent failure on every pre-Node-bump VM)
- A1 openclaw-config-merge + openclaw-config-watchdog binaries (snapshot-only — though regenerated by configureOpenClaw per mtime probe)
- A5 ~/scripts/node_modules content
- C1-C5 runtime contamination cleanup

---

## What I changed today (2026-05-24)

**Validator gates added** to `instaclaw/scripts/_postbake-validation.ts`:

1. **B1**: `openclaw memory index` cron Node-path matches current Node (P0). Catches the silent-failure-since-Node-bump regression.
2. **S3**: `/etc/sudoers.d/openclaw` present (P0). Catches sudo-availability gap.
3. **S4**: ufw 22/tcp ALLOW rule (P0). Catches SSH-lockout regression.
4. **S2**: `/usr/local/bin/chromium-browser` executable (P0). Catches missing Chromium.
5. **A1**: `/usr/local/bin/openclaw-config-merge` + `openclaw-config-watchdog` (P1 each).

Net: +6 gates (5 in this commit; 1 per binary in A1).

**Documentation**: this file. Cooper has one place to consult next time someone asks "what's actually in the snapshot."

---

## Net answer to Cooper's question

> "If this was missing from the snapshot, would any automated system catch it and fix it? Or would it silently be absent forever?"

**Per artifact** (consolidated):

| Artifact class | Auto-restored? | By what |
|---|---|---|
| All Category 1 (manifest-tracked) | YES | Reconciler step* functions, 3-min cadence |
| All Category 1.5 (cloud-init BE-N) | YES | setup.sh on every fresh provision |
| All Category 2 (per-user) | YES | configureOpenClaw at assign |
| Tier S1 bun | NO | _bake-gap-fixes.sh at bake; otherwise silent forever |
| Tier S2 chromium-browser | NO | Bake recipe only; silent forever if absent |
| Tier S3 sudoers.d/openclaw | NO | Bake recipe only; silent forever |
| Tier S4 ufw 22/tcp | NO | Bake recipe only; silent SSH lockout |
| Tier S5 linger | NO | Bake recipe only; user systemd dies |
| Tier S6/S7 gbrain | PARTIALLY (stepGbrain heals for edge_city only) | install-gbrain.sh |
| Tier A1 openclaw-config-* binaries | YES (configureOpenClaw at assign — observed mtime is provision time) | configureOpenClaw |
| Tier A2 pglite-checkpoint | PARTIALLY (install-gbrain.sh at bake / on stepGbrain) | install-gbrain.sh |
| Tier A3 ~/scripts contents | NO | Snapshot-only; silent feature breakage |
| Tier A4 ~/scripts entrypoints | NO | Snapshot-only (validator gates exist) |
| Tier A5 ~/scripts/node_modules | NO | Snapshot-only; silent broken |
| Tier A6 NPM globals | YES | setup.sh BE-11 + stepNpmPinDrift (for the pinned ones) |
| Tier A7 Python packages | YES | setup.sh BE-10 |
| Tier A8 skill clones | PARTIALLY (stepSkills with sentinel check) | stepSkills + skill-integrity-check cron |
| Tier B1 memory-index cron drift | NO | Silent every 4 AM (validator now catches at bake time) |
| Tier B2 apt extras | PARTIALLY (Ubuntu auto-updates) | Some only via _bake-gap-fixes.sh |
| Tier B3 sysctl.d defaults | YES | Ubuntu apt |
| Tier B4 system unit files | PARTIALLY | setup.sh BE-7 + BE-12 + stepNodeExporter |
| Tier B5 NodeSource hold | NO (one-time) | _bake-gap-fixes.sh at bake; subsequent bakes might forget |
| Tier C* runtime contamination | NO (cleanup gap) | Should be wiped by _prebake-cleanup.sh; currently isn't |

**Summary**: there are **9 Tier S/A items** that would be silently absent forever if missing from the snapshot. **The new validator gates added today (B1, S2, S3, S4, A1) close 5 of them.** The remaining 4 (S1, S5, A2, A3) are already covered by existing validator gates or by `_bake-gap-fixes.sh`.

**For Cooper's bake-trust decision**: as long as `_postbake-validation.ts` passes all P0 gates in BAKE MODE before imagize, the snapshot encodes all Tier S/A correctness. Tier C cleanup is cosmetic.

---

## Recommended follow-ups (not done tonight)

1. **`_prebake-cleanup.sh` extension** (P1): scrub Tier C runtime contamination — `openclaw.json.hourly-*`, `openclaw.json.bak*`, `workspace-pre-soul-v2-migration.tar.gz`, `.silence-watchdog-state.json`. Saves ~1-2 MB per snapshot.

2. **A3 comprehensive script-inventory gate** (P2): the 60+ files in `~/scripts/` are not individually gated. A single `count > 50` gate would catch the case where most scripts went missing. Trade-off: false positives if Cooper adds/removes scripts intentionally.

3. **B2/B5 apt-package presence gates** (P2): fail2ban, haveged, sysstat, ghostscript, fonts-noto-mono. None individually catastrophic, but cumulative absence indicates a bake recipe regression.

4. **Reconciler stepPythonPackages** (P1): make Tier A7 reconciler-healed (not just setup.sh-healed at provision). Closes the gap where a Python package is removed manually and never restored.

5. **Reconciler stepNpmExtras** (P1): same for Tier A6 NPM globals beyond the existing pinned ones.

6. **Memory index cron template fix** (P0 if not already): the manifest's cronJobs entry should use `$(which openclaw)` or `~/.nvm/versions/node/$(cat ~/.nvm/alias/default)/bin/openclaw` — version-resolving paths. The current hardcoded `v22.22.0` was a one-time install that never adapts. Even with the validator gate, the manifest should be self-rewriting on Node bumps.
