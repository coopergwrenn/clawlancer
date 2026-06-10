# Frontier spend surface — adversarial red-team (2026-06-10)

**Scope:** everything live on the autonomous-spend money path after today's ships
(human_approved hardening phase 1, travel category + ceiling). Written as an outside
red-teamer who wants to steal money or grief users, plus what we *haven't* built that
a cancellable $1200/tx Travala lane needs within days.

**Tags:** `proven` (traced in code / probed live) · `assumed` (reasoned, not exercised)
· `researched` (external best-practice). **Severity × Effort** on each.

**The stakes:** toolrouter's P2 is building the Travala lane against `/authorize` +
the approval flow + the travel category *now*; real USDC bookings to $1200/tx ride this.
Canary = 1 booking; fleet = ~164 VMs.

---

## TOP-3 PRE-P3 BLOCKERS (must land before the canary booking touches real money)

1. **F2 — travel "consent-always" is FORGEABLE until the phase-3 flip.** The $0
   just-do-it we shipped today routes every travel spend to `ask_first`, but in phase 1
   `decideAuthorization` still honors the raw `human_approved` body bool above the
   threshold — so a prompt-injected / stolen-token agent can authorize a $1200 hotel by
   setting one forgeable boolean. The unforgeable (session) requirement only exists
   post-flip. The whole safety story of the ceiling is forgeable without this.
2. **F9 — no buyer-side unwind lane.** Travala bookings cancel; our refund route is
   seller-side only. A settled travel spend has no path for returned USDC to credit back
   into the ledger / daily budget / standing. A cancellable lane with no unwind story is
   a money-accounting hole on day one.
3. **F5 — no per-VM spend-anomaly alarm.** `frontier-spend-health` watches *rail* health
   (settle-failure spike, stuck holds), not spend *behavior*. A wrong-but-authorized
   $1200 booking at 3am fires zero operator/fleet signal — only the user's "was that
   you?". We are blind to a bad booking until a human complains.

