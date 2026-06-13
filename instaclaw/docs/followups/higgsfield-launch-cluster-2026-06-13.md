# Higgsfield launch cluster — mini-PRD / tracking doc (2026-06-13)

**Status:** PLAN ONLY. Nothing in here is executed. Single source of truth for the
threads converging on the higgsfield video skill during launch week. Check items
off as they land. Every credit-touching or fleet-touching step has an explicit
**[COOPER]** gate.

**Author:** higgsfield-skill terminal (Claude). Re-derived from code/data, not from
the framing of the request — corrections to that framing are marked **[CORRECTION]**.

---

## The one fact that reframes everything: there are TWO paid video accounts

This is the missed thread that the "473 vs 499.74" mismatch exposed, and it ties
the whole cluster together.

| Account | Provider / portal | Used by | Balance (2026-06-13) | Auto-top-up |
|---|---|---|---|---|
| **Higgsfield Cloud** | cloud.higgsfield.ai (Visa ...3783) | the **cloud rail** (`HIGGSFIELD_CLOUD_KEY`, the `higgsfield-cloud` skill, the gate, the /videos page, the v129 flip) — **generation** | **499.74** (134.4 used this mo) | **DISABLED** ❗ |
| **muapi** | via `INSTACLAW_MUAPI_PROXY` → `/api/gateway/muapi/credits` | the **legacy rail** (`higgsfield-video` skill) — **extend / edit / audio**, and ALL generation pre-v129 | **~473** (the number timmy recited) | unknown (separate account) |

**They are not the same ledger drifting apart. They are two different vendors'
prepaid balances.** Post-v129, BOTH stay in use: cloud = generation, legacy/muapi
= extend (the cloud rail has no extend). So the launch has **two money rails**, and
all the §8.3 runway work so far covers only ONE (Cloud).

---

## Thread 1 — the "473 vs 499.74" credit-display mismatch

### Where 473 came from (code-traced)
- `higgsfield-setup.py:52-56` `get_credits_url()` → `<MUAPI_PROXY>/api/gateway/muapi/credits`. The legacy rail's credit check hits the **muapi** account.
- `higgsfield-setup.py:139 cmd_credits` reads `credits_available` from that muapi response (`muapi/credits/route.ts:152-165` returns `credits_available`/`credit_balance`).
- `higgsfield-video/SKILL.md:51-55, 103, 302` **instructs the agent to recite it**: *"Tell the user the cost: 'This video will use about 80 credits. You have 420 remaining.'"*
- timmy ran the extend on the legacy rail → checked the muapi balance (~473) → recited it per the SKILL.md.

### [CORRECTION] to the framing
The request offered (a) drifted internal ledger, (b) old-rail stale accounting, (c) something else.
It's effectively **(c), but specifically: two different accounts, both numbers correct.**
473 is the **muapi** balance (the account the extend actually spends from). 499.74 is the
**Higgsfield Cloud** balance (a different vendor Cooper happened to be looking at). Neither
ledger is "lying" — they were never the same number. The extend did **NOT** touch the 499.74.

### Which account the extend spent from
**muapi**, not Higgsfield Cloud. Cooper was watching the Cloud portal; the extend drew
(or would draw) from muapi. This is the real story for "is it on the right account."

### The two real problems
1. **The agent recites a raw account balance at all** — exposes billing plumbing, and here
   the exposed number belonged to a different account than the one Cooper was watching, which
   read as "wrong." Fix: quote only the cost of the action, never the balance.
2. **Extend silently spends from a separate, unmonitored account** (muapi). Feeds Thread 5.

### Fix scope (verified)
- Balance recital is **only** in `higgsfield-video/SKILL.md` (legacy). The **cloud** SKILL.md
  does NOT recite balances (checked), and the cloud **gate returns no raw balance** to the agent
  (only held/free per render). So the display fix is a **single-file SKILL.md edit**.
- **Proposed wording** (staged, NOT shipped): replace the recital pattern with cost-only —
  - was: *"This video will use about 80 credits. You have 420 remaining."*
  - to: *"This extend costs about 80 credits — firing now."*
  - delete the SKILL.md "always check credits and inform the user of the balance" directive
    (`:51-55, :103 #1, :302 #4`); keep the cost estimate, drop the "you have N remaining."
