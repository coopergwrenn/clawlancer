# Changelog — generated 2026-05-18

Window: `a27d26fc240cda6d310d4e2ec4d7b9870ccbdd0e` → `HEAD` (HEAD = `9c525e9e`)
Total commits: 3

<!-- LAST_GENERATED_SHA: 9c525e9e999957dacc949719288e1dc228043786 -->

## Summary

- **Manifest version bumps:** 1
  - Range: v103 → v103
- **Reconciler / manifest:** 1
- **Infrastructure:** 1
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 1
- AI-assisted commits (co-authored): 1
- Merge commits: 0

## Manifest version timeline

### v103 — 2026-05-18 — `944068db`

feat(reconcile): stepUfwRules + Rule 57 — enforce ufw 9100/tcp fleet-wide (v103)

> The 2026-05-18 IR triage found 8 VMs whose node_exporter was bound locally
> but firewalled at 9100 — 1-4 days of VMUnreachable noise that masked the
> real P1 (vm-748 disk pressure). stepNodeExporter verified `ss -tln | grep
> :9100` but never that Prometheus could actually reach it.

## What changed for users

_None in this window._

## What changed under the hood

- `944068db` 2026-05-18 — feat(reconcile): stepUfwRules + Rule 57 — enforce ufw 9100/tcp fleet-wide (v103) [5 files] _(**MANIFEST v103**; multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `9c525e9e` 2026-05-18 — fix(cron): stuck-vm-auto-recover + reconcile-stuck-vms — same last_health_check filter bug [2 files]
- `5e4362ab` 2026-05-18 — chore(changelog): auto-update [skip ci] [2 files]

## By category

### Reconciler / manifest (1)

- `944068db` 2026-05-18 — feat(reconcile): stepUfwRules + Rule 57 — enforce ufw 9100/tcp fleet-wide (v103) [5 files] _(**MANIFEST v103**; multi: [reconciler, infrastructure, docs]; ai-assisted)_

### Infrastructure (1)

- `9c525e9e` 2026-05-18 — fix(cron): stuck-vm-auto-recover + reconcile-stuck-vms — same last_health_check filter bug [2 files]

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (1)

- `5e4362ab` 2026-05-18 — chore(changelog): auto-update [skip ci] [2 files]

## Multi-category commits (1)

These touch more than one category root and are listed in every applicable section above.

- `944068db` 2026-05-18 — [reconciler, infrastructure, docs] — feat(reconcile): stepUfwRules + Rule 57 — enforce ufw 9100/tcp fleet-wide (v103)

## AI-assisted commits (1)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `944068db` 2026-05-18 — feat(reconcile): stepUfwRules + Rule 57 — enforce ufw 9100/tcp fleet-wide (v103)

## Appendix — every commit (chronological)

- `5e4362ab` 2026-05-18 — chore(changelog): auto-update [skip ci] [2 files]
- `944068db` 2026-05-18 — feat(reconcile): stepUfwRules + Rule 57 — enforce ufw 9100/tcp fleet-wide (v103) [5 files] _(**MANIFEST v103**; multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `9c525e9e` 2026-05-18 — fix(cron): stuck-vm-auto-recover + reconcile-stuck-vms — same last_health_check filter bug [2 files]
