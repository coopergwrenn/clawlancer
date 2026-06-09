# Higgsfield Video Credits — Profitability Proof (real numbers)

**Date:** 2026-06-08 · **Status:** proof against MEASURED costs + the shipped gate.
Companion to the calibration doc (where the costs were measured) and the
guardrails spec (where the gate was designed). Every cost here is a number we
read off the Higgsfield dashboard, not an estimate.

> **The claim being proved:** for every path a user can take through the gate,
> we either **charge more than it costs us** or **charge nothing for something
> that costs us nothing**. There is no path where we pay Higgsfield and collect
> less than we paid. If any line below were margin-negative, the gate would be
> unsafe to expose — it isn't.

---

## 1. The conversion, stated once

- **Our cost:** `hfCostCredits × $0.0625` (16 Higgsfield credits = $1, measured).
- **What we hold/charge (video-credits):** `ceil(hfCostCredits × 1.15)`.
  - Margin is applied to the *cost*, then `ceil` — so the integer rounding is
    always **in our favor** (we never round a charge *down*).
- **What the user paid for a video-credit:** ~**$0.10** (sold in packs).
- **Hold == charge:** every allowlisted model has a **flat** cost (DoP ignores
  duration; same tier = same credits — calibration #7). So the amount we *hold*
  at reserve is exactly the amount we *charge* at settle. The settle RPC also
  **clamps** `charge = LEAST(passed, held)`, so a charge can never exceed the
  hold *by construction* (hardening migration §C).

---

## 2. Per-model margin — every allowlisted model

| Model | hfCost (cr) | **our cost $** | held = charge (vc) | **user pays $** (@$0.10/vc) | margin on $ |
|---|---|---|---|---|---|
| Image (`soul/standard`) | 1 | **$0.0625** | 2 | $0.20 | **3.2×** |
| **DoP-lite** (default) | 2 | **$0.125** | 3 | $0.30 | **2.4×** |
| DoP-turbo | 6.5 | **$0.406** | 8 | $0.80 | **1.97×** |
| DoP-standard | 9 | **$0.5625** | 11 | $1.10 | **1.96×** |
| **Kling** (premium, 10s) | 15.0 | **$0.9375** | 18 | $1.80 | **1.92×** |

(Kling is locked to its measured 10s tier — `allowedDurations: [10]` — so the
flat cost above is exact: one length ⇒ one price. The 5s tier is unmeasured and
deliberately not offered; see the Kling-duration handling in the gate.)

**Lowest margin on any paid path = 1.92× (Kling).** The most expensive,
fastest, longest-clip model — the one most likely to be "rinsed" — still returns
**~$0.86 gross per generation** ($1.80 collected − $0.9375 cost). **No paid path is
margin-negative.** ✅

The Kling worst case spelled out (the path Cooper flagged):
- Held at reserve: `ceil(15.0 × 1.15) = ceil(17.25) = 18` vc.
- Charged at settle: `LEAST(18, 18) = 18` vc → user pays **$1.80**.
- Our Higgsfield cost: **$0.9375**.
- **Gross margin: +$0.86 (1.92×).** Settlement is provably positive. ✅

---

## 3. The free allowance — is "free" actually free to us?

Free jobs are **DoP-lite or images only** (`freeEligible` in the registry).
Cost to us per free job:

- Free DoP-lite: **$0.125** to us, $0 to the user.
- Free image: **$0.0625** to us, $0 to the user.

This is a **deliberate CAC/retention cost**, bounded two ways:
1. **Count cap per tier per day** (Starter 2 / Pro 5 / Power 15), enforced
   atomically in the reserve RPC.
2. **Failed free jobs now consume a slot** (hardening §A) — so a user can't
   loop failed free generations to burn unlimited Higgsfield cost.

**Worst-case free cost per VM per day:**
| Tier | free/day | model | **max free cost/day** | **/mo** |
|---|---|---|---|---|
| Starter | 2 | lite | $0.25 | ~$7.5 |
| Pro | 5 | lite | $0.625 | ~$19 |
| Power | 15 | lite | $1.875 | ~$56 |

Each sits at ~15% of the plan price (Starter $50 / Pro $130 / Power $350) — a
sane free-tier CAC, **fully bounded**, never open-ended. ✅

---

## 4. Failed / nsfw / cancelled — do we eat the cost?

**No.** Two independent protections:

1. **Higgsfield auto-refunds us** for failed/nsfw/cancelled jobs (calibration
   #7 — confirmed by balance behavior during calibration; the dashboard refunds
   the credits for non-delivered jobs). So our *real* cost on a failed job
   trends to **$0**.
2. **We never charge the user for one.** On any non-`completed` terminal status
   the webhook calls `instaclaw_video_release` → the hold flips to `failed`,
   `settled_credits = 0`, **no balance debit**. The user pays nothing.

So a failed job is **$0 to the user and ≈$0 to us** — symmetric, no leak.

> ⚠️ **Honest caveat to verify in production:** the "$0 to us" half rests on
> Higgsfield's auto-refund being reliable for *every* non-delivered status. The
> calibration observed refunds on failed/preview-rejected jobs; we have NOT yet
> stress-tested nsfw-after-generation (where compute already ran). If a future
> reconciliation shows Higgsfield does NOT refund a particular failure mode, our
> exposure is bounded to that model's cost (max $0.9375/Kling) per failed job, and
> the free-attempt-counts-a-slot fix (§A) already caps how many a single VM can
> trigger per day. **Action:** a periodic recon (guardrail #3's fleet $ cron)
> compares our settled+released ledger against the Higgsfield balance delta;
> any divergence surfaces a refund gap. Not margin-negative on the user side
> regardless — this only affects *our* cost, and only if a refund assumption is
> wrong.

---

## 5. Hold sufficiency — can actual ever exceed the hold?

**No, by construction.** Three reasons stacked:

1. **Flat cost.** Every allowlisted model has one measured cost; there is no
   per-second or per-resolution variability within a model (DoP literally
   ignores `duration`). So `actual == est == held`.
2. **Pre-submit validation.** Only allowlisted slugs with sanitized params reach
   Higgsfield (no passthrough), so a request can't mutate into a costlier job
   than the one we priced.
3. **Settle clamp.** `charge = LEAST(passed_actual, held)` — even if a future
   variable-cost model or a route bug passed a larger number, the charge is
   capped at the hold. The hold is a **hard ceiling**.

So "estimate-vs-actual hold sufficiency" is not a hope — it's `held ≥ charge`
enforced in SQL. ✅

---

## 6. The free→paid boundary

- A free-eligible model tries the **free** allowance first; on exhaustion (which
  inserts **no** row) it falls through to a **paid** hold with the *same*
  request_id (clean, no double-count).
- The boundary is atomic: the free-count and the paid balance/cap checks both
  run under the same per-VM advisory lock, so concurrent requests can't race
  past either the free cap or the balance.
- A user crossing the boundary mid-day pays the normal paid price (lite $0.30)
  — still **2.4×** margin. No discontinuity that loses money. ✅

---

## 7. Blast-radius ceilings (defense beyond per-call margin)

Even with positive per-call margin, a compromised/abusive VM is bounded:
- **Per-VM daily paid ceiling** (`VIDEO_DAILY_CREDIT_CEILING`, default 300 vc ≈
  $30 user-facing / ~$15 our cost), ALWAYS passed (never NULL → can't fail open,
  hardening §B). Max paid Higgsfield cost a single VM can incur in a UTC day is
  bounded by this ÷ the cheapest paid model's margin.
- **Balance gate**: a VM can never hold more than its `video_credit_balance`
  minus outstanding fresh holds — so it can't spend credits it doesn't have.
- **Free count cap**: bounds free (CAC) cost per VM per day (§3).
- **Fleet kill-switch (#3, next gate):** the emergency stop if a supplier issue
  or a bug slips all of the above.

---

## 8. Verdict

**Every paid path is ≥1.92× margin. Every free path is a bounded, ~15%-of-plan
CAC cost. Failed jobs are $0/$0. The hold is a hard ceiling on the charge. No
path is margin-negative.** The gate is safe to expose on the money model.

The single thing to keep honest is the Higgsfield **refund reliability** on
exotic failure modes (§4 caveat) — it doesn't threaten user-side margin, only
our cost, and it's bounded + reconcilable. Track it with the fleet $ recon cron
when guardrail #3 lands.

*Numbers measured 2026-06-08 (calibration doc). Proof matches the shipped
`lib/higgsfield-models.ts` cost table + the hardened reserve/settle RPCs.*
