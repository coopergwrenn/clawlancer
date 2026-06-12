# Tracked follow-up — SoT (Stripe-verified) conversion of destructive billing gates

**Opened:** 2026-06-12 (INC-2026-06-12 close-out)
**Context:** PRD `docs/prd/absence-based-destruction-audit-2026-06-12.md` §4. The stripe-reconcile cap landmine is fixed (`fetchAllOrThrow`, fail-closed — this commit). What remains is the **second seam**: the destructive consumers read *cached* local `instaclaw_subscriptions` instead of Stripe ground truth, so a sub that's stale from a **missed webhook** (not the cap) can still cause wrongful action. Deferred deliberately to avoid scope-creeping the P0 cap fix into a multi-cron billing refactor. Tracked here, sequenced.

## Why this is safe to defer (the bound)
`wake-paid-hibernating` runs every 15 min and uses `getBillingStatusVerified` (Stripe ground truth) — it wakes any wrongly-hibernated paying user within 15 min, and `freezeVM` only escalates after 30–90 days of sleep a real payer can't accumulate. So the **hibernate/freeze** chain self-heals. The wake net does NOT cover the **reaper's db-dead delete** (delete is not a sleep state), which is why item 1 below goes first.

## Item 1 (FIRST, small, reaper-local) — reaper db-dead delete → `getBillingStatusVerified`
- **Where:** `app/api/cron/vm-lifecycle/route.ts` Pass -1, the db-dead branch safety check currently uses `userHasLiveSubscription(supabase, dbRow.assigned_to)` (reads cached local `instaclaw_subscriptions`).
- **Change:** swap to `getBillingStatusVerified(supabase, stripe, vm.id)` (or equivalent Stripe-verified `isPaying`) for the **delete** decision specifically. Delete is irreversible + no-snapshot, so it must verify Stripe ground truth, not cache (Rule 14).
- **Why it matters (proven 2026-06-12):** the first clean dry-run after re-enable showed `candidates:10, skipped_credits:6` — i.e. ~6 db-dead rows with running Linodes exist and were protected by the *credits* gate. If one had 0 credits + a webhook-stale 'canceled' cached sub + no recent activity, the only remaining gate (`userHasRecentActivity`) could miss it → wrongful delete of a paying customer. This closes that residue.
- **Risk/cost:** small, reaper-local, one call-site swap. `getBillingStatusVerified` already exists and is used by `wake-paid-hibernating`. Ship with the reaper's ceremony (dry-run observe, watch deleted_*=0).

## Item 2 (LATER, broader) — suspend-check + freezeVM → SoT
- **Where:** `lib/vm-lifecycle-helpers.ts:userHasLiveSubscription` (cached) is consumed by `suspend-check` Pass 2 and `freezeVM`.
- **Change:** route the destructive decision through `getBillingStatusVerified`. Mitigation already exists (wake-paid-hibernating SoT net bounds wrongful hibernate to ~15 min), so this is hardening, not a bleed.
- **Caveat:** `getBillingStatusVerified` hits Stripe per-VM — cost/latency. Batch or cache-with-short-TTL where needed; don't naively call it in a tight fleet loop. Design before shipping.

## Sequence
1. stripe-reconcile cap fix — **DONE** (this commit).
2. Item 1 (reaper db-dead → SoT) — next, reaper-local, closes the one residue the wake net misses.
3. Item 2 (suspend/freeze → SoT) — hardening, after, with the per-VM-Stripe-call cost designed for.
