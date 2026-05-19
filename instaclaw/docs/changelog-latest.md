# Changelog — generated 2026-05-19

Window: `8d464c117cd088ae7b6071b742d72dc8b36e9fbe` → `HEAD` (HEAD = `60d36675`)
Total commits: 2

<!-- LAST_GENERATED_SHA: 60d3667595a9b899d62a7302a68e55e34580d386 -->

## Summary

- **Manifest version bumps:** 1
  - Range: v106 → v106
- **Reconciler / manifest:** 1
- **Infrastructure:** 0
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 1
- AI-assisted commits (co-authored): 1
- Merge commits: 0

## Manifest version timeline

### v106 — 2026-05-19 — `60d36675`

feat(v106): stepDeployGbrainSoulRouting — replace MEMORY.md-first SOUL section with gbrain-first marker block

> Closes the gap surfaced by 2026-05-19 fleet audit: 8 of 9 edge_city VMs
> had the OBSOLETE MEMORY.md-first `## Memory Persistence (CRITICAL)`
> section in SOUL.md (bit-identical, sha 6010222d370f...), despite having
> gbrain v0.36.3.0 installed. Agents saw the MCP tools but their SOUL.md
> routing told them to write to MEMORY.md instead — so no persistent memory
> got built in practice on those 8 VMs. Only vm-050 had been hand-fixed via
> scripts/_push_gbrain_fix.ts on 2026-05-17.

## What changed for users

_None in this window._

## What changed under the hood

- `60d36675` 2026-05-19 — feat(v106): stepDeployGbrainSoulRouting — replace MEMORY.md-first SOUL section with gbrain-first marker block [8 files] _(**MANIFEST v106**; multi: [reconciler, infrastructure, edge]; ai-assisted)_
- `8377b9ef` 2026-05-19 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (1)

- `60d36675` 2026-05-19 — feat(v106): stepDeployGbrainSoulRouting — replace MEMORY.md-first SOUL section with gbrain-first marker block [8 files] _(**MANIFEST v106**; multi: [reconciler, infrastructure, edge]; ai-assisted)_

### Infrastructure (0)

_(none)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (1)

- `8377b9ef` 2026-05-19 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (1)

These touch more than one category root and are listed in every applicable section above.

- `60d36675` 2026-05-19 — [reconciler, infrastructure, edge] — feat(v106): stepDeployGbrainSoulRouting — replace MEMORY.md-first SOUL section with gbrain-first marker block

## AI-assisted commits (1)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `60d36675` 2026-05-19 — feat(v106): stepDeployGbrainSoulRouting — replace MEMORY.md-first SOUL section with gbrain-first marker block

## Appendix — every commit (chronological)

- `8377b9ef` 2026-05-19 — chore(changelog): auto-update [skip ci] [2 files]
- `60d36675` 2026-05-19 — feat(v106): stepDeployGbrainSoulRouting — replace MEMORY.md-first SOUL section with gbrain-first marker block [8 files] _(**MANIFEST v106**; multi: [reconciler, infrastructure, edge]; ai-assisted)_
