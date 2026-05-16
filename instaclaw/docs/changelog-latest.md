# Changelog — generated 2026-05-16

Window: `4ca1860d22b38e0e1671aa81012a59a8bc7f8f26` → `HEAD` (HEAD = `48af5075`)
Total commits: 2

<!-- LAST_GENERATED_SHA: 48af5075f23662c3da55edb04dfe56371196ae0e -->

## Summary

- **Manifest version bumps:** 1
  - Range: v101 → v101
- **Reconciler / manifest:** 1
- **Infrastructure:** 0
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 1
- AI-assisted commits (co-authored): 1
- Merge commits: 0

## Manifest version timeline

### v101 — 2026-05-16 — `48af5075`

feat(v101): startup orphan tool_use repair — companion fix to v100

> When SIGTERM lands during an in-flight tool_use turn — between the
> assistant writing a toolCall and the matching toolResult being persisted
> — the session jsonl is left with an orphan toolCall. Anthropic's API
> rejects the next turn with 400 "tool_use_id: did not find matching
> tool_use_id", which OpenClaw's error path surfaces as
> "Something went wrong, use /new" to the customer.

## What changed for users

_None in this window._

## What changed under the hood

- `48af5075` 2026-05-16 — feat(v101): startup orphan tool_use repair — companion fix to v100 [5 files] _(**MANIFEST v101**; multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `5a0c19dd` 2026-05-16 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (1)

- `48af5075` 2026-05-16 — feat(v101): startup orphan tool_use repair — companion fix to v100 [5 files] _(**MANIFEST v101**; multi: [reconciler, infrastructure, docs]; ai-assisted)_

### Infrastructure (0)

_(none)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (1)

- `5a0c19dd` 2026-05-16 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (1)

These touch more than one category root and are listed in every applicable section above.

- `48af5075` 2026-05-16 — [reconciler, infrastructure, docs] — feat(v101): startup orphan tool_use repair — companion fix to v100

## AI-assisted commits (1)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `48af5075` 2026-05-16 — feat(v101): startup orphan tool_use repair — companion fix to v100

## Appendix — every commit (chronological)

- `5a0c19dd` 2026-05-16 — chore(changelog): auto-update [skip ci] [2 files]
- `48af5075` 2026-05-16 — feat(v101): startup orphan tool_use repair — companion fix to v100 [5 files] _(**MANIFEST v101**; multi: [reconciler, infrastructure, docs]; ai-assisted)_
