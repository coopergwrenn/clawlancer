# INC-20260602: 35-day silent credit_pack webhook failure due to RPC overload ambiguity

## Severity & scope

**P0** — 6 paying customers, $90 of paid credits not delivered, 35-day window.

7 orphan credit-pack purchases between 2026-04-29 and 2026-06-02. Discovered via customer report (Robbie Rhead, lagomera.boy@googlemail.com) the day after he paid $35 for credits that never appeared. Audit then surfaced 5 prior affected customers who had not reported.

Affected (all paid, all backfilled 2026-06-02 12:14-12:20 UTC):

| Date | User | Credits | Amount |
|---|---|---|---|
| 2026-04-29 | TJ Borriello (tjborriello@gmail.com) | 100 | $10 (2 purchases) |
| 2026-05-10 | Mateo Sauton (sautonmateo@gmail.com) | 500 | $30 |
| 2026-05-11 | Brian Liao (blianriao@gmail.com) | 500 | $30 |
| 2026-05-17 | Zeus Collegiate (zeuscollegiate@gmail.com) | 50 | $5 |
| 2026-05-20 | Driven By Dreams (jongerenwerkforum@gmail.com) | 100 | $10 (2 purchases) |
| 2026-06-02 | Robbie Rhead (lagomera.boy@googlemail.com) | 550 | $35 (2 purchases — the report) |

## Timeline (UTC)

- **2026-03-26**: Migration `20260326_add_credits_source_param.sql` authored. Intent: add an optional `p_source TEXT DEFAULT 'stripe'` parameter to `instaclaw_add_credits` for cleaner ledger-source attribution. Uses `CREATE OR REPLACE FUNCTION`, but because the signature changed (different argument list), PostgreSQL does NOT replace — it creates a SECOND overload.
- **2026-04-28**: Migration applied to production (inferred — ledger inserts via the 3-param signature stop after this date). On the same day, a recovery script backfills earlier orphans (`source='admin_manual_recovery_orphan_credits'`, 7 rows + `admin_orphan_resend_guard` 24 zero-amount audit rows). The "Recovered manually 2026-04-28" comment in `app/api/billing/webhook/route.ts:74` refers to this batch.
- **2026-04-28 → 2026-06-02**: Every single message/media credit-pack purchase silently fails. Stripe delivers the `checkout.session.completed` webhook → handler succeeds at the `instaclaw_credit_purchases` insert (idempotency row) → calls `instaclaw_add_credits` RPC with 3 args → PostgREST returns `PGRST203` because BOTH the legacy 3-param and the new 4-param overload match → handler throws → 500 → Stripe retries the same broken call indefinitely → after ~3 days Stripe gives up. Each subsequent retry re-enters the orphan-recovery branch which probes the ledger (empty), tries the same RPC, fails again. No alert because the handler's `logger.error` doesn't trigger an admin email (only the missing-metadata path does).
- **2026-06-02 07:42-07:45 UTC**: Robbie buys $30 + $5 credit packs. Both fail silently. Robbie reports to Cooper "I paid for credits but they haven't appeared."
- **2026-06-02 12:00-12:25 UTC**: Investigation, root-cause, fix.

## Root cause

`CREATE OR REPLACE FUNCTION` in PostgreSQL only replaces the existing function if the parameter list is **identical**. Adding any parameter — even with a `DEFAULT` value — creates a new overload. PostgreSQL then has TWO functions named `instaclaw_add_credits` in `pg_proc`:

1. `instaclaw_add_credits(p_vm_id uuid, p_credits integer, p_reference_id text)` (from `20260323_credit_ledger.sql`)
2. `instaclaw_add_credits(p_vm_id uuid, p_credits integer, p_reference_id text, p_source text DEFAULT 'stripe')` (from `20260326_add_credits_source_param.sql`)

PostgREST's RPC router sees both as candidates for any 3-argument call (since `p_source` has a default). It refuses to pick and returns `PGRST203`:

> `Could not choose the best candidate function between: public.instaclaw_add_credits(p_vm_id => uuid, p_credits => integer, p_reference_id => text), public.instaclaw_add_credits(p_vm_id => uuid, p_credits => integer, p_reference_id => text, p_source => text)`

The error is deterministic — verified by 3 direct invocations 2026-06-02 12:10 UTC.

**Why other RPC callers were unaffected**: `app/api/vm/assign/route.ts`, `app/api/cron/poll-delegation-confirmations/route.ts`, and `app/api/integrations/bankr/webhook/route.ts` all pass `p_source` explicitly — making them 4-argument calls. The 4-argument signature uniquely matches the 4-param function. No ambiguity. Only `app/api/billing/webhook/route.ts:245-249` omitted `p_source`. WLD-initial credits, delegation top-ups, and Bankr trading-fee credits all worked normally throughout the 35-day window.

## Fix

Three coordinated changes:

1. **Backfill (manual, 2026-06-02 12:14-12:20 UTC)** — applied credits to all 9 orphan VMs via direct 4-param RPC calls. credit_balance correctly incremented; ledger rows correctly created with `source='stripe'` and the original `reference_id=<payment_intent>`. Verified post-state for all 9 PIs.

2. **Migration `20260602120000_drop_instaclaw_add_credits_legacy_overload.sql`** — `DROP FUNCTION IF EXISTS public.instaclaw_add_credits(uuid, integer, text)`. After applying, only the 4-param version remains. 3-arg calls (legacy) resolve cleanly to it via the `p_source` default. Sits in `pending_migrations/` until Cooper applies via Supabase Studio (Rule 56), then `git mv` to `migrations/`.

