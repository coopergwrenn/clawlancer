# Frontier Spend — Incident Response Runbook

For the operator at 2am with an agent spending money it shouldn't. Every scenario is
executable top-to-bottom in that state: paste the query, read the result, follow the
branch, paste the remediation. Where a step needs judgment, the decision rule is
written here — do not re-derive it during the incident.

**Connection.** Supabase SQL Editor (Studio) against prod, OR via the service-role key
(`SUPABASE_SERVICE_ROLE_KEY` in `instaclaw/.env.local`). All queries are plain SQL.
Every query and every kill-switch statement below was run against a scratch replica of
the shipped DDL and/or live prod on 2026-06-11 — the example outputs are real.

---

## THE TRUST LADDER (read this once, it governs everything below)

The spend rail is **non-custodial**. The agent signs and broadcasts its own USDC
payment with its own Bankr wallet; the platform never holds the money. So our tables
record **decisions and self-reports, not money**:

| Source | What it actually tells you | Can it lie? |
|---|---|---|
| `frontier_spend_events` | what we **decided** (allow/deny/ask) + the budget snapshot at decision time | Yes — best-effort log; a write can silently fail (→ S7) |
| `frontier_transactions` | what the agent **told us** it did (a hold it reserved, a settle it reported) | Yes — the agent self-reports settle; it can pay on-chain and never call /settle, or report a different amount |
| **Base mainnet (basescan)** | what **actually moved** from the wallet | No — this is ground truth |

**At 2am: the DB tells you what we authorized and what we were told. Only the chain
tells you what an agent actually spent.** When the numbers don't add up, basescan wins
(S3). When the DB is suspiciously empty, suspect the logger before you conclude
"nothing happened" (S7).

---

## 30-SECOND TRIAGE — what am I looking at?

| Your symptom | Go to |
|---|---|
| "Agent X spent $Y and I don't know why" | **S1** (trace) → if the DB total ≠ the chain, **S3** |
| Kill switch is ON but spends are still completing | **S2** |
| Spend on-chain but our ledger shows nothing / less | **S3** |
| Alert: "[P1] Frontier spend rail BLIND" / denial flood | **S4** |
| A revoke didn't stop a spend | **S5** |
| A refund was promised to a user but never landed | **S6** |
| The trace query returns nothing but money clearly moved | **S7** |
| Same spend authorized twice (double-charge) | **S8** |
| Coverage script flagged armed-non-assigned / stuck-pending | **S9** |
| I just need it to STOP, now | **§0 — STOP THE BLEEDING** |

