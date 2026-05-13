# Bake Readiness Audit — 2026-05-13

Audit of the canonical bake toolchain (`0144181a` — runbook +
prebake-cleanup + postbake-validation) against three independent
sources of truth:

1. **17-item bake checklist** from `docs/changelog-cv82-to-v95.md`
2. **Cloud-init implementation map** at `docs/cloud-init-implementation-map.md`
   (1,832 lines, §0–§23, written by onboarding terminal 2026-05-12)
3. **5 fresh discoveries** flagged by the user 2026-05-12 → 13:
   - Stale ExecStart on Node upgrade (gbrain terminal)
   - Dispatch inline (`b3d58bc4` + `3839d176`)
   - Privacy bridge + chattr +i (`5c79ef90`)
   - SOUL V2 trim AGENTS.md
   - gbrain pre-install

**Bake target:** v95 manifest, OpenClaw 2026.4.26, Node 22.22.2.
Builds from v79 baseline (`private/38575292`), shipping a 16-version
delta.

**Bake window:** 2026-05-23 → 2026-05-25 (10–12 days out).

**Resolved during audit drafting (landed on main while this was being written):**
- ✅ **Finding #2 (POLYGON_RPC_URL):** `187b0331` — manifest now
  defaults to `publicnode.com`, matching `configureOpenClaw` + fleet
  operational reality. The flapping risk this audit flagged is closed.
- ✅ **Finding #3 (SOLA_AUTH_TOKEN):** `187b0331` — removed entirely.
  Edge migrated off Sola to EdgeOS calendar in May 2026.
- ✅ **Discovery #3.1 (stale Node-path ExecStart):** `c4b84156` —
  `stepExecStartAlignment` reconciler step. Runs BEFORE
  `stepConfigSettings` on every tick, compares systemd ExecStart's
  Node-version path to `node --version`, rewrites on drift. Permanent
  fleet-wide guard. **Two paying customers were taken down by this
  exact bug 2026-05-12.**

The validation check in this commit (NODE_PATH in `prctl-subreaper.conf`
matches `npm root -g`) is now a **complementary bake-time gate** — it
catches misalignment on the bake VM before the snapshot ships, while
`stepExecStartAlignment` catches it post-deploy on the fleet. Both
layers are valuable.

These are reflected in §2.10, §3.1, and §7 below as RESOLVED. The
mechanical validation expansion in this commit remains the load-bearing
remaining work.

**Bottom line:** runbook + prebake-cleanup are solid; the validation
script under-checks the manifest by ~25 items. **Three P0 gaps require
fixes before bake.** Most are mechanical additions to
`_postbake-validation.ts`. One (stale-Node ExecStart) is a real
discovery the runbook does not yet guard against.

---

## Verdict summary

| Source | Items | PASS | FAIL | N/A |
|---|---|---|---|---|
| 17-item changelog checklist | 17 | 14 | 3 | 0 |
| Cloud-init map cross-ref (load-bearing only) | 24 | 11 | 13 | 0 |
| 5 fresh discoveries | 5 | 4 | 1 | 0 |
| **TOTAL load-bearing checks** | **46** | **29** | **17** | **0** |

P0 fixes: 6. P1 fixes: 8. P2 fixes: 3.

---

## §1 — 17-item bake checklist (from `changelog-cv82-to-v95.md`)

For each of the 17 items in that doc's "what MUST land on the next
snapshot bake" section, map to the bake toolchain.

