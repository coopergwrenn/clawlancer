# Watchdog v2 + Wake Reconciler — Design Spec

**Date:** 2026-05-02
**Status:** DESIGN — awaiting Cooper review before implementation
**Branch (proposed):** `fix/wake-from-hibernation` (continuing from Fixes A+B+C)
**Author:** Claude (paired with Cooper)
**Audience:** Cooper review; future engineers maintaining the fleet

---

## 0. Why this exists

Five separate fleet-wide bugs surfaced this sprint, all related to the watchdog and lifecycle reconciler:

1. **2026-04-29 → 2026-04-30 v67 outage** — in-VM watchdog killed gateways mid-completion (3-min FROZEN threshold collided with 60-90s LLM response time on 32K-token prompts).
2. **2026-05-02 wake-from-hibernation** — 15 paying customers stranded because no wake path exists for the `hibernating` state.
3. **2026-05-02 false orphan census** — 38 "orphan VMs" turned out to be paying WLD users; classifier didn't check `credit_balance`.
4. **2026-05-02 near-miss vm-036/vm-068** — almost hibernated two active Stripe subscribers; their `credit_balance=0` is *normal* for `api_mode='all_inclusive'`.
5. **2026-05-02 stale `current_period_end`** — local DB drifted from Stripe; suspend-check would have re-hibernated paying customers.

Each of these is a different symptom of the same disease: **the fleet's lifecycle decisions trust local DB state and run on aggressive cadences without consecutive-failure requirements or actor-side ground truth.** This design fixes that.

---

## 1. The nine lessons being internalized

Every design decision below traces back to one or more of these. The "Lesson Map" table at the end shows where each is enforced.

1. The old watchdog restarted healthy agents every ~6 min because it had no time-based threshold — only a per-cycle failure counter.
2. Suspend-check hibernated paying Stripe customers because it trusted local DB `current_period_end` instead of querying Stripe.
3. "38 orphan VMs" census missed that they were paying WLD users — didn't check `credit_balance`.
4. vm-036 / vm-068 near-miss — `credit_balance=0` is normal for `api_mode='all_inclusive'`; classifier must understand all billing models.
5. Three sleep states (`suspended`, `hibernating`, `frozen`); only two wake paths existed. `hibernating` had no wake.
6. Heartbeats count as activity in `last_proxy_call_at`. Need `last_user_activity_at` to distinguish.
7. `.select("a, b, c")` silently returned empty rows for some columns (RLS or column-grant). Use `.select("*")` for safety-critical reads.
8. Column was `provider_server_id`, not `linode_id`. Verify schema before queries.
9. `SSH_PRIVATE_KEY_B64` lives in `.env.ssh-key`, not `.env.local`.

---

## 2. Components shipping in this PR

| Component | Type | Purpose |
|---|---|---|
| Migration `20260502_watchdog_v2.sql` | DB | Schema for state, audit, privacy mode, user activity |
| `lib/watchdog.ts` | Module | Pure state-machine logic + audit helpers |
| `lib/billing-status.ts` | Module | Single source of truth: "is this user paying us?" — Stripe + WLD + partner aware |
| `app/api/cron/watchdog/route.ts` | Cron | Watchdog v2 cron — runs every 5 min, shadow-mode by default |
| `app/api/cron/wake-paid-hibernating/route.ts` | Cron | Defensive wake reconciler (Fix D) — runs every 15 min |
| `vercel.json` | Config | Schedule the two new crons |
| `app/api/cron/health-check/route.ts` | Edit | Gate the OLD restart path behind `WATCHDOG_V1_RESTART_ENABLED` env var (default `true` for safety) |

NOT in this PR — explicitly deferred:
- In-VM `vm-watchdog.py` rewrite (requires snapshot/manifest changes)
- Privacy-mode UI toggle (just the DB column for now)
- Proxy update to populate `last_user_activity_at` accurately (backfilled from `last_proxy_call_at` as starting baseline)
- Audit-table cleanup cron (90-day retention) — added once table size warrants it

---

## 3. Watchdog v2 — state machine

### 3.1 States (persisted on `instaclaw_vms`)

The state is a derived view over these columns. We do NOT add a `watchdog_state` enum column — that would couple state to schema and force migrations on every state change. Instead, state is computed from:

