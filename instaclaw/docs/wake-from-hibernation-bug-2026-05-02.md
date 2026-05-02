# Wake-from-Hibernation Bug — Root Cause Analysis

**Date:** 2026-05-02
**Severity:** P0 — paying customers without service
**Discovered during:** post-census audit; 6 active Stripe + 9 WLD-with-credits customers found wrongly hibernating
**Resolution status:** diagnosed, manually woken (15 VMs); code fix proposed, not yet shipped

---

## What broke

15 customers (6 paying Stripe subscribers + 9 WLD users with positive credit balance) were stuck in `health_status='hibernating'` for 9–24 days each. They paid (or topped up) and the system never woke their agent.

vm-576 was a **Pro tier ($99/mo)** subscriber asleep for 10 days — ~$33 of paid service we owe back.

## Root cause: three wake-from-hibernation paths missing or broken

The codebase has **three** sleep states for VMs:

| `health_status` | When set | Linode instance | gateway |
|---|---|---|---|
| `suspended` | (legacy) past-due 7d → suspend in `cron/health-check` Pass 3 | running | stopped |
| `hibernating` | `cron/suspend-check` Pass 1+2, `cron/health-check` Pass 3b | running | stopped |
| `frozen` | `lib/vm-freeze-thaw` after `FREEZE_GRACE_HIBERNATING_DAYS` | **deleted (snapshot)** | n/a |

There are **two** wake-from-sleep paths in the webhook handler. Both target legacy state names. Neither handles `hibernating`:

### Bug 1 — `customer.subscription.updated` only thaws `frozen`

`app/api/billing/webhook/route.ts:657`:
```ts
.eq("assigned_to", subRow.user_id)
.eq("status", "frozen")           // ← only frozen
.not("frozen_image_id", "is", null)
.limit(1);
```

When a Stripe sub is reactivated, the webhook calls `thawVM` only if a frozen VM is found. Hibernating VMs (which are `status='assigned'`, `health_status='hibernating'`) are silently skipped. The user resubscribes; nothing happens.

### Bug 2 — `invoice.payment_succeeded` only restarts `suspended`

`app/api/billing/webhook/route.ts:878`:
```ts
if (vm?.health_status === "suspended") {   // ← only suspended
  // restartGateway + clear suspended_at
}
```

When a past-due payment recovers, the webhook restarts the gateway only if `health_status==="suspended"`. Hibernating VMs are skipped. This was correct when only the old `cron/health-check` past-due path existed (which sets `"suspended"`). The newer `cron/suspend-check` was added with a new `"hibernating"` state, but this wake handler was never updated to match.

### Bug 3 — credit top-ups never wake at all

WLD path: `instaclaw-mini/app/api/pay/confirm/route.ts:65` calls `instaclaw_add_credits` RPC. The RPC just does an UPDATE on `credit_balance` and an INSERT into `instaclaw_credit_ledger`. Zero hibernation awareness anywhere in the path.

Stripe credit-pack path: `app/api/billing/webhook/route.ts:177` — same RPC, same gap.

A WLD user can hit $0, get hibernated, top up to $1.50, and our system shows the credits while their agent stays asleep. (Symptom we just observed across 9 VMs.)

### Bug 4 (contributing) — two crons doing the same hibernation, with name drift

`cron/health-check` Pass 3 (line 1257) sets `health_status="suspended"` for past-due-beyond-grace.
`cron/suspend-check` Pass 1 (line ~122) sets `health_status="hibernating"` for the same condition.
`cron/health-check` Pass 3b (line 1358) sets `health_status="hibernating"` for no-sub-no-credits.
`cron/suspend-check` Pass 2 sets `health_status="hibernating"` for the same condition.

Both crons run, both set states — race condition possible, and the wake handlers downstream are split across two state names because they were written at different times.

## How the 6 Stripe customers reached this state

Stripe ground truth: all 6 are `status=active`, latest invoice `paid` first attempt. So they aren't past-due anymore. But our DB shows stale `current_period_end` (2 to 24 days in the past) on most of them. Likely sequence per VM:

1. Stripe charged at period_end. Charge succeeded OR temporarily failed.
2. If failed: `invoice.payment_failed` webhook → `payment_status='past_due'`. After 7 days past-due, `cron/health-check` or `cron/suspend-check` hibernated.
3. User paid (or Stripe retry succeeded). `invoice.payment_succeeded` fired.
4. Our handler checked `health_status==="suspended"` (Bug 2) → no match for `"hibernating"` → no wake.
5. `customer.subscription.updated` later updated `status='active'`, `payment_status='current'` in our DB. But never woke the VM (Bug 1).

Net: customer pays, our DB correctly reflects "active sub", VM stays asleep forever.

The 9 WLD users follow the same pattern with Bug 3: they ran out of credits → hibernated → topped up via mini-app → credits added → no wake → asleep forever.

## Fix proposal

Three small code changes plus a defensive reconciler. Total: probably ~80 LOC.

### Fix A — wake hibernating VMs on subscription update

`app/api/billing/webhook/route.ts:653` — add a hibernating branch alongside the existing frozen check:

