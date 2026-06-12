# F9 — buyer-side unwind / inbound-refund ledger (reference design, 2026-06-10)

**Status:** DESIGN. The build is gated on two external items (below); the architecture +
every edge case is specified here so it can be built + activated the moment they clear.
**Why design-only tonight:** the decision-level live-probe ceremony bar cannot be met
until the migration is applied and a provider refund-source is configured — so this ships
as a world-class design, not a half build.

## The problem
Travala/StableTravel bookings cancel. Our `refund/route.ts` is SELLER-side (our agent
refunds ITS buyer). For a BUYER-side cancellation — money returning FROM an external
provider TO our agent's wallet — there is no ledger path (`proven`: `reserveAwareSpentTodayUsd`
counts only `direction==='spend'`). A settled $1000 travel spend stays `settled`: it keeps
counting against the rolling daily cap, counts in standing as a completed spend, and the
returned USDC is invisible to the economy. For a cancellable lane that is a day-one
accounting hole.

## The load-bearing invariant (the thing that gets copied)
**A budget-INCREASING operation must be at least as UNFORGEABLE as the spend it reverses.**
A spend is unforgeable: real USDC leaves the wallet on-chain. So a refund credit must be
unforgeable: real USDC returns to the wallet, verified, from the right source. The agent's
word NEVER credits budget. This is the F2 principle (budget-increasing = unforgeable)
applied to the reverse direction. Without it, a compromised agent reports fake refunds →
frees its daily budget → spends more.

## Two external gates (why not tonight)
1. **Migration (Rule 56, Cooper-applied).** `frontier_transactions.direction CHECK
   (direction IN ('earn','spend'))` must gain `'refund_in'`. Staged in `pending_migrations/`,
   applied, then git-mv to `migrations/`.
2. **Provider refund-source address (toolrouter contract).** The unforgeable attribution
   anchor: a refund only credits if the on-chain inbound USDC is FROM an allow-listed
   StableTravel/Travala settlement address. **Fail-closed**: until `FRONTIER_REFUND_SOURCE_ADDRESSES`
   is configured, NO refund credits (we never credit an unverifiable refund). Surfaced to
   toolrouter: provide the source address(es).

## Architecture — double-entry, never mutate
A refund is a NEW `frontier_transactions` row (never touch the original spend — settle is
amount-immutable, the audit trail is sacred):
- `direction='refund_in'`, `status='settled'`, `amount_usdc=Y` (the refunded amount),
  its OWN `request_id` (e.g. `refund:<tx_hash>` — the spend's request_id is taken by the
  UNIQUE(vm_id,request_id)), `metadata.refunds_request_id=R`, `metadata.refund_tx_hash=H`.

**Netting** (the one change to the gate's core read — byte-identical when no refunds):
```
reserveAwareSpentTodayUsd = max(0,
    sum(spend committed in window) - sum(refund_in settled in window))
```
The `max(0, …)` is load-bearing for the window-race edge case (below). When there are no
refund_in rows the inner sum is 0 → identical to today (prove byte-identical in the test).

**The verified inbound endpoint** `POST /api/agent-economy/refund-inbound`
(gateway-token authed, but the trust is the verification, not the caller):
body `{ request_id: R, refund_tx_hash: H }`. Steps:
1. Load the original spend (vm_id from token, request_id R). Must exist, `direction='spend'`,
   `status='settled'`, on THIS vm (scope by token — never credit another VM).
2. Verify H on Base: a CONFIRMED USDC `Transfer` of amount Y, TO the vm's `bankr_evm_address`,
   FROM an address in `FRONTIER_REFUND_SOURCE_ADDRESSES` (the attribution anchor). Fail-closed
   if the allow-list is empty.
3. Idempotent on H (and on `request_id=refund:H`): a replay / double-cancellation credits once.
4. Cumulative guard: `sum(existing refund_in for R) + Y <= original.amount_usdc` — can never
   refund more than was spent.
5. Insert the `refund_in` row. Done — the netting picks it up on the next gate read.

## Edge cases (each must have a test before this ships)
- **Partial refund** (Y < X, Travala keeps a fee): one refund_in row, amount Y. Multiple
  partials: each its own H; the cumulative guard keeps `sum <= X`.
- **Double-cancellation / webhook replay**: idempotent on H → exactly one credit.
- **Race with the 24h window**: spend at T0, refund at T0+23h → both in window → net 0. At
  T0+25h the spend aged out (sum(spend)=0) but the refund is still in window → inner sum
  goes negative → `max(0, …)` clamps to 0. The budget was already freed when the spend aged
  out; the clamp prevents the refund from double-freeing. (Test: spend out-of-window +
  refund in-window → spentToday clamps to 0, never negative.)
- **Refund before settle**: only `status='settled'` spends are refundable. A pending hold
  self-expires (HOLD_TTL) or settles `failed` — nothing was paid, nothing to refund. Reject.
- **Over-refund** (Y > X): reject (cumulative guard). A cancellation can't return more than paid.
- **Refund for a spend on another VM**: the endpoint scopes by the token's vm_id; R must be
  this vm's spend. Cross-VM credit impossible.
- **Forged refund** (the attack): agent points at an unrelated inbound USDC. Closed by the
  FROM-allow-listed-source check (step 2). Without the source list (fail-closed) nothing
  credits. (Residual without the source list, if we ever ran source-less: bounded by the
  agent's own settled spends × on-chain-real inbound — never built that way; fail-closed.)

## Standing reconciliation (fast-follow, not v1)
A cancelled booking shouldn't count as a completed transaction for the reputation
diversity/reliability factors. v1 nets the DAILY CAP (the money governor); the standing
netting is a tracked follow-up (smaller inaccuracy, separate pass).

## Toolrouter contract
1. Provide the StableTravel/Travala refund-source address(es) → `FRONTIER_REFUND_SOURCE_ADDRESSES`.
2. On a cancellation, the wrapper calls `POST /api/agent-economy/refund-inbound { request_id, refund_tx_hash }`
   once the refund lands on-chain (the agent/wrapper sees the inbound transfer + its hash).
3. Until (1), the endpoint is fail-closed (no credits) — correct: we don't credit unverifiable money-back.

## Build order when unblocked
1. Migration (`refund_in` direction) → pending_migrations → Cooper applies → migrations.
2. Netting in `reserveAwareSpentTodayUsd` + the `max(0,…)` clamp + byte-identical test (no-refund case).
3. The verified endpoint + middleware allow-list (Rule 13) + on-chain verification + idempotency + cumulative guard.
4. The edge-case matrix (each bullet above) + a decision-level live-probe (a real refund tx → credit → spentToday nets).
5. Wire the source-address env + announce the contract to toolrouter.
