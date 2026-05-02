# InstaClaw WLD Pricing Strategy & Hibernation Architecture

**Status:** Approved (phased hybrid). Phase 1 build authorized for next week.
**Date:** 2026-05-02
**Owner:** Cooper Wrenn
**Audience:** Internal product/eng + investor briefing

---

## TL;DR

- WLD users currently pay ~$0.33/WLD × 25–50 WLD = **$8–$16.50** for a credit pack that runs on a VM costing **$29/mo fixed**.
- Even our cheapest Stripe plan (Starter, $29/mo) barely covers VM cost. WLD as currently priced is a structural loss.
- **Decision:** phased hybrid — Phase 1 stops the bleed via hibernation; Phase 2 reframes WLD as a free trial; Phase 3 introduces a recurring WLD subscription via World Mini App (pending Andy/World Foundation confirmation).
- We do not unilaterally raise WLD prices yet. The risk of killing the World ecosystem channel is higher than the cost of running idle VMs while we land hibernation + recurring billing.

---

## 1. The unit economics problem

### 1.1 Cost structure

| Cost | Amount | Notes |
|------|--------|-------|
| VM (Linode g6-dedicated-2) | **$29 / VM / month** | Negotiated rate. Billed even when stopped — only DELETE stops the meter. |
| LLM usage | Variable | Haiku=1, Sonnet=4, Opus=19 per credit weight. |
| Marginal cost per active user | ~$29 + $5–15 LLM | Floor is the VM. |

### 1.2 Revenue per user (current state)

| Plan | Price | Effective $/mo | VM-cost coverage | Margin |
|------|-------|----------------|------------------|--------|
| Stripe Starter | $29/mo | $29 | 100% | ~$0 (break-even at best) |
| Stripe Pro | $99/mo | $99 | 341% | ~$70/mo |
| Stripe Power | $299/mo | $299 | 1031% | ~$270/mo |
| WLD `try_it` (25 WLD = 150 credits, 3d) | ~$8.25 | **$2.50/mo** if monthly | 8.6% | **−$26.50 / mo** |
| WLD `starter` (15 WLD = 500 credits, 7d) | ~$4.95 | **$1.65/mo** if monthly | 5.7% | **−$27.35 / mo** |
| WLD `full_month` (50 WLD = 2000 credits, 30d) | ~$16.50 | $16.50 | 56.9% | **−$12.50 / mo** |

**Two-line summary:** WLD users are loss-leaders by design. Stripe Starter is barely profitable. Pro and above are where the business lives.

### 1.3 The "tire-kicker" failure mode

A WLD user who buys `try_it` once for ~$8.25, gets their VM provisioned, sends 5 messages, and never returns:
- Cost: $29/mo for as long as we leave the VM running
- Revenue: $8.25 one-time
- After month 1: pure loss at $29/mo per inactive VM forever
- Multiplied across the cohort: this is the hole.

---

## 2. Strategic options considered

### Option A — Reprice WLD to break even
- Target: 90 / 300 / 900 WLD across tiers (~$30 / $99 / $297 — matches Stripe).
- Pros: Solves the math instantly. No new infra.
- Cons: ~6× current price. High risk of killing adoption. World Foundation reaction unknown. We lose the "proof-of-human onramp" thesis if no one buys.
- **Rejected as standalone move.** Too aggressive without data.

### Option B — Reframe WLD as a free trial → Stripe conversion
- Keep current WLD prices. Position WLD packs as "trial your agent for a week, then subscribe."
- Add aggressive in-app CTA to upgrade to Stripe before hibernation.
- Pros: Preserves World ecosystem channel. Honest about what WLD currently is (a trial). Funnel-driven, measurable.
- Cons: Requires real conversion funnel + tracking. Conversion rate is currently **0%** (no CTA exists). Untested whether WLD users will convert at all.
- **Selected as Phase 2.** Low-risk, measurable, doesn't burn the channel.

### Option C — Recurring WLD subscription via World Mini App
- 100 WLD/mo (~$33) auto-debited monthly via World Mini App, equivalent to Starter tier.
- Pros: Best long-term equilibrium. WLD becomes a real subscription product. Solves the recurring-revenue problem at the source. Aligns with World's mini-app monetization story.
- Cons: **Unknown whether World Mini App supports recurring/auto-debit payments today.** Needs confirmation from Andy / World Foundation.
- **Selected as Phase 3 (gated on World Foundation confirmation).**

### Why a hybrid, not one option
- Option A solves math but kills channel. Option B solves channel but not math. Option C solves both but is technically blocked.
- Phased hybrid lets us: stop bleeding now (hibernation), preserve channel (B), and migrate to durable economics (C) — without making any one bet load-bearing.

---

## 3. The phased plan (approved)

### Phase 1 — Stop the bleed (this week)

**Build:** hibernation-on-credit-depletion + idle-detection.

