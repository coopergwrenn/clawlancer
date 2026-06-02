# Changelog — generated 2026-06-02

Window: `da6b842452c6abd09d2d8f8b1681792c49c42762` → `HEAD` (HEAD = `d923dc63`)
Total commits: 3

<!-- LAST_GENERATED_SHA: d923dc6393c51ff0ae1298732fe63c8d3f7c9ad7 -->

## Summary

- **Manifest version bumps:** 1
  - Range: v127 → v127
- **Reconciler / manifest:** 2
- **Infrastructure:** 0
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 1
- AI-assisted commits (co-authored): 2
- Merge commits: 0

## Manifest version timeline

### v127 — 2026-06-02 — `d923dc63`

feat(v127): bump manifest to roll toolrouter execPath fix fleet-wide

> Pairs with commit 69b74043 (fix(toolrouter): resolve wrapper child
> binary sibling-to-execPath). v127 advances the reconciler's filter
> cutoff to force every healthy + assigned VM at cv<127 back through
> stepFiles, which redeploys the corrected toolrouter-wrapper.mjs from
> TOOLROUTER_WRAPPER_MJS via the Rule 23 sentinel guard (now requires
> BINARY_RESOLVED_BY_EXECPATH).

## What changed for users

_None in this window._

## What changed under the hood

- `806bb6a4` 2026-06-02 — fix(toolrouter): resolve wrapper child binary sibling-to-execPath [3 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `d923dc63` 2026-06-02 — feat(v127): bump manifest to roll toolrouter execPath fix fleet-wide [2 files] _(**MANIFEST v127**; multi: [reconciler, infrastructure]; ai-assisted)_
- `ded94b24` 2026-06-02 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (2)

- `806bb6a4` 2026-06-02 — fix(toolrouter): resolve wrapper child binary sibling-to-execPath [3 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `d923dc63` 2026-06-02 — feat(v127): bump manifest to roll toolrouter execPath fix fleet-wide [2 files] _(**MANIFEST v127**; multi: [reconciler, infrastructure]; ai-assisted)_

### Infrastructure (0)

_(none)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (1)

- `ded94b24` 2026-06-02 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (2)

These touch more than one category root and are listed in every applicable section above.

- `806bb6a4` 2026-06-02 — [reconciler, infrastructure] — fix(toolrouter): resolve wrapper child binary sibling-to-execPath
- `d923dc63` 2026-06-02 — [reconciler, infrastructure] — feat(v127): bump manifest to roll toolrouter execPath fix fleet-wide

## AI-assisted commits (2)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `806bb6a4` 2026-06-02 — fix(toolrouter): resolve wrapper child binary sibling-to-execPath
- `d923dc63` 2026-06-02 — feat(v127): bump manifest to roll toolrouter execPath fix fleet-wide

## Appendix — every commit (chronological)

- `ded94b24` 2026-06-02 — chore(changelog): auto-update [skip ci] [2 files]
- `806bb6a4` 2026-06-02 — fix(toolrouter): resolve wrapper child binary sibling-to-execPath [3 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `d923dc63` 2026-06-02 — feat(v127): bump manifest to roll toolrouter execPath fix fleet-wide [2 files] _(**MANIFEST v127**; multi: [reconciler, infrastructure]; ai-assisted)_