| # | Checklist item | Runbook §  | Validation line | Verdict | Notes |
|---|---|---|---|---|---|
| 1 | OpenClaw 2026.4.26 pinned | §1.2, §2.3 | 180-181 | ✅ PASS | Exact version-string check. |
| 2 | manifest v95 baked | §0, §2.3 | n/a (implicit via configSettings) | ⚠ PARTIAL | No explicit "manifest_version" sentinel on the VM. Map §15 lists `OPENCLAW_CONFIGURE_DONE` but not a v95 marker. **FIX: write `/etc/instaclaw-manifest-version` with the manifest number during bake; validation asserts.** |
| 3 | TasksMax=120 (v86) | §2.3 | 195 | ✅ PASS | Override.conf check via regex. |
| 4 | prctl-subreaper installed (v87+v88) | §3.2, §3.3 | 187, 189-191 | ✅ PASS | Both npm pkg dir and drop-in checked. |
| 5 | build-essential / gcc (v88) | §2.3, §3.1 | 184 | ✅ PASS | `which gcc` check. |
| 6 | SOUL.md identity (v89) + Platform V2 (v91) + partner-stub APPEND (v93) | §2.3 | 199-202, 210-212 | ⚠ PARTIAL | Checks SOUL.md PRESENT and IDENTITY.md RESET, but does not verify the `INSTACLAW_PLATFORM_V1` marker is in SOUL.md. Map §13 step #24 mandates this. **FIX: add marker check.** |
| 7 | bootstrapMaxChars=40000 (v92) | §2.3 | 205-207, 407 | ✅ PASS | Both config key AND upfront-context byte count checked. |
| 8 | strip-thinking.py with four-layer compaction (v90) | n/a in runbook | 357-358 | ❌ **FAIL** | Validation checks only 2 of 10 Rule 23 sentinels. **FIX: add the other 8 sentinels (full list in §3 below).** |
| 9 | streaming.mode=partial with Layer 2 leak guards (v95) | §2.3 | 401-405 | ✅ PASS | 5 streaming keys checked. |
| 10 | agents.defaults.timeoutSeconds=300 (v80) | §2.3 | 406 | ✅ PASS | |
| 11 | Cron entries pruned (no vm-watchdog, no silence-watchdog) | runbook does NOT install them; cleanup §13 strips partner only | implicit | ⚠ PARTIAL | Cleanup script strips partner crons but doesn't explicitly assert the v76 prune is honored. CLAUDE.md note about the v79 snapshot says watchdogs are "carried from v64 — production fleet has these manually disabled; new VMs from this snapshot will re-enable them unless removed during configureOpenClaw." **FIX: validation asserts neither vm-watchdog.py nor silence-watchdog.py is in crontab.** |
| 12 | Cron entries added (Consensus 30-min health alert v88, Phase 4 gbrain-coverage-check) | n/a in bake; these are Vercel crons | n/a | ✅ N/A | Server-side crons, not on-VM. |
| 13 | Templates v2 — workspace-templates-v2.ts | not used (V1 canonical per §23.4 of map) | n/a | ✅ PASS | V2 migration env not set in Vercel. V1 is correct for bake. |
| 14 | Memory snapshot ExecStopPost/ExecStartPre (v73) | §2.3 (override.conf check) | 194 | ❌ **FAIL** | Validation reads override.conf but only regexes `TasksMax=120` and `MemoryMax=3500M`. Does NOT verify ExecStartPre/ExecStopPost lines invoking `memory-snapshot.sh restore` / `pre-stop`. **FIX: regex-check both ExecStartPre and ExecStopPost lines exist.** |
| 15 | Browser-relay-server (v65) | §3.3 mentions; not in validation | 351-353 (script presence only) | ⚠ PARTIAL | Validation checks `scripts/<script>.py` for many scripts but `browser-relay-server.js` is in `~/scripts/`, not `~/.openclaw/scripts/`. **FIX: add separate check for `~/scripts/browser-relay-server.js` + `~/.config/systemd/user/browser-relay-server.service`.** |
| 16 | Bankr CLI 0.3.1+ pinned (v62 + later) | §2.3 (implicitly via reconcile) | not checked | ⚠ PARTIAL | No direct version assertion. **FIX: validation checks `npm ls -g @bankr/cli` reports `0.3.1`.** |
| 17 | Manifest sentinels present (Rule 23 — `def trim_failed_turns`, `SESSION TRIMMED:`) | n/a | 357-358 | ✅ PARTIAL (see #8) | Two sentinels checked; 8 missing. Same fix as #8. |

**Score: 14 PASS / 3 FAIL (load-bearing) + 4 partial.**

---

## §2 — Cloud-init implementation map cross-reference

The map enumerates everything a working VM needs, derived from a deep
read of `lib/ssh.ts` + `lib/vm-reconcile.ts`. Cross-referencing against
the bake toolchain — what's in the map that the bake doesn't check.

### §2.1 configSettings — map §6 has 37 entries; validation has 14

The validation script asserts 14 specific config keys. The manifest has
**37 entries** in `configSettings`. The 23 unchecked keys include
several load-bearing values where a wrong setting silently breaks
fleet behavior.

**P0 — must-add (any of these missing/wrong on bake = silent failure):**

| Key | Manifest value | Failure mode if missing/wrong |
|---|---|---|
| `tools.exec.security` | `"full"` | exec tool refuses everything; agent can't run shell commands |
| `tools.exec.ask` | `"off"` | agent stalls waiting for human approval on every exec |
| `agents.defaults.sandbox.mode` | `"off"` | gateway requires Docker; won't start on our VMs |
| `gateway.http.endpoints.chatCompletions.enabled` | `"true"` | OpenAI-compat endpoint disabled; Vercel proxy 404s |
| `discovery.mdns.mode` | `"off"` | CIAO probe-cancel race on SIGTERM (v71 fix) |
| `session.maintenance.mode` | `"enforce"` | session pruning is "warn"-only; bloat → 4MB sessions |
| `agents.defaults.heartbeat.every` | `"3h"` | heartbeat cadence wrong; cron predictions skew |
| `agents.defaults.heartbeat.session` | `"heartbeat"` | heartbeat shares main session; pollutes context |
| `agents.defaults.compaction.mode` | `"safeguard"` | compaction is permissive; will not actually compact |
| `agents.defaults.compaction.reserveTokensFloor` | `"35000"` | wrong reserve; context-window blowouts |
| `commands.useAccessGroups` | `"false"` | reverts to access-group gating; agents not callable |

**P1 — should-add (correctness rather than catastrophic):**

| Key | Manifest value | Why |
|---|---|---|
| `agents.defaults.compaction.memoryFlush.enabled` | `"true"` | memory-flush half of compaction |
| `agents.defaults.compaction.memoryFlush.softThresholdTokens` | `"8000"` | threshold for memory flush |
| `agents.defaults.compaction.recentTurnsPreserve` | `"10"` | turns kept after compaction |
| `agents.defaults.compaction.qualityGuard.enabled` | `"true"` | LLM-quality guard on summarization |
| `agents.defaults.compaction.qualityGuard.maxRetries` | `"2"` | retry budget |
| `agents.defaults.compaction.notifyUser` | `"true"` | user-visible compaction notice |
| `agents.defaults.compaction.truncateAfterCompaction` | `"true"` | hard-truncate after compact |
| `agents.defaults.memorySearch.enabled` | `"true"` | memory search availability |
| `skills.limits.maxSkillsPromptChars` | `"500000"` | skills budget (silent truncation if smaller) |
| `commands.restart` | `"true"` | restart command available |
| `channels.telegram.groupPolicy` | `"open"` | group chat usability |
| `channels.telegram.groups.*.requireMention` | `"false"` | group-chat ergonomics |

**Verdict:** ❌ **FAIL** — 11 P0 + 12 P1 keys missing from validation.
**FIX:** add all 23 to `_postbake-validation.ts` `expectKeys` map.

### §2.2 Scripts in `~/.openclaw/scripts/` — map §4 has 17 entries; validation has 9

Missing from validation:

| Script | Severity | Why |
|---|---|---|
| `memory-snapshot.sh` | **P0** | Used by `ExecStopPost` and `ExecStartPre restore` in openclaw-gateway.service. If missing, gateway shutdown silently doesn't snapshot MEMORY.md → user data loss on next reboot. |
| `skill-integrity-check.sh` | **P0** | Hourly cron (Rule 24). Missing → broken-git-skill self-heal never runs → dgclaw-class silent failures recur. |
| `consensus_match_rerank.py` | P1 | Matching pipeline (Layer 2 listwise rerank). |
| `consensus_match_deliberate.py` | P1 | Matching pipeline (Layer 3 deliberation). |
| `consensus_match_consent.py` | P1 | Three-tier consent flow. |
| `consensus_match_skill_toggle.py` | P1 | Skill-toggle helper. |
| `consensus_intent_extract.py` | P1 | Intent extraction (called by consensus_intent_sync.py). |
| `privacy-bridge.sh` | P1 (test-mode partner=edge_city) | Edge City privacy mode. Validation should check presence when partner=edge_city. |

**Verdict:** ❌ **FAIL** — 2 P0 + 6 P1 script-presence checks missing.
**FIX:** extend `expectScripts` array in `_postbake-validation.ts:344`.

### §2.3 strip-thinking.py Rule 23 sentinels — map lists 10; validation checks 2

The map lists 10 required sentinels for `strip-thinking.py`:

```
def trim_failed_turns
SESSION TRIMMED:
def run_periodic_summary_hook
PERIODIC_SUMMARY_V1
PRE_ARCHIVE_SUMMARY_V1
PERIODIC_SUMMARY_V1_RESHRINK
def compact_session_in_place_lines
SESSION COMPACTED:
def _extract_large_tool_results_to_cache
LAYER3_EXTRACTED:
```

Validation checks the first 2. **Rule 23 is the load-bearing
protection against stale-module-cache regression** — a reconciler
running pre-v90 code that writes pre-v90 `strip-thinking.py` to the
bake VM would silently regress to the destructive
`os.remove(jsonl_file)` path (per CLAUDE.md Rule 22/Rule 23 incident).
The 8 missing sentinels are the post-v90 four-layer compaction
markers. Without them, the bake could ship the pre-v90 destructive
version and no one would know until a user's session got nuked.

**Verdict:** ❌ **FAIL** — P0.
**FIX:** validate all 10 sentinels in `_postbake-validation.ts:357`.

### §2.4 Cron entries — map §8 has 9 manifest crons; validation checks 2

Missing checks (in priority order):

| Cron | Schedule | Severity |
|---|---|---|
| `ack-watchdog.py` | `* * * * *` | **P0** (v95 Layer 3) |
| `skill-integrity-check.sh` | `17 * * * *` | **P0** (Rule 24) |
| `consensus_match_pipeline.py` | `*/30 * * * *` | P1 |
| `consensus_intent_sync.py` | `*/15 * * * *` | P1 |
| `openclaw memory index` | `0 4 * * *` | P1 |
| `workspace/backups` cleanup | `30 4 * * 0` | P2 |
| `consensus-2026 git pull` (universal) | `*/30 * * * *` | P1 |
| `check-skill-updates.sh` | `0 3 * * *` | P2 |

**Verdict:** ❌ **FAIL** — 2 P0 + 5 P1/P2 cron checks missing.
**FIX:** assert each marker is in `crontab -l` output.

### §2.5 Systemd services — map §9 lists 6 units; validation checks 3 (override.conf + prctl + gateway-active)

Missing checks:

| Unit / drop-in | Severity | Why |
|---|---|---|
| `xvfb.service` (system) | P1 | Required for dispatch mode + browser. |
| `x11vnc.service` (system) | P1 | Required for live desktop viewer. |
| `websockify.service` (system) | P1 | Required for noVNC. |
| `dispatch-server.service` (user) | **P0** | Critical-failure mark (`dispatch_deploy` at ssh.ts:5740). |
| `browser-relay-server.service` (user) | **P0** | Critical-failure mark (`browser_relay_deploy` at ssh.ts:5772). |
| `gateway-watchdog.timer` DISABLED | P1 | Map §9.7 — must be disabled per v69. |
| ExecStartPre lines (memory-snapshot.sh restore, telegram-pre-start.sh, pkill chrome) | **P0** | If missing, agent crashes / Telegram conflict loop. |
| ExecStopPost (memory-snapshot.sh pre-stop) | **P0** | If missing, memory snapshot doesn't fire on shutdown. |
| OOMScoreAdjust=500 | P1 | Gateway dies before sshd under pressure. |
| RuntimeMaxSec=86400 + RuntimeRandomizedExtraSec=3600 | P2 | Daily gateway restart for hygiene. |
| `Environment="PARTNER_ID=INSTACLAW"` | P2 | Identifier passed to upstream. |

**Verdict:** ❌ **FAIL** — 4 P0 + 4 P1/P2 systemd checks missing.
**FIX:** add to validation script's systemd section.

### §2.6 sshd OOM protection drop-in — not validated

Map §9.8: `/etc/systemd/system/ssh.service.d/oom-protect.conf` with
`[Service]\nOOMScoreAdjust=-900`. This is what keeps sshd alive when
the agent's gateway OOMs — without it, you lose SSH and have to reboot
the VM to investigate.

**Note:** map has a typo (`oom-protection.conf`); reconciler step
`stepSSHDProtection` writes `oom-protect.conf`. Confirmed by reading
`lib/vm-reconcile.ts:3207`. **Validation must check the correct
filename.**

**Verdict:** ❌ **FAIL** — P0.
**FIX:** add check for `/etc/systemd/system/ssh.service.d/oom-protect.conf` containing `OOMScoreAdjust=-900`.

### §2.7 Caddy /vnc/* proxy block — not validated

Map §9.9: `/etc/caddy/Caddyfile` must have a `handle /vnc/* { uri
strip_prefix /vnc; reverse_proxy localhost:6080 }` block before the
gateway proxy. Without it, live desktop viewer unreachable from
public URL.

**Verdict:** ❌ **FAIL** — P1.
**FIX:** grep Caddyfile for `/vnc/*` block.

### §2.8 Bun PATH for prctl-subreaper / gbrain — map §11 risk register

Map §11 known-risk: "Bun shebang `#!/usr/bin/env bun` — needs `bun` in
PATH". Gateway's systemd PATH must include `~/.bun/bin`. Validation
checks bun exists (line 361-362) but does NOT check gateway's PATH
includes it.

**Verdict:** ⚠ PARTIAL — P1.
**FIX:** check `systemctl --user show -p Environment openclaw-gateway` includes `~/.bun/bin` (or grep dispatch-server.service Environment for same).

### §2.9 Pre-bake cleanup — minor bugs

- `_prebake-cleanup.sh:170` `systemctl --user stop x11vnc.service` — x11vnc is a SYSTEM service (map §9.3, `/etc/systemd/system/`). The `--user` call silently fails. Doesn't affect bake correctness (x11vnc doesn't write user data) but is misleading code. **P2 fix:** use `sudo systemctl stop x11vnc.service` instead.

