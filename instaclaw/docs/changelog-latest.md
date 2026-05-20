# Changelog — generated 2026-05-20

Window: `9c8673f17b06563c7cc9bc2927cf51ffe46e5752` → `HEAD` (HEAD = `1731909f`)
Total commits: 2

<!-- LAST_GENERATED_SHA: 1731909f8af498461aa3c2bc97c82891920ff036 -->

## Summary

- **Manifest version bumps:** 1
  - Range: v111 → v111
- **Reconciler / manifest:** 1
- **Infrastructure:** 0
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 1
- AI-assisted commits (co-authored): 1
- Merge commits: 0

## Manifest version timeline

### v111 — 2026-05-20 — `1731909f`

chore(manifest): v111 — gate new stepEdgeOSApiKey reconciler step

> VM_MANIFEST.version 110 → 111 so the 4 edge_city VMs currently at
> cv=110 (vm-050, vm-354, vm-771, vm-923) re-enter the reconcile-fleet
> candidate query and pick up the new stepEdgeOSApiKey reconciler step
> (commit 12842fb2). Per CLAUDE.md version-bump policy: a new
> reconciler step is a MUST-bump case — without the bump, current-cv
> VMs are filtered out by `lt(config_version, 110)` forever.

## What changed for users

_None in this window._

## What changed under the hood

- `1731909f` 2026-05-20 — chore(manifest): v111 — gate new stepEdgeOSApiKey reconciler step [3 files] _(**MANIFEST v111**; multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
- `8b120c43` 2026-05-20 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (1)

- `1731909f` 2026-05-20 — chore(manifest): v111 — gate new stepEdgeOSApiKey reconciler step [3 files] _(**MANIFEST v111**; multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_

### Infrastructure (0)

_(none)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (1)

- `8b120c43` 2026-05-20 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (1)

These touch more than one category root and are listed in every applicable section above.

- `1731909f` 2026-05-20 — [reconciler, infrastructure, edge, docs] — chore(manifest): v111 — gate new stepEdgeOSApiKey reconciler step

## AI-assisted commits (1)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `1731909f` 2026-05-20 — chore(manifest): v111 — gate new stepEdgeOSApiKey reconciler step

## Appendix — every commit (chronological)

- `8b120c43` 2026-05-20 — chore(changelog): auto-update [skip ci] [2 files]
- `1731909f` 2026-05-20 — chore(manifest): v111 — gate new stepEdgeOSApiKey reconciler step [3 files] _(**MANIFEST v111**; multi: [reconciler, infrastructure, edge, docs]; ai-assisted)_
