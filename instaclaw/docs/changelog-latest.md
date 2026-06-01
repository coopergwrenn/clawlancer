# Changelog — generated 2026-06-01

Window: `72b325404b3a183e0467eeeea5e5cb22c1548649` → `HEAD` (HEAD = `67b5ae2f`)
Total commits: 25

<!-- LAST_GENERATED_SHA: 67b5ae2f0002785e97d15360c8462a25fdbe1579 -->

## Summary

- **Manifest version bumps:** 0
- **Reconciler / manifest:** 0
- **Infrastructure:** 22
- **Feature (user-facing):** 0
- **Edge City partner:** 1
- **Docs / PRD only:** 2
- AI-assisted commits (co-authored): 24
- Merge commits: 1

## What changed for users

- `7610d27d` 2026-06-01 — docs(frontier): Agent Economy OS v0.2 PRD — two-phase (core infra → compute marketplace) [1 files] _(multi: [edge, docs]; ai-assisted)_

## What changed under the hood

- `edf9d525` 2026-06-01 — feat(frontier): DB schema — economy storage layer (pending_migrations) [1 files] _(ai-assisted)_
- `efee3b11` 2026-06-01 — feat(frontier): autonomy spend gate + 27-case unit test [2 files] _(ai-assisted)_
- `b62c9bb5` 2026-06-01 — fix(frontier): migration audit — FK ON DELETE semantics + defer premature columns [1 files] _(ai-assisted)_
- `c8fa074f` 2026-06-01 — chore(frontier): promote economy migration pending_migrations/ → migrations/ [2 files] _(ai-assisted)_
- `e906a153` 2026-06-01 — feat(frontier): POST /api/agent-economy/transaction — VM settlement record [2 files] _(ai-assisted)_
- `db4193aa` 2026-06-01 — feat(frontier): GET /api/agent-economy/state — dashboard economy summary [1 files] _(ai-assisted)_
- `c8388029` 2026-06-01 — feat(frontier): GET/POST /api/agent-economy/offerings — agent storefront CRUD [2 files] _(ai-assisted)_
- `64f20059` 2026-06-01 — feat(frontier): POST /api/agent-economy/reputation/queue — ERC-8004 feedback [2 files] _(ai-assisted)_
- `7a76af19` 2026-06-01 — feat(frontier): POST /api/agent-economy/refund — seller-initiated refund [2 files] _(ai-assisted)_
- `af8bc67f` 2026-06-01 — feat(frontier): GET /api/agent-economy/policy — effective spend bands [1 files] _(ai-assisted)_
- `151a7f57` 2026-06-01 — feat(frontier): on-chain settlement verifier (lib/frontier-chain-verify) + 27 tests [2 files] _(ai-assisted)_
- `f197be12` 2026-06-01 — feat(frontier): chain-verification settlement worker (cron) [1 files] _(ai-assisted)_
- `c089e122` 2026-06-01 — chore(frontier): schedule chain-verification worker every 5 min [1 files] _(ai-assisted)_
- `b7920e44` 2026-06-01 — fix(frontier): scope settlement replay-defense by direction [1 files] _(ai-assisted)_
- `e01fa368` 2026-06-01 — feat(frontier): treasury buy-and-burn executor (gated, crash-safe) [5 files] _(ai-assisted)_
- `41d8d971` 2026-06-01 — feat(frontier): nightly lifetime-rollup cron [2 files] _(ai-assisted)_
- `a81a1463` 2026-06-01 — feat(frontier): /offerings DELETE (soft-delete, provenance-safe) [1 files] _(ai-assisted)_
- `f9aaf6a5` 2026-06-01 — feat(frontier): /policy PUT — per-VM autonomy overrides (tighten-only) [4 files] _(ai-assisted)_
- `0a1eb163` 2026-06-01 — feat(frontier): refund-reconciliation sweep (the promised safety net) [4 files] _(ai-assisted)_
- `74e0100a` 2026-06-01 — chore(frontier): promote burn-claim-state + policy-overrides migrations [4 files] _(ai-assisted)_
- `6137b61d` 2026-06-01 — feat(frontier): _coverage-frontier.ts — Rule 27 economy health query [1 files] _(ai-assisted)_
- `67b5ae2f` 2026-06-01 — Merge feat/frontier-economy-phase1: Frontier agent economy (Phase 1A) [0 files] _(ai-assisted; merge)_
- `cd4adf38` 2026-06-01 — fix(frontier): SKILL.md tool catalog — remove invented tools, phase-tag (v0.2) [1 files] _(ai-assisted)_
- `c72df5a6` 2026-06-01 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (0)