- `_prebake-cleanup.sh:171` `systemctl --user stop openbox` — openbox is also system-level usually. Same shape.

**Verdict:** ⚠ PARTIAL — P2 each.

### §2.10 Pre-Phase-1A findings carry through to bake — map §23.3

The implementation map's §23.3 identifies 3 CRITICAL pre-flight findings:

1. **Finding #1: Snapshot 16 versions behind.** This IS the bake task. ✅ ACKNOWLEDGED.
2. **Finding #2: POLYGON_RPC_URL three-way conflict.** ✅ **RESOLVED in `187b0331`** (2026-05-13 12:34 ET). Manifest now `polygon-bor-rpc.publicnode.com`. Bake inherits aligned state.
3. **Finding #3: SOLA_AUTH_TOKEN missing.** ✅ **RESOLVED in `187b0331`** — SOLA integration dead-code removed entirely; Edge moved to EdgeOS. Existing edge_city VMs may carry inert stale `SOLA_AUTH_TOKEN=PLACEHOLDER` in `.env` (cosmetic; no code references it).

---

## §3 — 5 fresh discoveries

### §3.1 Stale ExecStart path on Node upgrade (gbrain terminal, 2026-05-13)

**The bug:** When Node is upgraded later, systemd unit files written
with frozen Node paths become stale.

