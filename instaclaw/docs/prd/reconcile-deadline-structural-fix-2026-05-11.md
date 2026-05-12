# Reconcile Deadline Structural Fix — Why the Fleet Got Stuck and How to Prevent It

**Author:** Claude (Opus 4.7)
**Status:** Draft — for Cooper's review and decision
**Date:** 2026-05-11
**Trigger event:** Phase 3 V2 SOUL.md migration on 2026-05-11 evening surfaced a fleet-wide stall: 67% of VMs stuck at cv=82-85 while manifest was at v94, despite Vercel cron running continuously.
**Companion:** `instaclaw/scripts/_catch-up-stuck-cohort.ts` (commit `47764527`) ships the immediate unblock.

---

## TL;DR

The Vercel cron's `reconcileVM` has a hardcoded 180s strict deadline. The cron's per-VM budget is structurally bounded by Vercel's 300s function `maxDuration` (CLAUDE.md Rule 11). For VMs more than ~5 manifest versions behind, the per-VM catch-up work exceeds both budgets — so the cron tick aborts mid-catch-up and `config_version` never advances. **The cron is structurally incapable of catching up multi-version drift.**

This is critical-path for every fleet-wide feature: V2 SOUL.md, v94 ack-ux Layer 1+2 (👀 reactions), gbrain, monitoring crons, and every future manifest bump. **Nothing reaches the stuck cohort until this is fixed.**

The catch-up script shipped tonight (`_catch-up-stuck-cohort.ts`) is the **tactical unblock** — operator-attended local run with `strict=false`, no 300s ceiling, drains the cohort once. The **structural fix** to prevent recurrence on the next manifest bump is the topic of this doc.

---

## 1. Forensic evidence

### 1.1 Fleet cv distribution (2026-05-11 23:30 UTC)

```
cv  count  pct
 92     4   2.6%   newest
 91    18  11.8%
 89     3   2.0%
 88     8   5.3%
 87     2   1.3%
 85    10   6.6%
 84    32  21.1%
 82    60  39.5%   ← majority stuck
 79     1   0.7%
 77     1   0.7%
 54     3   2.0%
 53     5   3.3%
  0     5   3.3%   ← never reconciled (likely ready-pool)
```

**Zero VMs at cv=93 or cv=94.** Manifest was at v94 (now v95 — bumped again while we were investigating). Cron has been running but advancing zero VMs to current.

Of 152 healthy assigned VMs:
- Only 22 (14%) within 2 versions of current
- 102 (67%) stuck at cv=82-85

### 1.2 Why the 180s deadline is the load-bearing constraint

`STRICT_DEADLINE_MS = 180_000` in `vm-reconcile.ts:149`. Set via `Promise.race()` against `runSteps()` in strict mode.

Per-VM catch-up cost for cv=82 → v95:
- 29 configSettings keys × ~3-5s each in strict mode (read + verify, or read + write + verify) = 90-145s
- ~10-15 manifest file entries (append/insert/overwrite checks) × ~1-3s = 10-45s
- stepBackup, stepWorkspaceIntegrity, etc. = ~10-20s
- stepFiles + stepConfigSettings combined: 110-210s

Add steps 5-12 (npm, node, openclaw, env vars, systemd, prctl-subreaper, dispatch, XMTP, node_exporter): another 30-60s in the no-op-fast-path case, 100-200s in the "needs install" case.

**Total per cv=82 VM:** 140-410s. The 180s deadline catches the median case.

### 1.3 Why Vercel cron can't solve this even without the deadline

Vercel cron functions have a hard `maxDuration = 300s` (CLAUDE.md Rule 11). The cron processes `CONFIG_AUDIT_BATCH_SIZE = 3` VMs per tick (`vm-manifest.ts` per Rule comments). Per-VM budget = 100s — strictly tighter than the 180s deadline.

**Even if we removed the strict deadline tomorrow, the Vercel function would still die at 300s,** and the cv-bump that happens at the end of the tick would never persist for the cv=82 cohort.

### 1.4 Why this didn't auto-quarantine

Per `route.ts:407-460`, failure classification:
- `strictFailed = strict && auditResult.strictErrors.length > 0` → bumps `strict_hold_streak`, sends per-VM alert, no auto-quarantine
- `pushFailed = auditResult.errors.length > 0` → bumps `reconcile_consecutive_failures`, alerts, auto-quarantines at K=10

Strict-deadline timeouts push to `strictErrors` (vm-reconcile.ts:466), NOT `result.errors`. So they hit the `strictFailed` branch — alert fires, streak counter increments, but **the auto-quarantine logic from commit `e2380e68` never triggers.** The cron logs noise but the failure-tracking-and-quarantine architecture is blind to this class of stall.

This is a **gap in the e2380e68 work**. The fix (per §3.5 below) is to treat persistent strict-hold streaks the same as persistent push-error streaks for quarantine purposes.

---

## 2. The four options Cooper raised

### 2.1 Option A — Catch-up script (this is what we just shipped)

**Approach:** A local-machine script invokes `reconcileVM(strict=false)` against the stuck cohort. No 300s ceiling because it's not Vercel.

