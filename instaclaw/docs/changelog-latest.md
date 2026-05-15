# Changelog — generated 2026-05-15

Window: `5612bddf017861f845981eb240ef8e87626d7573` → `HEAD` (HEAD = `b1cc7a91`)
Total commits: 3

<!-- LAST_GENERATED_SHA: b1cc7a91a99caaf04efd3f353be658edbc47a759 -->

## Summary

- **Manifest version bumps:** 1
  - Range: v100 → v100
- **Reconciler / manifest:** 2
- **Infrastructure:** 0
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 1
- AI-assisted commits (co-authored): 2
- Merge commits: 0

## Manifest version timeline

### v100 — 2026-05-15 — `d2f94536`

feat(v100): remove RuntimeMaxSec — no more scheduled 24h gateway restarts

> The 24h forced restart via systemd RuntimeMaxSec caused mid-conversation
> SIGTERM with no drain mechanism. Discovered after P0 incident 2026-05-14
> 00:01:34 UTC on vm-050 (Cooper mid-conversation, queued "the one from
> uofa" message hit gateway DOWN window + post-restart gbrain MCP hang
> → user-facing "Something went wrong, use /new" Telegram error).

## What changed for users

_None in this window._

## What changed under the hood

- `d2f94536` 2026-05-15 — feat(v100): remove RuntimeMaxSec — no more scheduled 24h gateway restarts [5 files] _(**MANIFEST v100**; multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `b1cc7a91` 2026-05-15 — fix(reconcile): stepExternalSkillHeal — heal existing fleet for BE-5 (bankr overlay + consensus clone + edge clone + crons) [1 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `8d63d9b8` 2026-05-15 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (2)

- `d2f94536` 2026-05-15 — feat(v100): remove RuntimeMaxSec — no more scheduled 24h gateway restarts [5 files] _(**MANIFEST v100**; multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `b1cc7a91` 2026-05-15 — fix(reconcile): stepExternalSkillHeal — heal existing fleet for BE-5 (bankr overlay + consensus clone + edge clone + crons) [1 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_

### Infrastructure (0)

_(none)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (1)

- `8d63d9b8` 2026-05-15 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (2)

These touch more than one category root and are listed in every applicable section above.

- `d2f94536` 2026-05-15 — [reconciler, infrastructure, docs] — feat(v100): remove RuntimeMaxSec — no more scheduled 24h gateway restarts
- `b1cc7a91` 2026-05-15 — [reconciler, infrastructure, edge] — fix(reconcile): stepExternalSkillHeal — heal existing fleet for BE-5 (bankr overlay + consensus clone + edge clone + crons)

## AI-assisted commits (2)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `d2f94536` 2026-05-15 — feat(v100): remove RuntimeMaxSec — no more scheduled 24h gateway restarts
- `b1cc7a91` 2026-05-15 — fix(reconcile): stepExternalSkillHeal — heal existing fleet for BE-5 (bankr overlay + consensus clone + edge clone + crons)

## Appendix — every commit (chronological)

- `8d63d9b8` 2026-05-15 — chore(changelog): auto-update [skip ci] [2 files]
- `d2f94536` 2026-05-15 — feat(v100): remove RuntimeMaxSec — no more scheduled 24h gateway restarts [5 files] _(**MANIFEST v100**; multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `b1cc7a91` 2026-05-15 — fix(reconcile): stepExternalSkillHeal — heal existing fleet for BE-5 (bankr overlay + consensus clone + edge clone + crons) [1 files] _(multi: [reconciler, infrastructure, edge]; ai-assisted)_