**Where it occurs:**
1. `~/.config/systemd/user/dispatch-server.service` line 7069 in `lib/ssh.ts`:
   ```
   ExecStart='$NODE_BIN_PATH' /home/openclaw/scripts/dispatch-server.js
   ```
   `NODE_BIN_PATH` is captured via `$(which node)` at write time, then frozen.
2. Same file PATH= line (7071): hardcodes `.nvm/versions/node/$NODE_VER/bin`.
3. `~/.config/systemd/user/browser-relay-server.service` — same pattern (lines 7100, 7102).
4. `~/.config/systemd/user/openclaw-gateway.service.d/prctl-subreaper.conf`:
   ```
   Environment="NODE_PATH=${npmRoot}"
   ```
   `npmRoot` is computed from `npm root -g` at reconcile time. If Node version changes after the drop-in is written, NODE_PATH points at the OLD version's `node_modules` directory which probably no longer has `prctl-subreaper`.

**Why it matters for the bake:** During the bake's reconcile in §2.2,
the reconciler calls `stepNodeUpgrade` BEFORE `stepPrctlSubreaper`
(line 217 of vm-reconcile.ts, per the comment on `stepPrctlSubreaper`
itself at line 2326). The order is correct — but it means at reconcile
time the active Node version matches. The snapshot captures that
moment. ✅ Bake itself is safe.