**Pros:**
- Already shipped. Tested in dry-run on cv=82 (150.8s) and cv=0 (110-164s).
- Surgical: only touches VMs that need catch-up. Doesn't change cron behavior.
- Trivially reversible: just don't run it again.
- Operator-attended, audit-gated, halts on fail-rate threshold.

**Cons:**
- One-shot. Doesn't prevent recurrence after the next manifest bump.
- Requires operator time (~8.5h for 102 VMs sequentially, ~3h at concurrency=3).
- Holds the `reconcile-fleet` cron lock for the duration (blocks Vercel cron entirely).
- Side effect: cv-bump skips the strict canary probe (`stepCanaryProbe`) that the cron does in strict mode. The Vercel cron's next pass on these VMs will run the strict canary.

**Time to deploy:** Already shipped (commit `47764527`). Operator runs tomorrow.

### 2.2 Option B — Dynamic deadline based on cv gap

**Approach:** `STRICT_DEADLINE_MS` becomes a function of `(MANIFEST.version - vm.config_version)`. E.g., 180s + 30s × gap, capped at 270s (to stay under Vercel's 300s).

**Pros:**
- Targeted: only loosens the deadline for VMs that need it.
- Cron continues to enforce strict mode discipline; just gives slow VMs more rope.

**Cons:**
- **Still bounded by Vercel's 300s function maxDuration.** A cv=82 VM legitimately needs 200-300s on the first attempt — borderline at best. cv=53 / cv=0 VMs (the rare deep-drift case) can't fit even at 270s.
- Architectural change: deadline becomes a runtime decision based on DB state. More complexity in `reconcileVM`.
- Doesn't help the underlying issue that a single Vercel function call must fit all of one VM's catch-up + its peers in the batch.

**Time to deploy:** ~4 hours (code + tests + canary). Doesn't fully solve.

**Verdict:** Partial fix at best. Helps the cv=88-89 cohort but not cv=82.

### 2.3 Option C — Split catch-up into smaller cv increments

**Approach:** Bump the manifest in smaller deltas. Don't ship v82→v95 as one diff; ship v82→v85, wait for cron to settle, then v85→v88, etc.

**Pros:**
- Each increment fits in 180s budget.
- Cron handles everything autonomously.

**Cons:**
- **Doesn't actually work in this architecture.** The manifest version is monotonic; we can't roll back v95 → v82 and replay. Once v95 ships, that's the target. The stuck cohort is already at cv=82 — the smaller-increments approach assumes we control time.
- The "ship smaller manifests going forward" version requires every PR to gate behind a fleet-soak window. Massive process overhead.
- Today's reality: the manifest bumps because shipping a fix matters more than waiting for fleet soak. v92 (P0 bandage), v93 (partner stub fix), v94 (ack-ux), v95 (in flight) — none could have waited a full cron-soak.

**Verdict:** Idealistic but unworkable.

### 2.4 Option D — Slow-path cron with longer deadline at lower frequency

**Approach:** A second Vercel cron function specifically for catch-up — runs every 30-60 minutes (vs the current every-5-min), with `maxDuration = 300` but a longer reconcileVM deadline (say 280s).

**Pros:**
- Stays within Vercel constraints (function maxDuration 300s).
- Targets the slow path specifically; doesn't affect the fast path.
- Self-maintaining: no operator intervention needed.

**Cons:**
- Still bounded by 300s — same issue as Option B for cv=53/cv=0.
- Two cron functions to maintain. The "slow" and "fast" crons might step on each other or race on the same lock.
- Cooper's stated preference is for ONE source of truth on reconcile behavior.

**Verdict:** Reasonable; partial fix.

---

## 3. Recommendation: A + a structural improvement

### 3.1 Now (tomorrow morning, post-Cooper-approval)

Run `_catch-up-stuck-cohort.ts` to unstick the cv=82 cohort. Operator-attended, audit-gated. Estimated wall-clock 3-8 hours depending on concurrency.

```bash
# Tomorrow morning, after Cooper reviews this doc:
cd instaclaw/

# Phase 1: small batch (5 VMs) — validate it works in live mode
npx tsx scripts/_catch-up-stuck-cohort.ts --max-vms=5 --concurrency=1 --yes

# Phase 2: expand to remaining cohort
npx tsx scripts/_catch-up-stuck-cohort.ts --concurrency=3 --lock-ttl-hours=6 --yes
```

### 3.2 Short-term structural fix (this week, before next manifest bump)

**The 180s strict deadline should NOT abort `result.errors`-clean reconciles that are simply slow.** Replace the all-or-nothing deadline with per-step deadlines:

- Each individual step has its own timeout (e.g. 60s for stepConfigSettings, 30s for stepFiles, 60s for stepSystemPackages, etc.).
- A step that times out pushes to `strictErrors` AND records which step.
- The reconcile continues to subsequent steps. Later steps may still succeed.
- At end of reconcile: if ANY step has strictErrors, the cron route holds cv. If all clean, cv bumps.

This converts "180s overall budget" into "every step gets its right-sized budget." A VM with one slow step doesn't lose all its other completed work.

**Estimated impact:** Most cv=82 VMs would advance under this model because stepConfigSettings would complete (it's most of the work) even if a tail-step times out, and the cron would still hold cv until that step also resolves on next tick. Progressive catch-up: each tick advances the VM toward fully-clean state.

**Code touch:** `lib/vm-reconcile.ts` lines 149-485. Replace single `Promise.race` with per-step `await Promise.race` wrappers. ~2-3 hours of work + tests.

### 3.3 Medium-term structural fix (next month)

**Bump the Vercel cron's per-VM allocation.** Reduce `CONFIG_AUDIT_BATCH_SIZE` from 3 → 1. Each VM gets the full 300s budget. Tradeoff: cron processes 1/3 the throughput per tick, BUT actually advances drift instead of looping uselessly.

Or: drop the strict canary probe (`stepCanaryProbe`) from the regular cron and run it as a separate, dedicated cron. The canary probe burns 10-20s per VM in strict mode — moving it out of the audit cycle frees that time for actual catch-up work.

### 3.4 Long-term: cron-vs-script separation of concerns

**Vercel cron's job: maintain the fleet at-or-near current manifest.** Fast, frequent, single-VM-budget-aware.

**Local script's job: handle deep drift, mass operations, multi-version catch-ups.** Operator-attended, no cap, audit-heavy.

This is essentially what tonight's catch-up script makes explicit. We should formalize the boundary:
- The cron NEVER attempts >3 versions of catch-up per VM per tick.
- The cron quarantines (via a new mechanism) any VM that's been at the same cv for >24h despite multiple cron ticks.
- Quarantined VMs are surfaced to operators as "needs manual catch-up via `_catch-up-stuck-cohort.ts`."

This is the architectural shape: cron for maintenance, scripts for drift.

### 3.5 Failure-tracking gap: treat strict-hold streaks as quarantine-eligible

The `strictFailed` branch (route.ts:407+) increments `strict_hold_streak` but never auto-quarantines. The `pushFailed` branch auto-quarantines at K=10 (`reconcile_consecutive_failures`).

For the strict-deadline-stall pattern (which is exactly what's happening to the cv=82 cohort), the right behavior is the same as pushFailed: log K times → auto-quarantine → surface to operators.

**Code change:** In `route.ts:407-459`, after the strict-hold-streak increment, check `if (newStreak >= STRICT_HOLD_QUARANTINE_THRESHOLD) ...` and apply the same auto-quarantine flow. Threshold: probably 5 (lower than K=10 push because strict-deadline stalls are typically more persistent).

This means the cron would have auto-quarantined the cv=82 cohort hours ago, surfacing them as "this needs manual intervention" instead of silently looping.

---

## 4. Open questions for Cooper

1. **Should the catch-up script also restart gateway on the vm-354/vm-050 stale-closure VMs?** They have v94 messages.* keys on disk but the closure was captured before the `RESTART_REQUIRED_CONFIG_PREFIXES` trigger landed. They need a one-shot manual restart. Could be a flag (`--restart-already-correct-messages`) or a sibling script (`_restart-stale-closure-vms.ts`).

2. **What's the right `concurrency` for the full cohort run?** Defaults to 1 (sequential, lowest risk). At 3 (max), ~3× faster but 3× the SSH/Anthropic load. Operator preference.

3. **Should we ship §3.2 (per-step deadlines) BEFORE the next manifest bump?** Otherwise the next bump re-stalls a similar cohort. v95 is already in flight; v96 is presumably coming.

4. **Should §3.5 (strict-hold-streak quarantine) ship as a separate PR?** Independent of the catch-up script. Could be done in parallel by another terminal.

---

## 5. What this PRD does NOT cover

- The vm-354/vm-050 stale-closure restart (separate concern; v94 ack-ux specific).
- The V2 SOUL.md migration (Phase 3 of `prd-soul-restructure.md`; will resume after the cohort is unstuck).
- The gbrain fleet rollout (waits on cohort unstuck).
- Cron route route.ts:226 `CONFIG_AUDIT_BATCH_SIZE` tuning (touched in §3.3 as one option; not the load-bearing choice).

---

## 6. Decision summary

| Action | Status | Owner | Timeline |
|---|---|---|---|
| Ship `_catch-up-stuck-cohort.ts` | ✅ Done (commit `47764527`) | Claude/canary terminal | Tonight |
| Dry-run validation (cv=0 + cv=82) | ✅ Done | Claude/canary terminal | Tonight |
| Live-validate 1 VM (vm-882) | Pending lock | Claude/canary terminal | Tonight or tomorrow |
| Authorize full-cohort run | Pending | Cooper | Tomorrow |
| Per-step deadlines (§3.2) | Pending decision | TBD | This week |
| Strict-hold quarantine (§3.5) | Pending decision | TBD | This week |
| Cron batch-size tuning (§3.3) | Pending decision | TBD | Next month |
| Cron-vs-script separation (§3.4) | Pending decision | TBD | Next month |

Cooper's input requested on §3.2, §3.3, §3.4, §3.5, and the open questions in §4.
