# Changelog — generated 2026-05-26

Window: `67e1237fad9c7e1db28e656affaabd5d7892ce4e` → `HEAD` (HEAD = `f16a743a`)
Total commits: 3

<!-- LAST_GENERATED_SHA: f16a743aca4b64b3f64f6b26a1a10bac4068839b -->

## Summary

- **Manifest version bumps:** 1
  - Range: v122 → v122
- **Reconciler / manifest:** 2
- **Infrastructure:** 0
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 1
- AI-assisted commits (co-authored): 2
- Merge commits: 0

## Manifest version timeline

### v122 — 2026-05-26 — `a073b316`

feat(v122): bump manifest 121 → 122 for OpenClaw 2026.5.22 fleet rollout

> Content-identical to v121. The bump's sole purpose is to re-enter the
> 151 healthy + assigned cv=121 customer VMs into the reconcile-fleet
> queue (via the `lt(config_version, manifest)` filter at line 474).
> Once they enter, stepNpmPinDrift detects the 2026.4.26 → 2026.5.22
> mismatch and runs `npm install -g openclaw@2026.5.22` on each VM.

## What changed for users

_None in this window._

## What changed under the hood

- `a073b316` 2026-05-26 — feat(v122): bump manifest 121 → 122 for OpenClaw 2026.5.22 fleet rollout [2 files] _(**MANIFEST v122**; multi: [reconciler, infrastructure]; ai-assisted)_
- `f16a743a` 2026-05-26 — fix(configureOpenClaw): channels.telegram.streaming must be object (2026.5.22 schema) [3 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `debe8087` 2026-05-26 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (2)

- `a073b316` 2026-05-26 — feat(v122): bump manifest 121 → 122 for OpenClaw 2026.5.22 fleet rollout [2 files] _(**MANIFEST v122**; multi: [reconciler, infrastructure]; ai-assisted)_
- `f16a743a` 2026-05-26 — fix(configureOpenClaw): channels.telegram.streaming must be object (2026.5.22 schema) [3 files] _(multi: [reconciler, infrastructure]; ai-assisted)_

### Infrastructure (0)

_(none)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (1)

- `debe8087` 2026-05-26 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (2)

These touch more than one category root and are listed in every applicable section above.

- `a073b316` 2026-05-26 — [reconciler, infrastructure] — feat(v122): bump manifest 121 → 122 for OpenClaw 2026.5.22 fleet rollout
- `f16a743a` 2026-05-26 — [reconciler, infrastructure] — fix(configureOpenClaw): channels.telegram.streaming must be object (2026.5.22 schema)

## AI-assisted commits (2)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `a073b316` 2026-05-26 — feat(v122): bump manifest 121 → 122 for OpenClaw 2026.5.22 fleet rollout
- `f16a743a` 2026-05-26 — fix(configureOpenClaw): channels.telegram.streaming must be object (2026.5.22 schema)

## Appendix — every commit (chronological)

- `debe8087` 2026-05-26 — chore(changelog): auto-update [skip ci] [2 files]
- `a073b316` 2026-05-26 — feat(v122): bump manifest 121 → 122 for OpenClaw 2026.5.22 fleet rollout [2 files] _(**MANIFEST v122**; multi: [reconciler, infrastructure]; ai-assisted)_
- `f16a743a` 2026-05-26 — fix(configureOpenClaw): channels.telegram.streaming must be object (2026.5.22 schema) [3 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