Severity default: a **paying customer losing money they didn't authorize is P0** — engage
the kill switch first (§0), diagnose second. A *denied* spend (agent can't pay) is at
most P1 — money is safe; you have time to read.

---

## §0 — STOP THE BLEEDING (do this before diagnosing a P0)

There are two levers. Reach for them in this order.

### Lever 1 — the kill switch (instant, fleet-wide, reversible)

Engaging `frontier_spend_kill_switch` makes `/api/agent-economy/authorize` deny **every**
spend on **every** VM on the next call — no deploy, no restart. It's read live per
request and fails CLOSED, so it cannot be bypassed by a transient blip (Tier-0 F).

**Decision rule — engage when:** you have ≥1 confirmed unauthorized spend, OR a supplier
has turned malicious, OR you can't yet tell how many agents are affected. The cost of
engaging is bounded and reversible (every armed agent is denied for as long as it's on;
they retry and succeed once you release). The cost of NOT engaging during a real
incident is unbounded. **When unsure, engage.**

**ENGAGE the frontier spend kill switch** (upsert — works whether the row exists or not;
in prod the row exists with `bool_value=false`):
```sql
INSERT INTO instaclaw_admin_settings (setting_key, bool_value, notes)
VALUES ('frontier_spend_kill_switch', true, 'IR: <why> — <who>, <when>')
ON CONFLICT (setting_key) DO UPDATE SET bool_value = true, updated_at = now(), notes = EXCLUDED.notes;
```

**Blast radius of engaging:** every VM with `frontier_spend_enabled=true` (run the count
below) is denied with `reason=spend_kill_switch` on its next authorize. The agent sees a
"spend temporarily unavailable" outcome and asks the user. **It does NOT stop bookings
already paid, does NOT reverse in-flight on-chain payments, and does NOT disable the
travala booking path** (that's a separate switch — engage it too if hotels are the
vector). Who's affected right now:
```sql
SELECT count(*) AS armed_agents_denied FROM instaclaw_vms WHERE frontier_spend_enabled = true;
```

**RELEASE the frontier spend kill switch** (after the incident is contained):
```sql
UPDATE instaclaw_admin_settings SET bool_value = false, updated_at = now()
WHERE setting_key = 'frontier_spend_kill_switch';
```

**The travala booking kill switch** (the hotel-booking money path — a SEPARATE rail; a
booking also passes the frontier gate, so engaging frontier already blocks new bookings'
pay leg, but this stops the booking flow earlier and explicitly):
```sql
-- ENGAGE (the row does NOT exist in prod yet → upsert creates it):
INSERT INTO instaclaw_admin_settings (setting_key, bool_value, notes)
VALUES ('travala_booking_kill_switch', true, 'IR: <why> — <who>, <when>')
ON CONFLICT (setting_key) DO UPDATE SET bool_value = true, updated_at = now(), notes = EXCLUDED.notes;

-- RELEASE (note: if the row was never created, this UPDATE affects 0 rows —
-- that's correct, absent = not engaged):
UPDATE instaclaw_admin_settings SET bool_value = false, updated_at = now()
WHERE setting_key = 'travala_booking_kill_switch';
```

Confirm current state of both before AND after any change (prove the WHERE found the row):
```sql
SELECT setting_key, bool_value, updated_at, notes
FROM instaclaw_admin_settings
WHERE setting_key IN ('frontier_spend_kill_switch','travala_booking_kill_switch');
```
Live prod example (2026-06-11) — frontier present+false, travala absent:
```
         setting_key        | bool_value |          updated_at           |  notes
----------------------------+------------+-------------------------------+-----------
 frontier_spend_kill_switch | f          | 2026-06-03 15:23:40.238784+00 | live-test
(1 row)   ← travala row not present; engage will create it
```

### Lever 2 — mass-disarm (nuclear; per-VM opt-in, NOT instantly reversible)

The kill switch is the right tool 99% of the time. Mass-disarm flips every agent's
opt-in off — re-enabling requires each USER to opt back in from their dashboard (an
agent cannot re-arm itself, by design). Use ONLY if the kill switch is somehow
unavailable and you must hard-stop. **Snapshot the armed list first or you can't tell
users who to re-enable:**
```sql
-- SNAPSHOT (copy this output somewhere before disarming):
SELECT id, name FROM instaclaw_vms WHERE frontier_spend_enabled = true ORDER BY name;

-- DISARM (only after snapshotting):
UPDATE instaclaw_vms SET frontier_spend_enabled = false WHERE frontier_spend_enabled = true;
```

---

## S1 — Trace an unexpected spend ("agent X spent $Y, why?")

**You are here if:** a user (or you) saw a spend you can't explain and want the full
decision chain.

**Detection — recent decisions for the VM** (find the request_id):
```sql
SELECT created_at, decision_point, verdict, gate, reason, amount_usd, category, counterparty, request_id
FROM frontier_spend_events
WHERE vm_id = '<VM_UUID>' AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC LIMIT 50;
```
Example output (rig):
```
       created_at      | decision_point |    verdict     |     gate      |        reason        | amount_usd | category | counterparty |  request_id
-----------------------+----------------+----------------+---------------+----------------------+------------+----------+--------------+-------------
 17:12:29 | settle    | settle_success | other         | settle_success       |   4.20     |          |              | req-trace-1
 17:10:29 | authorize | allow          | earned_budget | within_earned_budget |   4.20     | data     | 0xSupplier1  | req-trace-1
```

**Then — the full chain for that request_id** (the marquee query; authorize + settle on
one spend, with the budget state at decision time):
```sql
SELECT created_at, decision_point, verdict, gate, reason,
       amount_usd, category, counterparty, consent_grade, mode,
       standing_score, earned_daily_budget_usd, spent_today_usd, remaining_earned_after_usd,
       wallet_balance_usd, just_do_it_per_tx_usd, tx_hash, latency_ms, pay_error, transaction_id
FROM frontier_spend_events
WHERE request_id = '<REQUEST_ID>'
ORDER BY created_at;
```

**Read it like this:**
- `verdict=allow` + `gate=earned_budget` / `reason=within_earned_budget` → the agent had
  **earned** the autonomy; `earned_daily_budget_usd` / `remaining_earned_after_usd` show
  the budget it spent against. This was a legitimate autonomous spend.
- `consent_grade=session` → the **human approved it in-browser**. Not unauthorized.
- `consent_grade=forgeable` (`reason=human_approved`) → authorized on the raw
  `human_approved` bool, which a compromised agent can set. **Suspicious if the user
  says they didn't approve** — the agent may be compromised; engage §0 and check S3.
- `consent_grade=autonomous` for an amount the user calls unexpected → the agent spent
  within its earned band but the user didn't expect it. Product/expectation issue, not a
  breach — but confirm the chain math (does `spent_today + amount ≤ earned_budget`?).
- `tx_hash` present on the settle row → **take it to basescan** and confirm the on-chain
  amount + recipient match `amount_usd` + `counterparty`. If they don't match → S3.

**If this query returns NOTHING but money moved → S7 (the logger may be down) AND S3
(reconcile against the chain).**

**Blast radius of remediation:** tracing is read-only. If you conclude the agent is
compromised, the remediation is §0 (kill switch) — blast radius there.

---

## S2 — Kill switch engaged, spends still completing (the impossible state)

**You are here if:** `frontier_spend_kill_switch=true` but agents are still spending.

**Detection — allows recorded AFTER the switch was engaged:**
```sql
SELECT e.created_at, e.vm_id, e.amount_usd, e.request_id
FROM frontier_spend_events e
JOIN instaclaw_admin_settings s ON s.setting_key = 'frontier_spend_kill_switch'
WHERE s.bool_value = true
  AND e.decision_point = 'authorize' AND e.verdict = 'allow'
  AND e.created_at > s.updated_at
ORDER BY e.created_at DESC;
```
Any rows = real allows minted after the brake was on. This should be empty.

**Escalation ladder (work top to bottom; stop when it explains the rows):**
1. **Clock/skew sanity.** Is `s.updated_at` actually before the allows? If you *just*
   engaged, the first 1-2 in-flight requests already past the kill-check can still mint a
   hold — that's a sub-second window, not a breach. Re-run in 60s; if it stops, it was the
   in-flight window.
2. **Is the value really true?** `SELECT bool_value, updated_at FROM instaclaw_admin_settings WHERE setting_key='frontier_spend_kill_switch';`
   — if a concurrent RELEASE flipped it back, that's your "leak." Re-engage.
3. **Settles ≠ new authorizes.** A `settle` event after engage is NOT a new spend — it's
   the pay-completion of a hold authorized *before* the brake. The switch stops new
   authorizations, not the settling of already-authorized holds. Filter to
   `decision_point='authorize'` (the query above already does). If the leaked rows are all
   settles, this is expected; the holds were authorized pre-engage. To stop those too,
   you'd revoke each VM (S5) — but the money for a settling hold may already be in flight.
4. **The verdict log is lying (S7).** If allows are genuinely being minted with the
   switch on, the authorize gate's kill-check is being bypassed — but far more likely the
   gate is fine and the *log* is mis-recording. Confirm against `frontier_transactions`:
   `SELECT count(*) FROM frontier_transactions WHERE vm_id='<VM>' AND status='pending' AND created_at > '<engage_time>';` — if there are NEW pending holds, the gate really is leaking; if not, it's a logging artifact.
5. **Genuine gate bypass** (gate leaking despite the switch): this is a code regression in
   `authorize/route.ts`'s kill-check. Lever 2 (mass-disarm) is your hard stop while you
   ship a fix. P0, page whoever owns the gate.

**Blast radius:** read-only until you reach step 5; then Lever 2 (mass-disarm) — see §0.

---

## S3 — Rail-vs-ledger mismatch (the agent went around us)

**You are here if:** the DB looks clean (or under-counts) but the wallet clearly spent
more. **This is the one the non-custodial rail makes possible and the one most likely to
catch you out:** the agent pays from its own Bankr wallet; if it pays without calling
`/settle`, or pays a different amount than it authorized, our DB never sees it.

**Detection — what our ledger thinks the VM spent (24h):**
```sql
SELECT t.vm_id, v.name, v.bankr_evm_address,
       count(*) AS settled_spends, sum(t.amount_usdc) AS rail_total_usdc
FROM frontier_transactions t JOIN instaclaw_vms v ON v.id = t.vm_id
WHERE t.direction = 'spend' AND t.status = 'settled' AND t.settled_at > now() - interval '24 hours'
GROUP BY 1, 2, 3;
```
Example (rig):
```
       name       | bankr_evm_address | settled_spends | rail_total_usdc
------------------+-------------------+----------------+-----------------
 instaclaw-vm-900 | 0xRogueWallet     |       2        |     4.95
```

**Then — the ground truth.** Take `bankr_evm_address` to
`https://basescan.org/address/<ADDRESS>` → "Token Transfers (ERC-20)" → filter USDC
outbound in the same window. **Sum the on-chain USDC out and compare to `rail_total_usdc`.**

**Diagnosis branches:**
- **on-chain == ledger** → the agent used the rail honestly. The spends are real and were
  decided through our gate; go back to S1 to see *why* each was authorized.
- **on-chain > ledger** → the agent paid on-chain for spends it never settled (or never
  authorized) through us. The rail did NOT authorize this money. **P0, breach-class.**
  Engage §0 immediately (stops *future* authorizations, but this agent isn't using our
  authorize path — so also Lever 2 / freeze the VM). The gap = on-chain minus ledger = the
  unauthorized amount. There is no clawback (money's gone); the job now is contain +
  notify the user + investigate how the agent got an un-gated payment path.
- **on-chain < ledger** → we recorded settles that didn't move money (agent reported
  success without paying, or a double-record). Less dangerous (no money lost) but the
  ledger is wrong; cross-check the specific `tx_hash`es on the settle rows — a settle row
  with a `tx_hash` that doesn't exist on basescan is a fabricated settle.

**Blast radius of remediation:** §0 kill switch stops future authorize-path spends but
NOT an agent that's bypassing the rail — for that, freeze the VM (stop the gateway) so the
agent can't run at all. That's the only thing that stops a rail-bypassing agent.

---

## S4 — Unverifiable denials spiking (the DB is sick)

**You are here if:** the alert `[P1] Frontier spend rail BLIND` fired, or every agent is
suddenly being denied. `spend_kill_switch_unverifiable` means the gate tried to read the
kill switch, failed even after a retry, and **failed CLOSED** — money is safe, the rail is
down.

**Detection — count in the alerting window:**
```sql
SELECT count(*) AS unverifiable_15m, min(created_at) AS first_seen, max(created_at) AS last_seen
FROM frontier_spend_events
WHERE reason = 'spend_kill_switch_unverifiable' AND created_at > now() - interval '15 minutes';
```
Example (rig, 4 seeded): `unverifiable_15m = 4`. Live prod (healthy): `0`.

**Threshold judgment (decided now, don't deliberate at 2am):**
- **1–2 in 15 min** → a transient blip the retry didn't catch. Note it, don't act. If it
  doesn't recur next window, it's noise.
- **≥3 in 15 min, OR any with `last_seen` within the last 2 min and rising** → the DB /
  Supabase is genuinely unhealthy. **Act.** This isn't a spend incident — it's a database
  incident wearing a spend costume. Spends are being *correctly* denied; your job is to
  fix Supabase, not the rail.

**Diagnosis:** the gate reads `instaclaw_admin_settings`. Confirm the table is reachable:
```sql
SELECT bool_value FROM instaclaw_admin_settings WHERE setting_key = 'frontier_spend_kill_switch';
```
- Query hangs / errors → Supabase/Postgres is down or overloaded → standard DB incident
  (check Supabase status, connection pool, recent migrations). The spend denials will stop
  on their own the moment the DB recovers — **no spend-side action needed**.
- Query returns instantly → the per-request failures were transient and have passed;
  confirm the count stopped climbing.

**Remediation:** fix the DB. The rail self-heals (next successful read → `clear` → spends
resume). Do NOT "work around" the denials — failing closed is correct.

**The alert itself:** fired by `authorize/route.ts` via `sendPerVmAlertDeduped` with key
`frontier_kill_switch_unverifiable`, deduped 1h (fleet-level, so a fleet-wide DB sickness
sends one email, not one-per-VM). The dedup query fails-open, so the alert works even
during the DB sickness it reports.

**Blast radius:** none from you — this scenario is read-only on the spend side; the fix is
in the DB layer.

---

## S5 — Revoke didn't interdict (verify your own G mechanism)

**You are here if:** a user revoked an agent's spend authority but a spend went through
anyway, OR you want to confirm a revoke actually cancelled the in-flight holds.

**Detection — what the revoke interdicted (one row per cancelled hold):**
```sql
SELECT created_at, transaction_id, amount_usd
FROM frontier_spend_events
WHERE vm_id = '<VM_UUID>' AND reason = 'revoked_in_flight'
ORDER BY created_at DESC;
```
Each row = a `pending` hold the revoke flipped to `revoked` (it can no longer settle).

**Invariant — nothing should be pending after a revoke** (the future-gate also stops new
holds, so this should be 0):
```sql
SELECT count(*) AS still_pending FROM frontier_transactions
WHERE vm_id = '<VM_UUID>' AND direction = 'spend' AND status = 'pending';
```
- `0` → interdiction is complete; any spend the user saw "go through" settled BEFORE the
  revoke landed (legitimate — it was authorized and paid before they revoked). Confirm via
  S1: the settle's `created_at` should be before the revoke.
- `>0` → in-flight holds were NOT interdicted. Either the revoke route's interdiction
  UPDATE failed (check logs for `revoke-spend: interdiction update failed`), or the
  `'revoked'` enum wasn't applied (it was, 2026-06-11). Manually interdict:
  ```sql
  UPDATE frontier_transactions SET status = 'revoked'
  WHERE vm_id = '<VM_UUID>' AND direction = 'spend' AND status = 'pending';
  ```

**The paid gap — the case that needs a human** (the agent PAID on-chain, then the human
revoked before settle: money left, the hold can't settle):
```sql
SELECT created_at, vm_id, transaction_id, amount_usd, tx_hash
FROM frontier_spend_events
WHERE reason = 'settle_on_revoked_hold' AND tx_hash IS NOT NULL
  AND created_at > now() - interval '7 days'
ORDER BY created_at DESC;
```
Example (rig): one row, `tx_hash=0xpaidanyway99`, $3.50. **Each row is a manual reconcile:**
- The `tx_hash` is real money that left the agent's wallet for a spend the user revoked.
- **There is no clawback** — the payment is on-chain and final. The user revoked *after*
  the agent committed the payment; the revoke stopped the *ledger* from recording it as
  settled but couldn't stop the chain.
- **Action:** confirm the `tx_hash` on basescan (amount + recipient). Then this is a
  customer-service reconcile — the agent bought the thing; decide with the user whether
  they keep it or you make them whole out-of-band. Note the transaction_id + tx_hash in the
  incident record. (This window is narrow by design — most revokes hit holds the agent
  hadn't paid yet; this query is the exception list.)

**Blast radius of the manual UPDATE:** it only flips `pending`→`revoked`, which (per the
reader-safety audit) frees the reserved budget and removes the hold from the settle path —
it touches no money and can't un-pay anything.

---

## S6 — Refund didn't reconcile (the value trail)

**You are here if:** a user was told a refund was coming and it didn't arrive.

A refund has two steps: (1) `/refund` flips the seller's txn to `status='refunded'` and
(2) inserts a `frontier_settlement_retry_queue` row (`action='refund'`, `status='queued'`)
that an on-chain executor drains. **Important: there is no automated refund executor
wired yet — a queued refund is OWED but will sit until executed.** The two failure modes:

**A — queued but never executed (the common case — no executor):**
```sql
SELECT q.id, q.transaction_id, q.status, q.attempts, q.created_at, t.vm_id, t.amount_usdc
FROM frontier_settlement_retry_queue q
JOIN frontier_transactions t ON t.id = q.transaction_id
WHERE q.action = 'refund' AND q.status = 'queued'
ORDER BY q.created_at;
```
Example (rig): one row, $6.00, queued 3h. **`created_at` = how long the refund has been
owed.** Remediation: the on-chain refund must be sent manually from the platform/treasury
to the buyer's address for `amount_usdc`, then mark it done:
```sql
UPDATE frontier_settlement_retry_queue SET status = 'done', updated_at = now() WHERE id = '<QUEUE_ROW_ID>';
```
(Do NOT mark done before the on-chain send confirms, or you'll lose the trail.)

**B — orphan: flipped to refunded but never queued** (the `/refund` queue-insert failed
after the status flip — the `frontier-refund-reconcile` cron is supposed to catch these,
but verify):
```sql
SELECT t.id, t.vm_id, t.amount_usdc, t.created_at
FROM frontier_transactions t
LEFT JOIN frontier_settlement_retry_queue q ON q.transaction_id = t.id AND q.action = 'refund'
WHERE t.status = 'refunded' AND q.id IS NULL;
```
Example (rig): one orphan, $1.25. Remediation — enqueue the missing row (then handle via A):
```sql
INSERT INTO frontier_settlement_retry_queue (transaction_id, action, status)
VALUES ('<TXN_ID>', 'refund', 'queued');
```

**Blast radius:** marking a queue row `done` only changes our bookkeeping — it does not
move money (the on-chain send is the manual step). Enqueuing an orphan only adds a
to-do; it never double-pays (the reconcile cron + the executor dedup on transaction_id).

---

## S7 — The flight recorder is dead (the verdict log is lying to you)

**You are here if:** money clearly moved but `frontier_spend_events` shows little/nothing.
The verdict log is **best-effort, fail-open** (Tier-0 A, Rule 77) — if the `after()` write
fails, a decision completes with NO event row. So "no events" can mean "no spend" OR "the
logger is down." This is the meta-incident: the tool you're investigating with is broken.

**Detection — settled spends that have NO settle event** (the recorder missed a real money
event):
```sql
SELECT t.id, t.vm_id, t.settled_at, t.amount_usdc
FROM frontier_transactions t
LEFT JOIN frontier_spend_events e ON e.transaction_id = t.id AND e.decision_point = 'settle'
WHERE t.direction = 'spend' AND t.status = 'settled'
  AND t.settled_at > now() - interval '24 hours'
  AND e.id IS NULL;
```
Example (rig): one settled $0.75 with no event row.

**Diagnosis by count:**
- **0 rows** → the recorder is healthy; if a trace (S1) came back empty, the spend really
  didn't happen through our rail → go to S3 (the agent may have bypassed us).
- **A few** → occasional best-effort write failures (transient). The ledger
  (`frontier_transactions`) is still authoritative for those; the *event log* just missed
  the decision detail. Note it; not an incident on its own.
- **Rising / many** → **the verdict log itself is the incident.** Every other query in
  this runbook is now unreliable (it can show fewer denials/allows than really happened).
  Fall back to `frontier_transactions` (the agent self-report) and basescan (truth) for the
  duration. Check: is Supabase healthy (S4)? Did a recent deploy break
  `recordSpendEvent` / drop the `frontier_spend_events` table grant? The fix is code/infra,
  not spend-side.

**Why trust `frontier_transactions` more than the event log here:** the transaction row is
written on the synchronous money path (the reserve RPC / the settle CAS), not via
best-effort `after()`. It can still be wrong vs the chain (S3), but it does not silently
drop the way the event log can.

**Blast radius:** read-only. If the log is down and you can't see decisions, treat the
whole rail as un-observable and consider §0 until observability is restored — flying blind
on a money rail is itself a reason to engage the brake.

---

## S8 — Double-allow on one request_id (atomic reserve broken)

**You are here if:** a single spend looks authorized twice, or you suspect the per-VM
reserve lock regressed. The budget gate is made atomic by the `frontier_reserve_spend`
RPC (a per-VM advisory lock). If it's missing (the route has a non-atomic fallback) or
regressed, two concurrent authorizes on the same `request_id` can both mint an `allow`.

**Detection:**
```sql
SELECT request_id, count(*) AS allows
FROM frontier_spend_events
WHERE decision_point = 'authorize' AND verdict = 'allow' AND request_id IS NOT NULL
  AND created_at > now() - interval '24 hours'
GROUP BY request_id HAVING count(*) > 1;
```
Example (rig): `req-dup-1 | 2`.

**Diagnosis:**
- Confirm it's a real double-reserve (not two log rows for one decision): check
  `frontier_transactions` for that request_id — the table has a `UNIQUE (vm_id,
  request_id)` constraint, so there should be **at most one hold** even if two allows
  logged. `SELECT id, status, amount_usdc, created_at FROM frontier_transactions WHERE request_id='<REQ>';`
  - **One hold row** → the DB constraint held; the second "allow" never created a second
    hold (the reserve RPC or the unique index caught it). The double *log* row is cosmetic
    (the second authorize hit the idempotent-replay path). Not a money incident.
  - **Two hold rows** → the unique constraint is missing/broken AND the reserve lock
    failed → genuine double-reserve → **P0**. Engage §0. The agent may have paid twice.
    Cross-check basescan for two payments (S3).

**Blast radius:** read-only diagnosis; remediation is §0 + a code fix to the reserve path.

---

## S9 — Armed-population anomalies (coverage-invariant follow-ups)

The coverage script (`scripts/_coverage-frontier.ts`) flags these; here's what to do when
one fires.

**S9a — armed on a non-assigned status** (a VM is `frontier_spend_enabled=true` but its
status isn't `assigned` — an F4-trigger leak, or a pool VM armed with no owner):
```sql
SELECT id, name, status, health_status FROM instaclaw_vms
WHERE frontier_spend_enabled = true AND status <> 'assigned';
```
Example (rig): `instaclaw-vm-902 | frozen`. **What it means:** the lifecycle trigger that
clears `frontier_spend_enabled` on ownership/terminal transitions didn't fire (or a row
was armed without an owner). A frozen/terminated VM can't actually spend (no running
gateway), but the flag is wrong and could re-arm on a thaw. **Remediation — clear it:**
```sql
UPDATE instaclaw_vms SET frontier_spend_enabled = false
WHERE frontier_spend_enabled = true AND status <> 'assigned';
```
Blast radius: only disarms VMs that shouldn't be armed; an assigned, legitimately-armed VM
is untouched (the `status <> 'assigned'` filter).

**S9b — stuck pending holds > 60 min** (a hold that reserved budget and never settled —
a crashed agent, or an authorize that never got paid):
```sql
SELECT id, vm_id, amount_usdc, created_at FROM frontier_transactions
WHERE direction = 'spend' AND status = 'pending' AND created_at < now() - interval '60 minutes';
```
**What it means:** the budget is already self-freed (the reserve math expires a pending
hold from the budget after 15 min — it stopped counting against the agent long ago), so
this is a *clean-activity-feed* issue, not a money one. **Remediation — terminalize stale
holds to `failed`** (the pay leg never completed):
```sql
UPDATE frontier_transactions SET status = 'failed'
WHERE direction = 'spend' AND status = 'pending' AND created_at < now() - interval '60 minutes';
```
Blast radius: flips abandoned holds to `failed` (a non-money terminal state); does not
touch any settled/revoked/refunded row. Do NOT do this to a hold younger than the 15-min
reserve TTL — it might still be a live in-flight spend.

**S9c — armed but no active subscription** (triage signal — an agent armed to spend whose
owner may not be paying):
```sql
SELECT v.id, v.name, v.assigned_to
FROM instaclaw_vms v
LEFT JOIN instaclaw_subscriptions s ON s.user_id = v.assigned_to AND s.status IN ('active','trialing','past_due')
WHERE v.frontier_spend_enabled = true AND s.id IS NULL;
```
**Caveat (Rule 14):** a missing active-sub row does NOT mean "not paying" — credits,
partner status, and all-inclusive tiers all count. **Do not disarm on this query alone.**
It's a list to *investigate* via the billing source of truth (`lib/billing-status.ts`);
confirm each is genuinely non-paying before any action.

---

## Appendix — fast coverage snapshot

One read for "is the spend economy healthy right now":
```bash
npx tsx scripts/_coverage-frontier.ts
```
It surfaces verification coverage, spend success rate, the armed population + the F4
invariant (S9a), stuck holds (S9b), revoke interdiction + the revoked-but-on-chain-paid
gap (S5), and refund orphans (S6) — exit code 1 if any invariant is breached.

---

*Last verified against prod + a scratch replica of the shipped DDL on 2026-06-11. If a
table/column name here doesn't match prod, the schema moved — re-verify before trusting
any query (three lanes shipped the night this was written).*
