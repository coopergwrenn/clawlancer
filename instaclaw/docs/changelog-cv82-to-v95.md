# Changelog: cv=82 → v95 (2026-04-15 → 2026-05-12)

Reference document for the **May 23-25 snapshot bake**. Every commit on
`origin/main` since 2026-04-15, mapped to its manifest version,
categorized, and split into "already in the v79 snapshot" vs "only in
code, must propagate on bake."

Generated manually 2026-05-12. The automated equivalent lives at
`scripts/generate-changelog.ts` and writes `docs/changelog-latest.md`.

---

## Snapshot baseline

| Anchor | Snapshot ID | Manifest at bake | Baked | Status |
|---|---|---|---|---|
| Old | `private/38458138` | v62 | 2026-04-27 | Rollback target (keep until 2026-05-10) |
| **Current** | `private/38575292` | **v79** | 2026-05-03 | What `LINODE_SNAPSHOT_ID` points at |
| Next | TBD | v95+ | 2026-05-23 → 2026-05-25 | This doc's target |

**Drift gap:** 16 manifest versions (v80 → v95) are in code but not in
the current snapshot. New VMs land at v79, reconciler catches them up.

**Version-line gaps to note:**
- **v70** — commit `347ef1a7` mentions "manifest v70 — Phase 1 of SOUL.md restructure" in the message, but the version line in `vm-manifest.ts` jumped 69 → 71 (commit `5ff04ba5`). v70 effectively skipped on disk.
- **v94** — commit `0712ba01` jumped 93 → 95. v94 skipped intentionally.

---

## Manifest version timeline

Each version below is one reconciler "deploy" — a `config_version` bump
that pushes the change to every VM running an older version. Date is
the version-bump commit date.

### v59 — 2026-04-22 — `e6ac015e` — enable gateway.openai.chatCompletionsEnabled

Enables OpenAI-compatible `POST /v1/chat/completions` endpoint on the
gateway. Required for Vercel-side proxy and external integrations.

### v60 — 2026-04-22 — `9e783f92` — install pinned @bankr/cli@0.2.15

`configureOpenClaw()` now installs the pinned Bankr CLI during VM
provisioning. **Reconciler adds.**

### v61 — 2026-04-23 — `bfd36690` — fix broken chat-completions config key

Bugfix: v59 had a typo in the config key name.

### v62 — 2026-04-27 — `678c2263` — pin @bankr/cli@0.3.1 (direct claim API)

Upgraded Bankr CLI to 0.3.1 for direct claim API target. Auxiliary:
`4eacc619` bumps `LINODE_SNAPSHOT_ID` to `private/38458138` (the v62
snapshot itself). **This is the prior bake's baseline.**

