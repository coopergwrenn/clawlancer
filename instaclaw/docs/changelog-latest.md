# Changelog — generated 2026-06-02

Window: `b03b5c2fc64e8374976a42ea040b157ab609475e` → `HEAD` (HEAD = `e9f20986`)
Total commits: 6

<!-- LAST_GENERATED_SHA: e9f20986ca0841426beead25a4c3e1aa9af1d68c -->

## Summary

- **Manifest version bumps:** 1
  - Range: v128 → v128
- **Reconciler / manifest:** 2
- **Infrastructure:** 1
- **Feature (user-facing):** 1
- **Edge City partner:** 0
- **Docs / PRD only:** 2
- AI-assisted commits (co-authored): 3
- Merge commits: 1

## Manifest version timeline

### v128 — 2026-06-02 — `e9f20986`

feat(v128): activate WorldID-gated ToolRouter fleet-wide

> Pairs with commit 803571d0 (feat(toolrouter): WorldID gate + activate
> K.4 fleet-wide). v128 advances the reconciler's filter cutoff to force
> every healthy + assigned VM at cv<128 back through reconcileVM, which
> runs the new stepDeployToolRouterRouting + stepDeployToolRouterBilling
> + stepToolRouter chain. The WorldID gate fires per-VM: verified users
> get the MCP wired (premium tools appear in the agent's catalog within
> seconds), unverified users have any stale entry unwired.

## What changed for users

- `4536d516` 2026-06-02 — feat(floor): redesign Larry's claws + body as a cohesive character [1 files]

## What changed under the hood

- `803571d0` 2026-06-02 — feat(toolrouter): WorldID gate + activate K.4 fleet-wide [6 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `e9f20986` 2026-06-02 — feat(v128): activate WorldID-gated ToolRouter fleet-wide [2 files] _(**MANIFEST v128**; multi: [reconciler, infrastructure]; ai-assisted)_
- `a9d3c4e5` 2026-06-02 — Merge remote-tracking branch 'origin/main' into feat/floor-claws-v3b [0 files] _(merge)_
- `88b22446` 2026-06-02 — chore(changelog): auto-update [skip ci] [2 files]
- `5af73ee6` 2026-06-02 — fix(billing): pass p_source explicitly on instaclaw_add_credits — credit_pack webhook silently broken 35 days [3 files] _(ai-assisted)_

## By category

### Reconciler / manifest (2)

- `803571d0` 2026-06-02 — feat(toolrouter): WorldID gate + activate K.4 fleet-wide [6 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `e9f20986` 2026-06-02 — feat(v128): activate WorldID-gated ToolRouter fleet-wide [2 files] _(**MANIFEST v128**; multi: [reconciler, infrastructure]; ai-assisted)_

### Infrastructure (1)

- `a9d3c4e5` 2026-06-02 — Merge remote-tracking branch 'origin/main' into feat/floor-claws-v3b [0 files] _(merge)_

### Feature (user-facing) (1)

- `4536d516` 2026-06-02 — feat(floor): redesign Larry's claws + body as a cohesive character [1 files]

### Edge City partner (0)

_(none)_

### Docs / PRD only (2)

- `88b22446` 2026-06-02 — chore(changelog): auto-update [skip ci] [2 files]
- `5af73ee6` 2026-06-02 — fix(billing): pass p_source explicitly on instaclaw_add_credits — credit_pack webhook silently broken 35 days [3 files] _(ai-assisted)_

## Multi-category commits (2)

These touch more than one category root and are listed in every applicable section above.

- `803571d0` 2026-06-02 — [reconciler, infrastructure] — feat(toolrouter): WorldID gate + activate K.4 fleet-wide
- `e9f20986` 2026-06-02 — [reconciler, infrastructure] — feat(v128): activate WorldID-gated ToolRouter fleet-wide

## AI-assisted commits (3)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `5af73ee6` 2026-06-02 — fix(billing): pass p_source explicitly on instaclaw_add_credits — credit_pack webhook silently broken 35 days
- `803571d0` 2026-06-02 — feat(toolrouter): WorldID gate + activate K.4 fleet-wide
- `e9f20986` 2026-06-02 — feat(v128): activate WorldID-gated ToolRouter fleet-wide

## Appendix — every commit (chronological)

- `88b22446` 2026-06-02 — chore(changelog): auto-update [skip ci] [2 files]
- `4536d516` 2026-06-02 — feat(floor): redesign Larry's claws + body as a cohesive character [1 files]
- `a9d3c4e5` 2026-06-02 — Merge remote-tracking branch 'origin/main' into feat/floor-claws-v3b [0 files] _(merge)_
- `5af73ee6` 2026-06-02 — fix(billing): pass p_source explicitly on instaclaw_add_credits — credit_pack webhook silently broken 35 days [3 files] _(ai-assisted)_
- `803571d0` 2026-06-02 — feat(toolrouter): WorldID gate + activate K.4 fleet-wide [6 files] _(multi: [reconciler, infrastructure]; ai-assisted)_
- `e9f20986` 2026-06-02 — feat(v128): activate WorldID-gated ToolRouter fleet-wide [2 files] _(**MANIFEST v128**; multi: [reconciler, infrastructure]; ai-assisted)_
