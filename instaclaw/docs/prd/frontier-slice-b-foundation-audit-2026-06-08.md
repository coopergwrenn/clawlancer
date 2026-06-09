# Frontier Slice B — pre-build foundation audit (the gate as it stands on `origin/main`, before any deny-line moves)

**Date:** 2026-06-08
**Status:** AUDIT — read + reason + verify only. **Zero gate code. Nothing committed beyond docs.** Gate verdict: **FOUNDATION SOUND — build #1 with confidence.** No cracks. Two doc-accuracy corrections found + applied to the spec (a stale line citation; an incomplete blast-radius enumeration). One test to add when #1 ships.
**Author:** frontier terminal (econ-surface worktree).
**Companion to:** `frontier-slice-b-spec-2026-06-08.md` (the locked Slice B spec). This audit turns that spec from "carefully reasoned" into "verified against live `origin/main` code," before #1 (the `clampOverrides` ceiling reversal) builds on top of it.

> **Verification basis (load-bearing).** Every claim below was checked against `origin/main` at `ba434794`, fetched fresh. My branch tip (`c57a75fa`) differs from main, but `git diff origin/main` confirms **all 8 gate files are byte-identical to `origin/main`** (`frontier-policy.ts`, `frontier-authz.ts`, `frontier-standing.ts`, `frontier-ledger.ts`, `frontier-overrides-db.ts`, `frontier-policy-write.ts`, `authorize/route.ts`, `policy/route.ts`). So the spec's citations were against deployed code, and nothing moved the gate under the spec — except the one stale citation in §3 below, which traces to reading a *different worktree's* older copy.

---

## §0 — Verdict table

| # | Area | Verdict | One-line |
|---|---|---|---|
| 1 | Load-bearing invariant (gate 2c unconditional on every autonomous path) | **PASS — proven, double-enforced** | 2d is unreachable without 2c; the earned budget 2c compares against depends on `justDoItPerDay` not `justDoItPerTx`, so #1 can't move it; a second atomic enforcement (reserve RPC) re-checks earned. |
| 2 | Slice A regression (f7b691d2 + 4c91f73f changed zero gate behavior) | **PASS** | Both commits touched zero gate files; gate is byte-identical to `origin/main`; the two-guard property (tighten-only controls + read-clamp) holds today. |
| 3 | Spec-vs-reality drift (every load-bearing citation) | **PASS — 1 STALE citation, corrected** | All gate citations confirmed at current lines; §1.5's `policy/route.ts:142` PUT-validator ref is stale (GAP-4 moved it to `frontier-policy-write.ts`). Substance unchanged; citation fixed. |
| 4 | #1 blast radius (every reader of the shared clamp/`justDoItPerTx`) | **PASS — 1 spec-completeness gap, corrected** | The clamp is reached only via `effectiveBands`; its 3 enforcement callers are accounted for. Found a 4th reader of `justDoItPerTx` the spec missed — `frontier-headroom.ts` — but it's display-only + earned-bounded + gate-consistency-tested. No hidden enforcement reader. |
| 5 | Senior-reviewer extras (RPC / reconciler / .mjs / RLS / concurrency / staker) | **PASS — 6 sub-checks** | The reserve RPC *strengthens* the foundation; no reconciler reads the bands; the agent `.mjs` defers to `/authorize` as sole authority; RLS is service-role-only; the override-row write is unchanged by #1; the staker seam is inert (staking not live). |

**Net: the foundation #1 ships onto is sound. The two findings are spec-accuracy corrections (Rule 72 — keep the map true), not cracks.** Greenlight #1.

---

## §1 — Load-bearing invariant: gate 2c is unconditional on every autonomous path  ·  **PASS**

**The claim under test (the spine of the whole Slice B suite):** a widened band never auto-spends above the earned budget — i.e., `decideAuthorization` gate 2c (`projected > earned → ask_first`) executes on *every* autonomous path, and the earned budget it compares against is independent of any band #1 widens.

**Evidence — full path trace of `decideAuthorization` (`frontier-authz.ts:95-170`), verified line-by-line:**

```
:107  Gate 1   if evaluation.decision === "deny"  → return deny            (no auto-spend)
:114  Gate 3   if humanApproved                   → return authorized       (human's authority; NOT autonomous)
:127  Gate 2a  if evaluation.decision==="ask_first"→ return ask_first        (not authorized)
:132  Gate 2b  if !categoryKnown                  → return ask_first        (not authorized)
:139  Gate 2c  if projected > earned              → return ask_first        ← THE KEYSTONE
:158  Gate 2e  if anomalyFlag === true            → return ask_first        (velocity_anomaly; #5b — downstream of 2c)
:163  Gate 2d  (fallthrough)                      → return authorized (mode:"autonomous")
```

