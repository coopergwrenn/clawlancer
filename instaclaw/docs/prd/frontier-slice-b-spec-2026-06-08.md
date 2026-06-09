# PRD — Frontier Slice B: cold spec of the five gate-touching/loosening changes (plan + Rule-31 test suite, pre-build)

**Date:** 2026-06-08
**Status:** SPEC — the Slice B map. **SHIPPED so far: #1 (justDoItPerTx ceiling reversal, `36f0c262`) + #5b (velocity-anomaly Gate 2e, `f877fd35`) — both live on `origin/main` 2026-06-08.** Remaining (#2a/#2b, #5a+#3, #4) unbuilt; this is the map Cooper reviews before each.
**Author:** frontier terminal (econ-surface worktree).
**Scope:** the five Slice-B changes named in `frontier-spend-approval-model-2026-06-08.md` §19 — each one moves a line on a real-money autonomous-spend surface. For each: the exact gate code it touches (verified against source, line-cited), the line it moves, the blast radius if wrong, the dependency order, the Rule-31 failure-mode test that gates merge, and the blockers that aren't ready to spec.

> **No-stomp (Rule 72).** This is a NEW sibling doc. It does NOT modify `PRD-frontier-economic-agency.md` (committed master), `frontier-spend-approval-model-2026-06-08.md` (the approval-model design doc this refines), or any other stream's working copy. When Slice B builds, the per-change status flips happen in *those* docs at ship time; this doc is the pre-build map.

> **Verification stance.** Every file:line below was read against the econ-surface source on 2026-06-08, not from memory. Where this doc contradicts the approval-model PRD's §5/§16/§19, the contradiction is called out explicitly in §8 — I re-verified and the PRD was wrong in two places.

---

## §0 — TL;DR + the headline pushback

The five-change framing is **directionally right but imprecise in three ways that change how Slice B should be built and reviewed.** Before the per-change spec, the corrections:

1. **Only ONE of the five actually moves a deny line.** Cooper's framing — "these move deny lines" — is true for exactly one: #2 (the `minWalletBalance` floor reversal moves `would_drain_wallet`, an absolute refusal). The other four move the **autonomy line** (the just-do-it ↔ ask-first boundary) or **add** ask lines. That distinction is load-bearing for blast radius: a deny is a refusal bounded by on-chain settlement; an ask is an escalation bounded by the earned-budget AND. Moving the autonomy line wider is *safe by a different mechanism* than I'd assume if I treated them all as "deny lines."

2. **#4 ("chat-tool bound-enforcement") is not a gate-logic change at all — and the tool it governs does not exist yet.** I grepped: there is no `frontier-settings` agent tool. `skills/frontier/scripts/frontier-spend.mjs` is the *spend* tool; `/api/agent-economy/spend-settings` is the opt-in toggle. #4 is a **new write-client** that must inherit bounds by routing through the existing `/policy` PUT — it edits *no* gate code (`evaluateSpend`/`decideAuthorization`/`clampOverrides` are untouched). Its risk class is integration ("does it write the right row through the right path; does it refuse to bypass") not pure-function. And it **depends on #1 and #2 landing** — until the clamp reversals exist, every loosening write the chat tool makes is silently neutralized at read. It rides the Slice-B review because it touches the money surface, but it is a different kind of change with a different kind of test.

3. **Two of the five are actually two changes each.** #2 is (2a) lower the tier-default floor `$2/$10/$25 → flat $0.10` — a **fleet-wide default change that lowers every existing user's drain floor on deploy, with no opt-in** — AND (2b) reverse the clamp direction so users can go below base to $0. These have independent blast radii and should land/test separately. #5 is (5a) the new-merchant first-contact ask — **coupled to #3** (supplier-trust is *defined as* "skip this ask") and **data-blocked** on the novelty floor — AND (5b) the anomaly ask, which is **independent** and whose signal already exists and already feeds the score. Splitting them clarifies the dependency graph and lets 5b ship early.

**Risk ranking (genuinely-riskier-than-others, honest):**

| Rank | Change | Why |
|---|---|---|
| **1 (highest)** | **#3 supplier-trust** | The only change that *loosens* the gate AND needs new storage AND threads a new input into `decideAuthorization`. It's the prompt-injection / compromised-agent attack surface (auto-pay above ceiling to a "trusted" supplier). Plus a storage-shape blocker. |
| 2 | **#1 ceiling reversal** | Reverses a *deliberate* tighten-only design on the safety-critical clamp. Safe by the earned-budget AND, but a regression that bypasses gate 2c would auto-spend up to `neverPerTx`. One-line change, huge invariant. |
| 3 | **#2b floor-clamp reversal** | Moves the one real deny line. Lower-risk than it sounds: velocity-bounded by daily caps + earned budget, and on-chain settlement physically forbids negative. Floor-to-0 = "spend it all," the user's choice. |
| 4 | **#2a default-floor lower** | Not a *gate-logic* change but a fleet-wide behavior change for existing users on deploy. Blast radius = everyone, but the direction (drain a little lower) is benign and reversible. |
| 5a | **#5 new-merchant ask** | Tightening (adds an ask). Risk is implementation-only (a mis-placed `return ask_first` in the gate). Data-blocked on the threshold. |
| 5b | **#5 anomaly ask** | Tightening, lowest risk. Signal already computed; the new path is one direct ask. |
| — | **#4 chat tool** | Not gate-logic. Integration risk + agent-behavior (don't-let-the-LLM-loosen-itself) risk. Depends on #1+#2. |

**Two blockers that are NOT ready to spec on real numbers:**
- **#3 storage shape** (`frontier_trusted_suppliers` table vs `trusted_supplier_ids text[]` column) — undecided (§13.3 of the approval PRD). Unblock = Cooper's call (lean: table, for the provenance/audit trail).
- **#5a novelty floor** (the dollar value above which a first-contact spend asks) — there are **16 transactions in the entire ledger, all $0.001**. There is no distribution to derive a floor from. Unblock = W12 real fleet volume. Interim = tier `justDoItPerTx`, flagged provisional. I will not guess it.

Everything else below is specced cold.

---

## §1 — The gate as-built (verified map, the substrate every change touches)

The spend decision is three pure modules composed in one route. The autonomy decision is `policy bands (evaluateSpend) → earned budget (decideAuthorization)`. Slice B edits the first two modules and the inputs the route feeds them. Nothing in Slice B touches the reserve RPC or the standing engine.

### 1.1 — `evaluateSpend` (`lib/frontier-policy.ts:164-231`) — the policy-band gate