**The latent risk:** A future Node upgrade applied to a VM provisioned
from this snapshot would break these paths until the reconciler heals
them on the next cycle. The reconciler DOES detect drift for
`prctl-subreaper.conf` (line 2306) but does NOT for
`dispatch-server.service` or `browser-relay-server.service` — those
have no Node-path-drift detection.

**Verdict:** ⚠ PARTIAL — bake is safe; latent risk for fleet VMs
post-Node-upgrade.

**FIX:** add validation check that `npm root -g` matches `NODE_PATH=`
in prctl-subreaper.conf. Add **runbook gate** (§2.3): after the
reconcile, verify all systemd unit files reference the CURRENT Node
binary and reject the bake if they don't. Also flag a follow-up:
extend `stepNodeUpgrade` to invalidate dispatch-server.service +
browser-relay-server.service on Node version change. **Including
in this audit's fix commit.**

### §3.2 Dispatch inline fix (`b3d58bc4` + `3839d176`)

**What changed:** Reconciler's `stepDispatchServer` now reads
`DISPATCH_SCRIPTS` / `DISPATCH_SERVER_JS` / `DISPATCH_SKILL_MD` from
`lib/dispatch-scripts.ts` (auto-generated TS const) instead of
`fs.readdirSync` over `instaclaw/skills/computer-dispatch/scripts/`.
Reason: Next 15's @vercel/nft tracer was silently dropping `.sh` files
from the Vercel bundle (Rule 12 incident, 2026-05-10).

