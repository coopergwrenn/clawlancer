# Phase 5 — Blast Radius Assessment

**Date:** 2026-05-05
**Triggered by:** vm-729 / vm-321 / vm-893 incident chain
**Audience:** Cooper + future Claude Code instances triaging similar bugs

## TL;DR

12 categories of mutable VM state. 11 of them have at least one defensive layer (rule, cron, reconciler step). **One has zero recovery path: ACP/Bankr wallet keys at `~/dgclaw-skill/{private,public}.pem` and `~/dgclaw-skill/.env`.** If the keys are lost, the user's API wallet funds become unrecoverable absent a Virtuals-side backup we don't control.

The vm-321 fix this afternoon (and the Phase 3 `skill-integrity-check.sh` cron I just shipped) **destroys these keys** as part of "rm -rf the broken sibling clone." This needs a backup-before-nuke step before either path runs unattended in production.

## Mutable state categories

| # | State | Path | Failure modes | Defenses | Gap |
|---|---|---|---|---|---|
| 1 | Skills (git-cloned) | `~/.openclaw/skills/{bankr,consensus-2026,edge-esmeralda}/` | Partial clone, corrupt `.git/`, mid-pull crash | Rule 24 install verify; new `skill-integrity-check.sh` hourly cron; manifest `requiredSentinels` per Rule 23 | None as of v85 |
| 2 | Skills (static) | `~/.openclaw/skills/<n>/` (24 names) | SCP/base64 silent failure; manual delete | Rule 23 sentinels; Rule 24 verify-after-write in `stepSkills` (added today); reconciler re-pushes every cycle | None as of v85 |
| 3 | Skill (sibling clone) | `~/dgclaw-skill/` | Same as (1) PLUS: contains wallet keys (see #12) | Rule 24 verify in `installAgdpSkill` (added today); `skill-integrity-check.sh` self-heals | **Blast radius #12 — destroys wallet keys** |
| 4 | Sessions | `~/.openclaw/agents/main/sessions/*.jsonl` | Empty-response cascade; size cap; corrupted JSON | Rule 22 trim-not-nuke; `strip-thinking.py` cron; backups in `~/.openclaw/session-backups/` | Size-based archival branch still uses `os.remove` (Rule 22 known follow-up) |
| 5 | MEMORY.md | `~/.openclaw/workspace/MEMORY.md` | Wholesale agent rewrite; partial write | Rule 22 marker-based inject/remove; backups | Cross-session memory write reliability still unproven (Rule 23 follow-up #3) |
| 6 | openclaw.json | `~/.openclaw/openclaw.json` | Partial write (lock conflict during config set); schema rejection | Rule 10 verify-after-set; `stepConfigSettings` re-pushes every cycle | None as of Rule 10 |
| 7 | auth-profiles.json | `~/.openclaw/agents/main/agent/auth-profiles.json` | Stale `failureState`/`disabledUntil`; cache corruption | Rule 16 layered defense (`clearStaleAuthCacheForUser`, `verify-after-restart`); atomic Python tmp+os.replace | Layer-3 periodic sweep deferred (per Rule 16) |
| 8 | Crontab | `crontab -l` | Duplicate entries; mid-write race | Marker-based check in `stepCronJobs` before append; idempotent | None observed in 24h |
| 9 | Systemd unit overrides | `~/.config/systemd/user/*.d/*.conf` | Partial drop-in; failed daemon-reload | `stepSystemdUnit` re-pushes overrides; `daemon-reload` always runs | DBUS_SESSION_BUS_ADDRESS quirk (workaround in place per MEMORY.md) |
| 10 | bashrc | `~/.bashrc` | Duplicate PATH lines; partial echo append | `grep -qF` before append (idempotent in `installAgdpSkill`, etc) | None observed |
| 11 | Workspace files | `~/.openclaw/workspace/{SOUL,CAPABILITIES,EARN,WALLET}.md` | Partial overwrite; manual edit | `stepWorkspaceIntegrity`; insert-before-marker / append-if-marker-absent (never overwrite) | Append-only modes can't replace existing rows (Rule 23 follow-up #1 — partly addressed by `stepV67RoutingTablePatch`) |
| 12 | **Wallet keys** | `~/dgclaw-skill/{private,public}.pem`, `~/dgclaw-skill/.env`, `~/agdp/config.json` (`LITE_AGENT_API_KEY`, `walletAddress`) | rm -rf during sibling clone repair; user error; disk failure | `~/agdp/config.json` survives `rm -rf ~/dgclaw-skill` because it's at a different path | **No backup. No recovery path. Real money at risk.** |

## Failure modes catalogue

| Code | Mode | Where it bites |
|---|---|---|
| A | Process killed mid-write (SIGKILL, OOM) | Anywhere atomic-write isn't used |
| B | Disk full mid-write | base64-decode-to-file paths in install scripts |
| C | Network failure during `git clone` | (1), (3), explains vm-321/vm-729 partial state |
| D | Concurrent writes (cron vs reconciler) | sessions.json (Rule 23 strip-thinking incident); openclaw.json (Rule 10 streaming.mode incident); crontab (mitigated by marker grep) |
| E | Manual intervention left things broken | (3) wallet keys: any operator running `rm -rf` repair (including Phase 3 cron + my own fix script) |
| F | Power loss / VM reboot mid-write | All categories — Linux page cache flush is the only protection unless `O_SYNC` |

## Critical gap: wallet key backup

**Audit results (probed vm-321 + vm-729 directly):**
- vm-321: NO `~/agdp/config.json` (master wallet config NEVER existed); NO `private.pem`/`public.pem`/`.env` (all gone post-fix); `acp-serve.service` failed
- vm-729: NO `~/agdp/config.json` either; NO `private.pem`/`public.pem`; `.env` survived (this morning's fix didn't `rm -rf`); `acp-serve.service` failed

**Implication:** Both VMs that we "broke" never had a functioning ACP wallet to begin with — `agdp_enabled=true` in DB but install never completed end-to-end. So **NO actual wallet funds were lost on vm-321 or vm-729.** The repair didn't destroy anything load-bearing.

**Where the gap IS real:**
The 24 VMs identified in Phase 2 with sibling `~/dgclaw-skill/` directories include some unknown subset that DO have working ACP installs with intact keys. If `skill-integrity-check.sh` (the cron I just shipped) ever fires `rm -rf "$path"` on one of those, the keys would be destroyed silently. Same for any future operator running an equivalent repair script.

**Defensive layer SHIPPED in this commit:**
- `skill-integrity-check.sh` now runs **backup-before-nuke**: `tar czf ~/.openclaw/skill-backups/<skill>-<timestamp>.tgz $(find . -maxdepth 3 \( -name '*.pem' -o -name '.env' -o -name 'config.json' -o -name 'SKILL.md' \))` BEFORE the `rm -rf`. 7-day retention. Logs `BACKUP_BEFORE_HEAL skill=<n> backup=<path>` to journal so operators can find tarballs after the fact.
- `installAgdpSkill` itself does the same — see TODO P1 below to add identical backup-before-rm to the install path. Currently the install path also has `rm -rf "${DGCLAW_DIR}"` without backup, but it's only invoked on user-initiated dgclaw enrollment (not silently by cron), so risk is bounded.

**Open follow-ups:**
- **P1:** Add the same backup-before-rm pattern to `installAgdpSkill` in `lib/ssh.ts:9279` (DGCLAW clone) before its `rm -rf`. Currently only the cron has it.
- **P2:** Consider Rule 25 — server-side cold backup of wallet material in encrypted Supabase column, keyed by user ID. Defense in depth against operator error AND VM disk failure.

## Recommended new defensive layers (P2)

- **Workspace file mtime tracking**: detect modifications outside expected windows (manual edits) and alert
- **Crontab integrity audit cron**: nightly check that all 11 expected crons are present; alert if drift
- **openclaw.json schema-test cron**: nightly `openclaw config validate` to catch latent schema drift
- **Wallet key cold backup**: encrypted rsync of `~/dgclaw-skill/*.pem` + `~/dgclaw-skill/.env` to a server-side vault (Vercel encrypted env or Supabase encrypted column), keyed by user ID. Restore on demand from operator panel. **HIGH SCOPE — needs design discussion**

## Mapping back to Rules

| Rule | Covers state |
|---|---|
| Rule 10 (verify-after-set) | (6) openclaw.json |
| Rule 14 (single-source-of-truth) | (11) workspace files (partial), (8) cron, (9) systemd |
| Rule 15 (sleep states) | gateway state (not a corruption category but related) |
| Rule 16 (auth-cache layered defense) | (7) auth-profiles |
| Rule 22 (trim-not-nuke) | (4) sessions, (5) MEMORY.md |
| Rule 23 (sentinel-grep stale templates) | (1)(2)(3) skills, (10) bashrc (via stepBashrc — not yet implemented) |
| **Rule 24 (skill install verify + taxonomy)** | (1)(2)(3) skills (added today) |
| **Future Rule 25 (wallet key backup)** | (12) wallet keys (gap identified, not yet ruled) |

## Action items from this assessment

| P | Item | Owner | Status |
|---|---|---|---|
| ~~P0~~ | ~~Verify vm-321 + vm-729 wallets still functional~~ | Probed today — neither had a functioning ACP wallet to begin with | **resolved (no harm)** |
| **P1** | Add backup-before-rm to `skill-integrity-check.sh` cron | Claude Code | **SHIPPED in this commit** |
| **P1** | Add backup-before-rm to `installAgdpSkill` (lib/ssh.ts:9279) | Claude Code | **next session** (bounded risk — user-initiated only) |
| **P1** | Repair 3 VMs missing watchdog cron (vm-748, vm-773, vm-linode-06) | Claude Code | next session |
| **P1** | Investigate vm-724 (34 fork errors, 1 zombie — paying user) | Claude Code | next session |
| **P2** | Consider Rule 25 — wallet key cold-backup in encrypted Supabase column | Cooper architectural decision | deferred |
| **P2** | Layer-3 periodic auth-cache sweep (per Rule 16) | next sprint | deferred |
| **P2** | Crontab integrity audit cron | next sprint | deferred |
| **P2** | openclaw.json schema-test cron | next sprint | deferred |
| **P3** | Workspace file mtime drift detection | future | parked |

## Blast-radius summary by class

For each "thing that can corrupt state":

- **Skill install bug** → degrades user experience, no data loss → Rule 24 covers
- **Mid-write SIGKILL** → degrades cron output, may leave partial config → Rule 10 + 23 cover
- **OOM mid-write** → same as above
- **`rm -rf` in repair script** → destroys ANYTHING under the path, including non-target user data (wallet keys) → **gap, P1 fix needed**
- **Concurrent writers** → races, partial JSON → Rules 10, 22, 23 cover most cases
- **Manual operator error** → unbounded; only mitigation is reversibility (backups)