_(none)_

### Infrastructure (22)

- `edf9d525` 2026-06-01 — feat(frontier): DB schema — economy storage layer (pending_migrations) [1 files] _(ai-assisted)_
- `efee3b11` 2026-06-01 — feat(frontier): autonomy spend gate + 27-case unit test [2 files] _(ai-assisted)_
- `b62c9bb5` 2026-06-01 — fix(frontier): migration audit — FK ON DELETE semantics + defer premature columns [1 files] _(ai-assisted)_
- `c8fa074f` 2026-06-01 — chore(frontier): promote economy migration pending_migrations/ → migrations/ [2 files] _(ai-assisted)_
- `e906a153` 2026-06-01 — feat(frontier): POST /api/agent-economy/transaction — VM settlement record [2 files] _(ai-assisted)_
- `db4193aa` 2026-06-01 — feat(frontier): GET /api/agent-economy/state — dashboard economy summary [1 files] _(ai-assisted)_
- `c8388029` 2026-06-01 — feat(frontier): GET/POST /api/agent-economy/offerings — agent storefront CRUD [2 files] _(ai-assisted)_
- `64f20059` 2026-06-01 — feat(frontier): POST /api/agent-economy/reputation/queue — ERC-8004 feedback [2 files] _(ai-assisted)_
- `7a76af19` 2026-06-01 — feat(frontier): POST /api/agent-economy/refund — seller-initiated refund [2 files] _(ai-assisted)_
- `af8bc67f` 2026-06-01 — feat(frontier): GET /api/agent-economy/policy — effective spend bands [1 files] _(ai-assisted)_
- `151a7f57` 2026-06-01 — feat(frontier): on-chain settlement verifier (lib/frontier-chain-verify) + 27 tests [2 files] _(ai-assisted)_
- `f197be12` 2026-06-01 — feat(frontier): chain-verification settlement worker (cron) [1 files] _(ai-assisted)_
- `c089e122` 2026-06-01 — chore(frontier): schedule chain-verification worker every 5 min [1 files] _(ai-assisted)_
- `b7920e44` 2026-06-01 — fix(frontier): scope settlement replay-defense by direction [1 files] _(ai-assisted)_
- `e01fa368` 2026-06-01 — feat(frontier): treasury buy-and-burn executor (gated, crash-safe) [5 files] _(ai-assisted)_
- `41d8d971` 2026-06-01 — feat(frontier): nightly lifetime-rollup cron [2 files] _(ai-assisted)_
- `a81a1463` 2026-06-01 — feat(frontier): /offerings DELETE (soft-delete, provenance-safe) [1 files] _(ai-assisted)_
- `f9aaf6a5` 2026-06-01 — feat(frontier): /policy PUT — per-VM autonomy overrides (tighten-only) [4 files] _(ai-assisted)_
- `0a1eb163` 2026-06-01 — feat(frontier): refund-reconciliation sweep (the promised safety net) [4 files] _(ai-assisted)_
- `74e0100a` 2026-06-01 — chore(frontier): promote burn-claim-state + policy-overrides migrations [4 files] _(ai-assisted)_
- `6137b61d` 2026-06-01 — feat(frontier): _coverage-frontier.ts — Rule 27 economy health query [1 files] _(ai-assisted)_
- `67b5ae2f` 2026-06-01 — Merge feat/frontier-economy-phase1: Frontier agent economy (Phase 1A) [0 files] _(ai-assisted; merge)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (1)