```ts
if (subscription.status === "active" || subscription.status === "trialing") {
  // ... existing frozen → thawVM logic ...

  // NEW: wake hibernating VMs (gateway-stopped on a still-running Linode)
  const { data: hibernatingVms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user")
    .eq("assigned_to", subRow.user_id)
    .eq("health_status", "hibernating");

  for (const vm of hibernatingVms ?? []) {
    try {
      const ok = await startGateway(vm as VMRecord);
      if (ok) {
        await supabase.from("instaclaw_vms").update({
          health_status: "healthy",
          last_health_check: new Date().toISOString(),
        }).eq("id", vm.id);
        logger.info("billing/webhook: woke hibernating VM on subscription update", {
          route: "billing/webhook", vmId: vm.id, userId: subRow.user_id,
        });
      }
    } catch (err) {
      logger.error("billing/webhook: wake-from-hibernation failed", {
        vmId: vm.id, error: String(err),
      });
    }
  }
}
```

### Fix B — wake hibernating VMs on payment succeeded

`app/api/billing/webhook/route.ts:878` — change the state check from `=== "suspended"` to `IN (suspended, hibernating)`:

```ts
if (vm && (vm.health_status === "suspended" || vm.health_status === "hibernating")) {
  // existing restartGateway logic — already correct, just gate it on both states
}
```

### Fix C — wake on credit top-up (WLD + Stripe credit packs)

Two callsites, same logic. New helper in `lib/credits.ts` (new file) or inline:

```ts
export async function wakeIfHibernating(supabase: SupabaseClient, userId: string, runId: string) {
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user")
    .eq("assigned_to", userId)
    .eq("health_status", "hibernating");
  for (const vm of vms ?? []) {
    try {
      if (await startGateway(vm as VMRecord)) {
        await supabase.from("instaclaw_vms").update({
          health_status: "healthy",
          last_health_check: new Date().toISOString(),
        }).eq("id", vm.id);
        logger.info("Woke hibernating VM on credit top-up", { vmId: vm.id, userId, runId });
      }
    } catch (err) { logger.error("wakeIfHibernating failed", { vmId: vm.id, error: String(err) }); }
  }
}
```

Call sites:
1. `instaclaw-mini/app/api/pay/confirm/route.ts:69` — after `instaclaw_add_credits` succeeds
2. `app/api/billing/webhook/route.ts:177` (credit-pack handler) — after the RPC succeeds

Best-effort: failure to wake must NOT fail the webhook (Stripe would retry the credit grant — bad for idempotency).

### Fix D — defensive reconciler (catches future drift)

New cron `app/api/cron/wake-paid-hibernating/route.ts` running every 15 min. Logic:

```ts
// Find any hibernating VM whose owner has either:
//   (a) active stripe sub (status active/trialing, payment_status current), OR
//   (b) credit_balance > 0
// Wake all matches. This is the safety net for any future bug that hibernates a paying customer.
```

This is the load-bearing safety net — even if every webhook handler has a bug forever, this cron makes the worst-case dwell time 15 minutes, not 24 days.

### Cleanup (optional, separate PR) — collapse the two hibernate crons

`cron/health-check` Pass 3 and Pass 3b duplicate `cron/suspend-check` Pass 1 and Pass 2 with subtly different state names (`suspended` vs `hibernating`). Remove from `health-check`, keep only `suspend-check` as the single source of truth. Update any remaining `"suspended"` callers to `"hibernating"`. This eliminates the state-name fork that caused Bug 2.

## Manual recovery (already executed)

Both wake scripts are committed under `instaclaw/scripts/`:
- `_wake-6-stuck-stripe.ts` — woke vm-544, vm-576, vm-698, vm-655, vm-046, vm-442
- `_wake-9-wld-with-credits.ts` — woke vm-331, vm-850, vm-linode-10, vm-769, vm-779, vm-765, vm-763, vm-740, vm-742

Both use the same pattern: SSH-check → `startGateway()` → poll `is-active` 30s → curl `/health` → DB update. Sequential, halt-on-failure. Reusable as the inner loop of the Fix D reconciler.

## Why this matters beyond the immediate 15 customers

The Phase 1 hibernation work in the WLD pricing strategy doc (`docs/wld-pricing-strategy.md`) is going to put MORE customers into the hibernating state, intentionally, as part of the new credit-depletion lifecycle. **Phase 1 cannot ship until Fixes A, B, C are in.** Otherwise we'll multiply this exact failure mode across the new lifecycle: every WLD user who reloads after hibernation will be silently broken until someone notices.

Recommended order:
1. Fix A + Fix B + Fix C (Phase 1 prerequisite — ~half a day of work + tests)
2. Fix D (defensive — same week, reduces blast radius of future bugs to 15 min)
3. Cleanup (separate PR, no rush)
4. Then Phase 1 hibernation lifecycle build

## Open questions

- Should wake-from-hibernation also send a push notification to the user ("your agent is back")? The hibernation handler sends one when going to sleep; symmetric wake-up notification is probably right.
- For Fix D, what's the right interval? 15 min is generous; 5 min is paranoid; 1h matches existing slow crons. Default to 15 min.
