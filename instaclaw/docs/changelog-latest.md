# Changelog — generated 2026-05-12

Window: `2026-05-10` → `HEAD` (HEAD = `9434a2db`)
Total commits: 48

<!-- LAST_GENERATED_SHA: 9434a2db90aa66fc571ab6b210aae35dabc3f166 -->

## Summary

- **Manifest version bumps:** 3
  - Range: v92 → v95
- **Reconciler / manifest:** 16
- **Infrastructure:** 22
- **Feature (user-facing):** 4
- **Edge City partner:** 4
- **Docs / PRD only:** 2
- AI-assisted commits (co-authored): 44
- Merge commits: 3

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
- `0144181a` 2026-05-12 — feat(snapshot-bake): canonical fresh-nanode bake toolchain (cleanup + validation + runbook) [3 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `1c44d5e9` 2026-05-12 — fix(onboarding): break post-checkout loop + recover from configure partial-failure (Rule 33) [5 files] _(multi: [infrastructure, feature, edge, docs]; ai-assisted)_
- `6671f651` 2026-05-12 — Merge branch 'feat/matchpool-outcomes-ingest' — §5.2 matching engine infrastructure [49 files] _(multi: [infrastructure, feature, edge, docs]; ai-assisted)_
- `03df7ef1` 2026-05-12 — feat(telegram): one-shot fix for VMs missing channels.telegram.botToken on disk [1 files] _(ai-assisted)_
- `c944a3b0` 2026-05-12 — fix(auth): plug dual-account hole — partner cookie now applies to existing users [3 files] _(multi: [infrastructure, edge]; ai-assisted)_
- `4a5fddec` 2026-05-12 — feat(edge): branded Open Graph share card for /edge [4 files] _(multi: [infrastructure, feature, edge]; ai-assisted)_
- `273e1609` 2026-05-12 — fix(replenish-pool): orphan-collision defense + visible alerts [2 files] _(ai-assisted)_
- `39d0e237` 2026-05-12 — fix(vm-status): atomic health_status on terminal flips + defense filter [13 files] _(ai-assisted)_

## By category

### Reconciler / manifest (16)

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

### Infrastructure (22)

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

### Feature (user-facing) (4)

- `a8bb1bca` 2026-05-12 — feat(edge): rebrand /edge-city → /edge with Edge City visual language [11 files] _(multi: [feature, edge]; ai-assisted)_
- `b27f94ee` 2026-05-12 — fix(edge): move plaza page to /edge/ to match post-rebrand routing [2 files] _(multi: [feature, edge]; ai-assisted)_
- `ab48f58c` 2026-05-12 — feat(edge): brand /signup + /connect for Edge Esmeralda attendees [3 files] _(multi: [feature, edge]; ai-assisted)_
- `1bf237a9` 2026-05-12 — feat(edge): /edge responds to login state [3 files] _(multi: [feature, edge]; ai-assisted)_

### Edge City partner (4)

- `1e572e98` 2026-05-11 — docs(soul-v2): §14 — Agent Self-Compaction Architecture (V3+ roadmap) [1 files] _(multi: [edge, docs]; ai-assisted)_
- `bc34e307` 2026-05-12 — Merge branch 'feat/gbrain-stepGbrain-phase4c' [0 files] _(merge)_
- `5341923e` 2026-05-12 — Merge feat/edge-signup-connect-branding-2026-05-12: brand /signup + /connect for Edge attendees [0 files] _(merge)_
- `c2649f05` 2026-05-12 — Merge feat/edge-login-state-aware-2026-05-12: /edge responds to login state [0 files] _(merge)_

### Docs / PRD only (2)

- `0eeeebdb` 2026-05-11 — docs(lying-db-census): refresh 2026-05-11 with current fleet probe [1 files] _(ai-assisted)_
- `56d3a2e3` 2026-05-11 — docs(consensus): expand Phase C reset list — 5 stragglers + vm-512 hand-fix log [1 files]

## Multi-category commits (30)

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

## AI-assisted commits (44)

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