- `7610d27d` 2026-06-01 — docs(frontier): Agent Economy OS v0.2 PRD — two-phase (core infra → compute marketplace) [1 files] _(multi: [edge, docs]; ai-assisted)_

### Docs / PRD only (2)

- `cd4adf38` 2026-06-01 — fix(frontier): SKILL.md tool catalog — remove invented tools, phase-tag (v0.2) [1 files] _(ai-assisted)_
- `c72df5a6` 2026-06-01 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (1)

These touch more than one category root and are listed in every applicable section above.

- `7610d27d` 2026-06-01 — [edge, docs] — docs(frontier): Agent Economy OS v0.2 PRD — two-phase (core infra → compute marketplace)

## AI-assisted commits (24)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `7610d27d` 2026-06-01 — docs(frontier): Agent Economy OS v0.2 PRD — two-phase (core infra → compute marketplace)
- `edf9d525` 2026-06-01 — feat(frontier): DB schema — economy storage layer (pending_migrations)
- `efee3b11` 2026-06-01 — feat(frontier): autonomy spend gate + 27-case unit test
- `cd4adf38` 2026-06-01 — fix(frontier): SKILL.md tool catalog — remove invented tools, phase-tag (v0.2)
- `b62c9bb5` 2026-06-01 — fix(frontier): migration audit — FK ON DELETE semantics + defer premature columns
- `c8fa074f` 2026-06-01 — chore(frontier): promote economy migration pending_migrations/ → migrations/
- `e906a153` 2026-06-01 — feat(frontier): POST /api/agent-economy/transaction — VM settlement record
- `db4193aa` 2026-06-01 — feat(frontier): GET /api/agent-economy/state — dashboard economy summary
- `c8388029` 2026-06-01 — feat(frontier): GET/POST /api/agent-economy/offerings — agent storefront CRUD
- `64f20059` 2026-06-01 — feat(frontier): POST /api/agent-economy/reputation/queue — ERC-8004 feedback
- `7a76af19` 2026-06-01 — feat(frontier): POST /api/agent-economy/refund — seller-initiated refund
- `af8bc67f` 2026-06-01 — feat(frontier): GET /api/agent-economy/policy — effective spend bands
- `151a7f57` 2026-06-01 — feat(frontier): on-chain settlement verifier (lib/frontier-chain-verify) + 27 tests
- `f197be12` 2026-06-01 — feat(frontier): chain-verification settlement worker (cron)
- `c089e122` 2026-06-01 — chore(frontier): schedule chain-verification worker every 5 min
- `b7920e44` 2026-06-01 — fix(frontier): scope settlement replay-defense by direction
- `e01fa368` 2026-06-01 — feat(frontier): treasury buy-and-burn executor (gated, crash-safe)
- `41d8d971` 2026-06-01 — feat(frontier): nightly lifetime-rollup cron
- `a81a1463` 2026-06-01 — feat(frontier): /offerings DELETE (soft-delete, provenance-safe)
- `f9aaf6a5` 2026-06-01 — feat(frontier): /policy PUT — per-VM autonomy overrides (tighten-only)
- `0a1eb163` 2026-06-01 — feat(frontier): refund-reconciliation sweep (the promised safety net)
- `74e0100a` 2026-06-01 — chore(frontier): promote burn-claim-state + policy-overrides migrations
- `6137b61d` 2026-06-01 — feat(frontier): _coverage-frontier.ts — Rule 27 economy health query
- `67b5ae2f` 2026-06-01 — Merge feat/frontier-economy-phase1: Frontier agent economy (Phase 1A)

## Appendix — every commit (chronological)