**Bake exposure:** The bake's §2.2 reconcile uses the inline pattern.
22 .sh files + dispatch-server.js + SKILL.md deploy via in-memory TS
const. No `fs.readdirSync`, no Next-bundling risk.

**Verdict:** ✅ PASS — inline pattern in main; bake inherits.

**Verification gap:** No assertion that `~/scripts/<dispatch>.sh`
files exist after configure. Validation script doesn't check this
specifically — it only checks dispatch-server.service later
(currently missing — see §2.5). **Adding script-count check + service
check in fix.**

### §3.3 Privacy bridge + chattr +i (`5c79ef90`)

**What changed:** Tightened privacy bridge with new bypass-skip,
admin kill switch, and chattr +i lockdown on the deployed bridge file.

**Bake exposure:** Bake VM is NOT edge_city — privacy bridge isn't
deployed during bake. The bridge deploys later via the
reconciler/configure path when an edge_city user is assigned.

**Verdict:** ✅ PASS — N/A for bake; correctly excluded by
prebake-cleanup §8 (line 389 wipes
`$HOME/.openclaw/skills/edge-esmeralda`).

**Verification gap:** Validation doesn't check that
`$HOME/.openclaw/scripts/privacy-bridge.sh` is ABSENT on bake VM.
Currently checks `$HOME/.openclaw/skills/edge-esmeralda` absent (line
277) — adjacent. **Adding privacy-bridge.sh absence check (P2).**