- `health_status` (existing — `healthy`, `unhealthy`, `unknown`, `hibernating`, `suspended`, `frozen`)
- `watchdog_consecutive_failures` (NEW — int)
- `watchdog_first_failure_at` (NEW — timestamptz)
- `watchdog_last_restart_at` (NEW — timestamptz)
- `watchdog_restart_attempts_24h` (NEW — int)
- `watchdog_quarantined_at` (NEW — timestamptz)

The **derived state** for any VM at any moment:

```
function deriveState(vm) {
  if (vm.health_status IN ['hibernating', 'suspended', 'frozen']) → SLEEPING (not watchdog's job)
  if (vm.watchdog_quarantined_at IS NOT NULL) → QUARANTINED
  if (vm.watchdog_last_restart_at AND (NOW − last_restart) < 20min) → RESTART_COOLDOWN
  if (vm.watchdog_consecutive_failures = 0) → HEALTHY
  if (vm.watchdog_consecutive_failures < 3) → DEGRADED
  if (vm.watchdog_consecutive_failures ≥ 3 AND (NOW − first_failure_at) ≥ 15min) → UNHEALTHY
  // (The intermediate case: failures ≥3 but elapsed < 15min — still DEGRADED, time-protected)
  → DEGRADED
}
```

### 3.2 Transitions

```
                    ┌──────────────────────────────────────────────────┐
                    │                                                  │
            ┌───────▼──────┐                                           │
   ┌────────┤   HEALTHY    │◄──── probe success: reset counter ────────┤
   │        └──────┬───────┘                                           │
   │               │                                                   │
   │ probe failed  │                                                   │
   │  (counter++)  │                                                   │
   │  (set first_failure_at if null)                                   │
   │               ▼                                                   │
   │        ┌──────────────┐                                           │
   │        │   DEGRADED   │◄──── probe failed (counter < 3 OR         │
   │        └──────┬───────┘                  elapsed < 15min) ────────┤
   │               │                                                   │
   │     counter≥3 │                                                   │
   │ AND elapsed≥15min                                                 │
   │               ▼                                                   │
   │        ┌──────────────┐                                           │
   │        │  UNHEALTHY   │                                           │
   │        └──────┬───────┘                                           │
   │               │                                                   │
   │   ┌───────────┼───────────┐──────────┐──────────┐                 │
   │   │           │           │          │          │                 │
   │ user-active  privacy   cooldown   billing-down  proceed           │
   │ (skip)       (alert)   (skip)     (skip; tag)   ▼                 │
   │   │           │           │          │      ┌───────┐             │
   │   │ log audit │ alert     │ log     │ log  │RESTART│             │
   │   │           │           │          │     └───┬───┘             │
   │   │           │           │          │         │                 │
   │   ▼           ▼           ▼          ▼         │ ssh attempt     │
   │  back to UNHEALTHY (next cycle re-evaluates)   ▼                 │
   │                                            ┌───────────┐         │
   │                                   ┌────────┤ post-probe ├────────┐│
   │                                   │  200   └───────────┘   fail  ││
   │                                   │                              ││
   │                                   ▼                              ▼│
   │                          ┌─────────────────┐         ┌──────────────┐
   │                          │RESTART_COOLDOWN │         │ restart_fail │
   │                          │  (20 min hold)  │         │ counter++    │
   │                          └────────┬────────┘         └──────┬───────┘
   │                                   │ 20min over              │
   │                                   ▼                         │
   │                              re-probe ────► HEALTHY         │
   │                                                            ≥3 in 24h
   │                                                              │
   │                                                              ▼
   │                                                      ┌──────────────┐
   │                                                      │ QUARANTINED  │
   └──────────────────────── back to HEALTHY ──────────── │ (manual fix) │
                              (after manual reset)        └──────────────┘
```

### 3.3 Restart preconditions (ALL must hold)

A restart fires only when EVERY one of these is true:

