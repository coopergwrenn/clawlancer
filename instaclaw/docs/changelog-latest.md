# Changelog — generated 2026-05-23

Window: `6ca60de579103f7dcf98c2407124a7543def0a52` → `HEAD` (HEAD = `503bf35f`)
Total commits: 2

<!-- LAST_GENERATED_SHA: 503bf35f6512424627f91606a62f7f309250ef4d -->

## Summary

- **Manifest version bumps:** 1
  - Range: v119 → v119
- **Reconciler / manifest:** 1
- **Infrastructure:** 0
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 1
- AI-assisted commits (co-authored): 1
- Merge commits: 0

## Manifest version timeline

### v119 — 2026-05-23 — `503bf35f`

fix(v119): EMERGENCY revert messages.statusReactions.enabled to false + CLAUDE.md Rule 64

> v118 re-enabled statusReactions fleet-wide on the bet that
> configureOpenClaw's typing-keepalive patch (commit 554cc581) would
> land fleet-wide. The bet was wrong — configureOpenClaw only runs at
> provisioning and certain reconcile flows, NOT on every existing
> assigned VM. Existing fleet VMs got statusReactions back via
> stepConfigSettings (auto-restart per Rule 32) WITHOUT the keepalive
> patch on their bot-msflwCEW.js. Every paying user on those VMs
> immediately saw the choppy "type → silence → emoji → silence → type"
> UX regression. v118 made the entire fleet worse to chase a fix that
> only existed on vm-1019.

## What changed for users

_None in this window._

## What changed under the hood

- `503bf35f` 2026-05-23 — fix(v119): EMERGENCY revert messages.statusReactions.enabled to false + CLAUDE.md Rule 64 [3 files] _(**MANIFEST v119**; multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `af83ec53` 2026-05-23 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (1)

- `503bf35f` 2026-05-23 — fix(v119): EMERGENCY revert messages.statusReactions.enabled to false + CLAUDE.md Rule 64 [3 files] _(**MANIFEST v119**; multi: [reconciler, infrastructure, docs]; ai-assisted)_

### Infrastructure (0)

_(none)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (1)

- `af83ec53` 2026-05-23 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (1)

These touch more than one category root and are listed in every applicable section above.

- `503bf35f` 2026-05-23 — [reconciler, infrastructure, docs] — fix(v119): EMERGENCY revert messages.statusReactions.enabled to false + CLAUDE.md Rule 64

## AI-assisted commits (1)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `503bf35f` 2026-05-23 — fix(v119): EMERGENCY revert messages.statusReactions.enabled to false + CLAUDE.md Rule 64

## Appendix — every commit (chronological)

- `af83ec53` 2026-05-23 — chore(changelog): auto-update [skip ci] [2 files]
- `503bf35f` 2026-05-23 — fix(v119): EMERGENCY revert messages.statusReactions.enabled to false + CLAUDE.md Rule 64 [3 files] _(**MANIFEST v119**; multi: [reconciler, infrastructure, docs]; ai-assisted)_