Ordered, deny-first. Verified order:
1. `:178-183` invalid amount / spent-today → **deny**
2. `:186-188` privacy mode → **deny**
3. `:191-193` required-but-unverified counterparty → **deny**
4. `:198-200` category not in allowlist → **deny**
5. `:203-205` `amount > neverPerTx` → **deny** *(per-tx hard ceiling)*
6. `:206-208` `spentToday + amount > neverPerDay` → **deny** *(daily hard ceiling)*
7. `:210-217` balance known AND `balance − amount < minWalletBalance` → **deny: `would_drain_wallet`** *(the one deny line Slice B moves — #2)*
8. `:219-227` `amount < justDoItPerTx AND agg < justDoItPerDay` → **just_do_it** *(the autonomy line — #1 moves this; balance-unknown here → `ask_first`, `:222-224`)*
9. `:229-230` else → **ask_first**

**Critical ordering fact:** step 5 (`amount > neverPerTx → deny`) runs *before* step 8 (the just-do-it split). So even if `justDoItPerTx` were somehow raised above `neverPerTx`, step 5 denies first. This is a backstop the #1 reversal does not remove.

### 1.2 — `clampOverrides` (`lib/frontier-policy.ts:72-87`) — tighten-only, the thing #1 and #2b reverse

```
:75  neverPerTx       = min(base, override)               // ceiling ↓ only
:76  neverPerDay      = min(base, override)               // ceiling ↓ only
:77  minWalletBalance = max(base, override)               // floor ↑ only        ← #2b reverses (pending)
:84  justDoItPerTx    = min(neverPerTx, override)         // no-ask line, USER-RAISABLE to neverPerTx   ← #1 SHIPPED 2026-06-08
:85  justDoItPerDay   = min(base, override, neverPerDay)  // no-ask line ↓ only   (stays)
```

`at(v, fb)` (`:73-74`) coerces negative / non-finite / absent → fallback to base. The whole function is the *two-guard safety property*: `/policy` PUT stores raw values (no tighten-enforcement at write), and `clampOverrides` enforces tightening at **read** — so a bad stored value can never make the agent less safe, because the clamp neutralizes it. **Slice B's #1 and #2b each punch a controlled hole in exactly one line of this guard.**

### 1.3 — `decideAuthorization` (`lib/frontier-authz.ts:95-170`) — the three-actor composition

- `:107-109` **Gate 1** — `evaluation.decision === "deny"` → deny. Absolute; the human cannot override per-spend.
- `:114-122` **Gate 3** — `humanApproved` → just_do_it (`human_approved`). Lifts the autonomy gate, NOT the hard denies.
- `:127-129` **Gate 2a** — policy `ask_first` → ask_first.
- `:132-134` **Gate 2b** — `!categoryKnown` → ask_first (`unknown_category`).
- `:139-147` **Gate 2c — THE KEYSTONE** — `projected (= reserveAwareSpentToday + amount) > earnedDailyBudget` → ask_first (`exceeds_earned_budget`).
- `:158-160` **Gate 2e** — `standing.anomalyFlag === true` → ask_first (`velocity_anomaly`). #5b SHIPPED; additive, strictly downstream of 2c.
- `:163-169` **Gate 2d** — within policy AND within earned → autonomous.

**The load-bearing invariant for ALL of Slice B:** the earned budget at 2c ANDs independently of every policy band, and `earnedDailyBudget ≤ justDoItPerDay` by construction (`frontier-standing.ts:119-121`). Therefore widening any policy band (raising the no-ask ceiling, trusting a supplier) raises **willingness**, never **realized** autonomy — the agent must still have *earned* it at 2c. **Every Slice-B change is safe iff 2c still executes on its path.** This is the single assertion that runs through the whole test suite.

**What `decideAuthorization` does NOT take today (verified):** no supplier identity, no supplier-novelty flag, no anomaly flag, no trusted-supplier set. `AuthorizationInput` (`:58-76`) is `{evaluation, standing, reserveAwareSpentTodayUsd, amountUsd, humanApproved, categoryKnown}`. **#3 and #5 must add new inputs here** — that is the surface they edit.

### 1.4 — The route wiring (`app/api/agent-economy/authorize/route.ts`)

- `:386` `resolveEffectivePolicy(supabase, vm.id, tier)` → `{bandOverrides, allowedCategories}` (canonical override read, shared with the dashboard GET).
- `:388-399` `evaluateSpend(tier, {...})` — note the ctx has **no supplier identity** (`counterpartyVerified` yes, but no `supplierId`).
- `:401-408` `decideAuthorization({evaluation, standing, reserveAwareSpentTodayUsd, amountUsd, humanApproved, categoryKnown})` — **no supplier-novelty, no anomaly, no trust input.**
- `:468-482` `frontier_reserve_spend` RPC — atomic re-check + insert. **Slice B does not touch this.**

The route is where #3 and #5 compute their new signals (`supplierIdOf` from the ledger, first-contact from `deriveSupplierStats`/`deriveCounterpartyRollup`, anomaly from `deriveTrackRecord.anomalyFlag`) and thread them into the gate. **`standing` already carries the anomaly effect indirectly** — `anomalyFlag` feeds `computeFactors` integrity (`frontier-standing.ts:95`), which lowers the score and thus the earned budget. #5b's anomaly ask is a *new direct* escalation on top of that indirect effect.

### 1.5 — The `/policy` PUT validator — what #1's reversal does and does NOT need

> **Citation corrected 2026-06-08 (foundation audit §3).** On `origin/main` the validator is NOT inline in the route — commit `178a0ff5` (GAP-4) extracted it to `lib/frontier-policy-write.ts`. The route (`app/api/agent-economy/policy/route.ts:39,:168,:174`) *delegates* to `validatePolicyPutBody` + `upsertPolicyOverrideRow`. (My original line refs pointed at the frontier-policy worktree's pre-GAP-4 inline copy — stale; substance below is unchanged and re-verified against the real home.)

Verified end-to-end on `origin/main`:
- `frontier-policy-write.ts:83` each band validated to `[0, MAX_OVERRIDE]` where `MAX_OVERRIDE = 10_000_000` (`:28`).
- `frontier-policy-write.ts:80,:90` stores the **raw** requested value (omitted band → `null`, replace-semantics). **No clamp to tier default at write.**
- `upsertPolicyOverrideRow` (`:142-165`) upserts raw with `onConflict:"vm_id"`. The route then returns EFFECTIVE bands via `effectiveBands` (`policy/route.ts:190`) — the clamp applies at read, as designed.

**Correction to the approval PRD §5.4** ("the `/policy` PUT validator must allow values up to `neverPerTx` (today it likely clamps to tier default — verify + widen)"): **this is wrong. The PUT does NOT clamp to tier default; it already stores raw values in `[0, 10M]`.** So #1 (and #2b) are **pure `clampOverrides` semantics changes — one line each — with no PUT-validator change required.** The two-guard property means the PUT was always permissive; the clamp was always the enforcer. This shrinks #1 and #2b from "two-file changes" to "one-line changes," which materially lowers their implementation risk. (A *UI* affordance is still needed to let the user enter the higher value, but that's Slice-A-adjacent display, not gate code.)

---

## §2 — Per-change deep spec

For each: **(a)** gate code touched (cited), **(b)** the line it moves (deny vs autonomy vs add-ask), **(c)** blast radius if wrong, **(d)** is it really one change.

### Change #1 — `justDoItPerTx` ceiling reversal

- **(a) Code touched:** `clampOverrides` `:84` only. Diff: `min(base.justDoItPerTx, override, neverPerTx)` → `min(neverPerTx, override ?? base)`. The `neverPerTx` cap **stays** (the per-tx hard ceiling is still the hard bound); the `base` cap is **removed** so an override can exceed the tier default up to `neverPerTx`. No `evaluateSpend` change, no `decideAuthorization` change, **no PUT-validator change** (§1.5).
- **(b) Line it moves:** the **autonomy line** (just-do-it ↔ ask-first split, `evaluateSpend:219-220`). **Not a deny line.** Raising it widens *willingness* to auto-spend per-tx, not the refusal boundary. The deny line (`neverPerTx`, step 5) is untouched.
- **(c) Blast radius if wrong:** the failure that matters is a regression that lets a *raised* ceiling auto-spend *above the earned budget* — i.e., gate 2c gets short-circuited or the earned-budget path stops executing on the raised-ceiling branch. If that happened: a brand-new agent ($0.10 earned) with a user-set $10 ceiling could auto-spend up to `min(justDoItPerDay, neverPerDay, wallet−floor)` ≈ $5/day to *any* supplier with no human in the loop. **Bounded by:** (i) `neverPerTx`/`neverPerDay` hard caps still deny above them; (ii) on-chain settlement (can't spend USDC you don't hold). **Not bounded by** the earned budget *if the regression is specifically a 2c bypass* — which is why the load-bearing test is "raised ceiling + low earned → MUST ask." The correctly-implemented change is safe; the *regression* is the risk, and it's a 2c-bypass regression.
- **(d) One change?** Yes — genuinely one line. The cleanest of the five.
- **(e) Verified blast radius (foundation audit §4, 2026-06-08):** `clampOverrides` is reached ONLY via `effectiveBands`, whose complete caller set is: `evaluateSpend` (the intended widen), `creditStanding:119` (reads `.justDoItPerDay` ONLY → **earned budget provably invariant under #1**), and `policy` GET/PUT (display/echo of the new ceiling — intended). **One reader the original spec missed:** `frontier-headroom.ts:116` reads `justDoItPerTx` — but it is **display-only** (sole caller: `policy` GET `:122`), **earned-bounded** (`perPurchaseCapUsd = min(justDoItPerTx, effectiveMaxToday)`, and `effectiveMaxToday` includes `earnedRemaining`), and **gate-consistency-tested** (`_test-frontier-headroom.ts`). So after #1 it honestly displays `min(raised-ceiling, earned-remaining)` — correct, not a leak. **No hidden enforcement reader exists.** Test note: add a raised-ceiling case to `_test-frontier-headroom.ts` (display stays earned-bounded) — the display-side mirror of authz test 1.1.

### Change #2 — `minWalletBalance` floor reversal — **actually two changes**

- **#2a — lower the tier-default floor to flat $0.10.** `DEFAULT_BANDS_BY_TIER` (`:48-50`): `minWalletBalance` `2/10/25` → flat `0.10`.
  - **(a) Code touched:** `DEFAULT_BANDS_BY_TIER:48-50`. Pure data.
  - **(b) Line it moves:** lowers the **default position of the deny line** (`would_drain_wallet`) for **every existing user** at once — no override, no opt-in.
  - **(c) Blast radius:** **fleet-wide on deploy.** Every starter agent's drain floor drops from $2 to $0.10 the moment the constant ships (it's the `base`, read live by `effectiveBands`). Direction is benign (agent can drain a little lower before stopping; releases ~$1.90 of stranded value per starter) and reversible (revert the constant). But it is *not* opt-in — flag it as such. The "silent dead-end at exactly $2 funded" failure mode (approval PRD §16.1) is *fixed* by this, but the change touches everyone.
  - **(d)** This is the half that has a fleet-wide blast radius. Separable from #2b: #2a with the clamp still raise-only would lower everyone to $0.10 but users couldn't go below.
- **#2b — reverse the floor clamp.** `clampOverrides:72`: `max(base, override)` → `max(0, override ?? base)` (allow below base, floor bound at 0).
  - **(a) Code touched:** `clampOverrides:72` only. No PUT-validator change (§1.5; PUT already allows `[0, 10M]`).
  - **(b) Line it moves:** the **`would_drain_wallet` deny line** (`evaluateSpend:210-217`) — **the one genuine deny line in Slice B.** Lowering the floor lets the wallet drain lower before the absolute refusal fires.
  - **(c) Blast radius if wrong:** the only real bug is a floor going *negative* (spend the wallet below zero). **Bounded by:** the `max(0, ...)` platform floor AND on-chain settlement (EIP-3009 transfer of more USDC than held fails at the facilitator). A floor at exactly $0 = "spend down to dust" = the user's explicit choice; velocity-bounded by the daily caps + earned budget (you can't reach $0 in one tick unless the earned budget allows the whole spend). **Lower-risk than #1** despite moving a deny line, precisely because the deny line is the *last* gate before money that physics already protects.
  - **(d)** Separable from #2a (see above).

### Change #3 — supplier-trust relaxation — **the riskiest; storage-blocked**

- **(a) Code touched:** this is the biggest surface. Today there is **no supplier identity in the gate at all** (§1.3). Building it requires:
  1. **New storage** (BLOCKER §6.1): `frontier_trusted_suppliers` table OR `trusted_supplier_ids text[]` on `frontier_policy_overrides`. Stores `(vm_id, supplierId, grantedAt)`.
  2. **Route change** (`authorize/route.ts`): compute `supplierIdOf(...)` (exists, `ledger:76-88`) for the inbound spend, look up trust, thread a new `trustedSupplier: boolean` (and the supplier id) into the gate.
  3. **Gate change** (`decideAuthorization` and/or `evaluateSpend`): a trusted supplier **skips the new-merchant ask (#5a) AND treats the per-tx amount as within the no-ask line** — i.e., bypasses the `evaluateSpend:229-230` ask-first-band fallthrough for that supplier. This is a genuine **loosen** of the autonomy logic.
  4. **Invariant that MUST survive:** trust relaxes **per-transaction only**. Gate 1 hard denies (`:107-109`), the drain floor (step 7 / `evaluateSpend:210-217`), and **gate 2c the earned budget** still bind (approval PRD §4.4). "I trust this supplier per-purchase" must never blow the daily exposure cap.
- **(b) Line it moves:** the **autonomy line for a specific supplier** (skips the ask). Not a deny line. But it's the only change that moves the autonomy line *conditionally on attacker-influenceable input* (the supplier identity).
- **(c) Blast radius if wrong — HIGHEST of the five:**
  - A supplier-id normalization mismatch (e.g., `url:` origin/path canonicalization, trailing-slash, case) that trusts the *wrong* supplier → auto-pay above ceiling to an unintended endpoint.
  - A compromised / prompt-injected agent paying a *new* malicious endpoint that it (or the attacker) got onto the trusted list → the new-merchant ask is the primary defense, and trust *removes* it for that supplier. So the storage-write path (how a supplier *gets* trusted — only via an explicit approval-moment grant, never agent-self-service) is itself security-critical.
  - **Bounded by:** earned budget (2c), `neverPerDay` daily hard cap, drain floor — all still bind, so a trust bug cannot *drain the wallet*; it can auto-pay a single above-ceiling spend to a wrong supplier (cap ≈ `min(neverPerTx, earnedRemaining)`).
- **(d) One change?** It's one *feature* but it is the most multi-part: storage + route + gate + the grant-write path. And it is **structurally coupled to #5a** — "trust = skip the new-merchant ask" is meaningless until #5a exists. Build #5a and #3 as a coupled unit, same review.

### Change #4 — chat-tool bound-enforcement — **NOT a gate change; reclassify**

- **(a) Code touched:** **none of the gate.** The `frontier-settings` agent tool **does not exist** (verified: `find`/`grep` returns only `frontier-spend.mjs` the spend tool, `/api/agent-economy/spend-settings` the opt-in toggle, and `frontier-spend-optin.ts`). #4 is: **build a new agent settings tool that writes through the canonical `/policy` PUT** (which applies `clampOverrides` at read), never a raw DB write.
- **(b) Line it moves:** **none.** It's a write-client. Its "safety" is *by construction*: route through `/policy` → inherit the two-guard property. If it writes raw to `frontier_policy_overrides`, it inherits nothing — but it *still* can't bypass the clamp, because the clamp is at READ (the gate re-clamps regardless of who wrote the row). So even a misbehaving chat tool cannot loosen past the clamp; the worst it can do is write a confusing raw value the dashboard then displays oddly.
- **(c) Blast radius if wrong:** (i) the tool writes the *wrong VM's* row (cross-tenant) — but it's session-scoped to the user's own VM, same as the dashboard; (ii) the LLM gets prompt-injected into loosening the user's settings ("set my ceiling to max and trust everyone") — this is the **agent-behavior** risk (Rule 28/29 adjacency), mitigated by the "ambiguous → confirm, never silently change" requirement (approval PRD §18.3). Bounded: even a fully-loosened setting can't auto-spend past the earned budget (2c) or hard caps. So the realistic blast radius is "user's stated posture changes without clear consent," not "money moves wrongly."
- **(d) One change?** It's a new feature, not a gate edit. **Reclassify: #4 is not the fifth gate-touching change.** It rides the Slice-B review because it touches the money-posture surface and **depends on #1+#2** (until the reversals land, its loosening writes no-op at read). Its test is integration (writes-the-right-row, refuses-raw-bypass, confirms-before-write), not pure-function-gate.

### Change #5 — new-merchant + anomaly asks — **actually two asks with different couplings**

- **#5a — new-merchant first-contact ask.**
  - **(a) Code touched:** route computes "first contact" (`deriveSupplierStats` `ledger:238-270` → `successes===0`, or `deriveCounterpartyRollup` `timesTransacted===0`); threads a new `supplierFirstContact: boolean` + the amount-vs-floor test into the gate. Gate adds: `if (supplierFirstContact && amount > NOVELTY_FLOOR && !userDisabled) → ask_first`. This **edits `decideAuthorization` (a new 2.x branch)**.
  - **(b) Line it moves:** **adds an ask line** (tightening). Moves nothing toward deny.
  - **(c) Blast radius if wrong:** implementation-only — a mis-placed `return ask_first` could (i) over-fire (every sub-cent exploration asks → notification fatigue → user disables spend, the worst churn outcome), or (ii) under-fire (a non-trivial first buy from a never-seen counterparty auto-pays — the exact compromised-agent failure this defends against). The novelty floor is what separates (i) from the intent. **Data-blocked** on that floor (§6.2).
  - **(d)** Coupled to #3 (trust *is* "skip this ask"). Build together.
- **#5b — anomaly ask.**
  - **(a) Code touched (corrected 2026-06-08 to the as-built read-shape):** `anomalyFlag` (computed in `deriveTrackRecord` — window `:206-214`, flag-set `:212-214` — and also driving the integrity score factor via `computeFactors:95`) is surfaced as an **explicit read-only boolean on `CreditStanding`** (`frontier-standing.ts`; passthrough, zero score/budget change), so the gate reads `standing.anomalyFlag` DIRECTLY rather than inferring it from `factors.integrity` (a money gate must not silently change which spends trip the ask if the score encoding ever changes — Cooper's call, Option B). It rides on the `standing` object already passed to the gate — **no route / `AuthorizationInput` change** (the original "route passes it as a direct gate input" was imprecise; `CreditStanding` did not previously carry the flag). `decideAuthorization` adds **Gate 2e**, placed strictly between 2c (earned-budget keystone) and 2d (autonomous fallthrough): `if (standing.anomalyFlag === true) → ask_first` (reason `velocity_anomaly`). Boundary: `frontier-standing.ts` (the field) + `frontier-authz.ts` (the 2e branch) + `scripts/_test-frontier-anomaly-ask.ts`.
  - **(b) Line it moves:** **adds an ask line** (tightening).
  - **(c) Blast radius if wrong:** lowest. A false-positive anomaly (legit burst of new suppliers) → spurious asks (recoverable: user approves, flag is a rolling-window heuristic that clears, `ledger:206-214`). A false-negative → the spend proceeds under the *indirect* score penalty anyway (the integrity factor already cut the earned budget). So even a broken #5b degrades to "the indirect effect still applies."
  - **(d)** **Independent of #3 and #5a.** Signal exists; can land early.
  - **(e) Follow-up (logged at ship, 2026-06-08):** #5b ships RAW (no dollar floor) — Cooper's call. The FP consequence is bounded to one recoverable, self-healing `ask_first`, never a block, and the flag self-clears (rolling window). If real fleet usage shows the FP rate (legit new-supplier bursts) is annoying, add a dollar floor so sub-threshold exploration stays frictionless. NOT load-bearing for any other Slice B piece.

---

## §3 — Dependency order + coupling (the graph Cooper asked me to surface)

```
                         ┌─────────────────────────────────────────┐
   STANDALONE, parallel  │  #1 ceiling reversal   (clampOverrides:76)│
   (each one line / data)│  #2a default floor↓    (DEFAULT_BANDS)    │
                         │  #2b floor clamp rev.  (clampOverrides:72)│
                         │  #5b anomaly ask       (signal exists)    │
                         └─────────────────────────────────────────┘
                                        │
                ┌───────────────────────┴───────────────────────┐
                ▼                                                ▼
   COUPLED UNIT (build + review together)            DEPENDS ON #1 + #2
   #5a new-merchant ask  ──defines the ask──▶ #3      #4 chat-settings tool
   #3 supplier-trust     ──skips the ask────▶          (writes through /policy;
   (blocked: storage shape + novelty floor)             no-ops at read until
                                                         #1+#2 reversals land)
```

**The couplings, stated plainly:**

1. **#5a ↔ #3 are one unit.** Supplier-trust is *defined as* "skip the new-merchant ask (and the per-tx ceiling ask) for this supplier." You cannot build the "skip the new-merchant ask" half of #3 before the new-merchant ask (#5a) exists, and building #5a without #3 means a user who said "always trust United" still gets asked (annoying but safe). They share a gate review because **#3 loosens the exact line #5a tightens** — a reviewer must see both diffs at once to reason about the net.

2. **#4 depends on #1 + #2.** The chat tool's whole value is letting the user *raise* the ceiling or *lower* the floor by voice. Until `clampOverrides` is reversed (#1, #2b), those writes are clamped back to no-ops at read — the user says "spend up to $10" and the gate keeps enforcing $1. Shipping #4 before #1+#2 produces a tool that silently lies. So: #1 and #2b **must** precede #4.

3. **#2a should precede or accompany #2b.** If #2b lands first (clamp allows below base) while base is still $2, a user can lower toward $2-and-below — fine — but the "silent dead-end at $2 funded" default is still live for everyone who *doesn't* touch the setting. #2a (lower the default) is what actually kills the dead-end fleet-wide. They compose; land #2a with or just before #2b.

4. **#1 is fully standalone.** No dependency. The earned budget makes it safe in isolation. It's the natural first ship of the set.

5. **#5b is fully standalone.** The anomaly signal already exists and already feeds the score. The direct ask is additive. Can ship first or last; lowest risk either way.

**One coupling Cooper's framing did NOT call out that I want to surface:** **#2a (default floor lower) and the low-balance warning are coupled.** The approval PRD §16.5 makes the warning ("running low — about a day of spending left") the *real* dead-end fix; #2a lowers the hard floor so the *warning* can do the nudging job the $2 floor was badly doing. If #2a ships without the warning, you've removed the (bad) nudge and replaced it with nothing — a user can now silently drain to $0.10 with no heads-up. **So #2a should not ship ahead of the §16.5 low-balance warning.** The warning is Slice-A display (read-only, boundary-safe per §19), so this is a sequencing note, not a gate dependency — but it's a real one, and it's the kind of thing that bites if #2a ships "because it's just a constant."

**Recommended build sequence (derived from the graph):**

1. **#1 ceiling reversal** — ✅ **SHIPPED 2026-06-08 (`36f0c262`).** standalone, foundational, one line, highest-value (unlocks Hands-off + "raise my line"). Shipped behind its Rule-31 test.
2. **#5b anomaly ask** — ✅ **SHIPPED 2026-06-08 (`f877fd35`).** standalone, lowest risk, additive defense.
3. **#2a + #2b floor work** — together, *after* the §16.5 low-balance warning is live (Slice A). Sequencing gate, not a code gate.
4. **#5a + #3 coupled unit** — *after* the storage-shape decision (§6.1) and an interim novelty floor (§6.2). Same gate review. This is the big one.
5. **#4 chat-settings tool** — *after* #1 + #2 land (else it no-ops). Integration-tested, not gate-tested.

---

## §4 — The Rule-31 failure-mode test suite (per change)

The discipline (Rule 31): each change ships with the failure-mode test that proves the adversarial case is ruled out, **built before the change merges**, mirroring the existing `scripts/_test-frontier-authz.ts` / `_test-frontier-policy.ts` style (pure-function, `npx tsx`, exit 0). "Safe to ship" for each = the named adversarial assertions pass AND the load-bearing invariant (2c still executes) holds.

> **The one assertion that runs through everything:** *a widened band never produces autonomous spend above the earned budget.* If any test in this suite can be made to auto-spend above `earnedDailyBudgetUsd` without `humanApproved=true`, the change is unsafe regardless of what else passes.

### #1 — ceiling reversal

| # | Adversarial case | Expected | Rules out |
|---|---|---|---|
| 1.1 **(load-bearing)** | starter, raised `justDoItPerTx=$10`, earned budget `$0.10`, spend `$5` | `ask_first` reason `exceeds_earned_budget` | a raised ceiling auto-spending above earned (Rule 28 / the whole safety proof) |
| 1.2 | same, then flip earned budget to `$6`, same `$5` spend | `just_do_it` / autonomous | proves willingness≠reality is *symmetric* — earned makes it auto |
| 1.3 | override `justDoItPerTx = 999` on starter | effective `justDoItPerTx === neverPerTx ($10)`, never 999 | `U` exceeding the hard ceiling (the `min(neverPerTx, …)` cap survives the reversal) |
| 1.4 | raised per-tx `$10`, per-day untouched `$5`, single `$7` spend, earned `$10` | `ask_first` (daily band binds at step 8 / `withinJustDoIt` false because `agg $7 ≮ $5`) | a per-tx raise leaking past the per-day band |
| 1.5 | `humanApproved=true`, amount `$50 > neverPerTx $10` | `deny` reason `exceeds_per_tx_ceiling` | human approval bypassing a hard deny (Gate 1 absolute) |
| 1.6 | override `justDoItPerTx = -3` (negative) | falls back to base (the `at()` guard) — agent no *less* safe | a bad override loosening via the new path |
| 1.7 **(invariant)** | code-review assertion, not runtime | on the raised-ceiling branch, `evaluateSpend` step 8 AND `decideAuthorization` 2c both still execute | a refactor short-circuiting 2c |

**Safe to ship #1 =** 1.1–1.6 green + 1.7 confirmed in review.

### #2a — default floor lower

| # | Adversarial case | Expected | Rules out |
|---|---|---|---|
| 2a.1 | starter, no override, base floor now `$0.10`, balance `$0.15`, spend `$0.10` (would leave `$0.05`) | `deny: would_drain_wallet` (`$0.05 < $0.10`) | the floor still denying below it after lowering |
| 2a.2 | starter, no override, balance `$0.50`, spend `$0.30` (leaves `$0.20 ≥ $0.10`) | not drain-denied (passes step 7) | the lowered floor over-denying |
| 2a.3 | all three tiers, no override | effective `minWalletBalance === $0.10` for each (flat) | a per-tier value surviving the flatten |
| 2a.4 | hard-cap deny behavior unchanged | `neverPerTx`/`neverPerDay` denies fire exactly as before | the floor change leaking into the hard caps |

### #2b — floor clamp reversal

| # | Adversarial case | Expected | Rules out |
|---|---|---|---|
| 2b.1 **(load-bearing)** | override `minWalletBalance = $0` (spend it all), balance `$0.50`, spend `$0.50` (leaves `$0`) | not drain-denied (`$0 < $0` is false) | floor-0 incorrectly denying a drain-to-exactly-zero |
| 2b.2 | override `minWalletBalance = $0`, balance `$0.50`, spend `$0.60` (would leave `−$0.10`) | `deny: would_drain_wallet` (`−$0.10 < $0`) | a $0 floor allowing *negative* (the only real bug) |
| 2b.3 | override `minWalletBalance = −5` (negative) | clamps to `0` (the `max(0, …)` platform bound) | a negative floor reaching the gate |
| 2b.4 | override `minWalletBalance = $50` (raise — old direction) | effective `$50` (raise still works) | the reversal breaking the still-valid tighten direction |
| 2b.5 **(invariant)** | floor-0 spend that is *within* drain but *above* earned | `ask_first: exceeds_earned_budget` | lowering the floor letting a spend skip 2c |

### #3 — supplier-trust *(specced; gated on storage-shape decision §6.1)*

| # | Adversarial case | Expected | Rules out |
|---|---|---|---|
| 3.1 **(load-bearing)** | trusted supplier `S`, earned `$5/day`, ten `$1` buys to `S` | first ~5 auto, then `ask_first` once daily aggregate hits earned cap — **trust does NOT bypass the daily/earned cap** | trust relaxing *daily* not just per-tx (approval PRD §4.4) |
| 3.2 | trusted `S`, single buy above per-tx ceiling but `humanApproved=false`, within earned | `just_do_it` (trust skips the per-tx ask) | trust failing to actually relax the per-tx ask it's supposed to |
| 3.3 | trusted `S`, spend that hits the **drain floor** | `deny: would_drain_wallet` (trust doesn't lift drain) | trust bypassing a hard deny |
| 3.4 | trusted `S`, spend above `neverPerTx` | `deny: exceeds_per_tx_ceiling` | trust bypassing the hard ceiling |
| 3.5 **(attack)** | spend to supplier `S'` whose id *almost* matches a trusted `S` (trailing slash / case / query-string variant) | treated as **untrusted** → new-merchant ask fires | supplier-id normalization mismatch trusting the wrong endpoint (the prompt-injection surface) |
| 3.6 | trust grant arrives via a path other than an explicit approval-moment | rejected (only the approval grant writes trust) | agent self-service trusting a supplier (the compromised-agent surface) |
| 3.7 **(invariant)** | every trusted-supplier path | `decideAuthorization` 2c still executes | trust short-circuiting the earned budget |
| 3.8 **(LOCKED — two-trust constraint, §9.5.1)** | supplier with gbrain `behavioralTrust === "trusted"` (earned) but NOT in the user-granted set, first-contact above `$0.10` | `ask_first` (new-merchant ask still fires) | the Rule-28 self-granting-autonomy bug — the agent earning its own way to skipping the user's gate. The gate input is `userGrantedTrust` ONLY; `behavioralTrust` must never reach the gate-skip. |

### #5a — new-merchant ask *(specced; gated on novelty floor §6.2)*

| # | Adversarial case | Expected | Rules out |
|---|---|---|---|
| 5a.1 | new supplier `S` (zero prior settled), `$0.001` (below novelty floor) | `just_do_it` (sub-cent exploration frictionless) | over-firing on the dominant sub-cent traffic (churn) |
| 5a.2 **(load-bearing)** | new supplier `S`, amount **above** novelty floor | `ask_first` | a non-trivial first buy to a never-seen counterparty auto-paying (compromised-agent defense) |
| 5a.3 | known supplier (≥1 prior settled), amount above floor | no new-merchant ask (other gates still apply) | the ask mis-firing on established suppliers |
| 5a.4 | new supplier, above floor, but user has disabled new-merchant asks (advanced) | no new-merchant ask | the disable toggle being ignored |
| 5a.5 | new supplier, above floor, but a trusted supplier (#3) | no new-merchant ask (trust skips it) | the #3↔#5a coupling not composing |

### #5b — anomaly ask

| # | Adversarial case | Expected | Rules out |
|---|---|---|---|
| 5b.1 **(load-bearing)** | `anomalyFlag=true`, an otherwise-autonomous spend | `ask_first` | an anomalous burst auto-spending |
| 5b.2 | `anomalyFlag=false`, same spend | `just_do_it` | the anomaly path mis-firing when clean |
| 5b.3 | `anomalyFlag=true` + `humanApproved=true` | `just_do_it` (human lifts the ask) | anomaly blocking a human-approved spend |
| 5b.4 | `anomalyFlag=true` + a hard-deny condition | `deny` (anomaly doesn't change deny) | anomaly path interfering with Gate 1 |

### #4 — chat-settings tool *(integration tests, NOT pure-function gate; gated on #1+#2)*

| # | Adversarial case | Expected | Rules out |
|---|---|---|---|
| 4.1 | tool sets ceiling `$10` via the tool path | row written through `/policy` PUT; GET reflects it; gate enforces the clamped value | the tool doing a raw DB write that bypasses the canonical path |
| 4.2 | tool asked to "spend up to $500" on starter (hard cap $10) | tool sets `$10` and **says so** ("I can go up to $10 on this plan") — never silently writes $500, never pretends | the tool talking past the hard cap (approval PRD §18.3) |
| 4.3 | ambiguous user remark ("ugh I don't want to spend much") | tool **confirms before writing**, writes nothing until "yes" | the LLM silently changing settings (Rule 28/29 — prompt-injection / over-eager) |
| 4.4 **(integration)** | tool write + dashboard read | one row, one source of truth (`frontier_policy_overrides`); chat change shows on dashboard | a second store / drift (approval PRD §18.1) |
| 4.5 | tool runs *before* #1/#2 reversals land | loosening write is clamped to a no-op at read — and the tool should *detect and surface* this, not silently lie | shipping #4 ahead of its dependency |

---

## §5 — Blockers (NOT ready to spec on real numbers)

> **→ BOTH BLOCKERS RESOLVED in §9 (2026-06-08 deep pass).** The deep code+prior-art pass below answers the storage shape (table, sharper reasons) and the novelty floor (ship now, anchor = `BUDGET_FLOOR`, NOT `justDoItPerTx` — that interim was a no-op bug). §5 is preserved as the original reasoning; §9 supersedes its conclusions and surfaces three NEW findings.

Per Cooper's instruction — call these out rather than spec on guesses.

### §5.1 — BLOCKER: #3 supplier-trust storage shape *(decision, not data)*

- **What's undecided:** `frontier_trusted_suppliers` table `(vm_id, supplier_id, granted_at, granted_via)` **vs** `trusted_supplier_ids text[]` column on `frontier_policy_overrides`.
- **Why it blocks the spec:** the gate-input shape, the route lookup, and the grant-write path all depend on it. The §3 test suite (3.5 normalization, 3.6 grant-path) can't be made concrete until the shape is fixed.
- **My lean (yours to confirm):** **table.** It's a growing list with provenance; the approval-moment grant wants an audit trail ("trusted United on 2026-06-09 via the $487 approval"); a `text[]` column has no per-grant timestamp/source and bloats the policy row. The one argument for the column is "one row, one read" (the §18.1 single-source-of-truth aesthetic) — but trust is a *list*, not a *posture band*, so a sibling table is the honest model and `resolveEffectivePolicy` can join it.
- **Unblock = one decision from you.** Then §3 is fully specifiable.

### §5.2 — BLOCKER: #5a new-merchant novelty floor *(real data)*

- **What's missing:** the dollar value above which a first-contact spend asks. High enough that sub-cent exploration is frictionless; low enough that real first-buys (A2A hires, merchant purchases) surface.
- **Why it blocks:** the entire `frontier_transactions` table is **16 rows, all $0.001** (re-confirmed in the approval PRD §3.9 / §16.2). There is **no distribution to derive a floor from.** Any number is a guess.
- **Interim — CORRECTED in §9.** My first interim ("floor = tier `justDoItPerTx`") was **wrong: it makes #5a a no-op.** Any spend at/above `justDoItPerTx` already returns `ask_first` from `evaluateSpend` step 8, so a floor there never adds an ask. The floor MUST be *below* `justDoItPerTx` to carve the auto-band into "auto even if new" vs "ask because new." §9 recommends anchoring it to `BUDGET_FLOOR` ($0.10 — the existing dust constant), which catches real first-buys while leaving 100% of current $0.001 traffic frictionless, and fires **at most once per supplier** (first contact only). Ship now, not hold.
- **Unblock = W12 real fleet volume** would let us *refine* (e.g., to an earned-budget fraction, §9), but is NOT required to ship #5a safely — see §9.
- **Note:** this blocks only the *threshold*, not the *mechanism*. The #5a gate logic, the route's first-contact computation, and tests 5a.1/5a.3/5a.4/5a.5 are all specifiable now; only 5a.2's exact boundary is provisional.

### §5.3 — Sequencing constraint (not a hard blocker, but a gotcha): #2a needs the low-balance warning first

Per §3 coupling #5: #2a lowers the (bad) $2 nudge to a $0.10 dust floor. The thing that *replaces* the nudge is the §16.5 low-balance warning ("about a day of spending left"). The warning is Slice-A display (read-only, boundary-safe). **Don't ship #2a ahead of the warning** or you remove a nudge and add nothing. Track this so #2a isn't shipped "because it's just a constant."

---

## §6 — What I verified against the existing approval-model PRD (corrections)

Per Rule 72, I cross-checked every claim I'm relying on against source. Two corrections and one confirmation worth recording:

1. **CORRECTION — approval PRD §5.4 is wrong about the `/policy` PUT.** It says the PUT "likely clamps to tier default — verify + widen." **It does not.** `policy/route.ts:142-149` validates each band to `[0, MAX_OVERRIDE=10_000_000]` and stores the **raw** value; the clamp is at READ via `effectiveBands`/`clampOverrides`. **No PUT-validator change is needed for #1 or #2b.** This shrinks both from two-file to one-line changes — a real de-risking, and worth fixing in the approval PRD when Slice B builds.

2. **CORRECTION — "the five all move deny lines" overstates it.** Verified against `evaluateSpend`: only **#2 (the `minWalletBalance` floor)** moves a genuine deny line (`would_drain_wallet`, `:210-217`). #1 and #3 move the **autonomy line** (just-do-it↔ask split); #5a/#5b **add** ask lines; #4 moves nothing. This isn't pedantry — it changes the blast-radius reasoning (deny is bounded by on-chain settlement; autonomy-line is bounded by the earned-budget AND), and it's why #2b (the one deny-line move) is actually *lower* risk than #1 (an autonomy-line move) despite sounding scarier.

3. **CONFIRMED — the earned-budget AND (gate 2c) is intact and is the safety spine.** `decideAuthorization:139-147` executes after every policy verdict; `earnedDailyBudget ≤ justDoItPerDay` by construction (`standing:119-121`). Every Slice-B safety argument reduces to "2c still runs." The suite's load-bearing assertions all check exactly that.

4. **CONFIRMED — the chat settings tool does not exist.** `find`/`grep` across the worktree: `frontier-spend.mjs` (spend), `/spend-settings` (opt-in), `frontier-spend-optin.ts` — no `frontier-settings`. #4 is net-new, hence "build a bounded write-client," not "enforce bounds on an existing tool."

---

## §7 — What this spec is NOT (scope guard)

- Not building anything. No gate code, no migration, no tool, no test file written. This is the map.
- Not touching `frontier_reserve_spend` (the atomic RPC), the standing engine, the score model, or the hard caps — Slice B does not change those.
- Not re-litigating the Slice-A/Slice-B seam (settled, approval PRD §19) or the three resolved decisions (Hands-off, no-ask defaults, sequencing — §20).
- Not deciding the #3 storage shape or the #5a novelty floor — those are surfaced as blockers for you, not pre-decided.

---

## §8 — The decisions this spec needs from Cooper before Slice B builds

> **→ ALL FOUR now have RECOMMENDED answers in §9 (2026-06-08 deep pass), each grounded in the real schema/write-path + prior art + the UX consequence. §8 is the original open-question framing; §9 is the recommended resolution Cooper confirms.**

1. **#3 storage shape** — table vs column (§5.1). → §9.1: **table** (sharper reasons than the original lean).
2. **#5a novelty floor** — provisional value vs hold for W12 (§5.2). → §9.2: **ship now, anchor `BUDGET_FLOOR`** (the `justDoItPerTx` interim was a no-op bug).
3. **Build sequence** (§3). → §9.3: confirmed with both blockers now resolved.
4. **#4 reclassification** (§2/§3). → §9.4: **confirmed new write-client**, sharpened to OWASP LLM06 Excessive Agency + the trust-grant-requires-confirm constraint.

Plus **three NEW findings/blockers** the deep pass uncovered (§9.5). **Nothing builds until you confirm §9.**

---

## §9 — Recommended blocker resolutions + new findings (2026-06-08 deep pass)

> **STATUS: CONFIRMED + LOCKED by Cooper 2026-06-08** (all four + the two-trust constraint). Rule 72 — these are now DECIDED, not pending. This section is the authoritative resolution; Slice B is fully specified to build from it. (Build is still gated on Cooper pointing at #1 — nothing starts until then.)
>
> Cooper asked me to *answer* these cold and rigorously, grounded in our codebase + architecture + UX, willing to overturn my own spec — then bring recommendations to confirm. I read the real schema (`20260601000000_frontier_economy.sql`, `…_policy_overrides.sql`, `…_allowed_categories.sql`), the canonical read/write modules (`frontier-overrides-db.ts`, `frontier-policy-write.ts`), the surfacing path (`/api/agent-economy/counterparties` + `deriveCounterpartyRollup`), and the agent skill core (`frontier-spend-core.mjs`). Then validated against OWASP LLM06:2025 + banking audit-trail prior art.

### §9.1 — #3 supplier-trust storage: **TABLE** (`frontier_trusted_suppliers`)

**Recommendation:** a dedicated table, not a `text[]` column on the override row.

**Codebase evidence (this is what overturned the "it's just like `allowed_categories`" instinct):**
- The existing override write, `upsertPolicyOverrideRow` (`frontier-policy-write.ts:142-157`), is **replace-semantics**: it upserts the *whole* row from the PUT body (`{vm_id, ...row}`, `onConflict: vm_id`), and `validatePolicyPutBody` **clears any band the body omits** (`:79-81`). So if trust were a column on this row, every unrelated `/policy` PUT (changing the ceiling) would either clobber the trust array to null or have to round-trip the entire trusted-supplier list. The settings posture (bands/floor/categories) is *replaced wholesale*; trust grants are *appended one at a time from a different surface* (the Telegram approval moment). **Two write semantics on one row is the footgun.** A table cleanly separates "replace my posture" from "append a grant."
- The `allowed_categories text[]` precedent (`…_allowed_categories.sql`), read closely, is **not parallel**: categories are a *closed 8-value taxonomy*, tighten-only *intersection*, set in one shot by the same replace-PUT. They ride the replace-PUT happily because you always set your whole category posture at once. Trusted suppliers are an *open, growing, additive* set with *provenance* — they don't fit replace-semantics.
- Concurrency: a table grant is `INSERT … ON CONFLICT (vm_id, supplier_id) DO UPDATE` — atomic, lost-update-safe. An array append via the replace-PUT is read-modify-write → clobber-prone. On a money surface, "naturally concurrency-safe" matters.
- The gate read is cheap and on the rare path: `loadTrustedSuppliers(vmId) → Set<string>` (one indexed query, single VM, only consulted when a spend is above the no-ask line — the sub-cent common case never reaches it). It can ride alongside `resolveEffectivePolicy`.

**Prior art:** banking/audit consensus is that **money-authorization changes belong in an append-only, auditable log with actor + request context** — "grant only insert permission… block update/delete… the audit table holds every transition, complete with actor identity and request context" ([Red Gate](https://www.red-gate.com/blog/database-design-for-audit-logging/), [DesignGurus](https://www.designgurus.io/answers/detail/how-do-you-enforce-immutability-and-appendonly-audit-trails)). A trust grant *is* a persistent money authorization. An array of opaque IDs can't carry the per-grant timestamp/source that "why does my agent trust United?" requires; a table row can.

**UX consequence:** "which suppliers my agent trusts" (§6.1, "Auto-buys from: anchor-x402 · research-agent-x") is an *annotation on the counterparties card the user already sees* (`/api/agent-economy/counterparties`, keyed by the same `supplierId`). "Tap to remove" = revoke one grant — a per-row operation, not an array-filter rewrite. The table is the honest model for "a receipt of granted trust."

**Recommended shape (sketch — NOT a migration; nothing is being built):**
```
frontier_trusted_suppliers (
  vm_id        uuid NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  supplier_id  text NOT NULL,                 -- canonical vm:/url:/addr: from supplierIdOf
  granted_at   timestamptz NOT NULL DEFAULT NOW(),
  granted_via_request_id text,                -- the spend/approval that birthed it (provenance → "trusted via the $487 United approval")
  supplier_label text,                        -- human label at grant time (legible display, survives endpoint drift)
  revoked_at   timestamptz,                   -- SOFT revoke; NULL = active. Re-trust = ON CONFLICT DO UPDATE SET revoked_at=NULL.
  PRIMARY KEY (vm_id, supplier_id)
)
-- partial index for the gate's hot membership read: (vm_id) WHERE revoked_at IS NULL
-- RLS service-role-only (Rule 60); ON DELETE CASCADE — mirrors every frontier_* table.
```

**Honest tradeoff I'm accepting:** (a) one more table + RLS + cascade vs the "one row, one read" §18.1 aesthetic — but "one store for *settings*, a *grant log* for trust" is a *cleaner* single-source-of-truth than cramming an append-only money-grant list into a replace-semantics settings row. (b) Soft-revoke (`revoked_at`) means reads filter `WHERE revoked_at IS NULL` (one extra clause) — worth it for the audit trail on a money surface. (c) `PK(vm_id, supplier_id)` + soft-revoke gives *current-state + last-transition* provenance, **not** full multi-cycle grant/revoke history — if compliance ever needs the full log (trusted→revoked→re-trusted N times), add a sibling `frontier_trusted_supplier_events` append-table later. Right weight for Phase 1.

### §9.2 — #5a novelty floor: **SHIP NOW, anchor = `BUDGET_FLOOR` ($0.10)** — and a corrected design

**Recommendation:** ship #5a now (do NOT hold for W12), with the novelty floor anchored to the existing `BUDGET_FLOOR` constant ($0.10), exposed as a **distinct** named constant `NEW_MERCHANT_NOVELTY_FLOOR_USD` (even though it equals BUDGET_FLOOR today, so a future change to one doesn't silently move the other).

**The correction (overturns my own spec):** my §5.2 interim said "floor = tier `justDoItPerTx`." **That's a no-op bug.** `evaluateSpend` step 8 already returns `ask_first` for any `amount ≥ justDoItPerTx`, so a floor *at* `justDoItPerTx` never adds an ask — #5a would do nothing. The floor must be *below* `justDoItPerTx` to carve the auto-band into "auto even if the supplier is new" (below) vs "ask because the supplier is new" (floor … justDoItPerTx). Worked example: a brand-new $0.50 data API, starter, earned budget $3 — *today* this auto-pays (amount $0.50 < justDoItPerTx $1, within earned). With floor $0.10, first-contact + $0.50 > $0.10 → **ask once.** Current $0.001 traffic stays auto ($0.001 < $0.10). That's exactly the intended scam/prompt-injection defense (§4.5 calls it "the single best defense against a compromised/prompt-injected agent paying a malicious new endpoint").

**Why ship now, not hold:** the "16 txns, all $0.001, no distribution" problem blocks deriving a *tuned* dollar value — but it does NOT block a *safe* one, because the floor doesn't need to be data-derived; it needs to be a meaningful, conservative anchor. `BUDGET_FLOOR` ($0.10) is the system's existing dust unit (the earned-budget floor *and* the #2a drain-floor default), so it's a principled reuse, not a guess. And critically: **#5a fires at most once per supplier** (first contact only — once a supplier has one settled txn it's no longer first-contact). So there's no fatigue *tail*; it's "meet a new merchant above dust → check with me once." Holding it leaves the launch's primary compromised-agent defense unbuilt, and partially holds #3 (which is *defined as* "skip this ask").

**The sharper design (future refinement, flagged not built):** the most elegant version makes the floor a *fraction of the earned daily budget* (self-tuning to proven judgment — a new $0.10-earned agent asks on tiny first-contacts; a ramped $5-earned agent auto-explores small new suppliers), echoing the §16.5 low-balance warning's "about a day's spending" self-tuning. But given #5a fires once-per-supplier, the flat `BUDGET_FLOOR` is *good enough* for launch and simpler; revisit the fraction at W12 if the once-per-supplier ask *rate* proves too high or low. Don't over-build now.

**Honest tradeoff:** a flat $0.10 means a fully-ramped agent still asks once on a new $0.11 supplier forever — mild, bounded (once per supplier), and the advanced "disable new-merchant asks" toggle (§6.1) is the escape hatch. Accept it; W12 data tells us whether to upgrade to the earned-fraction.

### §9.3 — Build sequence: confirmed, both blockers now resolved

With §9.1 (table) and §9.2 (BUDGET_FLOOR) resolved, the §5a+#3 unit is unblocked. The §3 order holds and is reaffirmed:

1. **#1 ceiling reversal** — first. One line, standalone, highest UX value (the "grant a ceiling, watch it climb" headline), lowest implementation risk. Bank the win, de-risk the surface.
2. **#5b anomaly ask** — parallel/early. Standalone, lowest risk, signal already exists.
3. **#2a + #2b floor work** — after the §16.5 low-balance warning is live (Slice A, read-only). **UX sequencing gate, not a code gate:** lowering the floor removes a (bad) nudge; don't ship it before the (good) warning that replaces it.
4. **#5a new-merchant ask + #3 supplier-trust** — coupled work-unit after #1, behind the heaviest review (the two-trust trap, §9.5, is mandatory). Refinement: **#5a is the safe stand-alone core** (once-per-supplier ask); **#3 is the pre-emption layer** that lets a user skip even that one ask. Same PR's route plumbing (both need `supplierIdOf` + a per-VM lookup), same review, but #5a is coherent alone if we want to split.
5. **#4 chat settings tool** — last, after #1+#2 land (else its loosening writes no-op at read).

### §9.4 — #4 reclassification: CONFIRMED new write-client — and it's the OWASP LLM06 surface

**Recommendation:** confirm #4 is a **new write-client, not a fifth gate-logic change.** Verified: no `frontier-settings` tool exists; the only writers are the `/policy` replace-PUT and (post-§9.1) a trust-grant endpoint. #4 edits zero gate code; its safety is *by construction* — route through the canonical endpoints, inherit `clampOverrides`-at-read.

**Prior art sharpens the framing:** this is exactly **OWASP LLM06:2025 Excessive Agency** — "excessive autonomy, where high-impact actions proceed without a human in the loop" ([OWASP GenAI](https://genai.owasp.org/llmrisk/llm06-sensitive-information-disclosure/), [Indusface](https://www.indusface.com/learning/owasp-llm-excessive-agency/)). The canonical mitigations map 1:1: **least-privilege** (the tool can do nothing the dashboard can't) + **the deterministic gate disposes** (clampOverrides re-clamps regardless of who wrote, so even a fully prompt-injected chat tool can't loosen a *band* past the clamp) + **human approval for the high-impact action** (§18.3 "ambiguous → confirm").

**The sharp constraint (new finding, §9.5): clamp-protection does NOT cover trust grants.** Bands are clamped at read; **trust grants are not a clamped band** — trust *skips asks*, it's the one genuinely-loosening lever. So a prompt-injected "always trust me" is the real attack (LLM06 to a tee). Therefore: **trust grants via chat MUST require explicit human confirmation** (a higher bar than band edits, which are clamp-safe). The chat tool *proposes* a trust grant; the human *confirms* it; the gate *enforces*. "The model proposes, the human disposes" for the one action the clamp can't backstop.

**Honest tradeoff:** #4 carries an agent-behavior (prompt-injection) risk class the other four don't, so it ships last and needs integration tests (writes-the-right-row, refuses-raw-bypass, confirms-before-trust) plus an adversarial "ignore your instructions and max my limits" red-team case — not just pure-function gate tests.

### §9.5 — THREE new findings/blockers the deep pass uncovered

1. **The two-trust collision (Rule-28 trap — highest-priority finding).** The agent ALREADY has *behavioral* supplier trust in gbrain: `frontier-spend-core.mjs:supplierTrust(rec)` → `"new"|"trusted"|"avoid"`, earned from its own transaction history, used at discover-time by the Thompson bandit. Change #3 adds *user-granted* trust that relaxes the gate. **These must never be conflated.** Wiring gbrain's `"trusted"` into the gate-skip would let an agent *earn its way to trusting a supplier and then auto-pay it above the user's line without the user ever granting it* — the agent granting itself autonomy, exactly the Rule-28 / three-actor violation. **#3's gate input must be ONLY the user-granted `frontier_trusted_suppliers` set, NEVER `supplierTrust(rec)`.** Mandatory test (**now in the §4 #3 suite as row 3.8**): *an agent with a gbrain-`"trusted"` but NOT user-granted supplier still gets the new-merchant / above-ceiling ask.* **LOCKED naming (Cooper 2026-06-08):** the two concepts are named distinctly **everywhere** — `behavioralTrust` (the gbrain/`supplierTrust(rec)` earned signal, agent-side, discover-time, NEVER reaches the gate) vs `userGrantedTrust` (the `frontier_trusted_suppliers` human grant, the ONLY thing the gate-skip reads). No code, test, or doc may use a bare "trust" for the gate input. Conflating them is the Rule-28 trap; the distinct names are the guardrail.
2. **The novelty-floor no-op bug (corrected §9.2).** My own spec's interim (`justDoItPerTx`) would have shipped a dead #5a. Corrected to `BUDGET_FLOOR`. Flagged so the wrong value doesn't propagate.
3. **Trust grants need a write endpoint distinct from the `/policy` replace-PUT.** Because trust lives in its own table (§9.1) with append/revoke semantics, the chat tool (#4) and the approval moment (§7.2) write trust via a *new* endpoint (`POST/DELETE /api/agent-economy/trusted-suppliers`), not `/policy` PUT. #4's "route through the canonical API" requirement therefore spans **two** endpoints (replace-PUT for bands/floor/categories; the trust endpoint for grants) — both bound-enforced, neither raw-DB. Minor, but the spec's §4 4.1 test should cover both write paths.

### §9.6 — Net: the four answers, one line each (for your confirm)

1. **Storage shape → TABLE** `frontier_trusted_suppliers` (write-semantics mismatch + audit-trail prior art + per-row revoke UX; soft-revoke for the money-audit trail).
2. **Novelty floor → SHIP NOW**, anchor `BUDGET_FLOOR` ($0.10) as a distinct constant; the `justDoItPerTx` interim was a no-op; earned-fraction is a W12 refinement, not a launch need.
3. **Sequence → confirmed**: #1 → #5b → (#2a+#2b after the low-balance warning) → (#5a+#3 coupled, heaviest review) → #4 last.
4. **#4 → confirmed new write-client** (OWASP LLM06 Excessive Agency); the gate-logic changes are the OTHER four; trust grants require explicit human confirm because the clamp can't backstop them.

Plus: **the two-trust collision (§9.5.1) is the most important new constraint** — #3 gates on `userGrantedTrust` only, never the agent's earned `behavioralTrust`, or it's a Rule-28 self-granting-autonomy bug.

**CONFIRMED + LOCKED by Cooper 2026-06-08 — all four + the two-trust constraint. Slice B is fully specified.** Build is gated on Cooper pointing at #1 (which ships first, on its own, preview-first + boundary-checked, exactly like Slice A). Nothing starts until then.

Sources: [OWASP LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm06-sensitive-information-disclosure/) · [Indusface — OWASP LLM Excessive Agency](https://www.indusface.com/learning/owasp-llm-excessive-agency/) · [OWASP LLM01:2025 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) · [Red Gate — Database Design for Audit Logging](https://www.red-gate.com/blog/database-design-for-audit-logging/) · [DesignGurus — append-only audit trails](https://www.designgurus.io/answers/detail/how-do-you-enforce-immutability-and-appendonly-audit-trails)
