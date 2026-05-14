# Cloud-Init Snapshot-Bake Requirements (cross-check inventory)

**Author:** Claude (Opus 4.7) for Cooper Wrenn
**Date:** 2026-05-13
**Purpose:** Cross-reference doc for the changelog terminal currently auditing the bake toolchain. Every item below is something `lib/cloud-init-userdata.ts` is classifying as **SNAPSHOT_BAKED** — i.e., cloud-init does NOT emit bash to install/write it; it assumes the snapshot bake delivers it. If anything here is missing from the bake checklist (or in the bake but doesn't actually land on the resulting snapshot), one of us has the wrong model.

**Target snapshot:** v95+ baseline, baked 2026-05-23 → 2026-05-25, replacing the current `private/38575292` (v79).

**Source for each item:** the line in `lib/ssh.ts:configureOpenClaw` where the existing SSH-shipped script writes it. The snapshot bake process (per CLAUDE.md "Snapshot Creation Process") runs an equivalent extraction script — these are the items the bake must produce.

**Verification command:** for each item, the changelog terminal can run the listed command against a freshly-baked snapshot VM to verify presence. If absent, escalate before cloud-init Phase 1B begins (2026-05-25).

---

## §1. Workspace files at `/home/openclaw/.openclaw/workspace/`

| File | Source (in configureOpenClaw) | Verify with |
|---|---|---|
| `CAPABILITIES.md` | `lib/agent-intelligence.ts:476` → `lib/ssh.ts:5667` deploy | `test -f` + `md5sum` matches template |
| `QUICK-REFERENCE.md` | `lib/agent-intelligence.ts:725` → `lib/ssh.ts:5668` | same |
| `TOOLS.md` | `lib/agent-intelligence.ts:764` → `lib/ssh.ts:5669` (create_if_missing) | `test -f` |
| `EARN.md` | `lib/earn-md-template.ts:6` → `lib/ssh.ts:5672` (create_if_missing) | `test -f` |
| `SOUL.md` | constructed via concat at `lib/ssh.ts:5631-5664` from 5 constants in `lib/agent-intelligence.ts` + `lib/ssh.ts:3760` (WORKSPACE_SOUL_MD) | `test -f` + size >25KB (the concat is ~28KB) |
| `MEMORY.md` initial template | `lib/vm-manifest.ts:1395-1404` (mode `create_if_missing`) | `test -f` + content begins with `# MEMORY.md - Long-Term Memory` |
| `memory/session-log.md` | `lib/vm-manifest.ts:1407-1411` | `test -f` |
| `memory/active-tasks.md` | `lib/vm-manifest.ts:1413-1417` | `test -f` |

**NOT in snapshot (cloud-init writes these per-user):**
- IDENTITY.md (per-user via telegram-bot-username regex)
- USER.md (per-user)
- WALLET.md (per-user, depends on bankr fields)
- BOOTSTRAP.md (per-user if Gmail; short version is SNAPSHOT_BAKED via `WORKSPACE_BOOTSTRAP_SHORT`)
- WORLD_ID.md (per-user conditional)

---

## §2. Agent-dir files at `/home/openclaw/.openclaw/agents/main/agent/`

| File | Source | Verify with |
|---|---|---|
| `HEARTBEAT.md` | inline heredoc `lib/ssh.ts:5390-5481` | `test -f` + content begins with `# HEARTBEAT.md — Proactive Work Cycle` |

**Cooper's specific question:** confirm HEARTBEAT.md lands at this path during bake. If the bake script doesn't extract the inline heredoc at lib/ssh.ts:5390-5481, the bake checklist needs to add it. If it does, my cloud-init plan correctly skips writing it.

**NOT in snapshot (cloud-init writes these per-user):**
- `auth-profiles.json` (per-user gateway token)
- `system-prompt.md` (per-user via `buildSystemPrompt(gmailProfileSummary)`)

---

## §3. Scripts at `/home/openclaw/.openclaw/scripts/` (Rule 23 sentinels required)

| File | Source | Rule 23 sentinels |
|---|---|---|
| `strip-thinking.py` | `lib/ssh.ts:269` (STRIP_THINKING_SCRIPT) | `def trim_failed_turns`, `SESSION TRIMMED:`, `def run_periodic_summary_hook`, `PERIODIC_SUMMARY_V1`, `PRE_ARCHIVE_SUMMARY_V1`, `PERIODIC_SUMMARY_V1_RESHRINK`, `def compact_session_in_place_lines`, `SESSION COMPACTED:`, `def _extract_large_tool_results_to_cache`, `LAYER3_EXTRACTED:` |
| `vm-watchdog.py` | `lib/ssh.ts:2145` (VM_WATCHDOG_SCRIPT) | none required |
| `silence-watchdog.py` | `lib/ssh.ts:156` (SILENCE_WATCHDOG_SCRIPT) | none |
| `auto-approve-pairing.py` | `lib/ssh.ts:2076` (AUTO_APPROVE_PAIRING_SCRIPT) | none |
| `push-heartbeat.sh` | `lib/ssh.ts:402` (PUSH_HEARTBEAT_SH) | none |
| `skill-integrity-check.sh` | `lib/ssh.ts:448` (SKILL_INTEGRITY_CHECK_SH) | `verify_or_heal_git_skill`, `SKILL_RECOVERED` |
| `ack-watchdog.py` | `lib/ssh.ts:3261` (ACK_WATCHDOG_SCRIPT) | `def is_turn_stalled`, `ACK_WATCHDOG_SLOW_WARNING` |
| `memory-snapshot.sh` | `lib/agent-intelligence.ts:1014` (MEMORY_SNAPSHOT_SCRIPT) | none |
| `generate_workspace_index.sh` | `lib/agent-intelligence.ts:961` (WORKSPACE_INDEX_SCRIPT) | none |
| `consensus_match_pipeline.py` | `lib/matchpool-scripts.ts` (lazy-registered) | `def build_l2_passthrough_deliberations`, `FALLBACK_ABORT_THRESHOLD`, `snapshot_anchor`, `CONSENSUS_MEMORY_PATH`, `maybe_send_match_notification`, `skip skill_disabled` |
| `consensus_match_rerank.py` | same | `RERANK_INSTRUCTIONS`, `fabrication rule`, `Banned phrases`, `def shuffle_candidates`, `x-call-kind: match-pipeline` |
| `consensus_match_deliberate.py` | same | `DELIBERATION_INSTRUCTIONS`, `fabrication rule`, `skip-reason discipline`, `def make_fallback`, `x-call-kind: match-pipeline` |
| `consensus_match_consent.py` | same | `VALID_TIERS`, `interests_plus_name` |
| `consensus_match_skill_toggle.py` | same | `TOGGLE_ENDPOINT`, `consensus-2026`, `def post_toggle` |
| `consensus_intent_sync.py` | same | `def check_skill_enabled`, `CONSENT_ENDPOINT`, `skip skill_disabled`, `MIN_EXTRACT_INTERVAL_SECONDS` |
| `consensus_intent_extract.py` | same | `HAIKU_MODEL`, `MIN_MEMORY_CHARS`, `def extract_intent` |
| `privacy-bridge.sh` | `lib/privacy-bridge-script.ts` (lazy-registered, edge_city only) | (Phase-1A defers — privacy bridge cutover is separate work stream) |

**All 17 scripts:** `chmod +x` required, owned by `openclaw:openclaw`.

---

## §4. Outer scripts at `/home/openclaw/scripts/`

| File | Source | Notes |
|---|---|---|
| `deliver_file.sh` | `lib/ssh.ts:2865` (DELIVER_FILE_SCRIPT) | chmod +x |
| `notify_user.sh` | `lib/ssh.ts:3018` (NOTIFY_USER_SCRIPT) | chmod +x |
| `token-price.py` | `lib/ssh.ts:3125` (TOKEN_PRICE_SCRIPT) | chmod +x |
| `dispatch-server.js` | `lib/dispatch-scripts.ts:834` (DISPATCH_SERVER_JS) | chmod +x; **CRITICAL** in configureOpenClaw (Rule 33 critical-failure) |
| `browser-relay-server.js` | `scripts/browser-relay-server/browser-relay-server.js` (read via fs at runtime) | chmod +x; **CRITICAL** |
| `check-skill-updates.sh` | `scripts/check-skill-updates.sh` (read via fs at runtime) | chmod +x |
| 22 dispatch scripts in `DISPATCH_SCRIPTS` object | `lib/dispatch-scripts.ts:16-833` | chmod +x for each |
| `package.json` | `{}` placeholder + `npm i ws` (lib/ssh.ts:7055-7056) | npm ws dependency installed |
| `node_modules/ws/` | npm ws install | populated |

---

## §5. Inline skills (17) at `/home/openclaw/.openclaw/skills/`

For each of the 17 inline skills, the snapshot must have:
- `SKILL.md` deployed
- `references/*.md` files deployed (where applicable)
- `assets/` or `scripts/` files deployed and chmod +x
- Any `~/scripts/<script-name>` mirror (e.g., `~/scripts/tts-openai.sh`) deployed

Skill list (per cloud-init-implementation-map §7.1):
1. `voice-audio-production/` — SKILL.md + references/voice-guide.md + 4 assets in `~/scripts/`
2. `email-outreach/` — SKILL.md + references/email-guide.md + 3 assets in `~/scripts/`
3. `financial-analysis/` — SKILL.md + references/finance-guide.md + 2 assets in `~/scripts/`
4. `competitive-intelligence/` — SKILL.md + references/intel-guide.md + 2 assets in `~/scripts/`
5. `social-media-content/` — SKILL.md + references/social-guide.md + 1 script in `~/scripts/`
6. `ecommerce-marketplace/` — SKILL.md + references/ecommerce-guide.md + 2 scripts in `~/scripts/`
7. `motion-graphics/` — SKILL.md + 2 references/ + 6 template files in `assets/template-basic/`
8. `brand-design/` — SKILL.md + references/brand-extraction-guide.md
9. `web-search-browser/` — SKILL.md + 2 references/ + crawlee-scrape.py in `~/scripts/`
10. `code-execution/` — SKILL.md + references/code-patterns.md
11. `sjinn-video/` — SKILL.md + 3 references/ + setup-sjinn-video.sh in `~/scripts/`
12. `marketplace-earning/` — SKILL.md only
13. `prediction-markets/` — SKILL.md + 6 references/ + 12 scripts in `~/scripts/`
14. `language-teacher/` — SKILL.md + 4 references/ + 3 language references + setup script
15. `solana-defi.disabled/` — SKILL.md + 5 references/ + 5 scripts in `~/scripts/` **(NOTE: `.disabled` suffix is required)**
16. `higgsfield-video/` — SKILL.md + 6 references/ + 8 scripts in skill scripts dir
17. `x-twitter-search/` — SKILL.md only
18. `agentbook/` — SKILL.md + 2 scripts (in skill dir AND `~/scripts/`)

Plus 3 manifest-only skills (deployed by `manifest.skillsFromRepo: true` walk, SKILL.md only):
- `frontier/` — SKILL.md (12,123 bytes)
- `newsworthy/` — SKILL.md (13,289 bytes)
- `instagram-automation/` — SKILL.md (12,470 bytes)
  - **Pre-existing gap (Cooper-acknowledged 2026-05-13):** scripts/*.py (10 files) NOT deployed. Bake should NOT add them; reconciler fix is a separate PR.

**Not deployed (no SKILL.md):**
- `xmtp-agent/` — only `scripts/xmtp-agent.mjs`. NOT deployed by stepSkills (filtered for missing SKILL.md). Deployed by `setupXMTP()` server-side post-configure via curl from GitHub.
- `shared/` — only `scripts/cron-guard.py`. Orphaned (not deployed by any code path I could find).

---

## §6. Git-cloned skills at `/home/openclaw/.openclaw/skills/`

The 4 external skills the snapshot must already have cloned (so cloud-init can skip the clone — though it's idempotent, the snapshot pre-clone saves provision time):

| Skill | Repo URL | Clone path | Overlay |
|---|---|---|---|
| `bankr` | `https://github.com/BankrBot/skills` | `~/.openclaw/skills/bankr` | **INSTACLAW_BANKR_PATCH_V1 overlay must be applied** to `~/.openclaw/skills/bankr/bankr/SKILL.md` AND `clanker` + `base` subdirs removed. Per Cooper 2026-05-13: cloud-init does write this overlay (production-critical). |
| `edge-esmeralda` | `https://github.com/aromeoes/edge-agent-skill.git` | `~/.openclaw/skills/edge-esmeralda` | INSTACLAW_OVERLAY.md written (separately from upstream SKILL.md). Cloud-init writes this for edge_city VMs. Snapshot need NOT clone this (universal vs. partner-conditional). |
| `consensus-2026` | `https://github.com/coopergwrenn/consensus-2026-skill.git` | `~/.openclaw/skills/consensus-2026` | None |
| `dgclaw` (sibling) | `https://github.com/Virtual-Protocol/dgclaw-skill` | `~/dgclaw-skill` (NOT under .openclaw/skills) | Handled by reconciler `installAgdpSkill`; out of cloud-init scope |

**Snapshot bake decision question for changelog terminal:**
- Should snapshot have `bankr` pre-cloned WITH the INSTACLAW_BANKR_PATCH_V1 overlay already applied? Currently the bake doesn't include this step explicitly — configureOpenClaw applies the overlay on every configure. Cloud-init also applies it (idempotent via marker grep). Either approach works.
- Should snapshot have `consensus-2026` pre-cloned? It's universal; pre-cloning saves a `git clone` per provision.
- Should snapshot have `edge-esmeralda` pre-cloned? It's partner-conditional. Cloud-init handles the conditional clone.

---

## §7. System packages (apt)

Snapshot must have these installed:
- `ffmpeg`, `jq`, `build-essential` (per VM_MANIFEST.systemPackages line 1931)
- `xvfb`, `xdotool`, `libx11-dev`, `libxext-dev`, `libxtst-dev`, `libpng-dev`, `openbox`, `imagemagick` (per ssh.ts:6970 dispatch deps)
- `x11vnc`, `websockify`, `novnc` (per ssh.ts:7001 live desktop viewer deps)
- `socat`, `netcat-openbsd` (per ssh.ts:7053 dispatch relay deps)
- `caddy` (for Caddyfile + reverse proxy)
- `fail2ban` (for cloud-init's defensive restart)
- `cron` (system service)
- `chromium-browser` at `/usr/local/bin/chromium-browser`
- `node_exporter` binary
- `python3` + `python3-pip`

---

## §8. Python packages (pip, --break-system-packages)

Per VM_MANIFEST.pythonPackages and inline configureOpenClaw installs:
- `openai`
- `crawlee[beautifulsoup,playwright]==1.5.0`
- `web3`, `py-clob-client`, `eth-account`, `websockets`, `cryptography`
- `solders`, `base58`, `httpx` (solders==0.27.1 per CLAUDE.md notes)

---

## §9. NPM global packages (via NVM as openclaw user)

- `openclaw@2026.4.26` (OPENCLAW_PINNED_VERSION)
- `@bankr/cli@0.3.1` (BANKR_CLI_PINNED_VERSION)
- `@worldcoin/agentkit-cli@0.1.3`
- `prctl-subreaper` (pinned per manifest)
- `usecomputer` (unpinned)
- `mcporter`
- `ws` (in `~/scripts/package.json`, not global)

---

## §10. Systemd units

**System (/etc/systemd/system/):**
- `xvfb.service` (ssh.ts:6979-6991)
- `x11vnc.service` (ssh.ts:7003-7016)
- `websockify.service` (ssh.ts:7019-7031)
- `ssh.service.d/oom-protect.conf` (per Rule 16 sshd OOM protection)

**User (`/home/openclaw/.config/systemd/user/`):**
- `openclaw-gateway.service` (from `openclaw gateway install`)
- `openclaw-gateway.service.d/override.conf` (manifest systemdOverrides + systemdUnitOverrides: TasksMax=120, KillMode=mixed, MemoryMax=3500M, ExecStartPre/ExecStopPost for memory snapshots, Delegate=yes, etc.)
- `openclaw-gateway.service.d/prctl-subreaper.conf` (v87 NODE_PATH + NODE_OPTIONS for prctl-subreaper)
- `dispatch-server.service`
- `browser-relay-server.service`

**Note for cloud-init Phase 1B canary:** the systemd unit files use NODE_VER substitution (e.g., `Environment=PATH=/home/openclaw/.nvm/versions/node/v22.22.2/bin:...`). The snapshot bake must substitute NODE_VER at bake time using the snapshot's actual `node --version` output. If the snapshot's NODE_PINNED_VERSION differs from the unit file's hardcoded NODE_VER, the gateway won't find node and won't start.

---

## §11. Crontab entries (openclaw user)

The 10 manifest crons (per VM_MANIFEST.cronJobs) + 1 baked-in SHM cleanup:

| Schedule | Marker | Command |
|---|---|---|
| `* * * * *` | `strip-thinking.py` | `python3 ~/.openclaw/scripts/strip-thinking.py > /dev/null 2>&1` |
| `* * * * *` | `auto-approve-pairing.py` | `python3 ~/.openclaw/scripts/auto-approve-pairing.py > /dev/null 2>&1` |
| `17 * * * *` | `skill-integrity-check.sh` | `bash ~/.openclaw/scripts/skill-integrity-check.sh > /dev/null 2>&1` |
| `0 * * * *` | `push-heartbeat.sh` | `bash ~/.openclaw/scripts/push-heartbeat.sh` |
| `0 4 * * *` | `openclaw memory index` | `. /home/openclaw/.nvm/nvm.sh && openclaw memory index >> /tmp/memory-index.log 2>&1` |
| `30 4 * * 0` | `workspace/backups` | `find ~/.openclaw/workspace/backups -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} + 2>/dev/null` |
| `*/30 * * * *` | `consensus_match_pipeline.py` | `python3 ~/.openclaw/scripts/consensus_match_pipeline.py >> /tmp/consensus_match.log 2>&1` |
| `*/15 * * * *` | `consensus_intent_sync.py` | `python3 ~/.openclaw/scripts/consensus_intent_sync.py >> /tmp/consensus_intent_sync.log 2>&1` |
| `* * * * *` | `ack-watchdog.py` | `python3 ~/.openclaw/scripts/ack-watchdog.py > /dev/null 2>&1` |
| `0 * * * *` | `SHM_CLEANUP` | (per CLAUDE.md snapshot bake step 5) |
| `0 3 * * *` | `check-skill-updates` | `/bin/bash $HOME/scripts/check-skill-updates.sh >> $HOME/.openclaw/logs/skill-updates.log 2>&1` |

**Cloud-init does NOT re-install these.** Per Cooper 2026-05-13: snapshot has them; reconciler heals if missing (3-min cycle). Step 13 of cloud-init §1 has been demoted from PER_USER to SNAPSHOT_BAKED single-line marker.

**Partner-conditional crons** (cloud-init writes these per-user):
- `*/30 * * * *` for edge-esmeralda git pull (only when partner=edge_city)
- `*/30 * * * *` for consensus-2026 git pull (universal; cloud-init writes if snapshot doesn't have it)

---

## §12. Configuration files

**Always overwrite from manifest (snapshot has, reconciler enforces):**
- `~/.openclaw/exec-approvals.json` — `{"version":1,"defaults":{"security":"full","ask":"off","askFallback":"full"},"agents":{}}` (VM_MANIFEST.files entry, mode `overwrite`)

**One-shot writes from snapshot bake:**
- `~/.openclaw/.openclaw-pinned-version` — contents `2026.4.26` (or current OPENCLAW_PINNED_VERSION)

**Caddyfile:** `/etc/caddy/Caddyfile` with `/vnc/*` reverse proxy block (per ssh.ts:7047-7050)

**Cloud-init writes these (NOT in snapshot — per-user):**
- `~/.openclaw/openclaw.json` (constructed from buildOpenClawConfig with per-user values)
- `~/.openclaw/agents/main/agent/auth-profiles.json` (per-user gateway token)
- `~/.openclaw/.env` (per-user, heredoc-base64 single write)

---

## §13. Other state

- **NVM** installed at `/home/openclaw/.nvm/` with `node v22.22.2` (NODE_PINNED_VERSION) as default
- **`.bashrc`** and `.bash_profile` for openclaw user with nvm-source lines (so `bash -lc` picks up node)
- **`loginctl linger` enabled** for openclaw user (so systemd-user-instance starts at boot)
- **mcporter binary** in `/home/openclaw/.nvm/versions/node/v22.22.2/bin/mcporter` (npm global)
- **SSH `authorized_keys`** for openclaw user with `instaclaw-deploy` + `instaclaw-deploy@vercel` ed25519 keys
- **Firewall rules** allowing 22 (SSH), 18789 (gateway from LAN), 18792 (browser relay localhost), 6080 (VNC websocket), 8765 (dispatch)

---

## §14. What cloud-init writes (NOT snapshot-baked — for completeness)

Per-user/per-VM:
- `~/.openclaw/openclaw.json` (constructed per-user)
- `~/.openclaw/agents/main/agent/auth-profiles.json` (per-user)
- `~/.openclaw/.env` (per-user, heredoc-base64)
- `~/.openclaw/workspace/IDENTITY.md` (per-user, agent name regex)
- `~/.openclaw/workspace/USER.md` (per-user)
- `~/.openclaw/workspace/WALLET.md` (per-user, conditional sections)
- `~/.openclaw/workspace/BOOTSTRAP.md` (per-user if Gmail, else SNAPSHOT_BAKED via WORKSPACE_BOOTSTRAP_SHORT)
- `~/.openclaw/workspace/WORLD_ID.md` (per-user conditional)
- `~/.openclaw/workspace/SOUL.md` partner stubs (per-user, idempotent append-or-skip)
- `~/.openclaw/agents/main/agent/system-prompt.md` (per-user)
- `~/.openclaw/wallet/agent.key` (per-VM, AgentBook key — generated server-side, written to disk)
- Edge City skill INSTACLAW_OVERLAY.md (partner-conditional)
- Bankr skill INSTACLAW_BANKR_PATCH_V1 overlay (universal, idempotent via marker)

---

## §15. Validation procedure for the changelog terminal

For each item in §1-§13, run the verification command against a freshly-baked snapshot VM. If any item is MISSING from the snapshot but listed here as SNAPSHOT_BAKED, escalate to Cooper before cloud-init Phase 1B (2026-05-25).

Suggested check approach:
1. Provision a single fresh VM from the new snapshot (cost: ~$0.04/hour during test)
2. SSH in as openclaw user
3. Run `find ~/.openclaw -maxdepth 5 -type f | sort` and compare to §1-§4 + §5 file lists
4. Run `crontab -l` and compare to §11
5. Run `systemctl --user list-units --all | grep openclaw` and compare to §10
6. Run `dpkg -l | grep -E "^(ii|hi).*(ffmpeg|jq|build-essential|xvfb|...)"` for §7
7. Run `pip3 list 2>/dev/null | grep -E "openai|crawlee|web3|solders"` for §8
8. Run `bash -lc 'npm list -g 2>/dev/null'` (as openclaw user) for §9

Any divergence → escalate before 2026-05-25.

---

## §16. Known uncertainties (flag to the changelog terminal)

These are items I'm classifying as SNAPSHOT_BAKED but I have lower confidence about — please verify explicitly:

1. **HEARTBEAT.md** — written by configureOpenClaw inline heredoc at lib/ssh.ts:5390-5481. Does the bake's extraction script pick this up?
2. **The 22 dispatch scripts in DISPATCH_SCRIPTS** — auto-generated from `skills/computer-dispatch/scripts/` by `scripts/_gen-dispatch-scripts.mjs`. Does the bake regen these?
3. **prctl-subreaper systemd drop-in** at `~/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf` — added in manifest v87. Is this in the bake checklist?
4. **`/etc/systemd/system/ssh.service.d/oom-protect.conf`** — manifest reconciler step deploys this. Is it baked, or does the reconciler heal on first cycle? (If reconciler-heal-only, cloud-init may want to write it for parity.)
5. **The pinned npm versions** (openclaw, @bankr/cli, @worldcoin/agentkit-cli) — confirm bake script uses the exact pinned versions, not "latest."

---

## §17. Verification cross-check (2026-05-14)

**Author:** Claude (Opus 4.7) — second-pass verification of §16 uncertainties and §1-§13 line references. Reading `lib/ssh.ts` / `lib/vm-reconcile.ts` / `lib/dispatch-scripts.ts` / `lib/vm-manifest.ts` at HEAD (commit `c3efe3e3` + ~14 successor commits).

### §16 resolutions

**Q1 — HEARTBEAT.md inline heredoc.** CONFIRMED present in configureOpenClaw, but the cited line range (`5390-5481`) is wrong. The heredoc actually opens at **`lib/ssh.ts:5370`** (`cat > "$AGENT_DIR/HEARTBEAT.md" << 'HBEOF'`). The doc's body-content lines (5390+) are mid-heredoc, not the bracket. Bake extraction must match the actual `<< 'HBEOF'` ... `HBEOF` bracket, not a fixed line range — line numbers drift on every commit to ssh.ts.

**Q2 — 22 dispatch scripts.** CONFIRMED at `lib/dispatch-scripts.ts:16` (`export const DISPATCH_SCRIPTS`) and `:834` (`export const DISPATCH_SERVER_JS`). Auto-generated by `scripts/_gen-dispatch-scripts.mjs` (per b3d58bc4). **Bake must re-run the gen script before extraction** so the constants reflect the latest `skills/computer-dispatch/scripts/*.sh` source.

**Q3 — prctl-subreaper drop-in.** SURPRISE: this is **reconciler-only, not configureOpenClaw**. Deploy code lives exclusively in `stepPrctlSubreaper` (`lib/vm-reconcile.ts`, see also `lib/vm-manifest.ts:822-876` for the manifest entry). configureOpenClaw does NOT emit this drop-in. Whether the bake produces it depends on the bake script's strategy:
- If the bake runs `configureOpenClaw` once → drop-in WILL BE MISSING from the snapshot. Fresh VMs lack prctl-subreaper until the reconciler heals (~3 min after first boot).
- If the bake runs a reconciler equivalent (e.g., walks `manifest.systemdUnitOverrides` and writes each drop-in directly) → drop-in present.

Per CLAUDE.md "Snapshot Creation Process" the bake's 15-point verification list doesn't explicitly check for `prctl-subreaper.conf`. **Action for the bake author:** either add an explicit step that mirrors `stepPrctlSubreaper` (the npm install + the drop-in write), or accept the 3-min reconciler-heal window. Document the choice.

**Q4 — `oom-protect.conf`.** SAME STORY AS Q3. The drop-in at `/etc/systemd/system/ssh.service.d/oom-protect.conf` is reconciler-only — `stepShdOomProtection` at `lib/vm-reconcile.ts:3438`. configureOpenClaw does NOT emit it. The `OOMScoreAdjust=500` at `ssh.ts:7130` is for a different unit (dispatch-server.service with score +500, *less* protected). The sshd drop-in needs `OOMScoreAdjust=-900` (highly protected) and lives only in vm-reconcile.ts.

**Q5 — `@worldcoin/agentkit-cli` version.** Hardcoded INLINE at `lib/ssh.ts:6889` as `@worldcoin/agentkit-cli@0.1.3`, **not** exported as a `*_PINNED_VERSION` constant. `OPENCLAW_PINNED_VERSION = "2026.4.26"` and `BANKR_CLI_PINNED_VERSION = "0.3.1"` ARE proper constants. The asymmetry is a drift risk: a future `npm install -g @worldcoin/agentkit-cli@latest` edit at line 6889 won't trigger anything that compares to a doc-cited version. Suggest: extract to a constant before bake (cheap, ~3 line change to ssh.ts).

### §1 line-number drift

The doc was written 2026-05-13. `lib/ssh.ts` has been modified since (Rule 35 channel-credential validator, etc.). All §1 line references have shifted by ~31 lines:

| Doc says | Actual today | Drift |
|---|---|---|
| CAPABILITIES.md deploy `lib/ssh.ts:5667` | `:5636` | −31 |
| QUICK-REFERENCE.md `:5668` | `:5637` | −31 |
| TOOLS.md `:5669` | `:5638` | −31 |
| EARN.md `:5672` | `:5639` | −33 |
| SOUL.md concat `:5631-5664` | `:5612` (concat) + `:3727` (WORKSPACE_SOUL_MD source) | varies |
| HEARTBEAT.md heredoc `:5390-5481` | start at `:5370` | −20 |

§15's verification commands are path-based (`test -f`) so they remain correct. But anyone using the doc as a code-tour reference will land on the wrong lines. Recommend the doc add a "verified-at-commit-SHA" note or switch citations to function names / constant names rather than line numbers.

### Recommendation summary

Before 2026-05-25 Phase 1B cutover:
1. **Bake script must explicitly handle `prctl-subreaper.conf` and `ssh.service.d/oom-protect.conf`** OR the bake validation step must check for their presence in the resulting snapshot. These are SNAPSHOT_BAKED per §10 but only configureOpenClaw is typically the bake source; these two live elsewhere.
2. **Extract `agentkit-cli` version to a constant** to mirror the OPENCLAW / BANKR pinning pattern. One-line refactor.
3. **HEARTBEAT.md bake-extraction must use heredoc-bracket matching**, not fixed line range, because ssh.ts is actively modified by other terminals.
4. **Update §1 line references** when the bake checklist is next revised (or replace line references with grep patterns).

---

**End of inventory. Cross-check against the bake audit and flag divergences before 2026-05-25.**

---

## §17b. Probe-verified discrepancies (2026-05-14)

**Author:** Claude (Opus 4.7) for Cooper Wrenn — pre-Day-8a inventory reconciliation per Cooper's directive: "setup.sh depends on knowing exactly which files are ALREADY on the snapshot vs which come from the tarball. if the doc is wrong, setup.sh will skip files it shouldn't or try to install files already there."

**Methodology.** Two SSH probes (read-only, find/ls/cat/crontab-l/dpkg-l/pip3-list/npm-list):
- **vm-944** — `status=ready`, `cv=0`, provisioned 2026-05-14T12:05Z. Pure snapshot state, never been configureOpenClaw'd. 6 hours of pool sitting, only cloud-init-poll touched it.
- **vm-050** — `status=assigned`, `cv=95`, `partner=edge_city`. Configured + reconciled + 6 weeks of user activity. Used to confirm that files MISSING on the fresh snapshot DO land later (via configureOpenClaw + reconciler) on a configured VM.

The delta (vm-050 has, vm-944 doesn't) = what configureOpenClaw + the reconciler ADD on top of the snapshot. The intersection = what's actually baked into the snapshot.

### §17b.1 Files PRESENT on the fresh snapshot that doc lists as PER_USER

The snapshot has default/placeholder versions of files configureOpenClaw later overwrites:

| File | Doc class | Snapshot state |
|---|---|---|
| `workspace/IDENTITY.md` | "NOT in snapshot" (per §1) | **PRESENT** — placeholder/default content; configureOpenClaw overwrites |
| `workspace/USER.md` | "NOT in snapshot" (per §1) | **PRESENT** — placeholder; configureOpenClaw overwrites if Gmail |
| `workspace/BOOTSTRAP.md` | "NOT in snapshot if Gmail; short version SNAPSHOT_BAKED" | **PRESENT** — actually IS the WORKSPACE_BOOTSTRAP_SHORT default (consistent with doc) |
| `workspace/AGENTS.md` | NOT MENTIONED ANYWHERE | **PRESENT** — additional file the doc doesn't list |

**Implication for setup.sh:** the `install -m 644` commands for IDENTITY.md / USER.md (Gmail-only) / BOOTSTRAP.md (Gmail-only) / WALLET.md / WORLD_ID.md (conditional) / MEMORY.md (Gmail-only) on Day 8a overwrite the snapshot's placeholders. This is the correct behavior — no need for setup.sh to detect "file already exists, skip" logic.

### §17b.2 Files MISSING from snapshot that doc lists as SNAPSHOT_BAKED

These are real gaps where the doc's claim ("snapshot has it, cloud-init can skip") is wrong:

| Section | File | Doc claim | Verified snapshot | configureOpenClaw deploys? | Day 8b BEST_EFFORT impact |
|---|---|---|---|---|---|
| §3 | `~/.openclaw/scripts/skill-integrity-check.sh` | SNAPSHOT_BAKED | **MISSING** | YES (lib/ssh.ts:448 + deploy step) | YES — must add to Day 8b BEST_EFFORT |
| §3 | `~/.openclaw/scripts/privacy-bridge.sh` | SNAPSHOT_BAKED (edge_city) | **MISSING** | YES (lazy-registered) | YES — partner-conditional Day 8b |
| §4 | `~/scripts/browser-relay-server.js` | **CRITICAL** | **MISSING** | YES (Rule 33 CRITICAL critical-failure step) | YES — Day 8b CRITICAL? Re-classify the doc OR ensure setup.sh deploys |
| §4 | `~/scripts/check-skill-updates.sh` | SNAPSHOT_BAKED | **MISSING** | YES (lib/ssh.ts:6378 cron line) | YES — Day 8b |
| §4 | `~/scripts/token-price.py` | SNAPSHOT_BAKED | **PRESENT** | (configureOpenClaw doesn't need to deploy) | ✓ correctly baked |
| §5 | `~/.openclaw/skills/frontier/SKILL.md` | SNAPSHOT_BAKED | **MISSING** | YES (manifest skillsFromRepo walk) | YES — Day 8b skill deploy |
| §5 | `~/.openclaw/skills/agent-status/` | NOT IN DOC | **MISSING** on snapshot, **PRESENT** on vm-050 | YES | YES — should be in doc |
| §5 | `~/.openclaw/skills/clawlancer/` | NOT IN DOC | **MISSING** on snapshot, **PRESENT** on vm-050 | YES | YES — should be in doc |
| §5 | `solana-defi/` rename to `.disabled` | "required" per doc note | **NOT RENAMED** on either snapshot or vm-050 | (doc is wrong; the .disabled suffix is unused) | Doc note can be removed |
| §8 | `crawlee[beautifulsoup,playwright]==1.5.0` | SNAPSHOT_BAKED | **MISSING** | YES (pip install during configure) | YES — Day 8b pip install |
| §8 | `web3` | SNAPSHOT_BAKED | **MISSING** | YES | YES |
| §8 | `solders==0.27.1` | SNAPSHOT_BAKED | **MISSING** | YES | YES |
| §8 | `eth-account` | SNAPSHOT_BAKED | **MISSING** | YES | YES |
| §8 | `websockets` | SNAPSHOT_BAKED | **MISSING** | YES | YES |
| §8 | `base58` | SNAPSHOT_BAKED | **MISSING** | YES | YES |
| §9 | `@worldcoin/agentkit-cli@0.1.3` | SNAPSHOT_BAKED | **MISSING** | YES | YES |
| §9 | `prctl-subreaper` | SNAPSHOT_BAKED | **MISSING** | reconciler-only (already documented §16 Q3) | reconciler heals; Day 8b can skip |
| §9 | `usecomputer` | SNAPSHOT_BAKED | **MISSING** | YES | YES |
| §9 | `mcporter` | SNAPSHOT_BAKED | **MISSING** | YES | YES |
| §10 | `/etc/systemd/system/xvfb.service` | SNAPSHOT_BAKED | **MISSING** | YES (lib/ssh.ts:6979) | YES |
| §10 | `/etc/systemd/system/x11vnc.service` | SNAPSHOT_BAKED | **MISSING** | YES | YES |
| §10 | `/etc/systemd/system/websockify.service` | SNAPSHOT_BAKED | **MISSING** | YES | YES |

### §17b.3 Files PRESENT on snapshot that doc doesn't list

These are "snapshot has, doc doesn't mention" — runtime artifacts and additions made to the bake recipe over time but not reflected in the 2026-05-13 doc:

- `~/.openclaw/scripts/gateway-health-textfile.sh` — Prometheus node-exporter textfile collector, looks new
- `~/.openclaw/agents/main/agent/models.json` — OpenClaw model registry
- `~/.openclaw/openclaw.json.hourly-*` — output of an hourly cron `cp openclaw.json openclaw.json.hourly-$(date +%H)`. Cron is on snapshot. Doc §11 doesn't list this cron.
- `~/.openclaw/openclaw.json.last-good`, `openclaw.json.bak.{0..4}` — backup rotation
- `~/.openclaw/update-check.json`, `watchdog-status.json`, `.watchdog-*` — runtime state files
- `crontab -l` extras: hourly `cp openclaw.json …hourly-N`, `*/5 * * * * sudo /usr/local/bin/openclaw-config-watchdog`, the duplicated git-pull crons (likely benign drift from a partner-cron deploy that didn't dedupe)

### §17b.4 The snapshot's `openclaw.json` has a real-looking gateway token

`~/.openclaw/openclaw.json` on vm-944 contains a 48-char hex token at `gateway.auth.token`. **Every fresh-from-snapshot VM starts with the SAME token** until configureOpenClaw rewrites it. Cloud-init's setup.sh overwrites `openclaw.json` in step 5 (CRITICAL), so the shared-token window is narrow (~30-60s during cloud-init's bootstrap → fetch → setup.sh path). Documented for awareness; not a Day 8a blocker.

### §17b.5 Snapshot directory inventory (verified)

Created at snapshot bake time, present on vm-944:

```
~/.openclaw/                    (mode 0700)
├── acpx/                       (3 files)
├── agents/main/agent/          (only models.json — auth-profiles + system-prompt are PER_USER)
├── agents/main/sessions/       (empty)
├── canvas/, completions/, flows/, identity/, logs/, memory/, plugins/, qqbot/, tasks/  (empty/template dirs)
├── plugin-runtime-deps/        (npm-installed openclaw plugin deps)
├── scripts/                    (16 scripts — see §17b.6)
├── skills/                     (23 skill dirs — see §17b.7)
├── workspace/                  (16 files — see §17b.8)
├── workspace/memory/           (active-tasks.md, session-log.md, MEMORY.md.bak)
├── .env                        (placeholder, ~38 bytes)
├── .openclaw-pinned-version    (contents "2026.4.26")
├── exec-approvals.json         (the {"version":1,...} default)
├── openclaw.json               (real-looking config with placeholder gateway token)
├── openclaw.json.{bak,hourly-*,last-good}  (rotation cron output)
├── update-check.json, watchdog-status.json, .watchdog-*, .session-summary-state.json
└── (NOT PRESENT: cron/, devices/, wallet/, audio-config.json, email-config.json)
```

**setup.sh Day 8a `install -d` is responsible for creating `~/.openclaw/wallet/` (mode 0o700)** — the snapshot does NOT have it. My Day 8a draft already includes the `install -d -o openclaw -g openclaw -m 700 /home/openclaw/.openclaw/wallet` line.

Likewise `cron/`, `devices/`, `audio-config.json`, `email-config.json` are absent on the snapshot — configureOpenClaw creates these conditionally (audio/email when their config is set). Cloud-init's setup.sh will need equivalent conditional installs for those that have per-user content (Day 8b — outside Day 8a CRITICAL scope).

### §17b.6 Snapshot `~/.openclaw/scripts/` (16 verified)

ack-watchdog.py, auto-approve-pairing.py, consensus_intent_extract.py, consensus_intent_sync.py, consensus_match_consent.py, consensus_match_deliberate.py, consensus_match_pipeline.py, consensus_match_rerank.py, consensus_match_skill_toggle.py, gateway-health-textfile.sh, generate_workspace_index.sh, memory-snapshot.sh, push-heartbeat.sh, silence-watchdog.py, strip-thinking.py, vm-watchdog.py

**Missing vs doc §3:** `skill-integrity-check.sh` (configureOpenClaw deploys it), `privacy-bridge.sh` (edge_city + lazy-registered).

**Extra (not in doc):** `gateway-health-textfile.sh`.

### §17b.7 Snapshot `~/.openclaw/skills/` (23 verified)

agentbook, bankr, brand-design, code-execution, competitive-intelligence, computer-dispatch, dgclaw, ecommerce-marketplace, email-outreach, financial-analysis, higgsfield-video, instagram-automation, language-teacher, marketplace-earning, motion-graphics, newsworthy, prediction-markets, sjinn-video, social-media-content, solana-defi, voice-audio-production, web-search-browser, x-twitter-search

**Missing vs doc §5:** `frontier/` (configureOpenClaw skillsFromRepo deploys it).
**Missing (configured-VM-only):** `agent-status/`, `clawlancer/` (configureOpenClaw deploys).
**Doc-claim-wrong:** `solana-defi.disabled/` — the snapshot has `solana-defi/` (no .disabled suffix); doc note can be removed.

### §17b.8 Snapshot `~/.openclaw/workspace/` (16 verified)

AGENTS.md, BOOTSTRAP.md (short version), CAPABILITIES.md, EARN.md, HEARTBEAT.md, IDENTITY.md (placeholder), MEMORY.md, QUICK-REFERENCE.md, SOUL.md, TOOLS.md, USER.md (placeholder), `.bootstrap_consumed`, plus memory/ + workspace-state.json under `.openclaw/`

**Doc §2 says HEARTBEAT.md lives at `agents/main/agent/HEARTBEAT.md`. SNAPSHOT REALITY: HEARTBEAT.md is at `workspace/HEARTBEAT.md`.** This is the same finding as my pre-audit notes — line 5390 in configureOpenClaw writes to AGENT_DIR but the snapshot bake's extraction placed it at workspace/. Either the bake or the doc has the path wrong. Cloud-init must not double-write HEARTBEAT.md to both paths.

### §17b.9 Day 8a impact

**None of these discrepancies block Day 8a.** Day 8a's CRITICAL steps (5/6/9/32/38) operate on the per-user content the tarball delivers; they overwrite snapshot placeholders cleanly:

| Step | Snapshot has | Day 8a behavior |
|---|---|---|
| 5 (openclaw.json + auth-profiles.json) | placeholder openclaw.json (real gateway token); no auth-profiles.json | `install -m 600` overwrites both |
| 6 (.env) | placeholder .env (~38 bytes) | `install -m 600` overwrites |
| 9 (workspace files + wallet/agent.key) | snapshot has IDENTITY/USER/BOOTSTRAP/WALLET placeholders; NO wallet/ dir; NO agent.key | `install -d` creates wallet/, then `install -m 644/0600` puts files |
| 32 (gateway start) | snapshot has openclaw-gateway.service user unit + override.conf | `systemctl --user start` works |
| 38 (callback POST) | independent of snapshot | works |

### §17b.10 Day 8b impact (deferred work)

Day 8b's BEST_EFFORT steps must deploy/install everything in §17b.2 (the 22-line "MISSING from snapshot" table). Specifically:

1. Deploy `~/.openclaw/scripts/skill-integrity-check.sh` (snapshot doesn't have it; the cron expects it).
2. Deploy `~/scripts/browser-relay-server.js` (Rule 33 — was CRITICAL in SSH path; classify as Day 8b CRITICAL).
3. Deploy `~/scripts/check-skill-updates.sh` + add the cron line.
4. Deploy frontier skill (universal manifest skill).
5. Deploy agent-status + clawlancer skills.
6. `pip install --break-system-packages crawlee[beautifulsoup,playwright]==1.5.0 web3 solders==0.27.1 eth-account websockets base58`.
7. `npm install -g @worldcoin/agentkit-cli@0.1.3 usecomputer mcporter` (prctl-subreaper handled by reconciler).
8. Deploy `/etc/systemd/system/{xvfb,x11vnc,websockify}.service` unit files + enable.
9. Edge City overlay write + skill clone (partner-conditional).

These are Day 8b's responsibility. Document scope clarified.

### §17b.11 Recommended bake-script updates (separate work)

When the snapshot is re-baked (2026-05-23 → 2026-05-25 per doc header), the bake script SHOULD add the items in §17b.2 (preferred — cloud-init's setup.sh can be shorter and Day 8b lighter). If the bake author elects to defer (smaller bake-script diff), Day 8b must cover all 22 missing items.

Tracking: this remediation list is the doc's source of truth for the bake author. Lines from §17b.2 marked **YES** in the "Day 8b BEST_EFFORT impact" column are the cloud-init's responsibility unless the bake script adds them first.

---

**End of §17b. Day 8a is unblocked.**