The autonomous authorization (2d, `:163-169`) is reachable **only by falling through 2c (`:139`)**. There is no branch between Gate 3 and 2d that returns `authorized` except 2d itself, and every intervening gate (2a, 2b, 2c) returns *not-authorized* on its trigger. **Therefore `outcome:"autonomous"` is logically unreachable unless 2c evaluated `projected > earned` as false.** Proven, not asserted.

**The one path that skips 2c is Gate 3 (`humanApproved`, `:114-122`) — and it is BY DESIGN and NOT a #1 concern.** `humanApproved=true` means the human approved *this specific spend*; the bypass is the human's authority exercised above the agent's earned ceiling (the docblock states this at `:30-32`). It is *not* autonomous spend. #1 widens the autonomous no-ask line (`justDoItPerTx`); it has zero interaction with `humanApproved`. The invariant is precisely scoped to autonomous spend, and on that path 2c is unconditional.

**Why #1 cannot move the earned budget that 2c compares against (the critical sub-proof):** the earned budget is computed by `creditStanding` (`frontier-standing.ts:104-137`). Its tier cap reads **`effectiveBands(...).justDoItPerDay`** (`:119`) — the *daily* band, not the per-tx band. #1 reverses the `justDoItPerTx` clamp (`frontier-policy.ts:84`) **only**; `justDoItPerDay` (`:85`) stays tighten-only and is computed independently (`:85` does not reference `justDoItPerTx`). So:
- `tierCap` (`:119`) is invariant under #1 → `cap` (`:121`) invariant → `earnedDailyBudgetUsd` (`:127,:132`) invariant.
- Raising `justDoItPerTx` makes *more amounts* return `just_do_it` from `evaluateSpend` (amounts in `(old-ceiling, new-ceiling)` that used to be `ask_first`) — but each then hits an unchanged 2c and is re-gated against an unchanged earned budget. **Widening raises *candidacy* for autonomy, never *realized* autonomy.** Exactly the spec's safety proof, now confirmed at code level.

