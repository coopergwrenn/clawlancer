# Changelog — generated 2026-05-20

Window: `63aba402dc8586484946582f108ab937a54a233e` → `HEAD` (HEAD = `0fb0abd5`)
Total commits: 3

<!-- LAST_GENERATED_SHA: 0fb0abd5aabd69654429bd64eadf9d164c526983 -->

## Summary

- **Manifest version bumps:** 1
  - Range: v110 → v110
- **Reconciler / manifest:** 1
- **Infrastructure:** 0
- **Feature (user-facing):** 1
- **Edge City partner:** 0
- **Docs / PRD only:** 1
- AI-assisted commits (co-authored): 2
- Merge commits: 0

## Manifest version timeline

### v110 — 2026-05-20 — `0fb0abd5`

feat(chatgpt-oauth): Day 11-15 — stepChatGPTOAuthToken (v110) closes the loop

> PURPOSE
>   Reflects each user's ChatGPT-subscription OAuth state from
>   instaclaw_users → the VM's auth-profiles.json +
>   agents.defaults.model.primary. Before this step, Day 1-4 stored
>   tokens server-side but the VM never knew — agent kept using Claude.
>   Broken promise. This step makes the connection actually do something.

## What changed for users

- `b1897866` 2026-05-20 — feat(edge): hoist InstaClaw-BYO under primary CTA + new self-hosted /edge/byob page [3 files] _(multi: [feature, edge]; ai-assisted)_

## What changed under the hood

- `0fb0abd5` 2026-05-20 — feat(chatgpt-oauth): Day 11-15 — stepChatGPTOAuthToken (v110) closes the loop [5 files] _(**MANIFEST v110**; multi: [reconciler, infrastructure]; ai-assisted)_
- `09c1b0ab` 2026-05-20 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (1)

- `0fb0abd5` 2026-05-20 — feat(chatgpt-oauth): Day 11-15 — stepChatGPTOAuthToken (v110) closes the loop [5 files] _(**MANIFEST v110**; multi: [reconciler, infrastructure]; ai-assisted)_

### Infrastructure (0)

_(none)_

### Feature (user-facing) (1)

- `b1897866` 2026-05-20 — feat(edge): hoist InstaClaw-BYO under primary CTA + new self-hosted /edge/byob page [3 files] _(multi: [feature, edge]; ai-assisted)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (1)

- `09c1b0ab` 2026-05-20 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (2)

These touch more than one category root and are listed in every applicable section above.

- `b1897866` 2026-05-20 — [feature, edge] — feat(edge): hoist InstaClaw-BYO under primary CTA + new self-hosted /edge/byob page
- `0fb0abd5` 2026-05-20 — [reconciler, infrastructure] — feat(chatgpt-oauth): Day 11-15 — stepChatGPTOAuthToken (v110) closes the loop

## AI-assisted commits (2)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `b1897866` 2026-05-20 — feat(edge): hoist InstaClaw-BYO under primary CTA + new self-hosted /edge/byob page
- `0fb0abd5` 2026-05-20 — feat(chatgpt-oauth): Day 11-15 — stepChatGPTOAuthToken (v110) closes the loop

## Appendix — every commit (chronological)

- `09c1b0ab` 2026-05-20 — chore(changelog): auto-update [skip ci] [2 files]
- `b1897866` 2026-05-20 — feat(edge): hoist InstaClaw-BYO under primary CTA + new self-hosted /edge/byob page [3 files] _(multi: [feature, edge]; ai-assisted)_
- `0fb0abd5` 2026-05-20 — feat(chatgpt-oauth): Day 11-15 — stepChatGPTOAuthToken (v110) closes the loop [5 files] _(**MANIFEST v110**; multi: [reconciler, infrastructure]; ai-assisted)_
