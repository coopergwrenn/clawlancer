# Changelog — generated 2026-06-12

Window: `1f3301ca8137b5dabb97d1b8553956edbcca2869` → `HEAD` (HEAD = `866c36e5`)
Total commits: 45

<!-- LAST_GENERATED_SHA: 866c36e5e19f59a003015ba1242ee0eb88c3a6d4 -->

## Summary

- **Manifest version bumps:** 0
- **Reconciler / manifest:** 0
- **Infrastructure:** 29
- **Feature (user-facing):** 1
- **Edge City partner:** 0
- **Docs / PRD only:** 15
- AI-assisted commits (co-authored): 34
- Merge commits: 2

## What changed for users

- `ea83d92f` 2026-06-11 — feat(higgsfield fork-a): video packs on the dashboard shelf + honest upsell destination [4 files] _(multi: [feature, docs]; ai-assisted)_

## What changed under the hood

- `eef8b4a7` 2026-06-09 — fix(higgsfield): close Kling 5s overcharge — re-pin to measured 15.0cr + lock duration to 10s [2 files] _(ai-assisted)_
- `83906dab` 2026-06-09 — fix(higgsfield): remove false "saved in your Studio" delivery copy (G6) [1 files] _(ai-assisted)_
- `5ebdbd02` 2026-06-09 — feat(higgsfield): G1 Part A — gate-side agent-poll support (Option B delivery) [4 files] _(ai-assisted)_
- `6cc4291f` 2026-06-09 — feat(higgsfield): G1 Part B — Cloud-rail skill files (agent-poll + G8 selection) [4 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `e34bfecc` 2026-06-09 — chore(higgsfield): untrack stray __pycache__ .pyc + ignore python build artifacts [2 files] _(ai-assisted)_
- `52aa50a0` 2026-06-09 — fix(higgsfield): M1 fail-safe status + M2 busy/rate-limit handling + de-em-dash copy [4 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `fc4e4b7f` 2026-06-09 — chore: trigger preview rebuild for higgsfield canary [0 files]
- `3667484c` 2026-06-09 — feat(higgsfield-cloud): canary bypass header for dark preview gate [1 files]
- `97cbedfb` 2026-06-09 — feat(higgsfield): complete the Cloud-rail video gate as a deployable unit [13 files] _(ai-assisted)_
- `12650990` 2026-06-09 — docs(higgsfield): commit the gate→user-path PRD + capture AGENTS.md:189 side-finding [1 files] _(ai-assisted)_
- `c73b9115` 2026-06-09 — docs(higgsfield): PRD §9 — G1 build + adversarial-review outcomes [1 files] _(ai-assisted)_
- `4733be72` 2026-06-09 — docs(higgsfield): H1 RESOLVED (native via message tool) + capture 2 separate findings [1 files] _(ai-assisted)_
- `52c244f9` 2026-06-09 — fix(higgsfield): SKILL.md — native attachment is the default delivery, never a link [1 files] _(ai-assisted)_
- `8ec182fd` 2026-06-10 — feat(higgsfield): HIGGSFIELD_GATE_ENABLED kill-switch on both gate routes [2 files]
- `7781dc70` 2026-06-10 — feat(higgsfield): G11 stale-hold sweeper cron — orphaned-render error handling [2 files] _(ai-assisted)_
- `51b8f8ae` 2026-06-10 — feat(higgsfield): A2 — gate resolves telegram_chat_id server-side when agent omits it [1 files] _(ai-assisted)_
- `cff3e4ee` 2026-06-10 — feat(higgsfield): passive telegram_chat_id backfill in proxy (A2 enabler) [1 files] _(ai-assisted)_
- `8ab053c5` 2026-06-10 — fix(higgsfield): suppress image webhook-delivery + delivery idempotency [3 files] _(ai-assisted)_
- `e98c8096` 2026-06-10 — feat(higgsfield): allowlist bytedance/seedance/v1/pro for the frontier quality vet [1 files] _(ai-assisted)_
- `b937e99d` 2026-06-10 — revert(higgsfield): remove bytedance/seedance/v1/pro allowlist entry [1 files] _(ai-assisted)_
- `0ece4ccf` 2026-06-10 — docs(higgsfield): canary verdict + closeout audit; skill _gate_base/bypass for re-run [3 files]
- `ea98c03d` 2026-06-10 — docs(higgsfield): PRD reconciliation + ordered remaining-work list to fleet-ship [1 files]
- `745e76ee` 2026-06-10 — docs(higgsfield): M5 async-delivery design + fork points (pre-build) [1 files]
- `93bdc25a` 2026-06-10 — feat(higgsfield-cloud): M5 fix — video submit-only (webhook delivers), image sync [2 files]
- `9c763968` 2026-06-10 — fix(higgsfield): free-cap excludes released holds (Option A) + fail-loud skill guards [3 files] _(ai-assisted)_
- `67c932f3` 2026-06-10 — docs(higgsfield): e2e canary findings + G-list quality-tier cost table + teardown ledger [1 files]
- `780eb533` 2026-06-10 — docs(higgsfield): corrected parity table — real bar=kling-3.0, frontier catalog + monthly tier costs + seedance vetting path [1 files]
- `956b4d63` 2026-06-10 — docs(higgsfield): grant ledger final — 17cr held + earmarked for seedance vet (Cooper ruling ii) [1 files]
- `65b0f4d4` 2026-06-11 — feat(higgsfield): G9 frontier slug sweep — allowlist kling-3.0/2.6, seedance-2.0/1, veo-3.1 probes [1 files] _(ai-assisted)_
- `9d0e7763` 2026-06-11 — feat(higgsfield): G9 sweep result — keep Kling 3.0+2.6 (Cloud-callable, rendered), revert dead seedance/veo [1 files] _(ai-assisted)_
- `2ec5ebde` 2026-06-11 — feat(higgsfield): 16:9 source frames + kling-3.0 text-to-video (fair-fight vs legacy crab) [2 files] _(ai-assisted)_
- `2b05a564` 2026-06-11 — fix(telegram): sendTelegramVideo passes real width/height/duration/supports_streaming (fleet media surface) [1 files] _(ai-assisted)_
- `7e4ead85` 2026-06-11 — fix(telegram): restore sendTelegramMessageWithButton (clobbered) + keep dims fix [1 files] _(ai-assisted)_
- `967ced02` 2026-06-11 — feat(higgsfield): wire video ladder by INPUT (text-only→t2v cinematic, image→i2v) + Rules 73/74 [4 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `e735975b` 2026-06-11 — feat(higgsfield §3 + §2): video purchase path + COGS correction [5 files] _(ai-assisted)_
- `f65c83e0` 2026-06-11 — feat(higgsfield §5): central-balance protection — two layers (Rule-67 pattern) [5 files] _(ai-assisted)_
- `2686cd2e` 2026-06-11 — feat(higgsfield §6): i2v source-image upload — off the Muapi CDN, onto our rail [6 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `c1b2f626` 2026-06-11 — docs(higgsfield §6): CDN cache-decay note from the live e2e (delete verified at storage; URL serves ~1h longer from edge cache) [1 files] _(ai-assisted)_
- `1cd66415` 2026-06-11 — feat(higgsfield §4): first-video seed + funnel instrumentation (ships together) [6 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `0354c31e` 2026-06-11 — chore(higgsfield): promote both video migrations pending->migrations (Rule 56) [4 files] _(ai-assisted)_
- `bed02c01` 2026-06-11 — docs(higgsfield): ratified launch build order (prices locked, COGS proven) [2 files] _(ai-assisted)_
- `5333300c` 2026-06-12 — merge: origin/main (187 commits — frontier/travala lanes) into higgsfield lane [5 files] _(multi: [infrastructure, docs]; ai-assisted; merge)_
- `866c36e5` 2026-06-12 — merge: higgsfield lane — purchase path + balance protection + photo upload + first-video seed + dashboard shelf [0 files] _(ai-assisted; merge)_
- `e4cd6f48` 2026-06-12 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (0)

_(none)_

### Infrastructure (29)

- `eef8b4a7` 2026-06-09 — fix(higgsfield): close Kling 5s overcharge — re-pin to measured 15.0cr + lock duration to 10s [2 files] _(ai-assisted)_
- `83906dab` 2026-06-09 — fix(higgsfield): remove false "saved in your Studio" delivery copy (G6) [1 files] _(ai-assisted)_
- `5ebdbd02` 2026-06-09 — feat(higgsfield): G1 Part A — gate-side agent-poll support (Option B delivery) [4 files] _(ai-assisted)_
- `6cc4291f` 2026-06-09 — feat(higgsfield): G1 Part B — Cloud-rail skill files (agent-poll + G8 selection) [4 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `e34bfecc` 2026-06-09 — chore(higgsfield): untrack stray __pycache__ .pyc + ignore python build artifacts [2 files] _(ai-assisted)_
- `52aa50a0` 2026-06-09 — fix(higgsfield): M1 fail-safe status + M2 busy/rate-limit handling + de-em-dash copy [4 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `fc4e4b7f` 2026-06-09 — chore: trigger preview rebuild for higgsfield canary [0 files]
- `3667484c` 2026-06-09 — feat(higgsfield-cloud): canary bypass header for dark preview gate [1 files]
- `8ec182fd` 2026-06-10 — feat(higgsfield): HIGGSFIELD_GATE_ENABLED kill-switch on both gate routes [2 files]
- `7781dc70` 2026-06-10 — feat(higgsfield): G11 stale-hold sweeper cron — orphaned-render error handling [2 files] _(ai-assisted)_
- `51b8f8ae` 2026-06-10 — feat(higgsfield): A2 — gate resolves telegram_chat_id server-side when agent omits it [1 files] _(ai-assisted)_
- `cff3e4ee` 2026-06-10 — feat(higgsfield): passive telegram_chat_id backfill in proxy (A2 enabler) [1 files] _(ai-assisted)_
- `8ab053c5` 2026-06-10 — fix(higgsfield): suppress image webhook-delivery + delivery idempotency [3 files] _(ai-assisted)_
- `e98c8096` 2026-06-10 — feat(higgsfield): allowlist bytedance/seedance/v1/pro for the frontier quality vet [1 files] _(ai-assisted)_
- `b937e99d` 2026-06-10 — revert(higgsfield): remove bytedance/seedance/v1/pro allowlist entry [1 files] _(ai-assisted)_
- `65b0f4d4` 2026-06-11 — feat(higgsfield): G9 frontier slug sweep — allowlist kling-3.0/2.6, seedance-2.0/1, veo-3.1 probes [1 files] _(ai-assisted)_
- `9d0e7763` 2026-06-11 — feat(higgsfield): G9 sweep result — keep Kling 3.0+2.6 (Cloud-callable, rendered), revert dead seedance/veo [1 files] _(ai-assisted)_
- `2ec5ebde` 2026-06-11 — feat(higgsfield): 16:9 source frames + kling-3.0 text-to-video (fair-fight vs legacy crab) [2 files] _(ai-assisted)_
- `2b05a564` 2026-06-11 — fix(telegram): sendTelegramVideo passes real width/height/duration/supports_streaming (fleet media surface) [1 files] _(ai-assisted)_
- `7e4ead85` 2026-06-11 — fix(telegram): restore sendTelegramMessageWithButton (clobbered) + keep dims fix [1 files] _(ai-assisted)_
- `967ced02` 2026-06-11 — feat(higgsfield): wire video ladder by INPUT (text-only→t2v cinematic, image→i2v) + Rules 73/74 [4 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `e735975b` 2026-06-11 — feat(higgsfield §3 + §2): video purchase path + COGS correction [5 files] _(ai-assisted)_
- `f65c83e0` 2026-06-11 — feat(higgsfield §5): central-balance protection — two layers (Rule-67 pattern) [5 files] _(ai-assisted)_
- `2686cd2e` 2026-06-11 — feat(higgsfield §6): i2v source-image upload — off the Muapi CDN, onto our rail [6 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `c1b2f626` 2026-06-11 — docs(higgsfield §6): CDN cache-decay note from the live e2e (delete verified at storage; URL serves ~1h longer from edge cache) [1 files] _(ai-assisted)_
- `1cd66415` 2026-06-11 — feat(higgsfield §4): first-video seed + funnel instrumentation (ships together) [6 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `0354c31e` 2026-06-11 — chore(higgsfield): promote both video migrations pending->migrations (Rule 56) [4 files] _(ai-assisted)_
- `5333300c` 2026-06-12 — merge: origin/main (187 commits — frontier/travala lanes) into higgsfield lane [5 files] _(multi: [infrastructure, docs]; ai-assisted; merge)_
- `866c36e5` 2026-06-12 — merge: higgsfield lane — purchase path + balance protection + photo upload + first-video seed + dashboard shelf [0 files] _(ai-assisted; merge)_

### Feature (user-facing) (1)

- `ea83d92f` 2026-06-11 — feat(higgsfield fork-a): video packs on the dashboard shelf + honest upsell destination [4 files] _(multi: [feature, docs]; ai-assisted)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (15)

- `97cbedfb` 2026-06-09 — feat(higgsfield): complete the Cloud-rail video gate as a deployable unit [13 files] _(ai-assisted)_
- `12650990` 2026-06-09 — docs(higgsfield): commit the gate→user-path PRD + capture AGENTS.md:189 side-finding [1 files] _(ai-assisted)_
- `c73b9115` 2026-06-09 — docs(higgsfield): PRD §9 — G1 build + adversarial-review outcomes [1 files] _(ai-assisted)_
- `4733be72` 2026-06-09 — docs(higgsfield): H1 RESOLVED (native via message tool) + capture 2 separate findings [1 files] _(ai-assisted)_
- `52c244f9` 2026-06-09 — fix(higgsfield): SKILL.md — native attachment is the default delivery, never a link [1 files] _(ai-assisted)_
- `0ece4ccf` 2026-06-10 — docs(higgsfield): canary verdict + closeout audit; skill _gate_base/bypass for re-run [3 files]
- `ea98c03d` 2026-06-10 — docs(higgsfield): PRD reconciliation + ordered remaining-work list to fleet-ship [1 files]
- `745e76ee` 2026-06-10 — docs(higgsfield): M5 async-delivery design + fork points (pre-build) [1 files]
- `93bdc25a` 2026-06-10 — feat(higgsfield-cloud): M5 fix — video submit-only (webhook delivers), image sync [2 files]
- `9c763968` 2026-06-10 — fix(higgsfield): free-cap excludes released holds (Option A) + fail-loud skill guards [3 files] _(ai-assisted)_
- `67c932f3` 2026-06-10 — docs(higgsfield): e2e canary findings + G-list quality-tier cost table + teardown ledger [1 files]
- `780eb533` 2026-06-10 — docs(higgsfield): corrected parity table — real bar=kling-3.0, frontier catalog + monthly tier costs + seedance vetting path [1 files]
- `956b4d63` 2026-06-10 — docs(higgsfield): grant ledger final — 17cr held + earmarked for seedance vet (Cooper ruling ii) [1 files]
- `bed02c01` 2026-06-11 — docs(higgsfield): ratified launch build order (prices locked, COGS proven) [2 files] _(ai-assisted)_
- `e4cd6f48` 2026-06-12 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (7)

These touch more than one category root and are listed in every applicable section above.

- `6cc4291f` 2026-06-09 — [infrastructure, docs] — feat(higgsfield): G1 Part B — Cloud-rail skill files (agent-poll + G8 selection)
- `52aa50a0` 2026-06-09 — [infrastructure, docs] — fix(higgsfield): M1 fail-safe status + M2 busy/rate-limit handling + de-em-dash copy
- `967ced02` 2026-06-11 — [infrastructure, docs] — feat(higgsfield): wire video ladder by INPUT (text-only→t2v cinematic, image→i2v) + Rules 73/74
- `2686cd2e` 2026-06-11 — [infrastructure, docs] — feat(higgsfield §6): i2v source-image upload — off the Muapi CDN, onto our rail
- `1cd66415` 2026-06-11 — [infrastructure, docs] — feat(higgsfield §4): first-video seed + funnel instrumentation (ships together)
- `ea83d92f` 2026-06-11 — [feature, docs] — feat(higgsfield fork-a): video packs on the dashboard shelf + honest upsell destination
- `5333300c` 2026-06-12 — [infrastructure, docs] — merge: origin/main (187 commits — frontier/travala lanes) into higgsfield lane

## AI-assisted commits (34)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `eef8b4a7` 2026-06-09 — fix(higgsfield): close Kling 5s overcharge — re-pin to measured 15.0cr + lock duration to 10s
- `97cbedfb` 2026-06-09 — feat(higgsfield): complete the Cloud-rail video gate as a deployable unit
- `83906dab` 2026-06-09 — fix(higgsfield): remove false "saved in your Studio" delivery copy (G6)
- `5ebdbd02` 2026-06-09 — feat(higgsfield): G1 Part A — gate-side agent-poll support (Option B delivery)
- `6cc4291f` 2026-06-09 — feat(higgsfield): G1 Part B — Cloud-rail skill files (agent-poll + G8 selection)
- `12650990` 2026-06-09 — docs(higgsfield): commit the gate→user-path PRD + capture AGENTS.md:189 side-finding
- `e34bfecc` 2026-06-09 — chore(higgsfield): untrack stray __pycache__ .pyc + ignore python build artifacts
- `52aa50a0` 2026-06-09 — fix(higgsfield): M1 fail-safe status + M2 busy/rate-limit handling + de-em-dash copy
- `c73b9115` 2026-06-09 — docs(higgsfield): PRD §9 — G1 build + adversarial-review outcomes
- `4733be72` 2026-06-09 — docs(higgsfield): H1 RESOLVED (native via message tool) + capture 2 separate findings
- `52c244f9` 2026-06-09 — fix(higgsfield): SKILL.md — native attachment is the default delivery, never a link
- `7781dc70` 2026-06-10 — feat(higgsfield): G11 stale-hold sweeper cron — orphaned-render error handling
- `51b8f8ae` 2026-06-10 — feat(higgsfield): A2 — gate resolves telegram_chat_id server-side when agent omits it
- `cff3e4ee` 2026-06-10 — feat(higgsfield): passive telegram_chat_id backfill in proxy (A2 enabler)
- `9c763968` 2026-06-10 — fix(higgsfield): free-cap excludes released holds (Option A) + fail-loud skill guards
- `8ab053c5` 2026-06-10 — fix(higgsfield): suppress image webhook-delivery + delivery idempotency
- `e98c8096` 2026-06-10 — feat(higgsfield): allowlist bytedance/seedance/v1/pro for the frontier quality vet
- `b937e99d` 2026-06-10 — revert(higgsfield): remove bytedance/seedance/v1/pro allowlist entry
- `65b0f4d4` 2026-06-11 — feat(higgsfield): G9 frontier slug sweep — allowlist kling-3.0/2.6, seedance-2.0/1, veo-3.1 probes
- `9d0e7763` 2026-06-11 — feat(higgsfield): G9 sweep result — keep Kling 3.0+2.6 (Cloud-callable, rendered), revert dead seedance/veo
- `2ec5ebde` 2026-06-11 — feat(higgsfield): 16:9 source frames + kling-3.0 text-to-video (fair-fight vs legacy crab)
- `2b05a564` 2026-06-11 — fix(telegram): sendTelegramVideo passes real width/height/duration/supports_streaming (fleet media surface)
- `7e4ead85` 2026-06-11 — fix(telegram): restore sendTelegramMessageWithButton (clobbered) + keep dims fix
- `967ced02` 2026-06-11 — feat(higgsfield): wire video ladder by INPUT (text-only→t2v cinematic, image→i2v) + Rules 73/74
- `bed02c01` 2026-06-11 — docs(higgsfield): ratified launch build order (prices locked, COGS proven)
- `e735975b` 2026-06-11 — feat(higgsfield §3 + §2): video purchase path + COGS correction
- `f65c83e0` 2026-06-11 — feat(higgsfield §5): central-balance protection — two layers (Rule-67 pattern)
- `2686cd2e` 2026-06-11 — feat(higgsfield §6): i2v source-image upload — off the Muapi CDN, onto our rail
- `c1b2f626` 2026-06-11 — docs(higgsfield §6): CDN cache-decay note from the live e2e (delete verified at storage; URL serves ~1h longer from edge cache)
- `1cd66415` 2026-06-11 — feat(higgsfield §4): first-video seed + funnel instrumentation (ships together)
- `ea83d92f` 2026-06-11 — feat(higgsfield fork-a): video packs on the dashboard shelf + honest upsell destination
- `0354c31e` 2026-06-11 — chore(higgsfield): promote both video migrations pending->migrations (Rule 56)
- `5333300c` 2026-06-12 — merge: origin/main (187 commits — frontier/travala lanes) into higgsfield lane
- `866c36e5` 2026-06-12 — merge: higgsfield lane — purchase path + balance protection + photo upload + first-video seed + dashboard shelf

## Appendix — every commit (chronological)

- `eef8b4a7` 2026-06-09 — fix(higgsfield): close Kling 5s overcharge — re-pin to measured 15.0cr + lock duration to 10s [2 files] _(ai-assisted)_
- `97cbedfb` 2026-06-09 — feat(higgsfield): complete the Cloud-rail video gate as a deployable unit [13 files] _(ai-assisted)_
- `83906dab` 2026-06-09 — fix(higgsfield): remove false "saved in your Studio" delivery copy (G6) [1 files] _(ai-assisted)_
- `5ebdbd02` 2026-06-09 — feat(higgsfield): G1 Part A — gate-side agent-poll support (Option B delivery) [4 files] _(ai-assisted)_
- `6cc4291f` 2026-06-09 — feat(higgsfield): G1 Part B — Cloud-rail skill files (agent-poll + G8 selection) [4 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `12650990` 2026-06-09 — docs(higgsfield): commit the gate→user-path PRD + capture AGENTS.md:189 side-finding [1 files] _(ai-assisted)_
- `e34bfecc` 2026-06-09 — chore(higgsfield): untrack stray __pycache__ .pyc + ignore python build artifacts [2 files] _(ai-assisted)_
- `52aa50a0` 2026-06-09 — fix(higgsfield): M1 fail-safe status + M2 busy/rate-limit handling + de-em-dash copy [4 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `c73b9115` 2026-06-09 — docs(higgsfield): PRD §9 — G1 build + adversarial-review outcomes [1 files] _(ai-assisted)_
- `4733be72` 2026-06-09 — docs(higgsfield): H1 RESOLVED (native via message tool) + capture 2 separate findings [1 files] _(ai-assisted)_
- `52c244f9` 2026-06-09 — fix(higgsfield): SKILL.md — native attachment is the default delivery, never a link [1 files] _(ai-assisted)_
- `fc4e4b7f` 2026-06-09 — chore: trigger preview rebuild for higgsfield canary [0 files]
- `3667484c` 2026-06-09 — feat(higgsfield-cloud): canary bypass header for dark preview gate [1 files]
- `0ece4ccf` 2026-06-10 — docs(higgsfield): canary verdict + closeout audit; skill _gate_base/bypass for re-run [3 files]
- `ea98c03d` 2026-06-10 — docs(higgsfield): PRD reconciliation + ordered remaining-work list to fleet-ship [1 files]
- `745e76ee` 2026-06-10 — docs(higgsfield): M5 async-delivery design + fork points (pre-build) [1 files]
- `8ec182fd` 2026-06-10 — feat(higgsfield): HIGGSFIELD_GATE_ENABLED kill-switch on both gate routes [2 files]
- `93bdc25a` 2026-06-10 — feat(higgsfield-cloud): M5 fix — video submit-only (webhook delivers), image sync [2 files]
- `7781dc70` 2026-06-10 — feat(higgsfield): G11 stale-hold sweeper cron — orphaned-render error handling [2 files] _(ai-assisted)_
- `51b8f8ae` 2026-06-10 — feat(higgsfield): A2 — gate resolves telegram_chat_id server-side when agent omits it [1 files] _(ai-assisted)_
- `cff3e4ee` 2026-06-10 — feat(higgsfield): passive telegram_chat_id backfill in proxy (A2 enabler) [1 files] _(ai-assisted)_
- `9c763968` 2026-06-10 — fix(higgsfield): free-cap excludes released holds (Option A) + fail-loud skill guards [3 files] _(ai-assisted)_
- `8ab053c5` 2026-06-10 — fix(higgsfield): suppress image webhook-delivery + delivery idempotency [3 files] _(ai-assisted)_
- `67c932f3` 2026-06-10 — docs(higgsfield): e2e canary findings + G-list quality-tier cost table + teardown ledger [1 files]
- `780eb533` 2026-06-10 — docs(higgsfield): corrected parity table — real bar=kling-3.0, frontier catalog + monthly tier costs + seedance vetting path [1 files]
- `956b4d63` 2026-06-10 — docs(higgsfield): grant ledger final — 17cr held + earmarked for seedance vet (Cooper ruling ii) [1 files]
- `e98c8096` 2026-06-10 — feat(higgsfield): allowlist bytedance/seedance/v1/pro for the frontier quality vet [1 files] _(ai-assisted)_
- `b937e99d` 2026-06-10 — revert(higgsfield): remove bytedance/seedance/v1/pro allowlist entry [1 files] _(ai-assisted)_
- `65b0f4d4` 2026-06-11 — feat(higgsfield): G9 frontier slug sweep — allowlist kling-3.0/2.6, seedance-2.0/1, veo-3.1 probes [1 files] _(ai-assisted)_
- `9d0e7763` 2026-06-11 — feat(higgsfield): G9 sweep result — keep Kling 3.0+2.6 (Cloud-callable, rendered), revert dead seedance/veo [1 files] _(ai-assisted)_
- `2ec5ebde` 2026-06-11 — feat(higgsfield): 16:9 source frames + kling-3.0 text-to-video (fair-fight vs legacy crab) [2 files] _(ai-assisted)_
- `2b05a564` 2026-06-11 — fix(telegram): sendTelegramVideo passes real width/height/duration/supports_streaming (fleet media surface) [1 files] _(ai-assisted)_
- `7e4ead85` 2026-06-11 — fix(telegram): restore sendTelegramMessageWithButton (clobbered) + keep dims fix [1 files] _(ai-assisted)_
- `967ced02` 2026-06-11 — feat(higgsfield): wire video ladder by INPUT (text-only→t2v cinematic, image→i2v) + Rules 73/74 [4 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `bed02c01` 2026-06-11 — docs(higgsfield): ratified launch build order (prices locked, COGS proven) [2 files] _(ai-assisted)_
- `e735975b` 2026-06-11 — feat(higgsfield §3 + §2): video purchase path + COGS correction [5 files] _(ai-assisted)_
- `f65c83e0` 2026-06-11 — feat(higgsfield §5): central-balance protection — two layers (Rule-67 pattern) [5 files] _(ai-assisted)_
- `2686cd2e` 2026-06-11 — feat(higgsfield §6): i2v source-image upload — off the Muapi CDN, onto our rail [6 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `c1b2f626` 2026-06-11 — docs(higgsfield §6): CDN cache-decay note from the live e2e (delete verified at storage; URL serves ~1h longer from edge cache) [1 files] _(ai-assisted)_
- `1cd66415` 2026-06-11 — feat(higgsfield §4): first-video seed + funnel instrumentation (ships together) [6 files] _(multi: [infrastructure, docs]; ai-assisted)_
- `ea83d92f` 2026-06-11 — feat(higgsfield fork-a): video packs on the dashboard shelf + honest upsell destination [4 files] _(multi: [feature, docs]; ai-assisted)_
- `0354c31e` 2026-06-11 — chore(higgsfield): promote both video migrations pending->migrations (Rule 56) [4 files] _(ai-assisted)_
- `e4cd6f48` 2026-06-12 — chore(changelog): auto-update [skip ci] [2 files]
- `5333300c` 2026-06-12 — merge: origin/main (187 commits — frontier/travala lanes) into higgsfield lane [5 files] _(multi: [infrastructure, docs]; ai-assisted; merge)_
- `866c36e5` 2026-06-12 — merge: higgsfield lane — purchase path + balance protection + photo upload + first-video seed + dashboard shelf [0 files] _(ai-assisted; merge)_
