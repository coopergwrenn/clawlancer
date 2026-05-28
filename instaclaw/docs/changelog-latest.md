# Changelog — generated 2026-05-28

Window: `95480af9438483c2895a379a564873ab33a17fdf` → `HEAD` (HEAD = `41b61ec0`)
Total commits: 3

<!-- LAST_GENERATED_SHA: 41b61ec06391a1e9465bfd2fa56e7643fc5e6e78 -->

## Summary

- **Manifest version bumps:** 1
  - Range: v124 → v124
- **Reconciler / manifest:** 1
- **Infrastructure:** 1
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 1
- AI-assisted commits (co-authored): 1
- Merge commits: 1

## Manifest version timeline

### v124 — 2026-05-28 — `27885f9b`

fix(P0): kill-switch periodic-summary LLM calls — burning user budgets fleet-wide

> INC-20260528 — strip-thinking.py's periodic-summary cron is sending
> x-model-override: claude-haiku-4-5-20251001 to /api/gateway/proxy, but
> the proxy ignores the header. The summary prompt ("You are summarizing
> a recent conversation...") matches SONNET_SIGNALS (and on some prompts
> OPUS_MULTI_AGENT / hasComplexBuild) in lib/model-router.ts and gets
> routed to sonnet (cost 4) or opus (cost 19) instead of haiku (cost 1).
> Calls are also logged with call_type='user' and charged against the
> user's daily display limit.

## What changed for users

_None in this window._

## What changed under the hood

- `4957c3b7` 2026-05-27 — chore(changelog): auto-update [skip ci] [2 files]
- `27885f9b` 2026-05-28 — fix(P0): kill-switch periodic-summary LLM calls — burning user budgets fleet-wide [3 files] _(**MANIFEST v124**; multi: [reconciler, infrastructure]; ai-assisted)_
- `41b61ec0` 2026-05-28 — Merge pull request #20 from coopergwrenn/fix/p0-strip-thinking-summary-killswitch [0 files] _(merge)_

## By category

### Reconciler / manifest (1)

- `27885f9b` 2026-05-28 — fix(P0): kill-switch periodic-summary LLM calls — burning user budgets fleet-wide [3 files] _(**MANIFEST v124**; multi: [reconciler, infrastructure]; ai-assisted)_

### Infrastructure (1)

- `41b61ec0` 2026-05-28 — Merge pull request #20 from coopergwrenn/fix/p0-strip-thinking-summary-killswitch [0 files] _(merge)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (1)

- `4957c3b7` 2026-05-27 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (1)

These touch more than one category root and are listed in every applicable section above.

- `27885f9b` 2026-05-28 — [reconciler, infrastructure] — fix(P0): kill-switch periodic-summary LLM calls — burning user budgets fleet-wide

## AI-assisted commits (1)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `27885f9b` 2026-05-28 — fix(P0): kill-switch periodic-summary LLM calls — burning user budgets fleet-wide

## Appendix — every commit (chronological)

- `4957c3b7` 2026-05-27 — chore(changelog): auto-update [skip ci] [2 files]
- `27885f9b` 2026-05-28 — fix(P0): kill-switch periodic-summary LLM calls — burning user budgets fleet-wide [3 files] _(**MANIFEST v124**; multi: [reconciler, infrastructure]; ai-assisted)_
- `41b61ec0` 2026-05-28 — Merge pull request #20 from coopergwrenn/fix/p0-strip-thinking-summary-killswitch [0 files] _(merge)_
