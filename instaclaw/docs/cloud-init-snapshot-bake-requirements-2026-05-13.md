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

**End of inventory. Cross-check against the bake audit and flag divergences before 2026-05-25.**