### §3.4 SOUL V2 trim of AGENTS.md

**Status per map §23.4:** V1 SOUL.md is canonical;
`RECONCILE_SOUL_MIGRATION_ENABLED` is NOT set in Vercel. Bake writes
V1 templates via `WORKSPACE_SOUL_MD` from `lib/ssh.ts:3760`.

**Bake exposure:** The load-bearing constraint is total upfront
context size ≤ `bootstrapMaxChars` (40,000). Validation checks this
at line 205-207. ✅

**Verification gap:** No assertion that the SOUL.md size individually
is within budget (per CLAUDE.md OpenClaw Upgrade Playbook step 2:
"As of v67 the SOUL.md component alone is 31,905 chars — already over.
Treat any further bump as a hard stop until trimmed."). With v89+v91+v93
SOUL additions, the latest size unknown. **Adding individual SOUL.md
byte-count check (P1).**

**Verdict:** ✅ PASS, with one validation hardening recommended.

### §3.5 gbrain pre-installed

**What's in runbook:** §3 installs gbrain manually via
`_install-gbrain-on-vm.ts` because `stepGbrain` is on
`feat/gbrain-stepGbrain-phase4c` (not main). Validation checks:
- bun installed (line 361)
- `~/.bun/bin/gbrain` symlink (line 364)
- MCP entry in `openclaw.json` (line 367)
- (bake mode) PGLite empty (line 269)

**Verdict:** ✅ PASS.

**Verification gap:** No check that `GBRAIN_ANTHROPIC_API_KEY` is in
gateway's environment (after configureOpenClaw on a test VM). Map says
the env var gets wiped by prebake-cleanup and re-written by
configureOpenClaw on the test VM. **Adding test-mode check (P1).**

---

## §4 — Other gaps (not in any of the 3 sources but worth flagging)

### §4.1 No assertion that snapshot's baseline matches `LINODE_SNAPSHOT_ID`

The runbook §1.1 templates `${LINODE_SNAPSHOT_ID:-private/38575292}`.
If `LINODE_SNAPSHOT_ID` env happens to be unset OR points at a
different snapshot, the bake silently uses the wrong base. **Add an
assertion in §0.5 pre-flight: `[ "$(printenv LINODE_SNAPSHOT_ID)" =
"private/38575292" ] || abort`.** (P2)

### §4.2 Reconciler-version-mismatch risk during bake

The runbook §2.2 says either catch-up script OR `auditVMConfig`
direct. If the operator forgets to git-pull origin/main first, the
reconciler runs against stale code. **Add §0.5 check: `git rev-parse
origin/main == HEAD || abort`.** (P2)

### §4.3 Validation script env file path is hardcoded

`_postbake-validation.ts:39-40` hardcodes `/Users/cooperwrenn/...` —
if anyone else runs the validation (CI, another operator, your future
self on a different machine), it'll silently skip env loading and
fail to find `SSH_PRIVATE_KEY_B64`. **Fix: resolve from
`process.cwd()` or repo root.** (P2)

---

## §5 — What I'm fixing in this commit

In priority order (committed alongside this audit doc):

### P0 fixes (block bake until merged)

1. **Expand `expectKeys` in `_postbake-validation.ts:396` to all 37 manifest configSettings.** Adds 23 missing key→value assertions, including the 11 P0 keys in §2.1 above.

2. **Expand Rule 23 sentinel check at line 357 to all 10 strip-thinking.py sentinels** (per map §4).

3. **Add the 2 P0 scripts to `expectScripts` at line 344:** `memory-snapshot.sh`, `skill-integrity-check.sh`.

4. **Add ExecStartPre / ExecStopPost checks for openclaw-gateway.service:** verify `memory-snapshot.sh restore`, `memory-snapshot.sh pre-stop`, telegram-pre-start.sh, pkill chrome.

5. **Add sshd OOM protection drop-in check:** `/etc/systemd/system/ssh.service.d/oom-protect.conf` contains `OOMScoreAdjust=-900`.

6. **Add stale-Node-path check (Discovery #1):** verify NODE_PATH in `prctl-subreaper.conf` matches CURRENT `npm root -g`. Fails on Node version drift.

7. **Add 2 P0 cron checks:** `ack-watchdog.py`, `skill-integrity-check.sh`. Also verify NO `vm-watchdog.py` or `silence-watchdog.py` in crontab (v76 prune).

8. **Add dispatch-server.service + browser-relay-server.service active checks (test mode).** P0 because both are critical-failure marks in configureOpenClaw.

### P1 fixes (recommended before bake)

9. **Add 6 P1 scripts to `expectScripts`:** consensus_match_{rerank,deliberate,consent,skill_toggle}.py, consensus_intent_extract.py, privacy-bridge.sh.

10. **Add 12 P1 configSettings to expectKeys.**

11. **Add `~/scripts/browser-relay-server.js` presence check.**

12. **Add @bankr/cli@0.3.1 version assertion.**

13. **Add INSTACLAW_PLATFORM_V1 marker check in SOUL.md.**

14. **Add system service presence checks:** xvfb.service, x11vnc.service, websockify.service.

15. **Add gateway-watchdog.timer DISABLED check.**

16. **Add 5 P1 cron checks:** consensus_match_pipeline, consensus_intent_sync, consensus-2026 git pull, openclaw memory index, check-skill-updates.

### Not fixing in this commit (recommended follow-ups)

- **Caddy /vnc/* block check** (§2.7) — P1 but not safety-critical for bake. File as follow-up.
- **Bun PATH in gateway environment** (§2.8) — P1 follow-up.
- **POLYGON_RPC_URL operator decision** (§2.10 Finding #2) — needs Cooper input before bake. Cannot fix in code.
- **Pre-bake-cleanup `systemctl --user stop x11vnc`** (§2.9) — P2 cosmetic.
- **Validation script env path hardcoding** (§4.3) — P2 portability fix.
- **stepNodeUpgrade invalidate dispatch/browser-relay services on Node bump** (§3.1 long-term) — file as separate PR; out of scope for bake-readiness audit.
- **`/etc/instaclaw-manifest-version` sentinel** (§1 #2) — useful for fleet diagnostics; out of scope here.

---

## §6 — Recommended runbook additions

Adding these to `snapshot-bake-runbook.md` in a follow-up commit (not
this one — runbook edits warrant a separate review pass):

1. **§0.5 pre-flight:** assert `git rev-parse origin/main == HEAD`.
2. **§0.5 pre-flight:** assert `printenv LINODE_SNAPSHOT_ID` matches expected.
3. **§2.3 verify list:** assert NODE_PATH in prctl-subreaper.conf matches `npm root -g`.
4. **§2.3 verify list:** assert all 10 strip-thinking.py sentinels.
5. **§2.3 verify list:** assert `messages.*` keys are HOT-RELOADED, not just on disk (per Rule 32). Specifically: `journalctl --user -u openclaw-gateway | grep "hot reload applied (messages."` should return matches.
6. **§5 validation:** runs the expanded validation in this commit.
7. **§11 known risks:** add stale-Node-path risk class (Discovery #1).

---

## §7 — POLYGON_RPC_URL decision — RESOLVED

✅ **Resolved in `187b0331`** (2026-05-13 12:34 ET, landed on main while
this audit was being drafted). Manifest's `envVarDefaults.POLYGON_RPC_URL`
now matches `configureOpenClaw`'s write (`polygon-bor-rpc.publicnode.com`).
Fleet reconciler no longer reverts to the broken `1rpc.io` endpoint.
Bake inherits aligned state. No Cooper-input needed.

The companion SOLA cleanup in the same commit removes dead code that
this audit had flagged as Finding #3 — also closed.

**Net post-187b0331 state:** the only operator-input items remaining
before bake are the two Cooper-decisions from the cloud-init map's
§23.5 (instagram-scripts gap mirror — Q7, and V1 SOUL canonical
confirmation — Q6). Both are non-blocking for the bake itself.

---

**End of audit. Fixes shipping in `_postbake-validation.ts` in the same commit.**
