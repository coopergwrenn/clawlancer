# Changelog — generated 2026-05-14

Window: `b068339d46910a0ddb8d1acb020f5feca9e7b368` → `HEAD` (HEAD = `09f0b11d`)
Total commits: 4

<!-- LAST_GENERATED_SHA: 09f0b11d098c83c52ef5c58b2da47f5a44889560 -->

## Summary

- **Manifest version bumps:** 1
  - Range: v99 → v99
- **Reconciler / manifest:** 2
- **Infrastructure:** 0
- **Feature (user-facing):** 0
- **Edge City partner:** 0
- **Docs / PRD only:** 2
- AI-assisted commits (co-authored): 3
- Merge commits: 0

## Manifest version timeline

### v99 — 2026-05-14 — `8c1afacd`

feat(v99): gateway-health textfile-collector promoted to manifest

> The Prometheus GatewayDown alert depends on a textfile-collector pipeline
> (script + dir + drop-in + cron) that was fleet-pushed by hand on
> 2026-05-14 during the timmy outage. It landed on all 242 then-existing
> VMs but was never added to the manifest. New VMs provisioned from a
> fresh snapshot after 2026-05-14 would silently miss it — gateway crash
> would go undetected until a user reported it. v99 closes that gap.

## What changed for users

_None in this window._

## What changed under the hood

- `8c1afacd` 2026-05-14 — feat(v99): gateway-health textfile-collector promoted to manifest [4 files] _(**MANIFEST v99**; multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `09f0b11d` 2026-05-14 — docs(cloud-init): §17b probe-verified snapshot inventory + Day 8a impact [1 files] _(multi: [reconciler, docs]; ai-assisted)_
- `753dbcc8` 2026-05-14 — chore(changelog): auto-update [skip ci] [2 files]
- `a841b281` 2026-05-14 — docs(P1-9): acp-serve.service exit 127 root cause + plan [1 files] _(ai-assisted)_

## By category

### Reconciler / manifest (2)

- `8c1afacd` 2026-05-14 — feat(v99): gateway-health textfile-collector promoted to manifest [4 files] _(**MANIFEST v99**; multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `09f0b11d` 2026-05-14 — docs(cloud-init): §17b probe-verified snapshot inventory + Day 8a impact [1 files] _(multi: [reconciler, docs]; ai-assisted)_

### Infrastructure (0)

_(none)_

### Feature (user-facing) (0)

_(none)_

### Edge City partner (0)

_(none)_

### Docs / PRD only (2)

- `753dbcc8` 2026-05-14 — chore(changelog): auto-update [skip ci] [2 files]
- `a841b281` 2026-05-14 — docs(P1-9): acp-serve.service exit 127 root cause + plan [1 files] _(ai-assisted)_

## Multi-category commits (2)

These touch more than one category root and are listed in every applicable section above.

- `8c1afacd` 2026-05-14 — [reconciler, infrastructure, docs] — feat(v99): gateway-health textfile-collector promoted to manifest
- `09f0b11d` 2026-05-14 — [reconciler, docs] — docs(cloud-init): §17b probe-verified snapshot inventory + Day 8a impact

## AI-assisted commits (3)

Commits with `Co-Authored-By` trailer or Claude attribution. Worth a second look for manual review.

- `8c1afacd` 2026-05-14 — feat(v99): gateway-health textfile-collector promoted to manifest
- `a841b281` 2026-05-14 — docs(P1-9): acp-serve.service exit 127 root cause + plan
- `09f0b11d` 2026-05-14 — docs(cloud-init): §17b probe-verified snapshot inventory + Day 8a impact

## Appendix — every commit (chronological)

- `753dbcc8` 2026-05-14 — chore(changelog): auto-update [skip ci] [2 files]
- `8c1afacd` 2026-05-14 — feat(v99): gateway-health textfile-collector promoted to manifest [4 files] _(**MANIFEST v99**; multi: [reconciler, infrastructure, docs]; ai-assisted)_
- `a841b281` 2026-05-14 — docs(P1-9): acp-serve.service exit 127 root cause + plan [1 files] _(ai-assisted)_
- `09f0b11d` 2026-05-14 — docs(cloud-init): §17b probe-verified snapshot inventory + Day 8a impact [1 files] _(multi: [reconciler, docs]; ai-assisted)_