Components:
1. **Credit depletion lifecycle for WLD users:**
   - `credits = 0` + `no active stripe sub` + 3 days no reload → **hibernate** (gateway stop, DB `health_status='hibernating'`).
   - Hibernation persists for 30 days. During that window, reloading credits **wakes** the VM (re-provision from frozen image, ~5–10 min wake time).
   - After 30 days hibernated → freeze (snapshot + delete Linode instance, $0.50/mo image storage cost).

2. **Inactivity hibernate (covers tier-based abandoners):**
   - Any VM with **0 proxy calls for 7 days** AND no active engagement signals → hibernate, even if Stripe sub is active.
   - Wakes on next user message (in-app or via Telegram bot).
   - Avoids penalizing users who pay for tier but don't use it daily.

3. **UX rules (non-negotiable, per Cooper's spec):**
   - **Never silently kill** an agent. Every transition must be communicated by the agent, in-character.
   - **Never nag while balance > 0.** Warnings start when credits < $2.
   - **Never delete memory or identity data** during hibernation or freeze. Restoration must be lossless.
   - Agent voice for transitions:
     - Low (<$2): *"Heads up — I'm running low on credits. Top me up so I don't fall asleep."*
     - Hibernate: *"I'm going to take a nap. Top up anytime to wake me up."*
     - Wake: *"I'm back. What's up?"*
     - Freeze (30d): *"I've been asleep a while — your stuff is still safe, but I need to be re-provisioned. This takes ~5 min."*

4. **Schema:** add `credits_depleted_at TIMESTAMPTZ` on `instaclaw_vms`; written by the credit-deduction RPC the first time balance hits zero, cleared on next reload.

5. **Cron rewrite:** `app/api/cron/suspend-check/route.ts` Pass 2 currently uses `assigned_at` + 24h grace — needs to switch to `credits_depleted_at` + 3d grace for WLD users. Pass 3 (idle hibernate) is new — query `last_proxy_call_at < now - 7d`.

6. **Pre-warm fix:** today's freeze→thaw is 5–10 min cold-start. Phase 1 includes eager pre-warm on first reload signal so the user doesn't wait 10 min staring at "waking up."

7. **Hosting fee (per Cooper's draft):** monthly cron deducts a `VM_HOSTING_FEE` (suggested 400 credits = $4 token-cost coverage) from each WLD user's credit balance on signup-anniversary. Functions as a countdown timer to hibernation. **Note:** this is a behavioral lever, not real cost recovery — we recover ~$3.30/mo per user, not $29.

**Estimated Phase 1 savings:** ~30–60% reduction in idle-VM Linode spend within 30 days.

### Phase 2 — Reframe WLD as trial (30 days out, measure first)

**Build:** in-app conversion funnel from WLD → Stripe.

Components:
1. New mini-app screen at hibernation: *"Your trial is up. Continue as a real subscriber for $29/mo on Stripe — your agent picks up exactly where it left off."*
2. Reduce visual friction: one-tap Stripe checkout from mini-app.
3. Track conversion: % of WLD-only users who add a Stripe sub within 7 / 30 / 90 days of first hibernation.
4. **Do not change WLD prices yet.** Goal is to learn the conversion rate before deciding whether to also raise prices.

**Decision gate:** if conversion ≥ 15% within 30 days of hibernation → continue Phase 2 unchanged. If conversion < 5% → escalate to repricing discussion (Option A) or accelerate Phase 3.

### Phase 3 — Recurring WLD sub (60 days out, gated on World Foundation)

**Pre-work:** Cooper to verify with Andy / World Foundation:
1. Does World Mini App support recurring auto-debit (subscription) payments?
2. If yes — what's the API? Webhook contract? Refund flow?
3. If no — is it on roadmap? ETA?

**If supported:** pilot 100 WLD/mo auto-debit subscription tier alongside existing one-shot WLD packs. Position as Stripe-equivalent for WLD-native users.

**If not supported:** stay on Phase 2 indefinitely; revisit pricing (Option A) once we have real conversion data.

### Phase 4 — Commit on data (90 days out)

After 60+ days of Phase 2 + Phase 3 data:
- If WLD recurring sub adoption is healthy → make it the WLD default; sunset one-shot packs.
- If conversion to Stripe is healthy → keep WLD as trial; no recurring needed.
- If neither → reprice WLD upward (Option A) and accept lower volume.

---

## 4. Hibernation architecture (Phase 1 detail)

### 4.1 Lifecycle states

```
   ┌────────────┐
   │  healthy   │◄────────────────┐
   └─────┬──────┘                 │
         │                        │ reload credits
         │ credits=0              │ OR new message (idle path)
         │ + 3d (WLD)             │
         │ OR 7d idle (any tier)  │
         ▼                        │
   ┌────────────┐                 │
   │hibernating │─────────────────┘
   │(VM stopped)│
   └─────┬──────┘
         │ 30d no wake
         ▼
   ┌────────────┐                 ┌──────────────┐
   │   frozen   │  reload signal  │  thawing     │
   │ (snapshot) │────────────────▶│ (re-provision)│
   └────────────┘                 └──────────────┘
                                          │
                                          ▼
                                    ┌────────────┐
                                    │  healthy   │
                                    └────────────┘
```

### 4.2 Hibernate trigger logic

```
WLD user (no active stripe sub):
  IF credit_balance = 0 FOR > 3 days  →  hibernate
  IF hibernating FOR > 30 days        →  freeze (Linode delete + image keep)

Stripe user (any tier):
  IF last_proxy_call_at < now - 7 days  →  hibernate (idle path)
  Stripe past_due > 7 days               →  hibernate (existing path)
  Stripe canceled + credit_balance = 0   →  hibernate (existing path)
```

### 4.3 Wake triggers

- User sends Telegram message → backend sees it before forwarding → triggers wake → forwards once VM healthy.
- User reloads credits via mini-app → wake immediately, push notification *"I'm waking up — give me 5 min."*
- User opens mini-app and clicks "wake my agent" → eager warm-up.

### 4.4 Pre-warm strategy

- Today: thaw is 5–10 min cold start (Linode boot ~3 min + cloud-init + reconcile).
- Phase 1 mitigation: detect "intent to wake" signals (mini-app open, low-credit reload, Telegram typing indicator) and eager-thaw. User waits ~30s instead of ~10 min.

---

## 5. What we're NOT doing

- ❌ **Not raising WLD prices unilaterally.** Without recurring subs in place, a 6× price hike kills the channel.
- ❌ **Not killing the WLD path.** The proof-of-operator thesis depends on World ID-verified users.
- ❌ **Not silently killing agents** at credit depletion. UX is the difference between "this app is broken" and "the agent took a nap, I'll wake it later."
- ❌ **Not bulk-suspending without verification.** Three times in this work cycle we've identified "stuck VMs" that turned out to be paying customers (38-VM "orphan" census, vm-036, vm-068). Every suspend candidate must be verified against Stripe + WLD state before mutation.

---

## 6. Open questions / pre-work blockers

| Question | Owner | Blocking which phase |
|----------|-------|----------------------|
| Does World Mini App support recurring/auto-debit payments? | Cooper → Andy | Phase 3 |
| What's our tolerance for WLD-tier price increase from World Foundation perspective? | Cooper | Phase 2 (if conversion data justifies) |
| Sunset `try_it` tier (strictly worse pricing than `starter`)? | Cooper | Phase 1 |
| Audit `STRIPE_PRICE_STARTER` env vars for trailing `\n` (CLAUDE.md Rule 6) | Phase 1 | Phase 1 |
| Why are 6 active Stripe subscribers currently hibernating? (vm-544, 576, 698, 655, 046, 442) | Phase 1 P0 | Phase 1 (paying customers without service) |

---

## 7. Census snapshot (2026-05-02)

For investor/Linode follow-up reference. Numbers will move; treat as point-in-time.

### 7.1 Hibernating VMs (n=19)

| Bucket | Count | Notes |
|--------|-------|-------|
| WLD with credits ($1.41–$1.50) | 9 | Hibernated when at $0, then recharged. **Wake-up flow appears broken** — they have credits but stay hibernated. P0 bug. |
| Stripe **active** subscribers | 6 | **PAYING customers without service.** P0 bug. |
| Stripe canceled, no credits | 3 | Correct hibernate state. |
| Stripe canceled, with credits | 1 | Should wake on credit-balance > 0. P0 bug. |

### 7.2 Grace-period VMs (n=9)

| Bucket | Count | Notes |
|--------|-------|-------|
| Stripe past_due (in 7-day suspension grace) | 9 | Working as designed. Will hibernate after grace if not resolved. |
| 24h-tooNew (recently assigned) | 0 | None right now. |

### 7.3 Implication for Linode email

Original "$1,102/mo waste" claim from the 38-VM orphan census was **wrong** — those 38 are paying customers. Corrected snapshot:
- **Real waste right now:** the 6 Stripe-active VMs that are wrongly hibernated are *losing* us revenue, not saving cost.
- **Real waste candidate:** the 9 past-due-grace VMs will become real waste if not resolved within 7 days.
- **Real opportunity:** 9 hibernating-with-credits WLD VMs need wake-flow fix to be served (not waste — we owe them service).

---

## 8. Decision log

| Date | Decision | By |
|------|----------|----|
| 2026-05-02 | Phased hybrid plan approved | Cooper |
| 2026-05-02 | Phase 1 hibernation build authorized for next week | Cooper |
| 2026-05-02 | Phase 2 (trial reframe) approved in concept; measure first | Cooper |
| 2026-05-02 | Phase 3 (recurring WLD sub) gated on Andy/World Foundation confirmation | Cooper |
| 2026-05-02 | NOT hibernating vm-036 / vm-068 — both are active Stripe Starter subscribers | Claude (verified before action) |