3. **`app/api/billing/webhook/route.ts`** — explicitly passes `p_source: "stripe"` in the RPC call. Defense-in-depth: works WITHOUT the migration (4-arg call uniquely matches the 4-param function); works WITH the migration (only signature remaining). Future re-introduction of any overload cannot regress this code path.

## Verification

- `instaclaw_credit_ledger` now has rows for all 9 historical orphan PIs with correct amounts + reference_ids.
- All 6 affected VMs' `credit_balance` is increased by the owed amount.
- Direct 4-param RPC call (mirroring the patched webhook) succeeds: gets past PostgREST resolution and only fails on the synthetic-zero vm_id with FK 23503 (proof the function ran).
- TypeScript typecheck clean.
- 5 of 7 older orphan events are still showing Stripe `pending_webhooks=1`. After the code change deploys, the next retry will enter the duplicate-PI dedup branch, find the existing ledger row (added today), and return 200 cleanly. The 2 oldest events (April 29) have already passed Stripe's 3-day retry window and will not retry — but their credits are already applied.

## Blast radius

- 6 customers, $90 directly impacted.
- Detection lag: 35 days (April 28 → June 2). Reported by customer, not by alerting.
- Resolution: ~25 minutes from report to all-credits-applied (Robbie was made whole within 5 minutes of receiving the report).

## Prevention

**Migration discipline:**
- Any future migration adding/removing a function parameter must `DROP FUNCTION IF EXISTS <name>(<old_signature>)` BEFORE the `CREATE OR REPLACE FUNCTION`. `CREATE OR REPLACE` does not handle signature changes — this is a known PostgreSQL behavior.
- Optional follow-up: a CI gate that flags any migration containing `CREATE OR REPLACE FUNCTION` for a function name that already exists in earlier migrations with a DIFFERENT parameter list. (Wishlist; mechanical check is non-trivial without parsing SQL.)

**Detection:**
- Optional follow-up: alert when `instaclaw_credit_purchases` has rows with no matching `instaclaw_credit_ledger` entry for >5 minutes. Would have detected this within minutes of the first orphan instead of 35 days. P1.
- Optional follow-up: surface Stripe's `pending_webhooks > 0` count on a dashboard; sustained non-zero pending across days is a strong signal that a webhook is silently failing. P1.

**Code:**
- All RPC callsites already use the explicit-`p_source` pattern except this one. Existing convention was right; webhook handler was missed. The fix brings it into the canonical shape.

## Related rules

- **Rule 10** (verify every config set; never `|| true`-suppress): the handler did correctly throw on the RPC error — but because Stripe's retry-on-500 is the only consumer of that error, and the error was permanent rather than transient, retries achieved nothing. The "verify" discipline alone doesn't help when the verifier always reports broken-the-same-way.
- **Rule 49** (partner secrets actively verified): same family of bug — "if no one ever exercises a code path proactively, it can be broken for arbitrary amounts of time with no signal." The credit-pack webhook had no canary, no synthetic exercise, no end-to-end probe. Adding one is the most durable fix for this class.
- **Rule 56** (migration files must be self-contained): the migration that introduced the overload was not itself wrong per Rule 56 — it WAS self-contained — but its assumption that `CREATE OR REPLACE FUNCTION` replaces an existing function with a different signature was wrong. A note belongs in Rule 56 (or a new rule) flagging this specific PostgreSQL behavior.

## Lessons

1. **`CREATE OR REPLACE FUNCTION` does not replace function signatures.** Adding `DEFAULT`-valued parameters silently creates an overload. Always `DROP FUNCTION IF EXISTS` first when changing a parameter list.
2. **An RPC error that's permanent and deterministic looks identical to a flaky one in the handler's eyes.** Stripe's retry-on-500 contract is a wonderful safety net for transient errors. It is a permanent loop with no exit for deterministic errors. The handler needs no change here, but the operator-facing signal must come from somewhere else (purchase-without-ledger alert).
3. **No customer complained for 35 days because most users who bought credit packs assumed the credits "must be applied" and just kept using their agent.** The agent kept working in many cases (subscription tier covers baseline usage). Trust degradation was slow and silent. The customer who complained (Robbie) had bought a large pack RIGHT after onboarding and was watching his dashboard; that's the only reason this got reported.

## Forensic evidence

- Pre-fix Stripe events: `evt_1TdmxoCsyFRN0uBDvmap9NRQ` ($30) and `evt_1Tdn0BCsyFRN0uBDK3iK7RAP` ($5), both `pending_webhooks=1` at investigation time.
- Pre-fix DB state: `instaclaw_credit_purchases` had both rows for Robbie; `instaclaw_credit_ledger` had none for either PI.
- RPC error captured: `{"code":"PGRST203","message":"Could not choose the best candidate function between: public.instaclaw_add_credits(p_vm_id => uuid, p_credits => integer, p_reference_id => text), public.instaclaw_add_credits(p_vm_id => uuid, p_credits => integer, p_reference_id => text, p_source => text)"}`.
- All 9 orphan backfill ledger rows have `created_at` between `2026-06-02T12:14:43` and `2026-06-02T12:20:19`, `source='stripe'`, `reference_id` matching original Stripe payment_intent.
