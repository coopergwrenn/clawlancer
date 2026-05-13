# Changelog — generated 2026-05-13

Window: `2026-05-10` → `HEAD` (HEAD = `afc05631`)
Total commits: 95

<!-- LAST_GENERATED_SHA: afc05631c3dfd18f24ddaba3438de1dd55250cf1 -->

## Summary

- **Manifest version bumps:** 3
  - Range: v92 → v95
- **Reconciler / manifest:** 30
- **Infrastructure:** 48
- **Feature (user-facing):** 4
- **Edge City partner:** 7
- **Docs / PRD only:** 6
- AI-assisted commits (co-authored): 86
- Merge commits: 4

## Manifest version timeline

### v92 — 2026-05-11 — `b6f949ac`

feat(soul-md): v92 partner-stub migration — fix live truncation bug on edge_city VMs

> Pre-v92 edge_city VMs had 36,054 chars of SOUL.md content vs the 35,000-char
> BOOTSTRAP_MAX_CHARS ceiling. The last ~1,054 chars (the Edge onboarding
> interview tail + the entire Consensus section) were silently truncated from
> the agent's bootstrap context. All 5 production edge_city VMs affected.

### v93 — 2026-05-11 — `e436cf3a`

feat(soul-md): v93 partner-stub APPEND branch + budget-aware over-budget check

> The v92 step's Python treated `old-not-found` as a no-op (mirroring v67
> routing-patch semantics where missing-old indicated user customization).
> For partner sections this was wrong: partner sections are auto-installed
> by configureOpenClaw, and a missing section means the VM was provisioned
> BEFORE the section existed in the template, OR a configure failure left
> it out. Either way we want to add it.

### v95 — 2026-05-11 — `0712ba01`

feat(ack-ux): v95 — three-layer Telegram agent acknowledgment UX

> Originating bug: 3 minutes of silence between Cooper's prompt and the
> agent's eventual response at 9:07 PM 2026-05-11. Edge Esmeralda (1000
> attendees, ships 2026-05-30) would have churned that experience at
> scale. PRD: docs/prd/agent-acknowledgment-ux-2026-05-11.md (~2000 lines).

## What changed for users

- `1e572e98` 2026-05-11 — docs(soul-v2): §14 — Agent Self-Compaction Architecture (V3+ roadmap) [1 files] _(multi: [edge, docs]; ai-assisted)_
- `a8bb1bca` 2026-05-12 — feat(edge): rebrand /edge-city → /edge with Edge City visual language [11 files] _(multi: [feature, edge]; ai-assisted)_
- `b27f94ee` 2026-05-12 — fix(edge): move plaza page to /edge/ to match post-rebrand routing [2 files] _(multi: [feature, edge]; ai-assisted)_
- `ab48f58c` 2026-05-12 — feat(edge): brand /signup + /connect for Edge Esmeralda attendees [3 files] _(multi: [feature, edge]; ai-assisted)_
- `1bf237a9` 2026-05-12 — feat(edge): /edge responds to login state [3 files] _(multi: [feature, edge]; ai-assisted)_
- `bc34e307` 2026-05-12 — Merge branch 'feat/gbrain-stepGbrain-phase4c' [0 files] _(merge)_
- `5341923e` 2026-05-12 — Merge feat/edge-signup-connect-branding-2026-05-12: brand /signup + /connect for Edge attendees [0 files] _(merge)_
- `c2649f05` 2026-05-12 — Merge feat/edge-login-state-aware-2026-05-12: /edge responds to login state [0 files] _(merge)_
- `c4502681` 2026-05-12 — docs(edgeclaw): §4.14 pixel-art Healdsburg village — full v1 spec [1 files] _(multi: [edge, docs]; ai-assisted)_
- `753470c9` 2026-05-12 — docs(changelog): full history 2026-03-01 → 2026-05-13 (1,336 commits) [1 files] _(multi: [edge, docs]; ai-assisted)_
- `452f24bf` 2026-05-13 — docs(cloud-init): on-demand-provisioning PRD + implementation map [2 files] _(multi: [edge, docs]; ai-assisted)_

## What changed under the hood