**Second, independent enforcement (defense in depth — this *strengthens* the verdict):** after `decideAuthorization` authorizes, the route reserves via the `frontier_reserve_spend` RPC, which **re-enforces the earned budget atomically under a per-VM advisory lock** (`20260602210000_frontier_reserve_spend.sql:63`: `IF (NOT p_human_approved) AND (v_committed + p_amount) > p_cap_earned → reserved:false, exceeds_earned_budget`) and the hard daily ceiling (`:59`, always binds). The RPC receives `p_cap_earned = decision.earnedDailyBudgetUsd` (invariant under #1) and `p_cap_daily = neverPerDay` (tighten-only, untouched by #1). So the earned budget is enforced **twice** — gate 2c (TS) and the reserve RPC (SQL, atomic) — and #1 touches neither's inputs. The RPC never even sees `justDoItPerTx` (it governs daily aggregates, not the per-tx no-ask decision).

**Verdict: PASS.** 2c is unconditional on the autonomous path; the earned budget is independent of `justDoItPerTx`; a second atomic enforcement backs it up. No branch lets a widened band reach auto-spend without 2c. **No foundation crack.**

---

## §2 — Slice A regression: did the live controls/feed ships change gate behavior?  ·  **PASS**

**The claim under test:** Slice A (`f7b691d2` controls + `4c91f73f` feed copy) is on `origin/main` and changed zero gate behavior; the two-guard property holds against *current* main, not against main-when-I-shipped.

**Evidence:**
- `f7b691d2` = *"feat(economy): Slice A spend-approval controls (contract sentence + presets + reserve-raise + low-balance states)"*; `4c91f73f` = *"feat(economy): §8 value-led feed copy."* A diff-grep of both commits for any gate-file path (`frontier-policy`/`frontier-authz`/`frontier-standing`/`frontier-overrides`/`frontier-policy-write`/`authorize/route`/`frontier-ledger`) returns **empty** for both — **neither commit touched a gate file.**
- The gate files are **byte-identical to `origin/main`** (the §0 verification basis). So the gate that's deployed today is the gate the spec was written against.
- The two-guard property held at audit time (pre-#1): `clampOverrides` (`frontier-policy.ts:72-87` post-#1) was tighten-only on all five bands — ceilings `min(base, override)` (`:75-76`), floor `max(base, override)` (`:77`), no-ask lines (`:84-85`); Slice B #1 has since reversed `justDoItPerTx` (`:84`) to `min(neverPerTx, override)` — the other four stay tighten-only. Slice A's controls write through `/policy` PUT → `upsertPolicyOverrideRow` (stores raw) → the read-clamp neutralizes any loosening. Confirmed intact.

**Verdict: PASS.** Slice A is read-path + components only; the gate is unchanged and the two-guard property is live.

---

## §3 — Spec-vs-reality drift: re-verify every load-bearing citation  ·  **PASS (1 STALE, corrected)**

**Confirmed at current `origin/main` lines (grep -n):**

| Spec citation | Reality on `origin/main` | Status |
|---|---|---|
| `clampOverrides:72-87`, `justDoItPerTx` clamp `:84`, `minWalletBalance` `:77`, `justDoItPerDay` `:85` | `clampOverrides` at `:72`; `:77`/`:84`/`:85` (post-#1) | ✓ |
| `effectiveBands:132`, clamp call `:147` | `:132`, `:147` | ✓ |
| `evaluateSpend:164`; per-tx hard deny `:203`; just-do-it split `:220-221` | `:164`, `:203`, `withinJustDoIt :220` | ✓ |
| `decideAuthorization:95`; humanApproved `:114`; categoryKnown `:132`; gate 2c `:139`; gate 2e `:158`; autonomous `:163-169` | all exact (post-#5b) | ✓ |
| `creditStanding` earned budget `:104-137`, tierCap `:119` | `tierCap = effectiveBands(...).justDoItPerDay` at `:119` | ✓ |
| `upsertPolicyOverrideRow (frontier-policy-write.ts:142-157)` (cited in §9.1) | `upsertPolicyOverrideRow` at `:142`, upsert `:150` | ✓ |
| **§1.5: `/policy` PUT validator at `app/api/agent-economy/policy/route.ts:117-226`, band validation `:142`, stores raw `:148-149`** | **STALE.** GAP-4 (`178a0ff5`) extracted validation to `frontier-policy-write.ts`: the route now *delegates* (`policy/route.ts:39` imports, `:168` calls `validatePolicyPutBody`, `:174` calls `upsertPolicyOverrideRow`). The actual validation (`raw < 0 \|\| raw > MAX_OVERRIDE`) is at **`frontier-policy-write.ts:83`**, `MAX_OVERRIDE=10_000_000` at **`:28`**, raw-store + replace-semantics (`row[snake]=null` clears; `upsert(..., {onConflict:"vm_id"})`) at **`:80,:150`**. | **STALE → fixed** |

**Root cause of the one stale citation:** when writing the spec I read the `/policy` route from the **frontier-policy worktree** (`/Users/cooperwrenn/wild-west-bots-frontier-policy/…`), whose copy still had the validator *inline* at `:142` (pre-GAP-4). `origin/main` (and the econ-surface worktree where #1 builds) has the GAP-4 extraction. **The spec's substantive conclusion is unaffected and remains correct:** the PUT stores raw `[0, 10M]` and the clamp is at read, so **#1 needs no PUT-validator change** — that claim holds verbatim against `frontier-policy-write.ts:83` + `:150` + `clampOverrides`. Only the file/line pointer was wrong.

**Correction applied:** spec §1.5 + §9.1 re-pointed at `frontier-policy-write.ts:28/67/83/142-165` (the GAP-4 home), with a note that the route delegates. Doc-only.

**Verdict: PASS.** All load-bearing gate citations verified; one stale file/line pointer (correct substance) found and fixed — exactly the drift this audit exists to catch.

---

## §4 — #1 blast radius: every reader of the shared clamp + `justDoItPerTx`  ·  **PASS (1 completeness gap, corrected)**

**The claim under test:** flipping `clampOverrides:76` from tighten-only to allow-raise-up-to-`neverPerTx` widens *only* the autonomous per-tx no-ask line, and nothing else that reads the shared seam is accidentally widened.

**The shared seam is `effectiveBands` (the only path to `clampOverrides`, `:147`). Its complete caller set (grep, repo-wide):**

| Caller | Reads | Effect of #1 | Verdict |
|---|---|---|---|
| `evaluateSpend` (`frontier-policy.ts:165`) | full bands incl. `justDoItPerTx` | **intended widen** — this is the no-ask line #1 raises | ✓ as designed |
| `creditStanding` (`frontier-standing.ts:119`) | **`.justDoItPerDay` ONLY** | **none** — #1 touches `justDoItPerTx`, not `justDoItPerDay`; earned budget invariant (proven §1) | ✓ unaffected |
| `policy` GET (`route.ts:102`) + PUT (`:190`) | full bands, for display/echo | shows the raised ceiling as effective — **correct** (the dashboard should reflect the user's set ceiling) | ✓ intended display |

**The spec's blast-radius enumeration was INCOMPLETE — a 4th reader of `justDoItPerTx` exists that the spec did not name:** `frontier-headroom.ts:116` —
```
perPurchaseCapUsd: r6(Math.min(input.bands.justDoItPerTx, effectiveMaxToday))
```
**Investigated: it is display-only, earned-bounded, and gate-consistency-tested — NOT an enforcement path, so not a crack.** Evidence:
- `autonomousHeadroom` is a **pure display computation** ("what can this agent spend right now," for the `/economy` headroom card). Its docblock (`:1-19`) states it must stay gate-consistent and is asserted so in `scripts/_test-frontier-headroom.ts` (confirmed present).
- Its **only caller is `policy` GET (`route.ts:122`)** — the dashboard display. It is **not** in the `authorize` gate path. It takes already-computed `bands` as input; it does **not** call `effectiveBands`/`clampOverrides` itself and authorizes nothing.
- `perPurchaseCapUsd = min(justDoItPerTx, effectiveMaxToday)` where `effectiveMaxToday = min(earnedRemaining, dailyLimitRemaining, walletHeadroom)` (`:92,:104,:116`). So after #1, a user who raises `justDoItPerTx` to $10 with earned $3 sees `perPurchaseCapUsd = min($10, $3) = $3` — **the honest, earned-bounded headroom.** The display widens its ceiling input but the surfaced number stays bounded by what the agent has actually earned. This is *correct* UX, not a leak: "your ceiling is $10; you can act on $3 of it right now."

**Critical confirmation: no hidden ENFORCEMENT reader of `justDoItPerTx`.** The only consumers are `evaluateSpend` (the gate — intended), `frontier-headroom` (display — earned-bounded), and the policy route (display/echo). The remaining grep hits (`frontier-policy-write.ts:39`, `frontier-overrides-db.ts:34`) are the snake↔camel `FIELD_MAP` (storage plumbing, not a band-value reader). **Blast radius = exactly what the spec claims plus the display surfaces that *should* reflect the new ceiling. Confirmed tight.**

**Corrections applied (doc-only):** (a) spec §9.1/blast-radius now lists `frontier-headroom.ts` as the 4th (display-only, earned-bounded) reader. (b) Added a Rule-31 test note for #1: when the ceiling reversal ships, `scripts/_test-frontier-headroom.ts` gains a *raised-ceiling* case proving `perPurchaseCapUsd` stays `min(raised-ceiling, earned-remaining)` = earned-bounded (the display-side analog of authz test 1.1).

**Verdict: PASS.** #1's blast radius is exactly the autonomous no-ask widen + the display surfaces that correctly reflect it; the earned budget and every other band are provably untouched. The one reader the spec missed is a display path that stays honest under #1.

---

## §5 — Senior-reviewer extras (the risk classes Cooper named + the ones I'd add)  ·  **PASS (6 sub-checks)**

1. **Atomic reserve RPC (the backstop) — STRENGTHENS the foundation.** `frontier_reserve_spend` re-enforces `earned` + hard `daily` under a per-VM advisory lock (§1). It is a second, independent enforcement of the earned budget that #1 cannot weaken (it never reads `justDoItPerTx`; its caps are invariant under #1). The route prefers the RPC and falls back to a plain insert only if the migration is absent (`authorize/route.ts:484-526`) — confirm the RPC is applied in prod before #1 ships so the atomic path (not the TOCTOU-vulnerable fallback) is live. *(The spec's master PRD notes it was verified live in prod 2026-06-08; re-confirm at #1 ship.)*
2. **Reconciler / cron view of widened bands — NONE.** Grep confirms **no `app/api/cron/*` or `lib/vm-reconcile.ts` reads `frontier_policy_overrides`.** The spend bands are purely app-layer (the `authorize` gate + the `policy` route). The VM reconciler has no concept of spend bands, so #1 has zero fleet/reconciler interaction — a raised ceiling can't drift a VM's `config_version` or trip any reconciler step. PASS.
3. **Agent-side `.mjs` reading stale bounds — NONE; it defers to the server gate.** `frontier-spend.mjs` runs probe→authorize→pay→settle and states "`/authorize` remains the sole budget authority" (`:273-274`). It pays **only** when `d.authorized` (`:359-366`); on `!authorized` it narrates the ask/deny and stops. Its local `maxAmountUsd` (`selectPaymentRequirement`, `:315`) is a **pre-filter** for which x402 requirement to consider — fail-safe (it can only make the agent *more* conservative than the server gate, never less). So a raised ceiling carries no agent-side stale-bounds risk; worst case the agent under-exercises a new ceiling until its local context catches up (conservative). PASS. *(Minor UX note for #1's ship: confirm where the agent sources its local pre-filter ceiling so a raised user ceiling is actually exercised — but it's fail-safe either way.)*
4. **RLS gaps — NONE.** `frontier_policy_overrides` has RLS enabled, **service-role-only** (`20260601130000_…:35-38`), matching every `frontier_*` table. The gate + dashboard read/write via the service key; there is no anon/authenticated policy (deny-by-default). #1 changes no storage access. PASS. *(Forward note: the #3 `frontier_trusted_suppliers` table must carry the same service-role-only RLS — already in the spec §9.1 sketch.)*
5. **Concurrency on the override row — unchanged by #1, acceptable as-is.** The override write is replace-semantics last-write-wins (`upsertPolicyOverrideRow:150`, `onConflict:"vm_id"`); two simultaneous dashboard PUTs → last wins (acceptable for a settings posture, approval-PRD §18.4). #1 is a read-time clamp change; it does not touch the write path, so it introduces no new concurrency surface. PASS. *(This is, separately, the exact reason #3's trust grants belong in their own append-table — but that's #3, not #1.)*
6. **Staker multiplier seam — inert today, flagged for when staking ships.** `effectiveBands` (`:138-146`) applies a 2× ceiling multiplier *before* `clampOverrides` when `isStaker`. `is_staker` is **hardcoded false everywhere** (staking not live — `policy/route.ts:96,:211`, `authorize/route.ts:394`). So the staker path is out of #1's blast radius today. **Flag:** when staking goes live, the earned-budget cap (which reads `effectiveBands(...).justDoItPerDay`) will 2× for stakers — orthogonal to #1, but the same `effectiveBands` seam, so re-audit the interaction at staking launch.

**Verdict: PASS.** Every named risk class checks out; the reserve RPC actively strengthens the invariant; two forward-notes (RPC-applied-in-prod confirm; staker re-audit at staking launch) are logged, neither blocking #1.

---

## §6 — Corrections applied to the spec (Rule 72 — doc-only, this audit's output)

1. **§1.5 + §9.1 stale citation:** `/policy` PUT validator re-pointed from `policy/route.ts:142` → `frontier-policy-write.ts:28/67/83` (`MAX_OVERRIDE`, `validatePolicyPutBody`, the range check) + `:142-165` (`upsertPolicyOverrideRow`), noting the route delegates post-GAP-4. Substance unchanged; #1 still needs no validator change.
2. **§9.1 / #1 blast-radius:** added `frontier-headroom.ts:116` as the 4th reader of `justDoItPerTx` (display-only, earned-bounded, gate-consistency-tested) so the blast-radius enumeration is complete and true.
3. **#1 test plan:** added a `_test-frontier-headroom.ts` raised-ceiling case (display stays earned-bounded) alongside the authz 1.1 (autonomous stays earned-bounded) — the display-side mirror of the load-bearing invariant.

---

## §7 — Bottom line

**No cracks. The gate's load-bearing invariant is proven (not asserted) and double-enforced (gate 2c + the atomic reserve RPC). The earned budget that gates autonomy is provably independent of the per-tx ceiling #1 widens. Slice A changed nothing in the gate. The blast radius of #1 is exactly the autonomous no-ask widen plus the display surfaces that should reflect it.** The audit found two doc-accuracy issues in the spec (a stale line citation, an incomplete reader list) and fixed both — the foundation itself is sound.

**Build #1 with confidence** — preview-first, boundary-checked, behind its Rule-31 suite (now including the headroom display-bound case), exactly like Slice A. Gated, as locked, on Cooper pointing at #1.
