# Changelog — generated 2026-05-23

Window: `1bd15951d76ed0d729db11236190d56145c28cc8` → `HEAD` (HEAD = `b547f3de`)
Total commits: 2

<!-- LAST_GENERATED_SHA: b547f3de1a1933779f35d72d88cf39a037739770 -->

## Summary

- **Manifest version bumps:** 1
  - Range: v118 → v118
- **Reconciler / manifest:** 1
- **Infrastructure:** 0
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 1
- AI-assisted commits (co-authored): 1
- Merge commits: 0

## Manifest version timeline

### v118 — 2026-05-23 — `b547f3de`

fix(v118): typing-keepalive patch + re-enable statusReactions — premium choppy-free UX

> PROBLEM (Cooper 2026-05-23 vm-1019 e2e):
> Even after v117 disabled statusReactions, telegram UX still felt choppy.
> sendTyping's 5-second TTL (no keepalive) meant the indicator died during
> any LLM call >5s, leaving dead-typing-air during which any other
> activity (reactions, message-edits) looked like "weird stuff happening
> on my message" instead of progress. v117 just masked the noise.

## What changed for users

_None in this window._

## What changed under the hood

- `b547f3de` 2026-05-23 — fix(v118): typing-keepalive patch + re-enable statusReactions — premium choppy-free UX [3 files] _(**MANIFEST v118**; multi: [reconciler, infrastructure]; ai-assisted)_
- `b53b8625` 2026-05-23 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (1)

- `b547f3de` 2026-05-23 — fix(v118): typing-keepalive patch + re-enable statusReactions — premium choppy-free UX [3 files] _(**MANIFEST v118**; multi: [reconciler, infrastructure]; ai-assisted)_

### Infrastructure (0)

_(none)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (1)

- `b53b8625` 2026-05-23 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (1)

These touch more than one category root and are listed in every applicable section above.

- `b547f3de` 2026-05-23 — [reconciler, infrastructure] — fix(v118): typing-keepalive patch + re-enable statusReactions — premium choppy-free UX

## AI-assisted commits (1)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `b547f3de` 2026-05-23 — fix(v118): typing-keepalive patch + re-enable statusReactions — premium choppy-free UX

## Appendix — every commit (chronological)

- `b53b8625` 2026-05-23 — chore(changelog): auto-update [skip ci] [2 files]
- `b547f3de` 2026-05-23 — fix(v118): typing-keepalive patch + re-enable statusReactions — premium choppy-free UX [3 files] _(**MANIFEST v118**; multi: [reconciler, infrastructure]; ai-assisted)_