- `7610d27d` 2026-06-01 — docs(frontier): Agent Economy OS v0.2 PRD — two-phase (core infra → compute marketplace) [1 files] _(multi: [edge, docs]; ai-assisted)_
- `edf9d525` 2026-06-01 — feat(frontier): DB schema — economy storage layer (pending_migrations) [1 files] _(ai-assisted)_
- `efee3b11` 2026-06-01 — feat(frontier): autonomy spend gate + 27-case unit test [2 files] _(ai-assisted)_
- `cd4adf38` 2026-06-01 — fix(frontier): SKILL.md tool catalog — remove invented tools, phase-tag (v0.2) [1 files] _(ai-assisted)_
- `b62c9bb5` 2026-06-01 — fix(frontier): migration audit — FK ON DELETE semantics + defer premature columns [1 files] _(ai-assisted)_
- `c8fa074f` 2026-06-01 — chore(frontier): promote economy migration pending_migrations/ → migrations/ [2 files] _(ai-assisted)_
- `e906a153` 2026-06-01 — feat(frontier): POST /api/agent-economy/transaction — VM settlement record [2 files] _(ai-assisted)_
- `db4193aa` 2026-06-01 — feat(frontier): GET /api/agent-economy/state — dashboard economy summary [1 files] _(ai-assisted)_
- `c8388029` 2026-06-01 — feat(frontier): GET/POST /api/agent-economy/offerings — agent storefront CRUD [2 files] _(ai-assisted)_
- `64f20059` 2026-06-01 — feat(frontier): POST /api/agent-economy/reputation/queue — ERC-8004 feedback [2 files] _(ai-assisted)_
- `7a76af19` 2026-06-01 — feat(frontier): POST /api/agent-economy/refund — seller-initiated refund [2 files] _(ai-assisted)_
- `af8bc67f` 2026-06-01 — feat(frontier): GET /api/agent-economy/policy — effective spend bands [1 files] _(ai-assisted)_
- `151a7f57` 2026-06-01 — feat(frontier): on-chain settlement verifier (lib/frontier-chain-verify) + 27 tests [2 files] _(ai-assisted)_
- `f197be12` 2026-06-01 — feat(frontier): chain-verification settlement worker (cron) [1 files] _(ai-assisted)_
- `c089e122` 2026-06-01 — chore(frontier): schedule chain-verification worker every 5 min [1 files] _(ai-assisted)_
- `b7920e44` 2026-06-01 — fix(frontier): scope settlement replay-defense by direction [1 files] _(ai-assisted)_
- `e01fa368` 2026-06-01 — feat(frontier): treasury buy-and-burn executor (gated, crash-safe) [5 files] _(ai-assisted)_
- `41d8d971` 2026-06-01 — feat(frontier): nightly lifetime-rollup cron [2 files] _(ai-assisted)_
- `a81a1463` 2026-06-01 — feat(frontier): /offerings DELETE (soft-delete, provenance-safe) [1 files] _(ai-assisted)_
- `f9aaf6a5` 2026-06-01 — feat(frontier): /policy PUT — per-VM autonomy overrides (tighten-only) [4 files] _(ai-assisted)_
- `0a1eb163` 2026-06-01 — feat(frontier): refund-reconciliation sweep (the promised safety net) [4 files] _(ai-assisted)_
- `c72df5a6` 2026-06-01 — chore(changelog): auto-update [skip ci] [2 files]
- `74e0100a` 2026-06-01 — chore(frontier): promote burn-claim-state + policy-overrides migrations [4 files] _(ai-assisted)_
- `6137b61d` 2026-06-01 — feat(frontier): _coverage-frontier.ts — Rule 27 economy health query [1 files] _(ai-assisted)_
- `67b5ae2f` 2026-06-01 — Merge feat/frontier-economy-phase1: Frontier agent economy (Phase 1A) [0 files] _(ai-assisted; merge)_