- `1fb249d5` 2026-05-11 — fix(reconciler): root-cause fixes for 27% lying-DB rate [2 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `b6f949ac` 2026-05-11 — feat(soul-md): v92 partner-stub migration — fix live truncation bug on edge_city VMs [6 files] _(**MANIFEST v92**; multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `0f796218` 2026-05-11 — fix(manifest): EMERGENCY bandaid — bootstrapMaxChars 35000 → 40000 (v92) [2 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `bc1608ac` 2026-05-11 — fix(manifest): EMERGENCY disable CONSENSUS_MATCHING_AWARENESS_V1 SOUL.md append [2 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `2750c10d` 2026-05-11 — chore(scripts): Phase 4 cv-reset for the 10 lying-DB VMs [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `567f653b` 2026-05-11 — fix(strip-thinking): idempotency gate on session-backup creation [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `c56efadf` 2026-05-11 — feat(soul-v2): bug-fix stepMigrateSoulV2 + canary/rollout/rollback scripts + PRD [5 files] _(multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `e436cf3a` 2026-05-11 — feat(soul-md): v93 partner-stub APPEND branch + budget-aware over-budget check [4 files] _(**MANIFEST v93**; multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `320ecb25` 2026-05-11 — feat(reconciler+claude.md): hot-reload classification + auto-restart guardrail [2 files] _(multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `47764527` 2026-05-11 — feat(reconcile): catch-up script for fleet stuck >N versions behind manifest [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `831533f4` 2026-05-11 — feat(phase4): gbrain fleet rollout design + stepEnvVarPush reconciler step [4 files] _(multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `0712ba01` 2026-05-11 — feat(ack-ux): v95 — three-layer Telegram agent acknowledgment UX [8 files] _(**MANIFEST v95**; multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `21d9dd9b` 2026-05-11 — docs(prd): reconcile deadline structural fix — Vercel cron can't catch up multi-version drift [1 files] _(multi: [reconciler, docs]; ai-assisted)_
- `ddcee2e4` 2026-05-11 — chore(scripts): stuck-head triage + selective-flip helpers [5 files] _(ai-assisted)_
- `035b3b11` 2026-05-11 — docs: lying-DB fleet census — 27% rate, 12 of 44 healthy cv≥88 VMs [2 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `50640a55` 2026-05-11 — feat(gbrain): Phase 1 uninstall scripts (mirror of install) [2 files] _(ai-assisted)_
- `d4e3dae5` 2026-05-11 — chore(scripts): emergency fleet sweep + reprobe (2026-05-11) [3 files] _(ai-assisted)_
- `36ea41e1` 2026-05-11 — chore(scripts): session-backups bloat probe + emergency purge [2 files] _(ai-assisted)_
- `6db05d8e` 2026-05-11 — fix(gateway-proxy): stop silently downgrading real user messages to MiniMax [1 files] _(ai-assisted)_
- `e2380e68` 2026-05-11 — feat(reconcile-fleet): persistent failure tracking + auto-quarantine + alerts [5 files] _(ai-assisted)_
- `871a78c5` 2026-05-11 — fix(soul-v2): cron lock acquisition in canary script + ip_address column [2 files] _(ai-assisted)_
- `90feea10` 2026-05-11 — fix(soul-v2): AGENTS.md threshold + ip_address column in fleet rollout [2 files] _(ai-assisted)_
- `bd3f671e` 2026-05-11 — fix(soul-v2): fleet rollout whitelist race on concurrent migrateOne calls [1 files] _(ai-assisted)_
- `ddb58683` 2026-05-11 — fix(soul-v2): fleet rollout process.exit() bypasses finally — leaks cron lock [1 files] _(ai-assisted)_
- `437504db` 2026-05-11 — feat(soul-v2): --no-strict opt-in flag for fleet rollout [1 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `e7d927b3` 2026-05-11 — feat(gbrain+monitoring): install pipeline + forensic handoff + 3 ops crons [9 files] _(multi: [infrastructure, edge, docs]; ai-assisted)_
- `2b985da0` 2026-05-11 — feat(phase4): gbrain-coverage-check cron + edge_city readiness probe [4 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `0eeeebdb` 2026-05-11 — docs(lying-db-census): refresh 2026-05-11 with current fleet probe [1 files] _(ai-assisted)_
- `56d3a2e3` 2026-05-11 — docs(consensus): expand Phase C reset list — 5 stragglers + vm-512 hand-fix log [1 files]
- `b1741db5` 2026-05-12 — feat(phase4c): stepGbrain reconciler step + build-time script embedding [4 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `b4b1e97b` 2026-05-12 — fix(reconcile): stepSystemdUnit verify uses md5 hash compare (likely cv=82 unstick) [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `9434a2db` 2026-05-12 — fix(telegram-token-drift): self-heal disk↔DB telegram_bot_token mismatch (Rule 34) [3 files] _(multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `b3d58bc4` 2026-05-12 — fix(configure): inline dispatch scripts to bypass Next 15 NFT .sh bundling [3 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `ef8258e6` 2026-05-12 — fix(reconcile): validate-before-restart guards against schema-rejection crashes [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `7f395209` 2026-05-12 — fix(reconcile): include NVM_PREAMBLE for validate-before-restart commands [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `3839d176` 2026-05-12 — fix(vm-reconcile): inline dispatch scripts (companion to b3d58bc4) [3 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `ed8ee6a1` 2026-05-12 — docs(lying-db): 2026-05-13 census — 0.8% rate (down from 27.3% on 05-11) [1 files] _(multi: [reconciler, docs])_
- `5f6d6a11` 2026-05-12 — feat(changelog): automated changelog + X-post generator system [8 files] _(multi: [reconciler, edge, docs]; ai-assisted)_
- `5c79ef90` 2026-05-12 — feat(edge-privacy): airtight v0 — tightened bridge + admin kill switch + chattr +i lockdown [5 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `0144181a` 2026-05-12 — feat(snapshot-bake): canonical fresh-nanode bake toolchain (cleanup + validation + runbook) [3 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `1c44d5e9` 2026-05-12 — fix(onboarding): break post-checkout loop + recover from configure partial-failure (Rule 33) [5 files] _(multi: [infrastructure, feature, edge, docs]; ai-assisted)_
- `6671f651` 2026-05-12 — Merge branch 'feat/matchpool-outcomes-ingest' — §5.2 matching engine infrastructure [49 files] _(multi: [infrastructure, feature, edge, docs]; ai-assisted)_
- `03df7ef1` 2026-05-12 — feat(telegram): one-shot fix for VMs missing channels.telegram.botToken on disk [1 files] _(ai-assisted)_
- `c944a3b0` 2026-05-12 — fix(auth): plug dual-account hole — partner cookie now applies to existing users [3 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `4a5fddec` 2026-05-12 — feat(edge): branded Open Graph share card for /edge [4 files] _(multi: [infrastructure, feature, edge]; ai-assisted)_
- `273e1609` 2026-05-12 — fix(replenish-pool): orphan-collision defense + visible alerts [2 files] _(ai-assisted)_
- `39d0e237` 2026-05-12 — fix(vm-status): atomic health_status on terminal flips + defense filter [13 files] _(ai-assisted)_
- `c707676d` 2026-05-12 — fix(rule-34): clear user channel state on VM release + guard health-check from clobbering configure_failed [3 files] _(ai-assisted)_
- `3914d05f` 2026-05-12 — fix(vm-status): plug 12 adjacent ghost-row paths uncovered by audit [11 files] _(ai-assisted)_
- `a527f867` 2026-05-12 — fix(process-pending): Pass 0 starvation + fairness + scale (khomenko89 12-day wait) [1 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `0d5499af` 2026-05-12 — fix(vm-status): final hardening — SQL guard, cron races, webhooks, top-5 polling [13 files] _(ai-assisted)_
- `7f96a982` 2026-05-12 — feat(configure): CI verifier for runtime file-read drift [1 files] _(ai-assisted)_
- `8ecf83d1` 2026-05-12 — refactor(vm-status): centralize user-VM lookup in getUserVm helper [11 files] _(ai-assisted)_
- `892826f3` 2026-05-12 — fix(vm-lifecycle): clear assigned_to on terminate — root-cause fix for ghost rows [3 files] _(ai-assisted)_
- `da5b7d5c` 2026-05-12 — fix(edge-privacy): cutover safety — skip bypass keys, abort if none found [3 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `48ea0e8f` 2026-05-12 — Merge feat/privacy-cutover-bypass-skip: privacy cutover bypass-skip + abort guard + .env.ssh-key fix [0 files] _(merge)_
- `da3e27eb` 2026-05-12 — fix(vm-lifecycle): split terminal-flip from last_assigned_to stamp to dodge FK atomicity [2 files]
- `0acc7598` 2026-05-12 — feat(soul-md-v2): trim WORKSPACE_AGENTS_MD_V2 18,812→13,919 chars [2 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `31457047` 2026-05-12 — docs(x-drafts): @garrytan OpenClaw bug reply — 3 variants [1 files] _(ai-assisted)_
- `a3479493` 2026-05-12 — docs(skill-inventory): land skill deployment inventory for on-demand-provisioning PRD [1 files]
- `eec2cf95` 2026-05-13 — fix(vm-lifecycle): null ip_address at status='failed' flip — kill IP-reuse resurrection [4 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `187b0331` 2026-05-13 — fix(manifest+ssh): publicnode.com canonical for POLYGON_RPC_URL; remove dead SOLA integration [3 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `5456afce` 2026-05-13 — fix(edge-privacy): one-shot bridge deploy — closes vm-354 lockout class [4 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `c4b84156` 2026-05-13 — feat(reconcile): stepExecStartAlignment — permanent guard against stale Node-path ExecStart [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `c5eb8f23` 2026-05-13 — chore(ssh): export buildPersonalizedBootstrap, buildSystemPrompt, buildUserMd [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `8c903f9a` 2026-05-13 — docs(CLAUDE.md): Fleet Health — Root Causes & Rules + new Rules 36-43 [1 files] _(multi: [reconciler, edge, docs]; ai-assisted)_
- `b97cf09f` 2026-05-13 — docs(CLAUDE.md): cv=91 cohort root cause is strict-180s-deadline (Rule 44) [1 files] _(multi: [reconciler, docs]; ai-assisted)_
- `2ed3ebaf` 2026-05-13 — feat(scripts): _phase3-v2-migrate.ts — single-VM V2 canary runner [1 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `91aaa61b` 2026-05-13 — fix(_phase3-v2-migrate): three pre/post-flight robustness fixes [1 files] _(ai-assisted)_
- `b2a7bf15` 2026-05-13 — fix(_phase3-v2-migrate): swap vm-075 → vm-310 in cohort [1 files] _(ai-assisted)_
- `4aed0be4` 2026-05-13 — fix(catch-up): audit retries up to 120s for gateway health (no false halts) [1 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `d31e7d0e` 2026-05-13 — fix(configure): channel-credential validator — extends Rule 33 gate (Rule 35) [1 files] _(ai-assisted)_
- `c3efe3e3` 2026-05-13 — fix(vm-status): complete IP-reuse defense — relax NOT NULL, backfill, cover remaining sites [4 files]
- `6b790ea7` 2026-05-13 — feat(bake): readiness audit 2026-05-13 + 46-check expansion to validation [2 files] _(multi: [infrastructure, edge, docs]; ai-assisted)_
- `bb7d9b0c` 2026-05-13 — fix(_phase3-v2-migrate): acquire cron lock BEFORE pre-flight (race fix) [1 files] _(ai-assisted)_
- `81e3ea34` 2026-05-13 — fix(_phase3-v2-migrate): pass VM_MANIFEST as 2nd arg to reconcileVM [1 files] _(ai-assisted)_
- `b5b24ebf` 2026-05-13 — feat(migration): cloud-init on-demand provisioning schema (Phase 1A Day 1-2) [1 files] _(ai-assisted)_
- `42d66df3` 2026-05-13 — fix(edge-privacy): audit_logged truthiness + chain-test + SOLA cleanup scripts [3 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `f6753c64` 2026-05-13 — feat(bake): SNAPSHOT_BAKED cross-ref + audit follow-ups + telegram heal [4 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `5bd54d77` 2026-05-13 — feat(cloud-init): buildCloudInitUserdata bootstrap (Phase 1A Day 3) [1 files] _(ai-assisted)_
- `2f74fe48` 2026-05-13 — fix(bake-validation): replace brittle version-pin regexes with semverGte [1 files] _(ai-assisted)_
- `afc05631` 2026-05-13 — feat(cloud-init): enable RLS on cloud_init_outcomes + circuit_breakers [1 files] _(ai-assisted)_
- `a34fdb89` 2026-05-13 — docs(cloud-init): v2 builder plan (bootstrap+fetch) + SNAPSHOT_BAKED inventory [2 files] _(ai-assisted)_
- `f5efa320` 2026-05-13 — docs(cloud-init): plan v2 fixes — log truncation race, last-known-good removal, BEST_EFFORT explicit, §14 audit protocol [1 files] _(ai-assisted)_

## By category

### Reconciler / manifest (30)

- `1fb249d5` 2026-05-11 — fix(reconciler): root-cause fixes for 27% lying-DB rate [2 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `b6f949ac` 2026-05-11 — feat(soul-md): v92 partner-stub migration — fix live truncation bug on edge_city VMs [6 files] _(**MANIFEST v92**; multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `0f796218` 2026-05-11 — fix(manifest): EMERGENCY bandaid — bootstrapMaxChars 35000 → 40000 (v92) [2 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `bc1608ac` 2026-05-11 — fix(manifest): EMERGENCY disable CONSENSUS_MATCHING_AWARENESS_V1 SOUL.md append [2 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `2750c10d` 2026-05-11 — chore(scripts): Phase 4 cv-reset for the 10 lying-DB VMs [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `567f653b` 2026-05-11 — fix(strip-thinking): idempotency gate on session-backup creation [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `c56efadf` 2026-05-11 — feat(soul-v2): bug-fix stepMigrateSoulV2 + canary/rollout/rollback scripts + PRD [5 files] _(multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `e436cf3a` 2026-05-11 — feat(soul-md): v93 partner-stub APPEND branch + budget-aware over-budget check [4 files] _(**MANIFEST v93**; multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `320ecb25` 2026-05-11 — feat(reconciler+claude.md): hot-reload classification + auto-restart guardrail [2 files] _(multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `47764527` 2026-05-11 — feat(reconcile): catch-up script for fleet stuck >N versions behind manifest [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `831533f4` 2026-05-11 — feat(phase4): gbrain fleet rollout design + stepEnvVarPush reconciler step [4 files] _(multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `0712ba01` 2026-05-11 — feat(ack-ux): v95 — three-layer Telegram agent acknowledgment UX [8 files] _(**MANIFEST v95**; multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `21d9dd9b` 2026-05-11 — docs(prd): reconcile deadline structural fix — Vercel cron can't catch up multi-version drift [1 files] _(multi: [reconciler, docs]; ai-assisted)_
- `b1741db5` 2026-05-12 — feat(phase4c): stepGbrain reconciler step + build-time script embedding [4 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `b4b1e97b` 2026-05-12 — fix(reconcile): stepSystemdUnit verify uses md5 hash compare (likely cv=82 unstick) [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `9434a2db` 2026-05-12 — fix(telegram-token-drift): self-heal disk↔DB telegram_bot_token mismatch (Rule 34) [3 files] _(multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `b3d58bc4` 2026-05-12 — fix(configure): inline dispatch scripts to bypass Next 15 NFT .sh bundling [3 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `ef8258e6` 2026-05-12 — fix(reconcile): validate-before-restart guards against schema-rejection crashes [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `7f395209` 2026-05-12 — fix(reconcile): include NVM_PREAMBLE for validate-before-restart commands [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `3839d176` 2026-05-12 — fix(vm-reconcile): inline dispatch scripts (companion to b3d58bc4) [3 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `ed8ee6a1` 2026-05-12 — docs(lying-db): 2026-05-13 census — 0.8% rate (down from 27.3% on 05-11) [1 files] _(multi: [reconciler, docs])_
- `5f6d6a11` 2026-05-12 — feat(changelog): automated changelog + X-post generator system [8 files] _(multi: [reconciler, edge, docs]; ai-assisted)_
- `5c79ef90` 2026-05-12 — feat(edge-privacy): airtight v0 — tightened bridge + admin kill switch + chattr +i lockdown [5 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `eec2cf95` 2026-05-13 — fix(vm-lifecycle): null ip_address at status='failed' flip — kill IP-reuse resurrection [4 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `187b0331` 2026-05-13 — fix(manifest+ssh): publicnode.com canonical for POLYGON_RPC_URL; remove dead SOLA integration [3 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `5456afce` 2026-05-13 — fix(edge-privacy): one-shot bridge deploy — closes vm-354 lockout class [4 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `c4b84156` 2026-05-13 — feat(reconcile): stepExecStartAlignment — permanent guard against stale Node-path ExecStart [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `c5eb8f23` 2026-05-13 — chore(ssh): export buildPersonalizedBootstrap, buildSystemPrompt, buildUserMd [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `8c903f9a` 2026-05-13 — docs(CLAUDE.md): Fleet Health — Root Causes & Rules + new Rules 36-43 [1 files] _(multi: [reconciler, edge, docs]; ai-assisted)_
- `b97cf09f` 2026-05-13 — docs(CLAUDE.md): cv=91 cohort root cause is strict-180s-deadline (Rule 44) [1 files] _(multi: [reconciler, docs]; ai-assisted)_

### Infrastructure (48)

- `ddcee2e4` 2026-05-11 — chore(scripts): stuck-head triage + selective-flip helpers [5 files] _(ai-assisted)_
- `035b3b11` 2026-05-11 — docs: lying-DB fleet census — 27% rate, 12 of 44 healthy cv≥88 VMs [2 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `50640a55` 2026-05-11 — feat(gbrain): Phase 1 uninstall scripts (mirror of install) [2 files] _(ai-assisted)_
- `d4e3dae5` 2026-05-11 — chore(scripts): emergency fleet sweep + reprobe (2026-05-11) [3 files] _(ai-assisted)_
- `36ea41e1` 2026-05-11 — chore(scripts): session-backups bloat probe + emergency purge [2 files] _(ai-assisted)_
- `6db05d8e` 2026-05-11 — fix(gateway-proxy): stop silently downgrading real user messages to MiniMax [1 files] _(ai-assisted)_
- `e2380e68` 2026-05-11 — feat(reconcile-fleet): persistent failure tracking + auto-quarantine + alerts [5 files] _(ai-assisted)_
- `871a78c5` 2026-05-11 — fix(soul-v2): cron lock acquisition in canary script + ip_address column [2 files] _(ai-assisted)_
- `90feea10` 2026-05-11 — fix(soul-v2): AGENTS.md threshold + ip_address column in fleet rollout [2 files] _(ai-assisted)_
- `bd3f671e` 2026-05-11 — fix(soul-v2): fleet rollout whitelist race on concurrent migrateOne calls [1 files] _(ai-assisted)_
- `ddb58683` 2026-05-11 — fix(soul-v2): fleet rollout process.exit() bypasses finally — leaks cron lock [1 files] _(ai-assisted)_
- `437504db` 2026-05-11 — feat(soul-v2): --no-strict opt-in flag for fleet rollout [1 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `e7d927b3` 2026-05-11 — feat(gbrain+monitoring): install pipeline + forensic handoff + 3 ops crons [9 files] _(multi: [infrastructure, edge, docs]; ai-assisted)_
- `2b985da0` 2026-05-11 — feat(phase4): gbrain-coverage-check cron + edge_city readiness probe [4 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `0144181a` 2026-05-12 — feat(snapshot-bake): canonical fresh-nanode bake toolchain (cleanup + validation + runbook) [3 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `1c44d5e9` 2026-05-12 — fix(onboarding): break post-checkout loop + recover from configure partial-failure (Rule 33) [5 files] _(multi: [infrastructure, feature, edge, docs]; ai-assisted)_
- `6671f651` 2026-05-12 — Merge branch 'feat/matchpool-outcomes-ingest' — §5.2 matching engine infrastructure [49 files] _(multi: [infrastructure, feature, edge, docs]; ai-assisted)_
- `03df7ef1` 2026-05-12 — feat(telegram): one-shot fix for VMs missing channels.telegram.botToken on disk [1 files] _(ai-assisted)_
- `c944a3b0` 2026-05-12 — fix(auth): plug dual-account hole — partner cookie now applies to existing users [3 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `4a5fddec` 2026-05-12 — feat(edge): branded Open Graph share card for /edge [4 files] _(multi: [infrastructure, feature, edge]; ai-assisted)_
- `273e1609` 2026-05-12 — fix(replenish-pool): orphan-collision defense + visible alerts [2 files] _(ai-assisted)_
- `39d0e237` 2026-05-12 — fix(vm-status): atomic health_status on terminal flips + defense filter [13 files] _(ai-assisted)_
- `c707676d` 2026-05-12 — fix(rule-34): clear user channel state on VM release + guard health-check from clobbering configure_failed [3 files] _(ai-assisted)_
- `3914d05f` 2026-05-12 — fix(vm-status): plug 12 adjacent ghost-row paths uncovered by audit [11 files] _(ai-assisted)_
- `a527f867` 2026-05-12 — fix(process-pending): Pass 0 starvation + fairness + scale (khomenko89 12-day wait) [1 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `0d5499af` 2026-05-12 — fix(vm-status): final hardening — SQL guard, cron races, webhooks, top-5 polling [13 files] _(ai-assisted)_
- `7f96a982` 2026-05-12 — feat(configure): CI verifier for runtime file-read drift [1 files] _(ai-assisted)_
- `8ecf83d1` 2026-05-12 — refactor(vm-status): centralize user-VM lookup in getUserVm helper [11 files] _(ai-assisted)_
- `892826f3` 2026-05-12 — fix(vm-lifecycle): clear assigned_to on terminate — root-cause fix for ghost rows [3 files] _(ai-assisted)_
- `da5b7d5c` 2026-05-12 — fix(edge-privacy): cutover safety — skip bypass keys, abort if none found [3 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `48ea0e8f` 2026-05-12 — Merge feat/privacy-cutover-bypass-skip: privacy cutover bypass-skip + abort guard + .env.ssh-key fix [0 files] _(merge)_
- `da3e27eb` 2026-05-12 — fix(vm-lifecycle): split terminal-flip from last_assigned_to stamp to dodge FK atomicity [2 files]
- `0acc7598` 2026-05-12 — feat(soul-md-v2): trim WORKSPACE_AGENTS_MD_V2 18,812→13,919 chars [2 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `2ed3ebaf` 2026-05-13 — feat(scripts): _phase3-v2-migrate.ts — single-VM V2 canary runner [1 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `91aaa61b` 2026-05-13 — fix(_phase3-v2-migrate): three pre/post-flight robustness fixes [1 files] _(ai-assisted)_
- `b2a7bf15` 2026-05-13 — fix(_phase3-v2-migrate): swap vm-075 → vm-310 in cohort [1 files] _(ai-assisted)_
- `4aed0be4` 2026-05-13 — fix(catch-up): audit retries up to 120s for gateway health (no false halts) [1 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `d31e7d0e` 2026-05-13 — fix(configure): channel-credential validator — extends Rule 33 gate (Rule 35) [1 files] _(ai-assisted)_
- `c3efe3e3` 2026-05-13 — fix(vm-status): complete IP-reuse defense — relax NOT NULL, backfill, cover remaining sites [4 files]
- `6b790ea7` 2026-05-13 — feat(bake): readiness audit 2026-05-13 + 46-check expansion to validation [2 files] _(multi: [infrastructure, edge, docs]; ai-assisted)_
- `bb7d9b0c` 2026-05-13 — fix(_phase3-v2-migrate): acquire cron lock BEFORE pre-flight (race fix) [1 files] _(ai-assisted)_
- `81e3ea34` 2026-05-13 — fix(_phase3-v2-migrate): pass VM_MANIFEST as 2nd arg to reconcileVM [1 files] _(ai-assisted)_
- `b5b24ebf` 2026-05-13 — feat(migration): cloud-init on-demand provisioning schema (Phase 1A Day 1-2) [1 files] _(ai-assisted)_
- `42d66df3` 2026-05-13 — fix(edge-privacy): audit_logged truthiness + chain-test + SOLA cleanup scripts [3 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `f6753c64` 2026-05-13 — feat(bake): SNAPSHOT_BAKED cross-ref + audit follow-ups + telegram heal [4 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `5bd54d77` 2026-05-13 — feat(cloud-init): buildCloudInitUserdata bootstrap (Phase 1A Day 3) [1 files] _(ai-assisted)_
- `2f74fe48` 2026-05-13 — fix(bake-validation): replace brittle version-pin regexes with semverGte [1 files] _(ai-assisted)_
- `afc05631` 2026-05-13 — feat(cloud-init): enable RLS on cloud_init_outcomes + circuit_breakers [1 files] _(ai-assisted)_

### Feature (user-facing) (4)

- `a8bb1bca` 2026-05-12 — feat(edge): rebrand /edge-city → /edge with Edge City visual language [11 files] _(multi: [feature, edge]; ai-assisted)_
- `b27f94ee` 2026-05-12 — fix(edge): move plaza page to /edge/ to match post-rebrand routing [2 files] _(multi: [feature, edge]; ai-assisted)_
- `ab48f58c` 2026-05-12 — feat(edge): brand /signup + /connect for Edge Esmeralda attendees [3 files] _(multi: [feature, edge]; ai-assisted)_
- `1bf237a9` 2026-05-12 — feat(edge): /edge responds to login state [3 files] _(multi: [feature, edge]; ai-assisted)_

### Edge City partner (7)

- `1e572e98` 2026-05-11 — docs(soul-v2): §14 — Agent Self-Compaction Architecture (V3+ roadmap) [1 files] _(multi: [edge, docs]; ai-assisted)_
- `bc34e307` 2026-05-12 — Merge branch 'feat/gbrain-stepGbrain-phase4c' [0 files] _(merge)_
- `5341923e` 2026-05-12 — Merge feat/edge-signup-connect-branding-2026-05-12: brand /signup + /connect for Edge attendees [0 files] _(merge)_
- `c2649f05` 2026-05-12 — Merge feat/edge-login-state-aware-2026-05-12: /edge responds to login state [0 files] _(merge)_
- `c4502681` 2026-05-12 — docs(edgeclaw): §4.14 pixel-art Healdsburg village — full v1 spec [1 files] _(multi: [edge, docs]; ai-assisted)_
- `753470c9` 2026-05-12 — docs(changelog): full history 2026-03-01 → 2026-05-13 (1,336 commits) [1 files] _(multi: [edge, docs]; ai-assisted)_
- `452f24bf` 2026-05-13 — docs(cloud-init): on-demand-provisioning PRD + implementation map [2 files] _(multi: [edge, docs]; ai-assisted)_

### Docs / PRD only (6)

- `0eeeebdb` 2026-05-11 — docs(lying-db-census): refresh 2026-05-11 with current fleet probe [1 files] _(ai-assisted)_
- `56d3a2e3` 2026-05-11 — docs(consensus): expand Phase C reset list — 5 stragglers + vm-512 hand-fix log [1 files]
- `31457047` 2026-05-12 — docs(x-drafts): @garrytan OpenClaw bug reply — 3 variants [1 files] _(ai-assisted)_
- `a3479493` 2026-05-12 — docs(skill-inventory): land skill deployment inventory for on-demand-provisioning PRD [1 files]
- `a34fdb89` 2026-05-13 — docs(cloud-init): v2 builder plan (bootstrap+fetch) + SNAPSHOT_BAKED inventory [2 files] _(ai-assisted)_
- `f5efa320` 2026-05-13 — docs(cloud-init): plan v2 fixes — log truncation race, last-known-good removal, BEST_EFFORT explicit, §14 audit protocol [1 files] _(ai-assisted)_

## Multi-category commits (55)

These touch more than one category root and are listed in every applicable section above.

- `035b3b11` 2026-05-11 — [infrastructure, docs] — docs: lying-DB fleet census — 27% rate, 12 of 44 healthy cv≥88 VMs
- `1fb249d5` 2026-05-11 — [reconciler, infrastructure] — fix(reconciler): root-cause fixes for 27% lying-DB rate
- `b6f949ac` 2026-05-11 — [reconciler, infrastructure, edge] — feat(soul-md): v92 partner-stub migration — fix live truncation bug on edge_city VMs
- `0f796218` 2026-05-11 — [reconciler, infrastructure, edge] — fix(manifest): EMERGENCY bandaid — bootstrapMaxChars 35000 → 40000 (v92)
- `bc1608ac` 2026-05-11 — [reconciler, infrastructure] — fix(manifest): EMERGENCY disable CONSENSUS_MATCHING_AWARENESS_V1 SOUL.md append
- `2750c10d` 2026-05-11 — [reconciler, infrastructure] — chore(scripts): Phase 4 cv-reset for the 10 lying-DB VMs
- `567f653b` 2026-05-11 — [reconciler, infrastructure] — fix(strip-thinking): idempotency gate on session-backup creation
- `c56efadf` 2026-05-11 — [reconciler, infrastructure, edge, docs] — feat(soul-v2): bug-fix stepMigrateSoulV2 + canary/rollout/rollback scripts + PRD
- `1e572e98` 2026-05-11 — [edge, docs] — docs(soul-v2): §14 — Agent Self-Compaction Architecture (V3+ roadmap)
- `e436cf3a` 2026-05-11 — [reconciler, infrastructure, edge] — feat(soul-md): v93 partner-stub APPEND branch + budget-aware over-budget check
- `437504db` 2026-05-11 — [infrastructure, edge] — feat(soul-v2): --no-strict opt-in flag for fleet rollout
- `e7d927b3` 2026-05-11 — [infrastructure, edge, docs] — feat(gbrain+monitoring): install pipeline + forensic handoff + 3 ops crons
- `320ecb25` 2026-05-11 — [reconciler, infrastructure, edge, docs] — feat(reconciler+claude.md): hot-reload classification + auto-restart guardrail
- `47764527` 2026-05-11 — [reconciler, infrastructure] — feat(reconcile): catch-up script for fleet stuck >N versions behind manifest
- `831533f4` 2026-05-11 — [reconciler, infrastructure, edge, docs] — feat(phase4): gbrain fleet rollout design + stepEnvVarPush reconciler step
- `0712ba01` 2026-05-11 — [reconciler, infrastructure, edge, docs] — feat(ack-ux): v95 — three-layer Telegram agent acknowledgment UX
- `2b985da0` 2026-05-11 — [infrastructure, edge] — feat(phase4): gbrain-coverage-check cron + edge_city readiness probe
- `21d9dd9b` 2026-05-11 — [reconciler, docs] — docs(prd): reconcile deadline structural fix — Vercel cron can't catch up multi-version drift
- `b1741db5` 2026-05-12 — [reconciler, infrastructure, edge] — feat(phase4c): stepGbrain reconciler step + build-time script embedding
- `0144181a` 2026-05-12 — [infrastructure, docs] — feat(snapshot-bake): canonical fresh-nanode bake toolchain (cleanup + validation + runbook)
- `1c44d5e9` 2026-05-12 — [infrastructure, feature, edge, docs] — fix(onboarding): break post-checkout loop + recover from configure partial-failure (Rule 33)
- `a8bb1bca` 2026-05-12 — [feature, edge] — feat(edge): rebrand /edge-city → /edge with Edge City visual language
- `6671f651` 2026-05-12 — [infrastructure, feature, edge, docs] — Merge branch 'feat/matchpool-outcomes-ingest' — §5.2 matching engine infrastructure
- `b4b1e97b` 2026-05-12 — [reconciler, infrastructure] — fix(reconcile): stepSystemdUnit verify uses md5 hash compare (likely cv=82 unstick)
- `c944a3b0` 2026-05-12 — [infrastructure, edge] — fix(auth): plug dual-account hole — partner cookie now applies to existing users
- `4a5fddec` 2026-05-12 — [infrastructure, feature, edge] — feat(edge): branded Open Graph share card for /edge
- `b27f94ee` 2026-05-12 — [feature, edge] — fix(edge): move plaza page to /edge/ to match post-rebrand routing
- `ab48f58c` 2026-05-12 — [feature, edge] — feat(edge): brand /signup + /connect for Edge Esmeralda attendees
- `1bf237a9` 2026-05-12 — [feature, edge] — feat(edge): /edge responds to login state
- `9434a2db` 2026-05-12 — [reconciler, infrastructure, docs] — fix(telegram-token-drift): self-heal disk↔DB telegram_bot_token mismatch (Rule 34)
- `c4502681` 2026-05-12 — [edge, docs] — docs(edgeclaw): §4.14 pixel-art Healdsburg village — full v1 spec
- `b3d58bc4` 2026-05-12 — [reconciler, infrastructure] — fix(configure): inline dispatch scripts to bypass Next 15 NFT .sh bundling
- `a527f867` 2026-05-12 — [infrastructure, edge] — fix(process-pending): Pass 0 starvation + fairness + scale (khomenko89 12-day wait)
- `ef8258e6` 2026-05-12 — [reconciler, infrastructure] — fix(reconcile): validate-before-restart guards against schema-rejection crashes
- `7f395209` 2026-05-12 — [reconciler, infrastructure] — fix(reconcile): include NVM_PREAMBLE for validate-before-restart commands
- `3839d176` 2026-05-12 — [reconciler, infrastructure] — fix(vm-reconcile): inline dispatch scripts (companion to b3d58bc4)
- `da5b7d5c` 2026-05-12 — [infrastructure, edge] — fix(edge-privacy): cutover safety — skip bypass keys, abort if none found
- `ed8ee6a1` 2026-05-12 — [reconciler, docs] — docs(lying-db): 2026-05-13 census — 0.8% rate (down from 27.3% on 05-11)
- `5f6d6a11` 2026-05-12 — [reconciler, edge, docs] — feat(changelog): automated changelog + X-post generator system
- `5c79ef90` 2026-05-12 — [reconciler, infrastructure, edge] — feat(edge-privacy): airtight v0 — tightened bridge + admin kill switch + chattr +i lockdown
- `753470c9` 2026-05-12 — [edge, docs] — docs(changelog): full history 2026-03-01 → 2026-05-13 (1,336 commits)
- `0acc7598` 2026-05-12 — [infrastructure, docs] — feat(soul-md-v2): trim WORKSPACE_AGENTS_MD_V2 18,812→13,919 chars
- `2ed3ebaf` 2026-05-13 — [infrastructure, edge] — feat(scripts): _phase3-v2-migrate.ts — single-VM V2 canary runner
- `eec2cf95` 2026-05-13 — [reconciler, infrastructure] — fix(vm-lifecycle): null ip_address at status='failed' flip — kill IP-reuse resurrection
- `187b0331` 2026-05-13 — [reconciler, infrastructure, edge] — fix(manifest+ssh): publicnode.com canonical for POLYGON_RPC_URL; remove dead SOLA integration
- `452f24bf` 2026-05-13 — [edge, docs] — docs(cloud-init): on-demand-provisioning PRD + implementation map
- `5456afce` 2026-05-13 — [reconciler, infrastructure, edge] — fix(edge-privacy): one-shot bridge deploy — closes vm-354 lockout class
- `4aed0be4` 2026-05-13 — [infrastructure, edge] — fix(catch-up): audit retries up to 120s for gateway health (no false halts)
- `c4b84156` 2026-05-13 — [reconciler, infrastructure] — feat(reconcile): stepExecStartAlignment — permanent guard against stale Node-path ExecStart
- `6b790ea7` 2026-05-13 — [infrastructure, edge, docs] — feat(bake): readiness audit 2026-05-13 + 46-check expansion to validation
- `42d66df3` 2026-05-13 — [infrastructure, edge] — fix(edge-privacy): audit_logged truthiness + chain-test + SOLA cleanup scripts
- `f6753c64` 2026-05-13 — [infrastructure, docs] — feat(bake): SNAPSHOT_BAKED cross-ref + audit follow-ups + telegram heal
- `c5eb8f23` 2026-05-13 — [reconciler, infrastructure] — chore(ssh): export buildPersonalizedBootstrap, buildSystemPrompt, buildUserMd
- `8c903f9a` 2026-05-13 — [reconciler, edge, docs] — docs(CLAUDE.md): Fleet Health — Root Causes & Rules + new Rules 36-43
- `b97cf09f` 2026-05-13 — [reconciler, docs] — docs(CLAUDE.md): cv=91 cohort root cause is strict-180s-deadline (Rule 44)

## AI-assisted commits (86)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `ddcee2e4` 2026-05-11 — chore(scripts): stuck-head triage + selective-flip helpers
- `035b3b11` 2026-05-11 — docs: lying-DB fleet census — 27% rate, 12 of 44 healthy cv≥88 VMs
- `50640a55` 2026-05-11 — feat(gbrain): Phase 1 uninstall scripts (mirror of install)
- `0eeeebdb` 2026-05-11 — docs(lying-db-census): refresh 2026-05-11 with current fleet probe
- `1fb249d5` 2026-05-11 — fix(reconciler): root-cause fixes for 27% lying-DB rate
- `b6f949ac` 2026-05-11 — feat(soul-md): v92 partner-stub migration — fix live truncation bug on edge_city VMs
- `0f796218` 2026-05-11 — fix(manifest): EMERGENCY bandaid — bootstrapMaxChars 35000 → 40000 (v92)
- `bc1608ac` 2026-05-11 — fix(manifest): EMERGENCY disable CONSENSUS_MATCHING_AWARENESS_V1 SOUL.md append
- `d4e3dae5` 2026-05-11 — chore(scripts): emergency fleet sweep + reprobe (2026-05-11)
- `2750c10d` 2026-05-11 — chore(scripts): Phase 4 cv-reset for the 10 lying-DB VMs
- `567f653b` 2026-05-11 — fix(strip-thinking): idempotency gate on session-backup creation
- `36ea41e1` 2026-05-11 — chore(scripts): session-backups bloat probe + emergency purge
- `c56efadf` 2026-05-11 — feat(soul-v2): bug-fix stepMigrateSoulV2 + canary/rollout/rollback scripts + PRD
- `6db05d8e` 2026-05-11 — fix(gateway-proxy): stop silently downgrading real user messages to MiniMax
- `e2380e68` 2026-05-11 — feat(reconcile-fleet): persistent failure tracking + auto-quarantine + alerts
- `1e572e98` 2026-05-11 — docs(soul-v2): §14 — Agent Self-Compaction Architecture (V3+ roadmap)
- `e436cf3a` 2026-05-11 — feat(soul-md): v93 partner-stub APPEND branch + budget-aware over-budget check
- `871a78c5` 2026-05-11 — fix(soul-v2): cron lock acquisition in canary script + ip_address column
- `90feea10` 2026-05-11 — fix(soul-v2): AGENTS.md threshold + ip_address column in fleet rollout
- `bd3f671e` 2026-05-11 — fix(soul-v2): fleet rollout whitelist race on concurrent migrateOne calls
- `ddb58683` 2026-05-11 — fix(soul-v2): fleet rollout process.exit() bypasses finally — leaks cron lock
- `437504db` 2026-05-11 — feat(soul-v2): --no-strict opt-in flag for fleet rollout
- `e7d927b3` 2026-05-11 — feat(gbrain+monitoring): install pipeline + forensic handoff + 3 ops crons
- `320ecb25` 2026-05-11 — feat(reconciler+claude.md): hot-reload classification + auto-restart guardrail
- `47764527` 2026-05-11 — feat(reconcile): catch-up script for fleet stuck >N versions behind manifest
- `831533f4` 2026-05-11 — feat(phase4): gbrain fleet rollout design + stepEnvVarPush reconciler step
- `0712ba01` 2026-05-11 — feat(ack-ux): v95 — three-layer Telegram agent acknowledgment UX
- `2b985da0` 2026-05-11 — feat(phase4): gbrain-coverage-check cron + edge_city readiness probe
- `21d9dd9b` 2026-05-11 — docs(prd): reconcile deadline structural fix — Vercel cron can't catch up multi-version drift
- `b1741db5` 2026-05-12 — feat(phase4c): stepGbrain reconciler step + build-time script embedding
- `0144181a` 2026-05-12 — feat(snapshot-bake): canonical fresh-nanode bake toolchain (cleanup + validation + runbook)
- `1c44d5e9` 2026-05-12 — fix(onboarding): break post-checkout loop + recover from configure partial-failure (Rule 33)
- `a8bb1bca` 2026-05-12 — feat(edge): rebrand /edge-city → /edge with Edge City visual language
- `6671f651` 2026-05-12 — Merge branch 'feat/matchpool-outcomes-ingest' — §5.2 matching engine infrastructure
- `b4b1e97b` 2026-05-12 — fix(reconcile): stepSystemdUnit verify uses md5 hash compare (likely cv=82 unstick)
- `03df7ef1` 2026-05-12 — feat(telegram): one-shot fix for VMs missing channels.telegram.botToken on disk
- `c944a3b0` 2026-05-12 — fix(auth): plug dual-account hole — partner cookie now applies to existing users
- `4a5fddec` 2026-05-12 — feat(edge): branded Open Graph share card for /edge
- `b27f94ee` 2026-05-12 — fix(edge): move plaza page to /edge/ to match post-rebrand routing
- `273e1609` 2026-05-12 — fix(replenish-pool): orphan-collision defense + visible alerts
- `ab48f58c` 2026-05-12 — feat(edge): brand /signup + /connect for Edge Esmeralda attendees
- `39d0e237` 2026-05-12 — fix(vm-status): atomic health_status on terminal flips + defense filter
- `1bf237a9` 2026-05-12 — feat(edge): /edge responds to login state
- `9434a2db` 2026-05-12 — fix(telegram-token-drift): self-heal disk↔DB telegram_bot_token mismatch (Rule 34)
- `c4502681` 2026-05-12 — docs(edgeclaw): §4.14 pixel-art Healdsburg village — full v1 spec
- `c707676d` 2026-05-12 — fix(rule-34): clear user channel state on VM release + guard health-check from clobbering configure_failed
- `3914d05f` 2026-05-12 — fix(vm-status): plug 12 adjacent ghost-row paths uncovered by audit
- `b3d58bc4` 2026-05-12 — fix(configure): inline dispatch scripts to bypass Next 15 NFT .sh bundling
- `a527f867` 2026-05-12 — fix(process-pending): Pass 0 starvation + fairness + scale (khomenko89 12-day wait)
- `0d5499af` 2026-05-12 — fix(vm-status): final hardening — SQL guard, cron races, webhooks, top-5 polling
- `7f96a982` 2026-05-12 — feat(configure): CI verifier for runtime file-read drift
- `8ecf83d1` 2026-05-12 — refactor(vm-status): centralize user-VM lookup in getUserVm helper
- `ef8258e6` 2026-05-12 — fix(reconcile): validate-before-restart guards against schema-rejection crashes
- `892826f3` 2026-05-12 — fix(vm-lifecycle): clear assigned_to on terminate — root-cause fix for ghost rows
- `7f395209` 2026-05-12 — fix(reconcile): include NVM_PREAMBLE for validate-before-restart commands
- `3839d176` 2026-05-12 — fix(vm-reconcile): inline dispatch scripts (companion to b3d58bc4)
- `da5b7d5c` 2026-05-12 — fix(edge-privacy): cutover safety — skip bypass keys, abort if none found
- `5f6d6a11` 2026-05-12 — feat(changelog): automated changelog + X-post generator system
- `31457047` 2026-05-12 — docs(x-drafts): @garrytan OpenClaw bug reply — 3 variants
- `5c79ef90` 2026-05-12 — feat(edge-privacy): airtight v0 — tightened bridge + admin kill switch + chattr +i lockdown
- `753470c9` 2026-05-12 — docs(changelog): full history 2026-03-01 → 2026-05-13 (1,336 commits)
- `0acc7598` 2026-05-12 — feat(soul-md-v2): trim WORKSPACE_AGENTS_MD_V2 18,812→13,919 chars
- `2ed3ebaf` 2026-05-13 — feat(scripts): _phase3-v2-migrate.ts — single-VM V2 canary runner
- `91aaa61b` 2026-05-13 — fix(_phase3-v2-migrate): three pre/post-flight robustness fixes
- `eec2cf95` 2026-05-13 — fix(vm-lifecycle): null ip_address at status='failed' flip — kill IP-reuse resurrection
- `187b0331` 2026-05-13 — fix(manifest+ssh): publicnode.com canonical for POLYGON_RPC_URL; remove dead SOLA integration
- `452f24bf` 2026-05-13 — docs(cloud-init): on-demand-provisioning PRD + implementation map
- `5456afce` 2026-05-13 — fix(edge-privacy): one-shot bridge deploy — closes vm-354 lockout class
- `b2a7bf15` 2026-05-13 — fix(_phase3-v2-migrate): swap vm-075 → vm-310 in cohort
- `4aed0be4` 2026-05-13 — fix(catch-up): audit retries up to 120s for gateway health (no false halts)
- `d31e7d0e` 2026-05-13 — fix(configure): channel-credential validator — extends Rule 33 gate (Rule 35)
- `c4b84156` 2026-05-13 — feat(reconcile): stepExecStartAlignment — permanent guard against stale Node-path ExecStart
- `6b790ea7` 2026-05-13 — feat(bake): readiness audit 2026-05-13 + 46-check expansion to validation
- `a34fdb89` 2026-05-13 — docs(cloud-init): v2 builder plan (bootstrap+fetch) + SNAPSHOT_BAKED inventory
- `bb7d9b0c` 2026-05-13 — fix(_phase3-v2-migrate): acquire cron lock BEFORE pre-flight (race fix)
- `f5efa320` 2026-05-13 — docs(cloud-init): plan v2 fixes — log truncation race, last-known-good removal, BEST_EFFORT explicit, §14 audit protocol
- `81e3ea34` 2026-05-13 — fix(_phase3-v2-migrate): pass VM_MANIFEST as 2nd arg to reconcileVM
- `b5b24ebf` 2026-05-13 — feat(migration): cloud-init on-demand provisioning schema (Phase 1A Day 1-2)
- `42d66df3` 2026-05-13 — fix(edge-privacy): audit_logged truthiness + chain-test + SOLA cleanup scripts
- `f6753c64` 2026-05-13 — feat(bake): SNAPSHOT_BAKED cross-ref + audit follow-ups + telegram heal
- `5bd54d77` 2026-05-13 — feat(cloud-init): buildCloudInitUserdata bootstrap (Phase 1A Day 3)
- `c5eb8f23` 2026-05-13 — chore(ssh): export buildPersonalizedBootstrap, buildSystemPrompt, buildUserMd
- `8c903f9a` 2026-05-13 — docs(CLAUDE.md): Fleet Health — Root Causes & Rules + new Rules 36-43
- `2f74fe48` 2026-05-13 — fix(bake-validation): replace brittle version-pin regexes with semverGte
- `b97cf09f` 2026-05-13 — docs(CLAUDE.md): cv=91 cohort root cause is strict-180s-deadline (Rule 44)
- `afc05631` 2026-05-13 — feat(cloud-init): enable RLS on cloud_init_outcomes + circuit_breakers

## Appendix — every commit (chronological)

- `ddcee2e4` 2026-05-11 — chore(scripts): stuck-head triage + selective-flip helpers [5 files] _(ai-assisted)_
- `035b3b11` 2026-05-11 — docs: lying-DB fleet census — 27% rate, 12 of 44 healthy cv≥88 VMs [2 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `50640a55` 2026-05-11 — feat(gbrain): Phase 1 uninstall scripts (mirror of install) [2 files] _(ai-assisted)_
- `0eeeebdb` 2026-05-11 — docs(lying-db-census): refresh 2026-05-11 with current fleet probe [1 files] _(ai-assisted)_
- `56d3a2e3` 2026-05-11 — docs(consensus): expand Phase C reset list — 5 stragglers + vm-512 hand-fix log [1 files]
- `1fb249d5` 2026-05-11 — fix(reconciler): root-cause fixes for 27% lying-DB rate [2 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `b6f949ac` 2026-05-11 — feat(soul-md): v92 partner-stub migration — fix live truncation bug on edge_city VMs [6 files] _(**MANIFEST v92**; multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `0f796218` 2026-05-11 — fix(manifest): EMERGENCY bandaid — bootstrapMaxChars 35000 → 40000 (v92) [2 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `bc1608ac` 2026-05-11 — fix(manifest): EMERGENCY disable CONSENSUS_MATCHING_AWARENESS_V1 SOUL.md append [2 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `d4e3dae5` 2026-05-11 — chore(scripts): emergency fleet sweep + reprobe (2026-05-11) [3 files] _(ai-assisted)_
- `2750c10d` 2026-05-11 — chore(scripts): Phase 4 cv-reset for the 10 lying-DB VMs [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `567f653b` 2026-05-11 — fix(strip-thinking): idempotency gate on session-backup creation [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `36ea41e1` 2026-05-11 — chore(scripts): session-backups bloat probe + emergency purge [2 files] _(ai-assisted)_
- `c56efadf` 2026-05-11 — feat(soul-v2): bug-fix stepMigrateSoulV2 + canary/rollout/rollback scripts + PRD [5 files] _(multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `6db05d8e` 2026-05-11 — fix(gateway-proxy): stop silently downgrading real user messages to MiniMax [1 files] _(ai-assisted)_
- `e2380e68` 2026-05-11 — feat(reconcile-fleet): persistent failure tracking + auto-quarantine + alerts [5 files] _(ai-assisted)_
- `1e572e98` 2026-05-11 — docs(soul-v2): §14 — Agent Self-Compaction Architecture (V3+ roadmap) [1 files] _(multi: [edge, docs]; ai-assisted)_
- `e436cf3a` 2026-05-11 — feat(soul-md): v93 partner-stub APPEND branch + budget-aware over-budget check [4 files] _(**MANIFEST v93**; multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `871a78c5` 2026-05-11 — fix(soul-v2): cron lock acquisition in canary script + ip_address column [2 files] _(ai-assisted)_
- `90feea10` 2026-05-11 — fix(soul-v2): AGENTS.md threshold + ip_address column in fleet rollout [2 files] _(ai-assisted)_
- `bd3f671e` 2026-05-11 — fix(soul-v2): fleet rollout whitelist race on concurrent migrateOne calls [1 files] _(ai-assisted)_
- `ddb58683` 2026-05-11 — fix(soul-v2): fleet rollout process.exit() bypasses finally — leaks cron lock [1 files] _(ai-assisted)_
- `437504db` 2026-05-11 — feat(soul-v2): --no-strict opt-in flag for fleet rollout [1 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `e7d927b3` 2026-05-11 — feat(gbrain+monitoring): install pipeline + forensic handoff + 3 ops crons [9 files] _(multi: [infrastructure, edge, docs]; ai-assisted)_
- `320ecb25` 2026-05-11 — feat(reconciler+claude.md): hot-reload classification + auto-restart guardrail [2 files] _(multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `47764527` 2026-05-11 — feat(reconcile): catch-up script for fleet stuck >N versions behind manifest [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `831533f4` 2026-05-11 — feat(phase4): gbrain fleet rollout design + stepEnvVarPush reconciler step [4 files] _(multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `0712ba01` 2026-05-11 — feat(ack-ux): v95 — three-layer Telegram agent acknowledgment UX [8 files] _(**MANIFEST v95**; multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `2b985da0` 2026-05-11 — feat(phase4): gbrain-coverage-check cron + edge_city readiness probe [4 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `21d9dd9b` 2026-05-11 — docs(prd): reconcile deadline structural fix — Vercel cron can't catch up multi-version drift [1 files] _(multi: [reconciler, docs]; ai-assisted)_
- `b1741db5` 2026-05-12 — feat(phase4c): stepGbrain reconciler step + build-time script embedding [4 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `0144181a` 2026-05-12 — feat(snapshot-bake): canonical fresh-nanode bake toolchain (cleanup + validation + runbook) [3 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `1c44d5e9` 2026-05-12 — fix(onboarding): break post-checkout loop + recover from configure partial-failure (Rule 33) [5 files] _(multi: [infrastructure, feature, edge, docs]; ai-assisted)_
- `bc34e307` 2026-05-12 — Merge branch 'feat/gbrain-stepGbrain-phase4c' [0 files] _(merge)_
- `a8bb1bca` 2026-05-12 — feat(edge): rebrand /edge-city → /edge with Edge City visual language [11 files] _(multi: [feature, edge]; ai-assisted)_
- `6671f651` 2026-05-12 — Merge branch 'feat/matchpool-outcomes-ingest' — §5.2 matching engine infrastructure [49 files] _(multi: [infrastructure, feature, edge, docs]; ai-assisted)_
- `b4b1e97b` 2026-05-12 — fix(reconcile): stepSystemdUnit verify uses md5 hash compare (likely cv=82 unstick) [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `03df7ef1` 2026-05-12 — feat(telegram): one-shot fix for VMs missing channels.telegram.botToken on disk [1 files] _(ai-assisted)_
- `c944a3b0` 2026-05-12 — fix(auth): plug dual-account hole — partner cookie now applies to existing users [3 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `4a5fddec` 2026-05-12 — feat(edge): branded Open Graph share card for /edge [4 files] _(multi: [infrastructure, feature, edge]; ai-assisted)_
- `b27f94ee` 2026-05-12 — fix(edge): move plaza page to /edge/ to match post-rebrand routing [2 files] _(multi: [feature, edge]; ai-assisted)_
- `273e1609` 2026-05-12 — fix(replenish-pool): orphan-collision defense + visible alerts [2 files] _(ai-assisted)_
- `ab48f58c` 2026-05-12 — feat(edge): brand /signup + /connect for Edge Esmeralda attendees [3 files] _(multi: [feature, edge]; ai-assisted)_
- `5341923e` 2026-05-12 — Merge feat/edge-signup-connect-branding-2026-05-12: brand /signup + /connect for Edge attendees [0 files] _(merge)_
- `39d0e237` 2026-05-12 — fix(vm-status): atomic health_status on terminal flips + defense filter [13 files] _(ai-assisted)_
- `1bf237a9` 2026-05-12 — feat(edge): /edge responds to login state [3 files] _(multi: [feature, edge]; ai-assisted)_
- `c2649f05` 2026-05-12 — Merge feat/edge-login-state-aware-2026-05-12: /edge responds to login state [0 files] _(merge)_
- `9434a2db` 2026-05-12 — fix(telegram-token-drift): self-heal disk↔DB telegram_bot_token mismatch (Rule 34) [3 files] _(multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `c4502681` 2026-05-12 — docs(edgeclaw): §4.14 pixel-art Healdsburg village — full v1 spec [1 files] _(multi: [edge, docs]; ai-assisted)_
- `c707676d` 2026-05-12 — fix(rule-34): clear user channel state on VM release + guard health-check from clobbering configure_failed [3 files] _(ai-assisted)_
- `3914d05f` 2026-05-12 — fix(vm-status): plug 12 adjacent ghost-row paths uncovered by audit [11 files] _(ai-assisted)_
- `b3d58bc4` 2026-05-12 — fix(configure): inline dispatch scripts to bypass Next 15 NFT .sh bundling [3 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `a527f867` 2026-05-12 — fix(process-pending): Pass 0 starvation + fairness + scale (khomenko89 12-day wait) [1 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `0d5499af` 2026-05-12 — fix(vm-status): final hardening — SQL guard, cron races, webhooks, top-5 polling [13 files] _(ai-assisted)_
- `7f96a982` 2026-05-12 — feat(configure): CI verifier for runtime file-read drift [1 files] _(ai-assisted)_
- `8ecf83d1` 2026-05-12 — refactor(vm-status): centralize user-VM lookup in getUserVm helper [11 files] _(ai-assisted)_
- `ef8258e6` 2026-05-12 — fix(reconcile): validate-before-restart guards against schema-rejection crashes [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `892826f3` 2026-05-12 — fix(vm-lifecycle): clear assigned_to on terminate — root-cause fix for ghost rows [3 files] _(ai-assisted)_
- `7f395209` 2026-05-12 — fix(reconcile): include NVM_PREAMBLE for validate-before-restart commands [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `3839d176` 2026-05-12 — fix(vm-reconcile): inline dispatch scripts (companion to b3d58bc4) [3 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `da5b7d5c` 2026-05-12 — fix(edge-privacy): cutover safety — skip bypass keys, abort if none found [3 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `48ea0e8f` 2026-05-12 — Merge feat/privacy-cutover-bypass-skip: privacy cutover bypass-skip + abort guard + .env.ssh-key fix [0 files] _(merge)_
- `ed8ee6a1` 2026-05-12 — docs(lying-db): 2026-05-13 census — 0.8% rate (down from 27.3% on 05-11) [1 files] _(multi: [reconciler, docs])_
- `5f6d6a11` 2026-05-12 — feat(changelog): automated changelog + X-post generator system [8 files] _(multi: [reconciler, edge, docs]; ai-assisted)_
- `31457047` 2026-05-12 — docs(x-drafts): @garrytan OpenClaw bug reply — 3 variants [1 files] _(ai-assisted)_
- `da3e27eb` 2026-05-12 — fix(vm-lifecycle): split terminal-flip from last_assigned_to stamp to dodge FK atomicity [2 files]
- `5c79ef90` 2026-05-12 — feat(edge-privacy): airtight v0 — tightened bridge + admin kill switch + chattr +i lockdown [5 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `753470c9` 2026-05-12 — docs(changelog): full history 2026-03-01 → 2026-05-13 (1,336 commits) [1 files] _(multi: [edge, docs]; ai-assisted)_
- `0acc7598` 2026-05-12 — feat(soul-md-v2): trim WORKSPACE_AGENTS_MD_V2 18,812→13,919 chars [2 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `a3479493` 2026-05-12 — docs(skill-inventory): land skill deployment inventory for on-demand-provisioning PRD [1 files]
- `2ed3ebaf` 2026-05-13 — feat(scripts): _phase3-v2-migrate.ts — single-VM V2 canary runner [1 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `91aaa61b` 2026-05-13 — fix(_phase3-v2-migrate): three pre/post-flight robustness fixes [1 files] _(ai-assisted)_
- `eec2cf95` 2026-05-13 — fix(vm-lifecycle): null ip_address at status='failed' flip — kill IP-reuse resurrection [4 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `187b0331` 2026-05-13 — fix(manifest+ssh): publicnode.com canonical for POLYGON_RPC_URL; remove dead SOLA integration [3 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `452f24bf` 2026-05-13 — docs(cloud-init): on-demand-provisioning PRD + implementation map [2 files] _(multi: [edge, docs]; ai-assisted)_
- `5456afce` 2026-05-13 — fix(edge-privacy): one-shot bridge deploy — closes vm-354 lockout class [4 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `b2a7bf15` 2026-05-13 — fix(_phase3-v2-migrate): swap vm-075 → vm-310 in cohort [1 files] _(ai-assisted)_
- `4aed0be4` 2026-05-13 — fix(catch-up): audit retries up to 120s for gateway health (no false halts) [1 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `d31e7d0e` 2026-05-13 — fix(configure): channel-credential validator — extends Rule 33 gate (Rule 35) [1 files] _(ai-assisted)_
- `c4b84156` 2026-05-13 — feat(reconcile): stepExecStartAlignment — permanent guard against stale Node-path ExecStart [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `c3efe3e3` 2026-05-13 — fix(vm-status): complete IP-reuse defense — relax NOT NULL, backfill, cover remaining sites [4 files]
- `6b790ea7` 2026-05-13 — feat(bake): readiness audit 2026-05-13 + 46-check expansion to validation [2 files] _(multi: [infrastructure, edge, docs]; ai-assisted)_
- `a34fdb89` 2026-05-13 — docs(cloud-init): v2 builder plan (bootstrap+fetch) + SNAPSHOT_BAKED inventory [2 files] _(ai-assisted)_
- `bb7d9b0c` 2026-05-13 — fix(_phase3-v2-migrate): acquire cron lock BEFORE pre-flight (race fix) [1 files] _(ai-assisted)_
- `f5efa320` 2026-05-13 — docs(cloud-init): plan v2 fixes — log truncation race, last-known-good removal, BEST_EFFORT explicit, §14 audit protocol [1 files] _(ai-assisted)_
- `81e3ea34` 2026-05-13 — fix(_phase3-v2-migrate): pass VM_MANIFEST as 2nd arg to reconcileVM [1 files] _(ai-assisted)_
- `b5b24ebf` 2026-05-13 — feat(migration): cloud-init on-demand provisioning schema (Phase 1A Day 1-2) [1 files] _(ai-assisted)_
- `42d66df3` 2026-05-13 — fix(edge-privacy): audit_logged truthiness + chain-test + SOLA cleanup scripts [3 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `f6753c64` 2026-05-13 — feat(bake): SNAPSHOT_BAKED cross-ref + audit follow-ups + telegram heal [4 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `5bd54d77` 2026-05-13 — feat(cloud-init): buildCloudInitUserdata bootstrap (Phase 1A Day 3) [1 files] _(ai-assisted)_
- `c5eb8f23` 2026-05-13 — chore(ssh): export buildPersonalizedBootstrap, buildSystemPrompt, buildUserMd [1 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `8c903f9a` 2026-05-13 — docs(CLAUDE.md): Fleet Health — Root Causes & Rules + new Rules 36-43 [1 files] _(multi: [reconciler, edge, docs]; ai-assisted)_
- `2f74fe48` 2026-05-13 — fix(bake-validation): replace brittle version-pin regexes with semverGte [1 files] _(ai-assisted)_
- `b97cf09f` 2026-05-13 — docs(CLAUDE.md): cv=91 cohort root cause is strict-180s-deadline (Rule 44) [1 files] _(multi: [reconciler, docs]; ai-assisted)_
- `afc05631` 2026-05-13 — feat(cloud-init): enable RLS on cloud_init_outcomes + circuit_breakers [1 files] _(ai-assisted)_