- **Sequencing:** this file (`higgsfield-video/SKILL.md`) is ALSO the file the v129 flip narrows
  (extend-only). **Fold the display fix into the same held flip commit** — do not ship a
  separate out-of-sequence edit to the same file. (Standalone-earlier is possible if Cooper
  wants the plumbing-exposure gone before the flip; see Execution Order.)

### Owner
- Display-fix wording + folding into the flip: **CC** (staged; rides the flip).
- The "is muapi the right rail for extend long-term / is it funded" decision: **[COOPER]** (Thread 5).

---

## Thread 2 — the v129 fleet flip

- **State:** built, held at branch SHA `63717ebe`, **NOT pushed**. Ships: `higgsfield-cloud`
  skill fleet-wide (SKILL.md + script via extraSkillFiles to the skill-dir path the SKILL.md
  invokes), `higgsfield-video` narrowed to extend-only (flip-coupled), manifest v128→129,
  `SKILLS_WITH_OWN_SCRIPT_DIR += higgsfield-cloud`. Pure file-content; no config/systemd/restart.
- **§8 checklist re-verified:** 8.1 ✅ (quality fixes in the shipping SKILL.md, vm-050-proven),
  8.2 ✅ ($3.99 purchase landed 06-12), **8.3 ❗ RED** (see Thread 3 — auto-top-up DISABLED),
  8.4 ✅ (manifest bumped; snapshot bake = follow-up), 8.5 ✅ (`HIGGSFIELD_GATE_ENABLED=true`
  proven at runtime), 8.6 ⏳ ([COOPER] Rule-64 go).
- **Blocked by:** Thread 3 (§8.3). Do NOT push until auto-top-up is ON.
- **Owner:** push + census + non-050 fulfillment proof = **CC**, after **[COOPER]** Rule-64 go.

---

## Thread 3 — §8.3 runway (the hard gate on the flip)

### [CORRECTION] sharper than "anchor only as good as its number"
The anchor must track the **right ACCOUNT** (Higgsfield Cloud 499.74), not just be an accurate
number. If anyone set the anchor to "473" (the number the agent surfaced) the cron would watch
the wrong vendor. **Thread 1 disambiguates which number the anchor uses.** So Thread 1 (account
clarification) blocks Thread 3 (anchor target) — confirmed.

### Current state (code + screenshot)
- `balance-check` cron returns `{"world":"none"}` — Higgsfield exposes no balance endpoint
  (World-A dead) AND `HIGGSFIELD_BALANCE_ANCHOR` is unset (World-B blind). **Predictive runway
  monitoring is blind.**
- **BUT** the cloud gate has a **reactive** exhaustion detector (`route.ts:465-500`, Rule-67
  pattern): when a render fails on insufficient balance, it fires `[P0] Higgsfield central
  balance EXHAUSTED`. So the failure mode is "renders start failing + P0 fires," not silent —
  but users still hit a dead promise before the operator can react.
- **Auto-top-up is DISABLED** on the Cloud account (screenshot). This is the load-bearing fact.

### 💰 THE DOMINANT MONEY FLAG
**499.74 Cloud credits ÷ 13 cr/kling render ≈ 38 renders of runway.** With ~150 healthy
fleet VMs each entitled to ONE free seed render, the free-seed drain alone needs ~1,950 cr —
**50× the current balance.** With auto-top-up OFF, the cloud account **runs dry after ~38
renders**, and every subsequent user hits "video unavailable." **This means §8.3 gates the
DRAIN itself, not just the post** — flipping with auto-top-up off turns the live /videos
promise into a different dead promise within ~38 renders.

### What closes it
- **[COOPER] — load-bearing:** enable auto-top-up on Higgsfield Cloud (Visa ...3783). With
  auto-top-up ON the account never dries; this is THE §8.3 gate.