F3 (revoke isn't real-time) and F4 (spend authority is billing/lifecycle-blind) are
serious fast-follows but are bounded enough to not gate a *supervised* canary.

---

## PART 1 — adversarial audit of what's LIVE

### F1 — `CRITICAL` · effort: process · `proven` — the partial-ship miss (finding #1, seeded)
The §6 travel category + its ceiling were ONE spec; the category shipped (40b248ed)
without the ceiling, and **the half read as complete**. The live-probe that "felt like
done" (`category:"travel"` → 200, not 400) proved the *surface accepted the input*, not
that the *behavior* was right — every real-priced booking still hard-denied at the tier
`neverPerTx` (`evaluateSpend` `:216`, category-blind). Caught only because toolrouter
verified against shipped `origin/main`.
- **Root cause of the miss:** the verification step exercised the *validation layer*
  (does the category parse?) not the *decision layer* (does a realistic value reach the
  intended outcome?). Unit tests existed but the operator-facing "live-probe" — the thing
  that signals done — checked the cheap half.
- **The fix that makes it unnecessary:** for any gate-affecting feature, the acceptance
  step is a **decision-level live-probe**: drive a *realistic* value end-to-end and assert
  the **decision** (`outcome`/`reason`), never just a 200. Today's ceiling live-probe
  ($100→ask_first, $1300→deny, $5→ask_first) is the correct shape; the category probe was
  not. Codify: "a spec that decomposes into [surface accepts X] + [behavior on X] is not
  shippable until a test drives a realistic X through the **behavior** and asserts the
  decision." The cross-terminal catch worked; a decision-level acceptance probe makes it
  unnecessary.

### F2 — `HIGH` · effort: S · `proven` — travel consent-always is forgeable pre-flip
`travelBands.justDoItPerTx = 0` → `evaluateSpend` returns `ask_first` for every travel
amount. But `decideAuthorization` (`frontier-authz.ts:135-156`): with
`sessionApproved=false`, `humanApprovedForgeable=true`, `requireSessionAboveThreshold=false`
(the phase-1 default of `FRONTIER_REQUIRE_SESSION_APPROVAL_ABOVE_THRESHOLD`), the forgeable
branch authorizes (`reason:"human_approved"`). Traced: a $1000 travel spend + `human_approved:true`
in the body → `authorized:true mode:human_approved`. The gateway token authenticates the
VM, not intent — a prompt-injected or token-stolen agent sets the bool itself.
- **Blast radius:** up to `$1200/tx`, `$3000/day`, bounded by wallet + the
  notification+revoke (which is *detection*, not prevention — see F3). Fleet-wide once
  travel-eligible VMs opt into spend.
- **Fix (pre-P3 blocker):** make travel (or generally any `justDoItPerTx===0` /
  consent-always category) require **session** approval unconditionally — the forgeable
  bool must NEVER authorize travel, independent of the global flip. Small, targeted change
  to `decideAuthorization` (a `sessionRequired` signal when `justDoItPerTxUsd===0`, or a
  category-aware flag) + the matrix test. This is the unforgeable half of "every booking is
  human-approved."
- **Verify:** confirm `FRONTIER_REQUIRE_SESSION_APPROVAL_ABOVE_THRESHOLD` is unset/false in
  Vercel prod (phase-1). If somehow already `true`, F2 is mitigated for *all* above-threshold
  spends, but travel-specific unconditional session is still the right belt.

### F3 — `HIGH` · effort: M · `proven` + `researched` — revoke is detection, not real-time interdiction
The "was that you?" notification fires AT authorize, *after* the hold is reserved
(`authorize/route.ts` `afterFreshAuthorize` → `sendForgeableSpendNotification`). Revoke
(`/api/agent-economy/revoke-spend`) sets `frontier_spend_enabled=false`, which the gate
checks for **future** authorizes only. It does **not** cancel an in-flight pending hold or
an already-signed Bankr/x402 payment. The agent's sign+settle is seconds; the user's
revoke is seconds-to-minutes later. So revoke prevents the *next* spend, not *this* one.
- 2026 best-practice ([Adyen], [PYMNTS]) is explicit: consent must be "revocable in
  **real time**." We are revocable, not real-time-interdictable.
- **What revoke does NOT stop:** (a) the in-flight hold being paid right now; (b) a hold
  already authorized but not yet settled (settle has no kill check — `settle/route.ts` is a
  pure status CAS, doesn't consult `isFrontierSpendKilled` or `frontier_spend_enabled`).
- **Mitigations (fast-follow):** for consent-always/high-value, insert a real confirm
  *before* the pay leg (the session approval already does this for travel once F2 lands —
  travel is approved BEFORE the spend, so F3's window mostly closes for travel); add a
  kill-switch check at settle as defense-in-depth.

### F4 — `MEDIUM` · effort: S · `proven` — spend authority is billing/lifecycle-blind (the SoT 4th instance)
The gate checks `frontier_spend_enabled` (`isFrontierSpendEnabled`) but **never**
`lib/billing-status.ts` (`grep` of `app/api/agent-economy/` + `lib/frontier-*` for
`billing-status`/`isPaying` = empty). And `frontier_spend_enabled` is written in only THREE
places — user toggle (`spend-settings:105`), agent-OFF (`settings:190`), revoke
(`revoke-spend:81`) — **never cleared on cancel / freeze / unassign**. So a cancelled
(non-paying) user's agent keeps spend authority until the VM is frozen; a thawed VM resumes
spend-enabled. It's the user's OWN Bankr USDC (not a platform loss), which caps the
severity — but it's the same class as today's `billing_exempt`-across-3-paths lesson: a
money-relevant authority decoupled from the billing source of truth.
- **Fix:** clear `frontier_spend_enabled=false` on cancel/freeze (fail-closed, cleanest),
  OR gate the opt-in read on `getBillingStatus().isPaying`. Prefer the former — one write in
  the lifecycle paths, and it composes with the existing fail-closed opt-in.

### F5 — `MEDIUM` · effort: M · `proven` — no per-VM spend-anomaly / velocity alarm
`frontier-spend-health` (read in full) watches failure-rate spike + stuck holds (rail
health). The in-band `anomalyFlag` (`frontier-ledger.ts:206`) is counterparty-DIVERSITY
(farming), raises `ask_first` in-band, is NOT an operator alert. There is no fleet/operator
signal for "VM-X spent $1200 on travel" or "VM-X drained its wallet in an hour." A wrong
booking is visible only to the user (the notification).
- **Fix:** a per-VM spend-velocity / large-single-spend alarm cron (e.g. spend >$X/hour or a
  single settled spend >$Y → admin alert, 6h-deduped, mirroring `frontier-spend-health` +
  Rule 49). Cheap, high leverage for the 3am case.

### F6 — `LOW-MED` · effort: S · `proven` — kill switch is fail-OPEN
`isFrontierSpendKilled` returns `false` on any DB error (`frontier-kill-switch.ts:40,43`),
by design (a blip shouldn't halt the fleet; authorize's ledger read fails on the same blip →
500). But a *partial* outage (kill-switch row unreachable, ledger reachable) lets spend
proceed despite an engaged emergency stop. The opt-in fails CLOSED; the *emergency brake*
fails OPEN — arguably inverted for the brake.
- **Fix (judgment call):** consider fail-CLOSED for the kill switch specifically (it's the
  break-glass), or a cached last-known-kill state so a transient read can't un-kill.

### Proven STRENGTHS (no action; documented so we don't regress them)
- **F7 (`positive`)** — "today" is a **24h rolling window** (`SPEND_WINDOW_MS`), not a
  calendar day → no midnight/timezone double-spend (calendar reset would allow $3000 at
  11:59 + $3000 at 00:01). Stricter than calendar. (Minor UX: dashboard "today" ≠ user's
  calendar intuition.)
- **F8 (`positive`)** — **single hold-creation chokepoint**: only `/authorize` inserts a
  spend hold (RPC + the `:594` fallback), both downstream of `evaluateSpend`+`decideAuthorization`.
  No route around the gate (grep-proven). Gateway-token theft is therefore bounded by the
  gate — forgeable-tier limits today, and travel-needs-session once F2 lands. settle is
  amount-immutable (`settle` doc + CAS) — kills "authorize $0.01, settle $100."
- **Approval flow races (`proven`, no defect):** the hold's `UNIQUE(vm_id, request_id)` +
  the RPC's `pg_advisory_xact_lock` are the real guards. Concurrent re-authorize → one
  reserves, the rest get `conflict` → idempotent reply. `consumeApproval` is best-effort
  AFTER a successful reserve; if it fails, the approval stays `approved` but the hold's
  uniqueness blocks any second spend, and a clean re-authorize re-consumes. "Approval
  consumed but spend fails" can't happen — consume only runs on reserve success. TTL is a
  single `nowMs` check (no split-window race). Replay of a `consumed`/`expired` approval →
  `evaluateApproval` returns `none` → normal gate. Double-guarded.

---

## PART 2 — what we HAVEN'T built (researched + reasoned)

### F9 — `HIGH` · effort: M-L · `proven` — no buyer-side unwind / inbound-credit lane
`refund/route.ts` is SELLER-side: our agent (seller) flips its own `settled→refunded` +
queues a refund to ITS buyer. For Travala (we are the BUYER paying an external provider), a
cancellation returns USDC FROM Travala TO our wallet — and there is **no ledger path** for
that inbound credit. A settled $1000 travel spend stays `settled`: it keeps counting against
the rolling daily cap until it ages out, it counts in standing/reputation as a spend, and the
returned money is invisible to the economy. For a *cancellable* booking lane this is a
day-one accounting hole.
- **Build:** an inbound-credit ledger entry (a `refund_in` / credit row tied to the original
  `request_id`) + a detection trigger (toolrouter/Travala cancellation webhook, or watch the
  wallet for inbound USDC referencing a prior spend) + reconcile into spent-today + standing.
  At minimum for the canary: an explicit accepted-risk note + a manual reconcile runbook.

### F10 — `MEDIUM` · effort: M · `researched` — no per-transaction scope attestation
2026 norm ([Adyen]): "delegated authority as a **machine-readable policy attached to each
transaction** — who authorized, under what conditions, whether the agent stayed in scope."
We have the approval row (per-tx authority) + the ledger, but not a single attestation an
external party (Travala, a dispute, a chargeback) could verify. Strategic for scale +
disputes; not a canary blocker.

### F11 — `LOW-MED` · effort: S · `proven` — limits hygiene at the boundary
Cap boundary is `>` (exactly-at-cap is allowed: $1200 travel → ask_first, $1200.01 → deny;
proven). An authorize-bomb can reserve up to the daily cap in fresh holds, locking the budget
for ≤15m (HOLD_TTL) then self-healing; the RPC's atomic re-check prevents over-reserve under
concurrency. Low risk, documented. The travel daily cap ($3000) is enforced as
*total-when-the-spend-is-travel* (non-travel is tier-capped low, so it's effectively the
travel ceiling) — intended, but worth stating explicitly so nobody reads it as travel-only.

---

## PART 3 — phase 2/3, re-derived against these findings

**This morning's assumption:** P2 = skill-flow update (fleet via reconciler); P3 = the global
flip (coverage-gated). **The evidence says skill-flow-first is the wrong order.**

The gating risk for real-money travel is not the skill ergonomics — it's that the consent
property we just shipped is **forgeable** (F2) and the money-back story is **missing** (F9)
and a bad booking is **invisible** (F5). Re-derived order:

1. **F2 — travel session-required, unconditionally** (close the forgeable hole). *This is the
   real pre-P3 blocker* — without it the ceiling's safety is one boolean deep.
2. **F5 — per-VM spend alarm** (so the canary's first wrong booking is operator-visible).
3. **F9 — unwind lane** (or an explicit accepted-risk + manual reconcile for the canary).
4. *Then* the skill-flow update (old P2) — still needed, but it's UX, not safety.
5. *Then* the global P3 flip (coverage-gated, Rule 27) — and note F2 makes travel safe even
   before the global flip, which is the point.

F3 (real-time revoke) and F4 (billing SoT) are the next tier — bounded enough for a supervised
canary, mandatory before broad opt-in rollout.

---

## Self-audit
- **Proven vs assumed:** F1/F2/F4/F5/F6/F7/F8/F9/F11 are code-traced or live-probed. F2's
  exploitability assumes the phase-1 flip default (verify the Vercel env — called out). F3 is
  code-traced + research-anchored. F10 is research-derived (norm we don't meet), not a live
  defect. Approval-race analysis is traced, no defect found — stated as a strength, which is
  itself a claim to re-check if the RPC or the consume ordering changes.
- **What I did NOT exercise live:** F9's inbound-refund (no Travala cancellation to observe);
  F2 was traced in `decideAuthorization`, not live-probed with a forged bool on a spend-enabled
  pro VM (deliberately — that would authorize a real hold; the trace is unambiguous). A
  follow-up could live-prove F2 on a throwaway VM.
- **Bias check:** I am the terminal that shipped F1/F2, so I have motive to under-rate them. I
  ranked F2 the #1 blocker against that bias — the fix we shipped today is itself incomplete on
  the consent dimension, and saying so is the assignment.
