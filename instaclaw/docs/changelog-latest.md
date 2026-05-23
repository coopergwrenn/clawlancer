# Changelog — generated 2026-05-23

Window: `0617b660353790d56297876650de4b9f6de85e4a` → `HEAD` (HEAD = `1fab31fa`)
Total commits: 2

<!-- LAST_GENERATED_SHA: 1fab31fa73b1b2ad98594198c5895db38f7d1881 -->

## Summary

- **Manifest version bumps:** 1
  - Range: v116 → v116
- **Reconciler / manifest:** 1
- **Infrastructure:** 0
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 1
- AI-assisted commits (co-authored): 1
- Merge commits: 0

## Manifest version timeline

### v116 — 2026-05-23 — `1fab31fa`

fix(v116): MEM_URGENT stale-flag root cause — exclude trajectory files from glob + clean-slate at configure

> THE 3-WEEK-OPEN BUG (vm-1019 e2e 2026-05-23):
> Cooper's first message took 3 minutes. The actual gpt-5.5 LLM call only
> took 16 seconds. 2 of those 3 minutes were the agent obeying a stale
> "SESSION ROTATION IMMINENT — WRITE YOUR MEMORIES NOW" warning that
> claimed 80% capacity on a 4%-capacity session. Bonjour fix (v115) freed
> the event loop; this v116 fix eliminates the fake-housekeeping turn.

## What changed for users

_None in this window._

## What changed under the hood

- `1fab31fa` 2026-05-23 — fix(v116): MEM_URGENT stale-flag root cause — exclude trajectory files from glob + clean-slate at configure [3 files] _(**MANIFEST v116**; multi: [reconciler, infrastructure]; ai-assisted)_
- `d717625d` 2026-05-23 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (1)

- `1fab31fa` 2026-05-23 — fix(v116): MEM_URGENT stale-flag root cause — exclude trajectory files from glob + clean-slate at configure [3 files] _(**MANIFEST v116**; multi: [reconciler, infrastructure]; ai-assisted)_

### Infrastructure (0)

_(none)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (1)

- `d717625d` 2026-05-23 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (1)

These touch more than one category root and are listed in every applicable section above.

- `1fab31fa` 2026-05-23 — [reconciler, infrastructure] — fix(v116): MEM_URGENT stale-flag root cause — exclude trajectory files from glob + clean-slate at configure

## AI-assisted commits (1)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `1fab31fa` 2026-05-23 — fix(v116): MEM_URGENT stale-flag root cause — exclude trajectory files from glob + clean-slate at configure

## Appendix — every commit (chronological)

- `d717625d` 2026-05-23 — chore(changelog): auto-update [skip ci] [2 files]
- `1fab31fa` 2026-05-23 — fix(v116): MEM_URGENT stale-flag root cause — exclude trajectory files from glob + clean-slate at configure [3 files] _(**MANIFEST v116**; multi: [reconciler, infrastructure]; ai-assisted)_
