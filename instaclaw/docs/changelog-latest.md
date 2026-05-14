# Changelog — generated 2026-05-14

Window: `e0c41fe778ff9dfc971f40ec90ac640349955c60` → `HEAD` (HEAD = `57295900`)
Total commits: 5

<!-- LAST_GENERATED_SHA: 572959003185be51c161854bc59892d7492b607e -->

## Summary

- **Manifest version bumps:** 1
  - Range: v100 → v100
- **Reconciler / manifest:** 1
- **Infrastructure:** 1
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 3
- AI-assisted commits (co-authored): 4
- Merge commits: 0

## Manifest version timeline

### v100 — 2026-05-14 — `57295900`

fix(systemd): v100 PATH for gateway-spawned subprocesses + acp-serve unit

> Root cause: openclaw-gateway.service runs under systemd-user with a
> minimal default PATH (/usr/local/bin:/usr/bin:/bin). Subprocess shebangs
> like `#!/usr/bin/env bun` (gbrain MCP) fail with exit 127 because `env`
> can't find `bun` in that PATH. Same failure class as the acp-serve.service
> NVM/PATH bug documented in CLAUDE.md P1-9.

## What changed for users

_None in this window._

## What changed under the hood

- `57295900` 2026-05-14 — fix(systemd): v100 PATH for gateway-spawned subprocesses + acp-serve unit [3 files] _(**MANIFEST v100**; multi: [reconciler, infrastructure]; ai-assisted)_
- `5a0d6e33` 2026-05-14 — feat(cloud-init): Day 8b BE-1 — linger + sshd OOM-protect drop-in [2 files] _(ai-assisted)_
- `93a7e5f5` 2026-05-14 — chore(changelog): auto-update [skip ci] [2 files]
- `058c4b70` 2026-05-14 — chore(skills): check in frontier SKILL.md from vm-050 [1 files] _(ai-assisted)_
- `4bf3cd13` 2026-05-14 — docs(P1-1): close lying-DB sweep — 0/144 by census, per-step audit clean [4 files] _(ai-assisted)_

## By category

### Reconciler / manifest (1)

- `57295900` 2026-05-14 — fix(systemd): v100 PATH for gateway-spawned subprocesses + acp-serve unit [3 files] _(**MANIFEST v100**; multi: [reconciler, infrastructure]; ai-assisted)_

### Infrastructure (1)

- `5a0d6e33` 2026-05-14 — feat(cloud-init): Day 8b BE-1 — linger + sshd OOM-protect drop-in [2 files] _(ai-assisted)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (3)

- `93a7e5f5` 2026-05-14 — chore(changelog): auto-update [skip ci] [2 files]
- `058c4b70` 2026-05-14 — chore(skills): check in frontier SKILL.md from vm-050 [1 files] _(ai-assisted)_
- `4bf3cd13` 2026-05-14 — docs(P1-1): close lying-DB sweep — 0/144 by census, per-step audit clean [4 files] _(ai-assisted)_

## Multi-category commits (1)

These touch more than one category root and are listed in every applicable section above.

- `57295900` 2026-05-14 — [reconciler, infrastructure] — fix(systemd): v100 PATH for gateway-spawned subprocesses + acp-serve unit

## AI-assisted commits (4)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `058c4b70` 2026-05-14 — chore(skills): check in frontier SKILL.md from vm-050
- `5a0d6e33` 2026-05-14 — feat(cloud-init): Day 8b BE-1 — linger + sshd OOM-protect drop-in
- `4bf3cd13` 2026-05-14 — docs(P1-1): close lying-DB sweep — 0/144 by census, per-step audit clean
- `57295900` 2026-05-14 — fix(systemd): v100 PATH for gateway-spawned subprocesses + acp-serve unit

## Appendix — every commit (chronological)

- `93a7e5f5` 2026-05-14 — chore(changelog): auto-update [skip ci] [2 files]
- `058c4b70` 2026-05-14 — chore(skills): check in frontier SKILL.md from vm-050 [1 files] _(ai-assisted)_
- `5a0d6e33` 2026-05-14 — feat(cloud-init): Day 8b BE-1 — linger + sshd OOM-protect drop-in [2 files] _(ai-assisted)_
- `4bf3cd13` 2026-05-14 — docs(P1-1): close lying-DB sweep — 0/144 by census, per-step audit clean [4 files] _(ai-assisted)_
- `57295900` 2026-05-14 — fix(systemd): v100 PATH for gateway-spawned subprocesses + acp-serve unit [3 files] _(**MANIFEST v100**; multi: [reconciler, infrastructure]; ai-assisted)_
