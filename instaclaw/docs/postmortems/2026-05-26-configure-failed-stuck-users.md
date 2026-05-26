# 2026-05-26 — `configure_failed` orphan-state: 4 paying users stuck silently for ~2 months

## Severity

**P0** — paying customers degraded for ~2 months with no automated recovery path
and no alert. Discovered only by Cooper via manual audit.

## TL;DR

`health_status='configure_failed'` is an orphan state. When a VM enters it,
**every** automated recovery path silently excludes it:

| Recovery path | Filter | Why it skips configure_failed |
|---|---|---|
| `health-check` cron (every 2 min) | explicit `if (vm.health_status === "configure_failed") continue` | Rule 33 guard: don't auto-flip back to healthy |
| `reconcile-fleet` cron (every 3 min) | `.eq("health_status", "healthy")` | Throughput-fix from 2026-05-09 |
| `file-drift` cron (every 15 min) | `.eq("health_status", "healthy")` | Same |
| `process-pending` Pass 2 (every 10 min) | `if (!hasPending) continue` after pending consumed | Designed for fresh onboarding only |
| `stuck-unhealthy-customer-alert` (every 30 min) | `.in("health_status", ["unhealthy","unknown"])` | Hardcoded list |
| `stuck-vm-auto-recover` (every 15 min) | Same | Same |
| `reconcile-stuck-vms` (every 30 min) | Same + `health_fail_count >= 60` | Same; fail_count never grows for cf VMs |

Net effect: once a VM enters `configure_failed` AND its `pending_users` row has
been consumed, **nothing in the system will ever touch it again**.

The bug has been latent for at least 2 months. **4 paying users found stuck**:
the 3 surfaced by Cooper (anton, noyget, leighton) plus 1 fourth surfaced by the
audit script I wrote tonight (civclaw / vm-960, in `health_status='unknown'` with
fail_count=0 — same orphan shape via a different door).

## Affected users

| VM | User | Email | Status | cv | Stuck since | Subscription | Last proxy call |
|---|---|---|---|---|---|---|---|
| vm-592 | ANTON RIZMAL | antonius001@gmail.com | configure_failed | 120 | 2026-03-29 (~58 days) | active, starter | 2026-05-26 15:00 UTC |
| vm-356 | Anthony Kenny | noyget@gmail.com | configure_failed | 119 | 2026-03-17 (~70 days) | active, starter | 2026-05-26 15:17 UTC |
| vm-046 | Leighton Cusack | leighton.cusack@gmail.com | configure_failed | 101 | 2026-04-01 (~55 days) | active, starter | 2026-05-26 14:07 UTC |
| vm-960 | (civclaw) | civclaw@gmail.com | unknown | 121 | 2026-05-21 (~5 days) | past_due, power | 2026-05-26 16:18 UTC |

All four were silently degraded — paying $29/mo for an agent that the DB
considered broken. **Their gateways were actually serving traffic the entire
time** (every `last_proxy_call_at` is today). The DB row was lying: gateway up,
openclaw 2026.4.26 installed, `openclaw.json` present, `/health=200` to both
localhost and the public Cloudflare URL.

## Timeline (UTC)