1. Derived state == `UNHEALTHY` (counter ≥ 3 AND elapsed ≥ 15 min)
2. `(NOW − watchdog_last_restart_at) ≥ 20 min` (cooldown)
3. `watchdog_restart_attempts_24h < 3` (rolling-window quarantine)
4. `(NOW − last_user_activity_at) ≥ 5 min` (don't disrupt active user — Lesson 6)
5. User does NOT have `privacy_mode = true` (Lesson: privacy mode users alerted only)
6. **Re-probe right before restart returns failure** (the same direct-HTTP double-check the v1 logic already does — keep it)
7. **Global anomaly check**: not >50% of all probed VMs failing this cycle (network partition guard)
8. The VM IS actually our customer's responsibility: derived from `lib/billing-status.ts` — has active Stripe sub OR credit_balance > 0 OR partner != null

If condition 1-7 hold but 8 fails, that VM should NOT exist as our problem (it's an unowned VM somehow assigned). Log `restart_skipped_unowned`, alert admin, do not restart.

### 3.4 Conservative bias

False negative (waiting an extra 15 min on a genuinely broken VM) is vastly cheaper than false positive (restarting a healthy VM mid-conversation). Every gate above defaults to "don't act" on uncertainty.

---

## 4. lib/billing-status.ts — single source of truth

This module exists to prevent Lessons 3, 4, and 5 from happening again. Any code that needs to know "is this VM owned by a paying customer?" calls this — never re-implements the check.

### 4.1 API

```ts
export type BillingStatus = {
  isPaying: boolean;
  reasons: string[];          // human-readable, for audit logs
  details: {
    stripeSubStatus: string | null;     // "active" | "trialing" | "past_due" | "canceled" | null
    stripeSubVerified: boolean;          // true ONLY if we hit Stripe API
    creditBalance: number;
    partner: string | null;
    apiMode: string | null;
    tier: string | null;
  };
};

// Cheap path: local DB only. Use for non-destructive decisions.
export async function getBillingStatus(supabase, vmId): Promise<BillingStatus>;

// Expensive path: queries Stripe API for ground truth. Use BEFORE destructive
// actions (hibernation, restart, freeze).
export async function getBillingStatusVerified(supabase, stripe, vmId): Promise<BillingStatus>;
```

### 4.2 isPaying logic

```
isPaying = (
  // Stripe path: any non-canceled sub with current/trialing status (or past_due in grace)
  (sub.status IN ['active', 'trialing'] AND sub.payment_status != 'past_due_beyond_grace') ||
  
  // WLD path: positive credit balance
  (credit_balance > 0) ||
  
  // Partner path: any partner tag (edge_city, eclipse, etc.)
  (partner IS NOT NULL AND partner != '') ||
  
  // All-inclusive tier: credit_balance=0 is NORMAL for these (Lesson 4)
  (api_mode = 'all_inclusive' AND tier IN ['starter', 'pro', 'power'] AND sub.status = 'active')
)
```

### 4.3 The verified version

`getBillingStatusVerified` does:
1. Read DB.
2. If user appears to have a Stripe sub, hit Stripe API: `stripe.subscriptions.retrieve(stripe_sub_id, { expand: ['latest_invoice'] })`.
3. Compare DB status vs Stripe status. If they disagree, **trust Stripe** and log the divergence to admin alerts (Lesson 2).
4. If `stripeSubVerified = true` and Stripe says active + invoice paid → keep `isPaying = true`.
5. If Stripe says canceled but DB says active → `isPaying = false`, alert admin to fix DB drift.

### 4.4 Why a module, not inline

If we re-implement this logic in 3+ places (watchdog, suspend-check, wake-reconciler) we WILL drift. The 38-orphan census happened because the classifier was a one-off script. Module + tests + single point of change = no drift.

---

## 5. Wake reconciler (Fix D) — DEFENSIVE NET

### 5.1 What it is

Cron at `*/15 * * * *`. Finds VMs that are sleeping (`hibernating` or `suspended`) but whose owner is paying. Wakes them.

This is the safety net for any future wake-path bug. Even if someone introduces a new code path that hibernates without a corresponding wake, this cron heals within 15 min. **15-min cron interval = max 15 min of customer downtime SLA.**

### 5.2 Algorithm

```
1. Acquire cron lock (cron-lock pattern, TTL = 600s)
2. Query: SELECT * FROM instaclaw_vms WHERE health_status IN ('hibernating', 'suspended')
   USE .select("*") — Lesson 7
3. For each candidate (parallel, but limit to 10/run — Cooper's spec):
   a. Read user's billing status from local DB (cheap)
   b. If isPaying = true (cheap-path), proceed to verified check
   c. Get verified billing status (Stripe API hit)
   d. If verified isPaying = false → SKIP (legit sleep state). Audit-log decision.
   e. If verified isPaying = true:
        - This VM should NOT be sleeping. Wake it.
        - Sequential wake (not parallel — Cooper's spec, halt on first SSH failure)
        - Use existing wakeIfHibernating helper (validated in P0/P1 wake)
        - For 'suspended' state, also clear suspended_at
        - Log every action to instaclaw_watchdog_audit
4. Halt on first SSH failure (Cooper's spec). Audit "halted_after_ssh_failure".
5. Release cron lock.
```

### 5.3 Why batch 10/run, not all

- Stripe API rate limit: 100 req/sec, 1000 burst — we'd be fine even at 30/run, but 10 keeps headroom.
- SSH operations are slow (~6-10s each); 10/run × 10s = ~100s, well under 600s maxDuration.
- If 10 customers are stranded simultaneously, the FIRST customer waits at most 15 min (next cron cycle). The last waits at most 30 min. Acceptable for a defensive net.
- Larger batches risk one slow VM eating most of the budget.

### 5.4 Why halt on first SSH failure

If SSH is broken to one VM, it's likely broken to many (network issue, key rotation, etc.). Halting prevents:
- Wasting cycles attempting all 10
- Mass-action on a transient-network event (Lesson "global anomaly")
- The next cycle will try the same VMs in the same order; halting + alert lets us investigate before more damage

---

## 6. DB schema additions

Migration `20260502_watchdog_v2.sql`:

```sql
-- ─── Privacy mode (per-user opt-out from invasive health checks) ───
ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS privacy_mode boolean NOT NULL DEFAULT false;

-- ─── Distinguish user activity from heartbeats (Lesson 6) ───
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS last_user_activity_at timestamptz;

-- Backfill: for existing rows, use last_proxy_call_at as the best available
-- baseline. The proxy will populate this accurately going forward (separate
-- follow-up to make proxy heartbeat-aware).
UPDATE instaclaw_vms
  SET last_user_activity_at = last_proxy_call_at
  WHERE last_user_activity_at IS NULL;

-- ─── Watchdog state tracking (derived state computed from these) ───
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS watchdog_consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watchdog_first_failure_at timestamptz,
  ADD COLUMN IF NOT EXISTS watchdog_last_restart_at timestamptz,
  ADD COLUMN IF NOT EXISTS watchdog_restart_attempts_24h integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watchdog_restart_attempts_24h_window_start timestamptz,
  ADD COLUMN IF NOT EXISTS watchdog_quarantined_at timestamptz;

-- ─── Audit trail (every watchdog action) ───
CREATE TABLE IF NOT EXISTS instaclaw_watchdog_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id uuid NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  user_id uuid REFERENCES instaclaw_users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'probe_healthy',
    'probe_failed',
    'restart_attempted',
    'restart_succeeded',
    'restart_failed',
    'restart_skipped_active_user',
    'restart_skipped_privacy_mode',
    'restart_skipped_cooldown',
    'restart_skipped_quarantined',
    'restart_skipped_unowned',
    'restart_skipped_global_anomaly',
    'restart_skipped_billing_unverified',
    'reset_after_recovery',
    'quarantined',
    'wake_reconciler_attempted',
    'wake_reconciler_succeeded',
    'wake_reconciler_failed',
    'wake_reconciler_skipped_not_paying',
    'wake_reconciler_halted_ssh_failure'
  )),
  prior_state text NOT NULL,
  new_state text NOT NULL,
  reason text,
  consecutive_failures integer,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_watchdog_audit_vm_time
  ON instaclaw_watchdog_audit(vm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watchdog_audit_action_time
  ON instaclaw_watchdog_audit(action, created_at DESC);
```

All `ADD COLUMN IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS` — migration is idempotent and safe to re-run.

---

## 7. Cron schedules (vercel.json additions)

```json
{ "path": "/api/cron/watchdog",                "schedule": "*/5 * * * *"  },
{ "path": "/api/cron/wake-paid-hibernating",   "schedule": "*/15 * * * *" }
```

| Cron | Cadence | maxDuration | Lock TTL |
|---|---|---|---|
| watchdog | 5 min | 300s (5 min) | 360s |
| wake-paid-hibernating | 15 min | 300s | 600s |

---

## 8. Shadow mode + rollout plan

The watchdog v2 ships **in shadow mode by default**. Env var `WATCHDOG_V2_MODE` controls behavior:

- `WATCHDOG_V2_MODE=shadow` (DEFAULT): probes, increments counters, writes ALL audit rows tagged `mode: shadow`. **Does NOT actually restart anything.** Old v1 restart path still runs in `cron/health-check`.
- `WATCHDOG_V2_MODE=active`: probes, increments counters, writes audit rows, AND takes restart action. v1 restart path should be turned off via `WATCHDOG_V1_RESTART_ENABLED=false`.

Rollout plan (Cooper executes in Vercel):
1. Day 0: ship this PR. v2 in shadow mode, v1 active. Watch audit table for ~3 days. Confirm v2 would have made same/better decisions than v1.
2. Day 3-7: review audit. If clean, set `WATCHDOG_V2_MODE=active` and `WATCHDOG_V1_RESTART_ENABLED=false` simultaneously.
3. Day 14: if no incidents, delete the v1 restart code (separate PR).

This is the SAFEST path. No "rip the bandage" risk.

---

## 9. Failure modes considered

| Failure mode | Mitigation |
|---|---|
| Cron pile-up during slow run | Distributed lock (`tryAcquireCronLock`), TTL > maxDuration |
| HTTP probe transient timeout | Counts as 1 failure; not 5; ditto SSH-side timeout |
| Network partition Vercel ↔ all VMs | Global anomaly guard: if >50% of VMs fail in single run, halt all destructive actions, alert |
| Stripe API rate limit | Fix D batches 10/run; well under 100 req/sec limit |
| Stripe API outage | `getBillingStatusVerified` falls back to local DB with `stripeSubVerified=false`; watchdog conservatively SKIPS restart when verification unavailable (lesson 2 — never act destructively on unverified billing) |
| VM in `restart_cooldown` repeatedly fails | After 3 restart attempts in 24h → `quarantined`. Daily admin alert; no more auto-restarts. |
| Audit table grows unbounded | Manual cleanup for now; 90-day retention cron in follow-up PR (after we see actual growth rate) |
| Race: suspend-check hibernating same VM watchdog probes | Watchdog skips `health_status IN (suspended, hibernating)` — those are intentionally not serving |
| Race: wake-reconciler waking VM while suspend-check tries to hibernate | suspend-check holds its own DB lock; wake-reconciler holds its own. Serialized via row-level updates. Worst case: wake wins one cycle, hibernate wins next. The defensive net catches it. |
| Privacy-mode user has genuinely broken VM | Alert admin daily; no auto-restart. Trade-off: privacy > convenience for those who opted in. |
| Active user mid-conversation when restart conditions hit | `last_user_activity_at < 5 min` → skip restart. Re-evaluate next cycle. |
| `last_user_activity_at` not yet populated by proxy (initial state) | Backfilled from `last_proxy_call_at` in migration; until proxy update, it has heartbeat noise. Conservative: this means we're MORE protective of "active" users in the interim, not less. |
| Migration partial-runs | All `IF NOT EXISTS` — re-runnable. |
| `.select()` returns empty rows for some columns (Lesson 7) | Use `.select("*")` for both crons' VM fetches; validate row shape before action |
| Wrong column names (Lesson 8) | Migration adds them; TypeScript types will catch usage errors at compile time |
| SSH key in wrong env (Lesson 9) | Cron routes use Vercel env (no .env file loading). Recovery scripts use `.env.ssh-key` already. Note in CLAUDE.md update. |
| Watchdog v2 has its own bug | Shadow mode catches it before any production action. Audit log shows what it WOULD have done. |
| Audit rows never written (silent watchdog) | Add Vercel cron success monitoring; admin alert if no audit rows in last 30 min during expected cron windows |

---

## 10. Lesson Map (every lesson ↔ where it's enforced)

| # | Lesson | Where enforced |
|---|---|---|
| 1 | No consecutive-failure requirement | `watchdog_consecutive_failures ≥ 3` AND `(NOW − first_failure_at) ≥ 15 min` AND restart cooldown 20 min — all in `lib/watchdog.ts` derived state |
| 2 | Trusted DB instead of Stripe | `getBillingStatusVerified` queries Stripe before any destructive action; both watchdog (restart) and wake-reconciler (wake) call it |
| 3 | Census didn't check all revenue sources | `lib/billing-status.ts` `isPaying` includes Stripe + WLD credits + partner + all-inclusive tier; ALL classification code MUST use it |
| 4 | Didn't understand all billing models | `lib/billing-status.ts` explicit branch: `api_mode='all_inclusive' AND tier IN (...) AND sub.status='active'` is paying even with credit_balance=0 |
| 5 | 3 sleep states, 2 wake paths | Wake reconciler queries `health_status IN ('hibernating', 'suspended')`. Frozen has its own thawVM path (already exists); reconciler doesn't touch frozen |
| 6 | Heartbeats counted as activity | New `last_user_activity_at` column. Watchdog uses this for active-user gate, not `last_proxy_call_at`. (Proxy update to populate accurately is follow-up; backfilled initially.) |
| 7 | `.select()` silently empty | Both new crons use `.select("*")` for VM fetches. Helper functions validate row shape before action. |
| 8 | Wrong column name | Migration adds named columns; TS types in cron route will fail compile if used wrong |
| 9 | SSH key in wrong env file | Cron routes inherit Vercel env. Diagnostic scripts (`_diag-watchdog-state.ts` etc.) load both `.env.local` and `.env.ssh-key` |

---

## 11. Open questions for Cooper review

1. **Shadow mode duration**: 3 days enough before flipping to active? Or want a full week?
2. **Quarantine reset**: should `watchdog_quarantined_at` clear automatically after some interval (e.g., 24h), or require manual admin reset? I lean manual — quarantine should mean "human looked at this." Let me know if you'd rather auto-clear.
3. **Audit retention**: 90 days? 180 days? Forever? The table will grow ~600 rows/day at 80 VMs × 12 cron cycles/hour × 4-7 audit rows per VM-cycle. Conservative estimate: 50K rows/week.
4. **Privacy-mode alert cadence**: daily? hourly while broken? I lean daily — a broken VM that the user opted out of auto-fixing should be a "did you mean to do this?" question, not a ping flood.
5. **Active-user threshold**: 5 min? 10 min? Lower means more protection (fewer disruptions), higher means faster recovery. 5 min was Cooper's spec — confirm or adjust.
6. **In-VM watchdog** (`vm-watchdog.py`, the one that caused the v67 incident): I am NOT touching it in this PR. It needs a snapshot/manifest cycle and is its own scoped piece of work. OK to defer?
7. **Proxy `last_user_activity_at` populate**: defer to follow-up PR or include here? Including here means an additional file edit (proxy route), an extra heartbeat-classification call per request. I'd prefer to defer — the watchdog gracefully handles null and the 15-min threshold means a few cycles of stale data won't cause issues.

---

## 12. What I am NOT doing

Things explicitly out of scope to keep this PR focused:

- ❌ Rewriting the in-VM `vm-watchdog.py` (separate snapshot/manifest cycle)
- ❌ Privacy-mode UI toggle (just the column for now)
- ❌ Proxy heartbeat-aware `last_user_activity_at` populate
- ❌ Audit-table cleanup cron
- ❌ Removing the v1 restart code from `cron/health-check` (just gating it behind env flag)
- ❌ Migrating existing scripts to use `lib/billing-status.ts` (write the module, migrate callers in follow-ups as needed)
- ❌ Backfilling `last_user_activity_at` more accurately than `last_proxy_call_at` baseline

Each of these is its own PR.

---

## 13. Diff size estimate

Roughly:

- Migration: 50 lines
- `lib/billing-status.ts`: 150 lines
- `lib/watchdog.ts`: 200 lines (state machine + audit helpers)
- `app/api/cron/watchdog/route.ts`: 250 lines
- `app/api/cron/wake-paid-hibernating/route.ts`: 200 lines
- `vercel.json`: 8 lines
- `cron/health-check/route.ts` edit: ~3 lines (env-var gate)

Total: ~860 lines of new code, ~3 lines of edit.

---

**Cooper: please review §3 (state machine), §4 (billing-status), §5 (reconciler), §10 (lesson map), §11 (open questions). Approve or push back; I'll start coding once we're aligned.**