In-window auxiliary commits (non-version, but on the v59→v62 stretch):
- `91597aff` docs(bankr): post-Sinaver claim API integration review checklist
- `28ac6187` feat(xmtp): proactive first-message on VM provisioning (#2)
- `913fcfc6` feat(vm-lifecycle): Phase 2 — orphan reconciliation pass + audit log
- `21ac38b7` fix(xmtp): always refresh xmtp-agent.mjs on configure (atomic)
- `f4fc7634` scripts: post-outage ops toolkit (recovery + audit + fleet probes)
- `1822ea57` fix(cron/health-check): per-VM deadline + cron lock to prevent batch-wide hangs
- `26efbdd8` feat(cron): Pass 0 recovers orphaned paid users with no VM
- `f4c8e55a` feat(reconcile): Phase 2c — strict-mode fleet reconciliation
- `9801bdd0` fix(reconcile): enforce agents.defaults.model.primary to prevent OpenAI default
- `35a2e87d` fix(gateway): intercept rate-limit + auth-failure errors before they leak to chat
- `821925cc` feat(reconcile): auto-heal pinned npm globals (@bankr/cli + openclaw)
- `697bcd72` feat(vm-lifecycle): Phase 3 — freeze/thaw pattern
- `636139a9` fix(vm-lifecycle): Phase 3 audit — 8 safety fixes

### v63 — 2026-04-27 — `0fa562d3` — silence-watchdog: only inspect telegram-origin sessions

Stops the silence-watchdog cron from firing on non-Telegram sessions
(false positives were restarting healthy gateways serving API users).

### v64 — 2026-04-28 — `65f79dae` — Node 22.22.2 + OpenClaw 2026.4.26 pinned upgrade

**The v67 incident-trigger upgrade.** Bumps Node and OpenClaw versions
in `OPENCLAW_PINNED_VERSION`. Tighter default timeouts in 2026.4.26
caused the multi-day fleet outage; subsequent v67–v75 versions are the
chain of fixes. See the OpenClaw Upgrade Playbook in CLAUDE.md.

In-window: `c5f394c2` temporarily disabled `reconcile-fleet` cron during
the v64/v65 upgrade; `6c043902` cleaned the disable up; `17b78313`
restored the original cron config.

### v65 — 2026-04-28 — `e85666d9` — wire browser-relay-server into configureOpenClaw

Adds the local relay (`127.0.0.1:18792`) that emulates CDP for the
Chrome extension running OpenClaw's old protocol. **`configureOpenClaw()`
now installs and starts `browser-relay-server.js`.** Required because
OpenClaw 2026.4.26 dropped the embedded relay.

Auxiliary: `f0b8ad45` adds the relay code; `57675e78` includes it in
Next file tracing; `be95b11a` npm cache clean before openclaw install.

### v66 — 2026-04-29 — `83eff391` — bankr-skill InstaClaw overlay

Kills the `clanker/` subdir from the Bankr skill, drops Solana
misroutes. **Reconciler-applied skill content change.**

In-window: `e39ab619` wires deploy plumbing for browser-use skill
(Tier 3.25 Phase 2).

### v67 — 2026-04-29 — `2229080d` — bump v66 → v67 — token-launch framing in upfront context

Moves "launch a token = Base via Bankr" framing into SOUL.md routing
table + CAPABILITIES.md wallet table (was previously only in skill
docs, which agents lazy-load).

In-window — **v67 emergency-response sprint** (post-outage):
- `7a3cfa51` fix(v67): bump `agents.defaults.timeoutSeconds` 60 → 90s, watchdog FROZEN 3min → 5min
- `d18d59a5` fix(v67): bump watchdog FROZEN further 5 → 10min
- `83155a1b` docs: expand OpenClaw Upgrade Playbook from v67 incident
- `d6487e88` docs: add Fleet Upgrade Lessons section
- `9dfe894b` fix(agent-context): scope token launches to Base in upfront-loaded surfaces
- `b886c924` fix(v67-routing): fleet patch + reconciler step (`stepV67RoutingTablePatch`)
- `25e55e14` feat(upgrade-fleet): wave-based concurrency=5 with audit gates
- `f623cdec` fix(reconcile): npm install timeout 360s→600s
- `44e779a1` fix(fleet-patch): don't bump config_version + add from-disk reset script
- `bf46ee3d` fix(configure): guard against wipe-on-already-onboarded-user
- `ef472917` fix(reconcile): npm install timeout 180s→360s + on-disk verify
- `d3d40a39` fix(reconcile): Bug D + 60s gateway health timeout
- `b3cfdaae` feat(bankr-skill): fleet patch script — apply overlay to live VMs now

### v68 — 2026-04-30 — `6679afe8` — watchdog uptime guard + telegram streaming off

Adds an uptime-based grace period to the watchdog and switches
`channels.telegram.streaming.mode = "off"` (was leaking tool-call
internals into chat). Auxiliary: `c07accec` closed a JSDoc comment so
v68 history could compile (CLAUDE.md Rule 12 incident).

### v69 — 2026-04-30 — `d967db50` — disable gateway watchdog timer fleet-wide

**The right fix for the watchdog kill-loops.** Disables the in-VM
watchdog timer entirely; systemd `Restart=on-failure` handles real
crashes. Pivotal change — directly addressed the v64-induced kill loop.

### v70 — 2026-04-30 — (commit `347ef1a7` "Phase 1 of SOUL.md restructure")

Version line on disk skipped from 69 → 71. The actual content change
(SOUL.md restructure Phase 1) landed in this commit but never advanced
the manifest counter. Cross-reference if debugging "v70" claims in old
logs.

### v71 — 2026-05-01 — `5ff04ba5` — disable mDNS + weekly backup prune

`discovery.mdns.mode = "off"` (Bonjour broadcast was triggering a CIAO
probe-cancel race on SIGTERM). Also adds a workspace-backup-prune cron
to delete dirs older than 14 days.

In-window: `27b24cc1`, `0baa0575` SOUL.md restructure design docs;
`bf053e9a` verify config-set in non-strict reconciler path; `5a1db4c5`
feat(cron): expire pending WLD delegations after 6h.

### v72 — 2026-05-01 — `5d6c0d07` — SOUL.md cache boundary marker

Adds `<!-- OPENCLAW_CACHE_BOUNDARY -->` to SOUL.md to split the system
prompt into Anthropic-cached prefix vs dynamic suffix. **1000× cheaper
Learned Preferences edits** (14K tokens → 10 cache_write tokens).

### v73 — 2026-05-01 — `731d41ec` — MEMORY.md backup + auto-restore (Phase 1)

ExecStopPost snapshots `MEMORY.md` before every gateway shutdown.
ExecStartPre restores ONLY if current is <50B (template-empty). Never
overwrites populated files.

### v74 — 2026-05-01 — `f2a8679a` — StartLimitAction=stop→none

`stop` is an invalid value for `StartLimitAction` and was silently
dropped — kill-loop protection was non-functional until this fix.

### v75 — 2026-05-01 — `f8f23353` — split StartLimit* into [Unit] section

Companion fix to v74. `StartLimit*` keys belong in `[Unit]`, not
`[Service]`. Were being silently dropped before.

In-window: build cleanup commits `f6049ab7`, `cfdcfa74` (tsconfig
excludes for wild-west-bots build), `4e2fed9a` (daily cleanup-feed
cron), `1058c330` (kill switch for heartbeat-driven buy_listing).

### v76 — 2026-05-01 — `1a2fc677` — remove vm-watchdog + silence-watchdog from cron

Removes both watchdog cron entries from the manifest cron schedule.
Carries from v69 (gateway watchdog kill) to userland (cron-side
watchdogs). Closes the loop on the v67 incident chain.

### v77 — 2026-05-02 — `2665ba31` — migrateExistingSoulMd reconciler step + kill switch (default OFF)

Adds `stepMigrateSoulV2` to the reconciler. **Default-off** behind
`RECONCILE_SOUL_MIGRATION_VM_IDS` env var allow-list. Begins the SOUL
v2 rollout (still gated).

In-window: `4bb354cd` introduces `workspace-templates-v2.ts` (no
behavior change yet); `3ccda655` PRD update; `b1c4ef3c` corrects bankr
SKILL.md path + softens partner-gated edge refs; `0fdbd037` per-VM
whitelist gate.

### v78 — 2026-05-02 — `cb52f1ec` — edge-privacy components 5-9

Privacy bridge: expire cron, audit log, SSH bridge, reconciler step,
cutover script. Foundation for Edge City Maximum Privacy Mode.

In-window:
- `85613f7a` feat(edge-privacy): components 1-3 — DB migration, toggle API, dashboard route
- `0b164436` feat(edge-privacy): component 3 — internal check API for SSH bridge
- `1da128be` fix(edge-privacy): lazy-load privacy-bridge.sh to survive Turbopack page-data collection
- `221c8be4` fix: wake-from-hibernation paths + auth-cache clear + watchdog v2
- `0523e5cf` fix(health-check): verify gateway active after billing-cache restart

### v79 — 2026-05-02 → 03 — `fa1193a4` — edge-privacy QA blockers (newline injection, fail-open, openclaw backdoor)

**Final manifest version baked into the current snapshot.** Privacy
bridge QA fixes — newline injection, fail-open behavior, OpenClaw
backdoor. This is what `private/38575292` ships with.

In-window:
- `a495680d` fix(strip-thinking): trim trailing empty turns, never nuke active session (CLAUDE.md Rule 22)
- `fee5324d` docs(rule-22): full incident history + fleet pusher for trim-not-nuke fix
- `599b9a1c` docs(CLAUDE.md): cut over to v79 snapshot private/38575292
- `b3fa5297` feat(consensus): partner skill for Consensus 2026 Miami (May 5-7)
- `0fefd764` feat(consensus): also install consensus skill for edge_city partners
- `e430426e` fix(wake-vm): handle BOTH 'hibernating' AND 'suspended' states (Rule 15)
- `9883dd17` docs(CLAUDE.md): add Rules 14-21 from this sprint's 9 internalized lessons
- `f0db1dfc` fix(watchdog,wake): QA fixes 1-4 — must-have before WATCHDOG_V2_MODE=active

---

## Versions NOT in the v79 snapshot — must propagate on next bake

These 16 versions live in code and are pushed to existing VMs via the
reconciler, but new VMs from `private/38575292` start at v79 and need
to be caught up.

### v80 — 2026-05-03 — `e285e68f` — periodic-summary hook unblocked when session shrinks

Fixes a silent gate where `new_msgs` went negative after compaction
and the periodic-summary throttle fired forever.

In-window:
- `18eed486` fix(timeout): bump `agents.defaults.timeoutSeconds` 90 → 300 (3-min response on vm-780)
- `cb4d425a` fix(memory): cross-session persistence layered fix (SOUL reorder + bootstrap bump + periodic summary)
- `bfb09037` ops(memory-deploy): operational scripts + fleet bump infra
- `58e59e0e` fix(reconcile): sentinel guard + race fix + Rule 23

### v81 — 2026-05-03 → 04 — `51ef0cd4` — matchpool fleet wiring for matching pipeline

Manifest entries for the Consensus matching pipeline (intent extraction,
on-VM scripts, cron entries).

In-window — matchpool components 2-10 + bankr-card polish:
- `0c34ef11` feat(matchpool): component 2 — embedding helper
- `f5d19bb9` feat(matchpool): component 3 — intent extraction on user VMs
- `0b6585fe` feat(matchpool): component 4 — VM-side intent sync + bridge
- `c9368e88` feat(matchpool): component 5 — POST /api/match/v1/profile
- `93094391` feat(matchpool): components 6-10 + hardening pass — full pipeline shipped
- `77a178bf` feat(matchpool): Telegram notification + ghost pool seed
- `bab5e37f` fix(gateway): heartbeat reclassification bypass for match pipeline
- `d099a5af` fix(matchpool,bankr): canary v81 + Telegram sanitization + brand orange
- `f209f0c6`/`8fde9dfb`/`1546122f` fix(consensus): record count sweep
- `73aea3d3` feat(consensus/matches): preview page for the intent-matching demo
- `ef6cecab` fix(consensus): universal skill install + fleet backfill + free-trial copy
- `7b02fbcf` docs(prd): consensus intent matching v2 — adds Layer 3 deliberation + XMTP intro negotiation

### v82 — 2026-05-04 — `327888af` — SOUL.md awareness for matching engine

SOUL.md additions teaching the agent about the matching engine + intent
extraction. **This is the cv=82 anchor in the title.**

In-window:
- `ff82a847` tools(fleet): controlled v82 rollout at concurrency=3

### v83 — 2026-05-04 — `259477ba` — pipeline + intent_sync gate on skill state

Gates the entire matching pipeline on `consensus-2026` skill state.
Non-attendees pay zero Haiku/Sonnet cost.

### v84 — 2026-05-04 — `5859048c` — Path 2 §Organic Activation helper

When users mention "Consensus 2026" with the skill OFF, agent offers to
enable matching. Soft conversion path.

In-window:
- `17b1a20d` fix(watchdog): suppress probe_healthy writes + 48h retention cron
- `4b28f8f3` feat(matchpool): Path 1 — Skills-page toggle for Consensus 2026
- `7dd896ab` fix(xmtp): XMTP-user fallback + pending-disk recovery + 20/24h limit
- `0c5c0f3a` fix(xmtp): receiver chat_id from DB, dynamic gateway token, no fallback reply
- `161615ab` feat(xmtp): agent-to-agent intro DMs for Consensus 2026 matching
- `579cd2a8` feat(xmtp): application-layer delivery guarantees + chat_id backfill

### v85 — 2026-05-05 — `31396d5c` — Rule 24 — skill install verification + self-healing + taxonomy

Adds verify-after-install for every skill clone, self-heals corrupted
`.git/` on the git-pull cron, codifies the three-tier skill taxonomy.

In-window:
- `55bb97ea` fix(skills): Rule 24 follow-ups — backup-before-rm + bootstrap const + vm-724/725 fixes
- `f08b60b8` fix(my-matches): strip em-dashes from copy + LLM rationale
- `bd13d54f` feat(skills): consensus-2026 brand-image orb icon

### v86 — 2026-05-05 — `56f71126` — TasksMax 75 → 120 on openclaw-gateway cgroup

Raises systemd `TasksMax` from 75 to 120 to restore burst headroom.
The 75 cap was root cause of vm-724-class fork EAGAIN errors.

### v87 — 2026-05-05 — `36c6b260` — integrate prctl-subreaper into openclaw-gateway

Open-sources `prctl-subreaper@0.1.0` on npm (later 0.1.1 dropped the
`|| exit 0` install mask). Gateway Node process becomes
`PR_SET_CHILD_SUBREAPER`, polling /proc reaper thread catches orphaned
descendants. Fixes the 8-year-old libuv #1911 zombie.

In-window: `6fa814df` canary(v87) vm-050 install + smoke test.

### v88 — 2026-05-05 — `faf8b8a8` — build-essential to systemPackages

Required precondition for `stepPrctlSubreaper` — needs gcc to compile
the N-API addon. Most cv=82 cohort silent-failed v87 without this.

In-window — Consensus launch sprint:
- `49e51b64` feat(consensus): kill-switch + 30-min health alert cron
- `55052829` test(consensus): real production intro fired end-to-end (1.77s)
- `178e10dc` fix(consensus): per-receiver intro cap (default 3/24h)
- `f4a908fb` fix(consensus): intro CTA points to sender's personal Telegram
- `c92a5e37` feat(consensus): self-healing telegram_handle backfill via Telegram getChat
- `9beb74bf` fix(reconcile-fleet): drop batch size 10 → 3 to fit under 300s timeout
- `991aa29b` chore(cron): reduce Supabase load — health-check 1m→2m, cloud-init-poll 2m→5m
- `1b36b078` perf(health-check): batch Pass 0 timestamp UPDATEs (855 → 2 queries)
- `8de505e3` docs(consensus): day-of runbook + PRD open-question lock-in
- `dd144bde` docs(gbrain): apply C1-C20 audit corrections to PRD body
- `de4e62f4` docs(changelog): v62 → v88 thread for X — copy-paste ready
- `aa816e58` feat(consensus): Draft C intro copy — match count + cap-controls footer

### v89 — 2026-05-06 — `b6141af9` — InstaClaw platform identity (fixes "I'm an OpenClaw agent")

Tightens upfront-loaded identity so the agent says "I'm an InstaClaw
agent" not "I'm an OpenClaw agent." Customer-facing branding fix.

In-window:
- `af2b7ced` docs(claude): P1-2 + P1-3 — node_exporter visibility, ssh-broken-tcp-reachable
- `8ffc2970` fix(reconcile): node_exporter post-restart sleep 2 → 5s
- `251e01fd` fix(reconcile): caddy hostname regex needs multiline flag
- `c3b8cee9` fix(reconcile): inline matchpool .py contents at build time
- `5e710334` fix(reconcile-fleet): touch route.ts to bust Vercel's nft trace cache
- `af38a16c` fix(consensus): sender-side match notification refresh
- `48c98a93`, `cb4d20c3`, `d28bf919`, `3f3443d2` fix(reconcile): glob shape for consensus_*.py file tracing
- `a20d85b6` fix(matchpool): partner-aware consent default for new profiles
- `af98e780` docs(prd-gbrain): apply 8 corrections from Phase 0 vm-050 canary

### v90 — 2026-05-07 — `7ac0d370` — four-layer session-overflow reliability fix

Replaces the destructive session-archive path with `compact_session_in_place_lines`
+ OpenClaw native compaction tuning + memory-pointer extraction + Layer 4
summary persistence. **No more `os.remove(jsonl_file)` on active sessions.**

In-window:
- `f0da920e` docs(claude): Rules 25-31 — systemic lessons from 2026-05-06/07 incidents
- `16aa97c9` fix(reconcile-fleet): touch route.ts to bust nft cache for v90 manifest

### v91 — 2026-05-07 → 08 — `e30c6a78` — Bankr wallet coverage gap + Platform V2

Backfills missing Bankr wallets for ~79% of users provisioned via
World App signup path. v91 SOUL.md "Platform V2" identity rewrite.

### v92 — 2026-05-08 → 11 — `b6f949ac` — partner-stub migration (fix edge_city truncation bug)

Live truncation bug on edge_city VMs — SOUL.md exceeded
`bootstrapMaxChars` for partner-tagged users.

In-window:
- `0f796218` fix(manifest): EMERGENCY bandaid — bootstrapMaxChars 35000 → 40000 (v92)
- `bc1608ac` fix(manifest): EMERGENCY disable CONSENSUS_MATCHING_AWARENESS_V1 SOUL.md append
- `5e949f0f` fix(reconcile-fleet): drop suspended/hibernating from eligibility
- `07269ec2` fix(ssh): add v90 compaction keys to buildOpenClawConfig static blob
- `6a11e06e` fix(reconcile-fleet): add missing lib/manifest-integrity.ts + pre-commit nft cache-bust
- `84775ac0` feat(manifest-integrity): P1-4 nft-cache defense + dynamic-value handling
- `4854398d` docs(claude): elevate P1-1 — lying-DB is ~20% fleet-wide
- `035b3b11` docs: lying-DB fleet census — 27% rate, 12 of 44 healthy cv≥88 VMs

### v93 — 2026-05-11 — `e436cf3a` — partner-stub APPEND branch + budget-aware over-budget check

SOUL.md partner-stub now appends rather than full-rewrites; over-budget
warning added.

In-window:
- `e2380e68` feat(reconcile-fleet): persistent failure tracking + auto-quarantine + alerts
- `2750c10d` chore(scripts): Phase 4 cv-reset for the 10 lying-DB VMs
- `6db05d8e` fix(gateway-proxy): stop silently downgrading real user messages to MiniMax
- `c56efadf` feat(soul-v2): bug-fix stepMigrateSoulV2 + canary/rollout/rollback scripts + PRD
- `567f653b` fix(strip-thinking): idempotency gate on session-backup creation
- `1fb249d5` fix(reconciler): root-cause fixes for 27% lying-DB rate
- `1e572e98` docs(soul-v2): §14 — Agent Self-Compaction Architecture (V3+ roadmap)

### v94 — skipped

`0712ba01` jumped 93 → 95 directly. v94 number is intentionally unused.

### v95 — 2026-05-11 → 12 — `0712ba01` — three-layer Telegram agent acknowledgment UX

Re-enables `streaming.mode = "partial"` with Layer 2 leak guards
(suppress tool-call rendering, sentence-boundary chunks, 800-char cap)
+ Layer 3 ack message refresh.

In-window — **5/11–5/12 sprint** (post-cooper outage + Edge prep):
- `47764527` feat(reconcile): catch-up script for fleet stuck >N versions behind manifest
- `320ecb25` feat(reconciler+claude.md): hot-reload classification + auto-restart guardrail (Rule 32)
- `831533f4` feat(phase4): gbrain fleet rollout design + stepEnvVarPush reconciler step
- `2b985da0` feat(phase4): gbrain-coverage-check cron + edge_city readiness probe
- `b1741db5` feat(phase4c): stepGbrain reconciler step + build-time script embedding
- `0144181a` feat(snapshot-bake): canonical fresh-nanode bake toolchain (cleanup + validation + runbook)
- `1c44d5e9` fix(onboarding): break post-checkout loop + recover from configure partial-failure (Rule 33)
- `6671f651` Merge feat/matchpool-outcomes-ingest — §5.2 matching engine infrastructure
- `b4b1e97b` fix(reconcile): stepSystemdUnit verify uses md5 hash compare (likely cv=82 unstick)
- `03df7ef1` feat(telegram): one-shot fix for VMs missing channels.telegram.botToken on disk
- `c944a3b0` fix(auth): plug dual-account hole — partner cookie now applies to existing users
- `a8bb1bca` feat(edge): rebrand /edge-city → /edge with Edge City visual language
- `4a5fddec` feat(edge): branded Open Graph share card for /edge
- `b27f94ee` fix(edge): move plaza page to /edge/ to match post-rebrand routing
- `273e1609` fix(replenish-pool): orphan-collision defense + visible alerts
- `ab48f58c` feat(edge): brand /signup + /connect for Edge Esmeralda attendees
- `1bf237a9` feat(edge): /edge responds to login state
- `39d0e237` fix(vm-status): atomic health_status on terminal flips + defense filter
- `9434a2db` fix(telegram-token-drift): self-heal disk↔DB telegram_bot_token mismatch (Rule 34)

---

## Categorical summary (2026-04-15 → 2026-05-12)

### Reconciler / manifest changes (33 version bumps + ~80 supporting commits)
Every commit listed under a manifest version section, plus auxiliary
reconciler fixes (`stepNodeUpgrade`, `stepNpmPinDrift`, sentinel guard,
strict-mode reconciliation, batch-size tuning, nft cache busts).

### Infrastructure / fleet ops (~70 commits)
- Cron rebalancing (health-check 1m→2m, batched timestamp UPDATEs)
- Database load reduction (in-memory daily_usage cache, BRIN index swap)
- Replenish-pool defenses (orphan-collision, lock semantics)
- Auth-cache clear on billing recovery (Rule 16)
- VM lifecycle freeze/thaw pattern (Phase 2 + Phase 3)
- Wake-from-hibernation paths (Rule 15)
- Watchdog v2 (shadow → active rollout)
- Snapshot-bake toolchain (`0144181a`)

### New user-facing features (~50 commits)
- **Consensus 2026 matching engine** (the big ship — intent extraction,
  3-layer pipeline, XMTP intro DMs, /my-matches UI)
- **Bankr token launch flow** (#1, #4-9, #17, #19 — tokenize button,
  autoposts, World ID badge, share card, agent learns about its token)
- **Edge City partner work** (privacy bridge, /edge rebrand, /edge-city
  → /edge, branded share card, partner cookie fix, login-state-aware
  /edge page)
- **Memory architecture overhaul** (cache boundary, MEMORY.md backup,
  cross-session persistence, trim-not-nuke)
- **Skills**: DegenClaw (Virtuals trading), Consensus 2026, Newsworthy,
  brand-design, code-execution, competitive-intelligence, dispatch
- **Earn page + EARN.md** (v44)
- **AgentBook banner** (state machine: verify/register/claim/sold-out)
- **WLD delegation cron + expiry**

### Edge City partner-specific (~25 commits)
Privacy bridge (components 1-9), partner-tagging existing users
(Rule 9), /edge-city → /edge rebrand, branded signup/connect/share
card, dual-account hole fix, login-state-aware /edge, edge_city skill
auto-install.

### gbrain integration (Phase 0 → 4c, ~15 commits)
Per-VM PGLite, Phase 1 install scripts, Phase 4c reconciler step,
coverage-check cron, edge_city readiness probe. **Not yet in
production fleet.**

### Discipline / docs / PRDs (~50 commits)
CLAUDE.md Rules 11-34 (LLM maxDuration, Vercel-vs-local debug order,
middleware allow-list, billing-status SoT, sleep states, auth-cache,
watchdog v2, SSH env files, .select("*") safety, schema verification,
PostgREST string coercion, trim-not-nuke, sentinel guards, skill
install verify, two-system races, onboarding paths, coverage queries,
explicit model overrides, agent hallucination, universal trim,
failure-mode tests, hot-reload classification, onboarding state
machine, DB↔disk drift). Multiple PRDs: gbrain integration, SOUL
restructure, agent negotiation v2, EdgeClaw architecture.

### Snapshot-bake prep
- `599b9a1c` docs(CLAUDE.md): cut over to v79 snapshot 2026-05-02
- `0144181a` canonical fresh-nanode bake toolchain
- `f5122470` fix(db): usage_log 14-day retention + BRIN index swap

---

## What MUST land on the next snapshot bake (May 23-25)

Anything in the "Versions NOT in the v79 snapshot" section above. Concrete checklist:

1. **OpenClaw version**: confirm pinned version is current (2026.4.26 unless bumped).
2. **manifest version**: bake from v95+ (will be whatever HEAD points to at bake time).
3. **TasksMax = 120** (v86) in systemd override.
4. **prctl-subreaper** installed via npm + drop-in present (v87 + v88 gcc precondition).
5. **build-essential** in apt packages.
6. **Latest SOUL.md** with InstaClaw identity (v89), Platform V2 (v91), partner-stub APPEND (v93), no Consensus matching awareness block (disabled in `bc1608ac`).
7. **bootstrapMaxChars = 40000** (v92 emergency bandaid).
8. **strip-thinking.py** with four-layer compaction (v90, no destructive archive path).
9. **streaming.mode = "partial"** with Layer 2 leak guards (v95).
10. **agents.defaults.timeoutSeconds = 300** (v80 bump, not 90).
11. **Cron entries pruned**: NO vm-watchdog, NO silence-watchdog (v76).
12. **Cron entries added**: 30-min Consensus health alert (v88), Phase 4 gbrain-coverage-check (if enabled).
13. **Templates v2**: workspace-templates-v2.ts SOUL output if SOUL v2 migration is fully on by bake time.
14. **Memory snapshot ExecStopPost/ExecStartPre** (v73).
15. **Browser-relay-server** in `~/scripts/browser-relay-server/` (v65).
16. **Bankr CLI 0.3.1+** pinned globally (v62 + later).
17. **Manifest sentinels** present for every requireSentinels entry (Rule 23 — `def trim_failed_turns`, `SESSION TRIMMED:`).

### Pre-bake verification queries
- Run `npx tsx scripts/_coverage-prctl-subreaper.ts` (if exists) — should be ~100%.
- Run `npx tsx scripts/_probe-v91-census.ts` — confirm v90+ compaction keys on disk.
- Lying-DB census: per P1-1 CLAUDE.md notes, run the 6-point pre-flight on a random sample of cv≥88 VMs; bake target is <2% lying-DB rate.

### Known not-yet-fixed risks to flag for bake decisions
- **P1-1 lying-DB**: ~20% of post-v88 fleet has cv≥88 but is missing v86/v87 changes. New snapshot at v95+ means new VMs land truthful, but the bake reset doesn't fix existing drift.
- **v94 skipped**: confirm no stale tooling expects v94 to exist.
- **SOUL.md size**: at ~32,677 chars (per CLAUDE.md note), already over `bootstrapMaxChars` ceiling pre-v92. Bandaid raised cap to 40,000. **Trim before bake** if any further additions land.

---

## Appendix — every commit since 2026-04-15

The full list (386 commits) is too long to inline. To regenerate:

```bash
git log --pretty=format:"%h|%ad|%s" --date=short \
  --since="2026-04-15" origin/main > /tmp/commits-since-cv82.txt
```

The automated generator (`scripts/generate-changelog.ts`) reproduces
this document from `git log` on demand, with up-to-date version
anchors. Use that going forward — this file is the manual snapshot for
the May 23-25 bake conversation only.