| Time | Event |
|---|---|
| 2026-03 → 2026-05 | The four VMs enter their respective broken DB states. No alert. No retry. |
| 2026-05-26 ~15:50 | Cooper notices 3 paying users in `configure_failed` and pages IR terminal. |
| 2026-05-26 15:54 | SSH probe on all 3 — every gateway is healthy, every `/health` returns 200. DB is lying. |
| 2026-05-26 15:55 | Root cause analysis begins. process-pending Pass 2 `if (!hasPending) continue;` confirmed as a primary failure mode. |
| 2026-05-26 15:58 | reconcile-fleet's `.eq("health_status", "healthy")` filter confirmed as second failure mode. |
| 2026-05-26 16:00 | file-drift cron confirmed to have the same filter. health-check confirmed to explicitly skip configure_failed (Rule 33 guard, intentional). |
| 2026-05-26 16:05 | All three tiers of the existing "stuck VM" recovery pipeline confirmed to filter on `.in(["unhealthy","unknown"])` — configure_failed orphaned across the entire safety net. |
| 2026-05-26 16:10 | vm-592 (anton) DB row flipped to healthy as canary. Backup of pre-state captured at `/tmp/inc-anr/`. |
| 2026-05-26 16:11 | vm-356 + vm-046 flipped to healthy. All three pre-states backed up. |
| 2026-05-26 16:18 | Audit script `_audit-stuck-paying-users.ts` written + run. Surfaces vm-960 (civclaw) as 4th P0. Flipped. |
| 2026-05-26 16:18 | Reconcile-fleet picks up vm-592 (cv=120 → 122) and vm-046 (cv=101 → **122** in one cycle). |
| 2026-05-26 16:21 | vm-356 cv=119, vm-960 cv=121 climbing. |
| 2026-05-26 16:25 | Preventive-fix patches staged for Tier 1 (alert) + Tier 3 (recovery). Awaiting Cooper's Rule-64 approval before deploy. |

## Root cause

The fundamental bug is structural: `configure_failed` is an
**operationally-undefined state**. Three properties combine to make it an
absorbing orphan:

1. **It looks healthy from the outside.** `gateway_url` is populated,
   `/health=200`, the agent is serving traffic. Cooper has no obvious signal.
2. **health-check intentionally won't auto-clear it** (Rule 33 guard, 2026-05-12,
   Carter Cleveland incident). The Rule 33 intent was correct — gateway-up
   doesn't mean the per-user config landed. But it built a one-way trap.
3. **No code path was written to clear it from outside the `/api/vm/configure`
   route.** Pass 2 of process-pending was supposed to retry — but `process-
   pending` Pass 2 has a hidden gate (`hasPending`) that excludes the
   post-assignment retry case. And `reconcile-stuck-vms` Tier 3 was supposed
   to be the safety net — but Tier 3's `.in()` filter doesn't include
   configure_failed.

