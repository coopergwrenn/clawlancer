# Frontier — Prior-Art Follow-Ups (logged 2026-06-12)

Structural observations from the 2026-06-11 reconciliation that the PRDs didn't anticipate —
because nobody has run an agent money rail long enough to hit them. Cooper ruled these into the
work. #3 (the deepest — earned-autonomy gaming) lives verbatim in `PRD-frontier-economic-agency.md
§5 Q11`. #1 and #2 are logged here with design notes.

---

## #1 — Outstanding-liability view + aging cron — **PRIORITY, post-canary** (Cooper ruling)

**The observation.** The platform can accrue money it *owes users* faster than any human pays
it, and the only backstop today is a coverage line nobody reads at 3am. There is **no automated
refund executor** (IR runbook S6: a `frontier_settlement_retry_queue` row with `action='refund',
status='queued'` is OWED indefinitely until a human manually sends USDC). G added a *second*
owed-money class (`settle_on_revoked_hold` — a hold revoked after the agent already paid
on-chain). Plus **orphan refunds** (a txn flipped `refunded` but the queue insert failed). That's
**three scattered detections of the same liability: USDC the platform owes a user and hasn't
sent** — surfaced in three different places, with no single number and no aging alarm.

**Why it's prior-art-class.** No incumbent has this problem: Stripe/the OTAs custody the money,
so a refund is a ledger reversal they control. On a non-custodial agent rail, the platform
*promises* a refund (flips the row) but the on-chain send is a separate manual act — so the gap
between "we owe it" and "we sent it" is real, unbounded, and invisible. The day those obligations
outpace the human draining them is the day the rail is quietly insolvent-to-its-users.

**The design (the elegant fix — ~one view + one cron):**
- A single `frontier_outstanding_liabilities` view (or a coverage section) that `UNION`s:
  1. `frontier_settlement_retry_queue WHERE action='refund' AND status='queued'` — refunds promised, not sent. Aging = `now() - created_at`.
  2. `frontier_spend_events WHERE reason='settle_on_revoked_hold' AND tx_hash IS NOT NULL` not yet reconciled — revoked-but-paid holds (money left, no settle). Aging = `now() - created_at`.
  3. orphan refunds: `frontier_transactions WHERE status='refunded'` with no matching `action='refund'` queue row.
- Each row carries: vm_id, owner_id, amount, the liability class, and the age.
- An aging cron (e.g. `/api/cron/frontier-liability-watch`, hourly, 6h-deduped per the alert pattern) that emails when the **total owed** crosses a floor OR any single row ages past a threshold (e.g. >24h owed). The 2am question "how much does the platform owe its users right now, and what's overdue" becomes one query, not a forensic exercise.
- **Sequencing:** post-canary (the canary doesn't create these — travala refunds as travel credits, bypassing the queue entirely). Priority once any merchant refunds in USDC, OR immediately if W12 widens the surface. Pairs naturally with building the actual refund *executor* (the thing that drains class 1) — but the *view + alarm* is the cheaper, more urgent half: you must be able to SEE the debt before you automate paying it.

---

## #2 — Settle re-checks the opt-in: revocation as a hard wall — **next-hardening** (Cooper ruling)

**The observation.** G (revoke interdiction) interdicts the *pending holds it catches* at revoke
time — correct and sufficient for the announce. The *stronger* invariant, the one that would
define the pattern, is: **nothing the agent did before a revoke can complete.** Today the
guarantee is "revoke flips the pending rows that exist at that instant." The prior-art guarantee
is "revocation is a hard wall — no spend authorized before it can cross it."

**The gap it closes.** Consider: a hold is authorized while the VM is spend-enabled; G's revoke
flips that hold to `revoked` (caught). But the settle path itself does **not** re-check the
opt-in — it only guards on `status='pending'`. So the invariant rests entirely on G having caught
every pending hold at revoke time. If a hold were created in the microscopic window *between*
revoke's flag-flip and its interdiction UPDATE (it can't today — they're sequential in one
request — but a future refactor, a retry, or a second concurrent authorize could open it), that
hold would settle despite the revoke. The hard-wall version removes the dependence on "did G
catch it": settle re-checks that the VM is still spend-enabled OR the hold provably predates the
revoke.

**The design (next-hardening, not now — G is sufficient for launch):**
- Add to the settle CAS guard: a hold may settle only if `(the VM's frontier_spend_enabled is
  still true) OR (the hold's created_at < the VM's last revoke timestamp)`. The cleanest
  encoding: stamp `instaclaw_vms.spend_revoked_at` on every revoke; settle's CAS adds
  `AND (created_at < spend_revoked_at IS NOT TRUE)` — i.e., a hold authorized before the most
  recent revoke cannot settle even if G somehow missed it.
- This is a money-path edit to the settle CAS (the hot path G deliberately avoided touching), so
  it carries the full rule-10/rule-77 discipline: verify-after, fail-closed, a failure-mode test
  proving a post-revoke settle is rejected. **Defer until after the canary** (it changes the very
  CAS the canary exercises); land it as a deliberate next-hardening pass with its own canary
  re-probe.

---

## #3 — (logged verbatim in the PRD, restated here for the index)

**How does earned autonomy resist an agent gaming its own track record?** On a non-custodial
rail the settle outcome is the agent's own word; `tx_hash` proves money moved, never that the
purchase was useful. An agent can climb the autonomy ladder on self-reported success. The
anti-wash-trade weighting stops sybil, not self-lying. The only corrective (disputes) is the
PRD's own admitted biggest gap. **There are no incumbents to copy — whatever we choose becomes
the prior art.** Full text + candidate directions: `PRD-frontier-economic-agency.md §5 Q11`. Must
be answered before earned-autonomy is the public-announce headline or before W12 widens the
gameable surface to the fleet.