- **CC (P2 nicety, after auto-top-up):** set `HIGGSFIELD_BALANCE_ANCHOR="<cloud-credits>@<ISO>"`
  using the **Cloud** number (Thread-1-disambiguated) so the predictive cron stops being blind.
  Not load-bearing once auto-top-up is on (the account can't dry), but good cost-awareness.
- **[COOPER]** confirm the current Cloud balance number for the anchor.

---

## Thread 4 — the t2v duration drop (lowest priority, independent)

- **Mechanism (re-verified):** `validateInput`'s `text2video` branch (`higgsfield-models.ts:260-269`)
  builds `input = {prompt, aspect_ratio?}` and **drops** `duration`; the gate forwards
  `validated.input` (`route.ts:444`), so the param never reaches Higgsfield → t2v default ~5s.
  NOT a platform cap (Muapi Kling supports `"5 | 10"`); NOT VM-specific (vm-050 healthy/unquarantined);
  i2v branches already forward duration. It's our gate dropping it, deliberately, for billing safety
  (`:152-155` — 10s-t2v COGS unmeasured).
- **Independent of the flip:** touches `higgsfield-models.ts` only; does NOT touch the flip's files
  (`vm-manifest.ts`, `vm-reconcile.ts`, the skills). Can ship before or after.
- **Gated on a measurement, not on Cooper-approval-of-code:** one instrumented 10s-t2v render →
  read HF dashboard burn vs 5s. If flat → ship the t2v duration-forward (`allowedDurations:[5,10]`
  + honor it in the t2v branch). If ~2× → re-price first.
- **💰 flag:** the measurement render spends ~1 render of Cloud credits — do it AFTER auto-top-up
  is on, and **[COOPER]** approves the (tiny) measurement spend.
- **Priority:** lowest. The hero clip is fine at 5s. Do NOT let this block the flip.

---

## Thread 5 — [NEW] two-account architecture & extend's unmonitored money rail

Surfaced by Thread 1. Post-v129 the launch runs on two prepaid vendor accounts:
- **Cloud** (generation) — §8.3 work covers it (once auto-top-up is on).
- **muapi** (extend, edit, audio) — **no runway monitoring, no documented top-up posture, separate
  auto-top-up setting.** If muapi dries, extend silently fails fleet-wide post-launch.

Also: `higgsfield-video/SKILL.md:68, 104` carries **stale billing copy** from the muapi-era
("credits from your daily pool shared with LLM messages", points to `/billing/credit-packs`) — wrong
for the cloud rail's `video_credit_balance` + /videos packs model. After the v129 narrowing this copy
only governs extend, but it's still confusing.

- **[COOPER] decisions:** (a) is muapi funded + auto-topped for extend? (b) long-term, migrate extend
  onto a single vendor, or keep two rails? (c) does extend ship as a launch capability at all, or stay
  "what we're building" (ref the earlier extend finding: can't continue a Kling clip without drift)?
- **CC (when decided):** muapi balance-check/alert (mirror the cloud Rule-67 detector); fix the stale
  legacy billing copy.
- **Priority:** post-launch tracking, UNLESS extend is part of the launch story — then (a) is a gate.

---

## Dependency graph

```
[COOPER] auto-top-up ON (Cloud)  ──┐  (THE load-bearing gate; §8.3)
                                   ├──▶ Thread 2: v129 flip push  ──▶ census + non-050 proof ──▶ [COOPER] post green-light
Thread 1: account clarify + display fix ──(folded into flip)──────────┘
        └──▶ Thread 3 anchor target (which account's number)

Thread 4 (duration)  ── independent ── (after auto-top-up; [COOPER] measurement spend) ── ships anytime
Thread 5 (two-account / muapi runway / stale copy) ── post-launch tracking (gate only if extend is a launch claim)
```

**Hard truths:**
- Nothing flips until **auto-top-up is ON** (§8.3) — it gates the drain, not just the post.
- The display fix **rides the flip** (same file as the narrowing) unless Cooper wants it earlier standalone.
- The anchor uses the **Cloud** number (Thread 1 disambiguates) — never the 473.
- Duration is independent and lowest — must not block the flip.

---

## CC-vs-Cooper gate table

| Step | Owner | Gate type |
|---|---|---|
| Enable auto-top-up on Higgsfield Cloud | **COOPER** | dashboard action (load-bearing) |
| Confirm current Cloud balance for the anchor | **COOPER** | data confirmation |
| Decide muapi funding/extend-as-launch-claim | **COOPER** | product/money decision |
| Rule-64 "ship to fleet" for v129 | **COOPER** | explicit go |
| Approve the duration measurement spend (~1 render) | **COOPER** | spend approval |
| Post green-light (after census + non-050 proof) | **COOPER** | explicit go |
| Fold display-fix into the held flip; set anchor; push flip; census; non-050 fulfillment proof; duration fix | **CC** | execute on Cooper's gates above |

---

## 💰 Money-risk flags (launch-week, fleet-scale)

1. **Auto-top-up OFF + flip = dry at ~38 renders.** The single biggest risk. The flip must wait on auto-top-up.
2. **Two accounts, one monitored.** Extend spends muapi (unmonitored). A muapi dry-out fails extend fleet-wide silently.
3. **Anchor on the wrong account.** Setting the anchor to 473 (muapi) would make the runway cron watch the wrong vendor — Thread 1 must land first.
4. **Duration measurement spends real credits** — gate behind auto-top-up + Cooper approval; it's ~1 render but it's real money on the launch account.
5. **"Prove before you act" holds on every credit-touching step** — no anchor set on an unconfirmed number, no flip on an unfunded account, no duration-forward on an unmeasured cost.

---

## Honest "not tonight / needs X" calls

- **The flip cannot push tonight** unless Cooper enables auto-top-up first — otherwise it self-defeats at ~38 renders. This is not a corner to cut.
- **Extend is not a safe launch capability** as-is (separate finding: can't continue a Kling clip without drift; lives on the unverified muapi rail). Keep it as the "what we're building" story unless Cooper decides to fund + prove the Seedance-regenerate-then-chain path.
- **The duration fix needs a measurement** before it's safe — don't ship the forward blind.
- **The anchor needs Cooper's confirmed Cloud number** — don't guess it from the 473 the agent surfaced.

---

## Recommended execution order (for thread-by-thread approval)

**Phase 0 — [COOPER], unblocks the launch (dashboard, ~2 min):**
1. Enable auto-top-up on Higgsfield Cloud (Visa ...3783). ← THE gate.
2. Tell CC the current Cloud balance for the anchor.
3. Decide: does extend ship as a launch claim, or stay "building"? (governs Thread 5 urgency)

**Phase 1 — CC, on Cooper's go:**
4. Fold the Thread-1 display fix into the held flip (`higgsfield-video/SKILL.md` cost-only wording, alongside the narrowing already there). Re-verify diff scope; gbrain never staged.
5. Set `HIGGSFIELD_BALANCE_ANCHOR` to the confirmed Cloud number (closes §8.3 predictive monitoring).

**Phase 2 — [COOPER] Rule-64 go → CC executes:**
6. Push v129 via the isolated-worktree ceremony (cherry-pick mechanics + skill leaves, WIP-guard, Vercel Ready w/ SHA).
7. Census (count-asserted, fleet-wide) + non-050 fulfillment proof.
8. **[COOPER]** post green-light only after 6–7 pass.

**Phase 3 — CC, independent, after the flip soaks:**
9. Duration measurement ([COOPER] spend approval) → ship the t2v forward if flat.

**Phase 4 — tracked, post-launch:**
10. muapi runway monitoring + stale legacy billing copy (Thread 5), unless extend-as-launch-claim pulls (a) forward.

---

## Checklist (check off as landed)

- [ ] [COOPER] auto-top-up ON (Cloud)
- [ ] [COOPER] current Cloud balance confirmed
- [ ] [COOPER] extend-as-launch-claim decision
- [ ] CC: display fix folded into held flip
- [ ] CC: `HIGGSFIELD_BALANCE_ANCHOR` set (Cloud number)
- [ ] [COOPER] Rule-64 go for v129
- [ ] CC: v129 pushed, Vercel Ready, SHA recorded
- [ ] CC: fleet census passes (count-asserted)
- [ ] CC: non-050 fulfillment proven
- [ ] [COOPER] post green-light
- [ ] CC: duration measurement + (conditional) t2v forward
- [ ] muapi runway monitoring + stale-copy fix (post-launch)