This is a **lying-DB pattern (Rule 23 family)** with a twist: instead of the
DB lying that everything is fine (DB says cv=current, disk doesn't match), the
DB is lying that everything is broken (DB says configure_failed, disk is fine).

The recovery pipeline was specifically designed (2026-05-17 post vm-911) to be
the safety net for situations like this. It is fully implemented as a 3-tier
pipeline (`stuck-unhealthy-customer-alert` + `stuck-vm-auto-recover` +
`reconcile-stuck-vms`). The architecture is right. But every tier's filter
hardcodes `["unhealthy", "unknown"]` — `configure_failed` was overlooked when
the pipeline was built.

### Why it persisted for 2 months

- **The agents kept working.** Telegram proxy calls hit the gateway directly
  (gateway_url is set, gateway_token is valid). Users never saw a problem.
  Their agents were FUNCTIONAL the whole time.
- **No dashboard surface.** `/api/admin/...` views show health_status but
  nobody was actively reviewing configure_failed VMs as a category.
- **No alert.** Tier 1 (the cron designed to catch exactly this) excluded the
  category.
- **No periodic operator audit until tonight.** This was the first time the
  state was surveyed in the wild.

### Why the existing recovery pipeline missed it

The 2026-05-17 vm-911 incident motivated building the 3-tier pipeline:
- Tier 1 — alert at 1h stuck
- Tier 2 — auto-recover narrow signature at 2h stuck (0-byte openclaw.json)
- Tier 3 — full `auditVMConfig` at 2h stuck

The vm-911 failure mode was `unhealthy`/`unknown` with growing `health_fail_count`.
Filters were written tightly around that signal. `configure_failed` was a
known state at the time but was assumed to be transient (process-pending Pass 2
would retry it). The Pass 2 retry bug was not yet known. Combine the two and
you get the orphan trap.

## Impact

**Customer-visible**: minimal — agents kept working via direct proxy calls.
The Telegram bots responded. No customer ticket. No complaint we could trace
to this specifically.

**Operational**:

- Four paying users at risk of being reassigned/destroyed by an aggressive
  cleanup script that trusted `health_status` as truth.
- Four VMs frozen in cv=101/119/120/121 with manifest at v122 → behind on
  every manifest-bump security fix, capability update, sentinel guard, etc.
  vm-046 was 21 manifest versions behind, missing 21 versions worth of fixes
  including the Rule 22 trim-not-nuke session preservation (v90), the gbrain
  rollout, the partner-secret rotation infra, the bonjour mDNS disable, and
  more.
- No revenue impact — all four kept paying.
- **Reputation risk if discovered by a user**: "you've been billing me for a
  broken agent" — would have been justified even though their agent worked.

**Estimated dollar exposure** (worst case): 4 users × $29/mo × 2 months ≈ **$232
of "billed but believed-broken" revenue**. Plus the ongoing risk that any
operator-driven cleanup script would have torched their workspaces under the
"this VM is broken, reclaim it" path.

## Fix — immediate (DONE tonight)

All four VMs were flipped to `health_status='healthy'` with
`configure_attempts=0`, `configure_lock_at=null`, `health_fail_count=0`. The
existing `reconcile-fleet` cron then picked them up automatically and advanced
their `config_version` to the current manifest (v122) within one tick for
two of them; the other two are climbing.

**Why DB-flip and not re-run configureOpenClaw**: per Rule 22 (Never Nuke,
Always Trim) + Rule 30 (no destructive state ops), a full `configureOpenClaw`
on an already-onboarded user would wipe `~/.openclaw/workspace/*` and
`~/.openclaw/memory/*` per the privacy-guard at `lib/ssh.ts:3480`. These users
have months of accumulated MEMORY.md, session history, and personality
context. We do NOT touch the VMs at all — the gateways were already correct.
We only correct the DB row's lie.

**Pre-state snapshots** preserved at:
- `/tmp/inc-anr/vm-592.before.json` (anton)
- `/tmp/inc-noy/vm-356.before.json` (noyget)
- `/tmp/inc-lei/vm-046.before.json` (leighton)
- `/tmp/inc-960/before.json` (civclaw)

Rollback path documented in each (1-line PATCH).

## Fix — preventive (STAGED for review, NOT pushed per Rule 64)

Two patches staged in the working tree:

### Patch 1: `app/api/cron/stuck-unhealthy-customer-alert/route.ts`

Adds a second query for `health_status='configure_failed'` with **age-based
gating** (because `health_fail_count` never grows for configure_failed VMs —
the Rule 33 guard in health-check skips them). Uses `updated_at < (now - 1h)`
as the staleness signal. Merges into the existing candidate set so the alert
fires through the same dedup / suppression / formatting path.

Also patches the `hoursStuck` calculation to use `updated_at` for
configure_failed VMs (fail_count math gives 0 hours otherwise).

### Patch 2: `app/api/cron/reconcile-stuck-vms/route.ts`

Adds a parallel `configureFailedPool` query with the same age-based gating
(`updated_at < now - 2h`). Merges into the existing eligibility filter so
B-deferral, C-failure-quarantine, per-VM timeout, and the recovery path all
apply uniformly. On success, also resets `configure_attempts` and
`configure_lock_at` so the row exits configure_failed cleanly.

The recovery path is `auditVMConfig` — drift-repair only, no workspace wipe,
restarts gateway after applying changes. Safe per Rule 22/30. This is the
ONLY automated path on the fleet that's safe to invoke on an already-onboarded
configure_failed VM.

### Why I did NOT also patch `process-pending` Pass 2

The hasPending gate bug in Pass 2 is real (`if (!hasPending) continue;` skips
post-assignment retries forever). But Tier 3 + Tier 1 cover the same
operational space and are explicitly designed for this. Patching Pass 2 too
would be three simultaneous changes; I chose minimum-viable for review safety.
Pass 2's gate should still be fixed in a follow-up — recommended change:
remove the `hasPending` gate OR fall through to `/api/vm/configure` which
already has a no-pending-row defaults fallback path at line 254-261.

### Why I did NOT lift the `.eq("health_status", "healthy")` filter on reconcile-fleet

That filter was added 2026-05-09 to fix the throughput-collapse incident
(45 stale suspended VMs head-of-line-blocking 149 healthy VMs, throughput
crashed 60/hr → 0.4/hr). Lifting it would re-open that bug. Per the
existing comment at route.ts:264, the right design is sibling recovery
crons — which is what Tier 3 already is, and what this patch extends to
cover the orphan state.

### Tests added

`scripts/_audit-stuck-paying-users.ts` — one-shot triage script:
- Surfaces all assigned VMs with `health_status != healthy`.
- Joins with `instaclaw_users` + `instaclaw_subscriptions` to classify by
  paying status.
- Categorizes into P0 (paying broken), P1 (paying offline), P2 (non-paying),
  P3 (operator-quarantined).
- Exits 1 if any P0 found — suitable for inclusion in a future CI check.
- Both human-readable and `--json` output.

Run regularly during operator patrol mode. Should report `P0_PAYING_BROKEN: 0`
when the recovery pipeline is doing its job.

## Verification

After the immediate fix:
- vm-592 (anton): cv 120 → 122 in ~3 min (one reconcile tick).
- vm-046 (leighton): cv 101 → **122** in one reconcile tick (the reconciler
  applied 21 manifest versions of drift in one cycle).
- vm-356 (noyget): cv climbing.
- vm-960 (civclaw): cv climbing from 121.
- Audit script post-fix: `P0_PAYING_BROKEN: 0` (clean).
- All four agents continue serving traffic (Telegram bots responsive).

After the preventive fix is approved + deployed:
- Tier 1 will alert Cooper within 30 min if any new VM enters configure_failed
  for >1h.
- Tier 3 will auto-recover (via auditVMConfig, no wipe) within 30 min if any
  VM enters configure_failed for >2h.
- Combined SLA: a paying customer can be stuck in configure_failed for at most
  ~2.5 hours before either auto-recovery succeeds or Cooper is paged.

## Lessons

### Lesson 1: Enumerate the recovery filters when introducing a new health_status

Every time a new `health_status` value is added (`configure_failed`,
`frozen`, `suspended`, `hibernating`, `unknown`), the team must walk every
downstream filter and explicitly decide which crons should consider that
state in-scope vs out-of-scope. The `.in(["unhealthy","unknown"])` pattern
across three tiers + reconcile-fleet's `.eq("healthy")` pattern is exactly
the kind of widespread silent filter that orphan states slip through.

**Rule candidate** for CLAUDE.md (numbered 68+ when codified):
> Every new `health_status` value MUST be matched by an explicit audit of the
> 7 known consumers (health-check, reconcile-fleet, file-drift, process-pending
> Pass 2, stuck-unhealthy-customer-alert, stuck-vm-auto-recover, reconcile-
> stuck-vms). The PR introducing the new state names each consumer and
> declares "INCLUDED" or "EXCLUDED" with a reason. EXCLUDED requires a
> documented sibling recovery path.

### Lesson 2: Lying-DB-LOW is the inverse of Rule 23

Rule 23 (sentinel-grep required templates) addresses the case where the DB
claims a VM is at version N but on-disk reality is older. This incident is
the inverse: the DB claims a VM is broken but on-disk reality is fine.

Both shapes are silent. Both bypass alerting because the standard signals
(metric thresholds, fail counts) don't move. The remedy is the same:
periodic operator audit that compares DB claims to disk truth on a sample of
VMs. `scripts/_audit-stuck-paying-users.ts` is the start of this for the
configure_failed orphan-state. A more general "DB-vs-disk reconciliation
sampler" cron (P1 follow-up) would catch both Rule-23 lying-DB-HIGH and
this incident's lying-DB-LOW patterns.

### Lesson 3: "It already has an alert cron" is not the same as "an alert will fire"

The Tier 1 alert cron existed. Cooper believed alerts were covered. The cron
literally did not contain the conditions to fire on this category. The lesson
isn't "build more alerts" — it's "review which categories every existing
alert filters in and out, and document the matrix in CLAUDE.md."

### Lesson 4: `last_proxy_call_at` is a richer health signal than `health_status`

Every one of the four affected VMs had `last_proxy_call_at` within the same
day. That proxy-call signal is the strongest evidence that the gateway is
actually serving traffic. If `health_status != "healthy"` AND
`last_proxy_call_at` within 1h, that's a smoking gun for lying-DB-LOW. A
future cron could use this as a primary signal independent of fail_count.

## Follow-up tasks (P1)

| Priority | Item | Owner |
|---|---|---|
| P1 | Investigate **vm-512** (spillageissue@gmail.com): past_due within 7-day grace, gateway INACTIVE on disk (not lying-DB — actually stopped). Suggests `wake-paid-hibernating` isn't firing on past_due-within-grace VMs. Different class from this incident (sleep-state wake bug, not configure_failed) but same shape of customer impact (paying-and-broken). | next operator |
| P1 | Fix process-pending Pass 2 `if (!hasPending) continue;` gate — either remove gate or fall through to /api/vm/configure subscription-defaults path | next operator |
| P2 | Codify Lesson 1 as numbered Rule 68 in CLAUDE.md (proposed text in Lesson 1 above) — enumerate health_status filter audit on any new state | next operator |
| P2 | DB-vs-disk reconciliation sampler cron (Rule 23 + this incident's inverse) — pick 5 random VMs/day, verify health_status matches disk reality | new work |
| P3 | Add `scripts/_audit-stuck-paying-users.ts` to operator patrol-mode (CLAUDE.md Operational Runbook → Patrol Mode section) | next operator |
| P3 | Consider deprecating the `configure_failed` health_status entirely — replace with `configure_attempts >= MAX_CONFIGURE_ATTEMPTS` as the "exhausted" signal, let health_status track only on-disk gateway reality | architecture |

### Original 6-VM "suspended-with-recent-proxy" concern — assessed + cleared

The first audit pass (before the past_due-grace tightening) surfaced 6 paying
users in suspended state with `last_proxy_call_at` within 1d as candidates for
the same bug class. Individual assessment 2026-05-26 ~16:43 UTC:

- **vm-921 (msgduel@gmail.com)** — past_due since 2026-05-15, 11d past grace cutoff → correctly suspended. Gateway responds (Cloudflare-tunneled), DB row is honest.
- **vm-925 (realme21082568@gmail.com)** — past_due since 2026-05-16, 10d past grace cutoff → correctly suspended.
- **vm-966, vm-945, vm-912, vm-947** — all past_due past grace cutoff (canceled/lapsed >7d) → correctly suspended.

None of the 6 needed the DB-flip treatment. The audit script's `isPaying` check
was too loose — counted ALL past_due as paying. Tightened to mirror
`lib/billing-status.ts:isPaying` semantics: past_due ONLY counts as paying
within 7 days of `current_period_end` (Rule 14). After tightening, P0 = 0 and
P1_PAYING_OFFLINE drops from 10 → 3, all of which are within-grace past_due
or normal user-idle suspends. The newly-surfaced vm-512 is the only one
worth a real look (filed as the P1 above).

## Forensic evidence

- Pre-fix DB row JSON: `/tmp/inc-anr/vm-592.before.json`, `/tmp/inc-noy/vm-356.before.json`, `/tmp/inc-lei/vm-046.before.json`, `/tmp/inc-960/before.json`
- Audit script + sample output: `instaclaw/scripts/_audit-stuck-paying-users.ts`
- Preventive-fix patches: staged in working tree at
  - `app/api/cron/stuck-unhealthy-customer-alert/route.ts`
  - `app/api/cron/reconcile-stuck-vms/route.ts`
- Git diff command for review: `git diff app/api/cron/stuck-unhealthy-customer-alert/route.ts app/api/cron/reconcile-stuck-vms/route.ts`

## Rollback (if preventive fix needs to be reverted)

```bash
git checkout HEAD -- app/api/cron/stuck-unhealthy-customer-alert/route.ts \
                     app/api/cron/reconcile-stuck-vms/route.ts
```

No DB rollback needed for the immediate fix — the affected VMs were already
serving customer traffic correctly; we only fixed the DB row's lie.
