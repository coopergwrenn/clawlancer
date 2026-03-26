# PRD: Access Control, Credit Portability & Upgrade System

**Status:** Draft - awaiting review
**Author:** Claude (from Cooper's audit request)
**Date:** 2026-03-26

---

## 1. Executive Summary

InstaClaw now has two user acquisition channels: the **instaclaw.io web app** (Stripe subscriptions) and the **World Mini App** (WLD payments). These systems were built independently and have no access gating, no unified credit model, and no upgrade path. Any authenticated user can access the full instaclaw.io dashboard regardless of how they paid. This PRD proposes a unified access control system, a portable credit model, and a frictionless upgrade flow from WLD-only to Stripe subscriber.

**What we're building:**
- Dashboard access gating based on subscription status
- A single credit system that works across both payment methods
- One-tap upgrade from the mini app to a Stripe subscription
- Proper credit exhaustion UX with clear upgrade prompts
- Low-credit warnings before users hit zero

---

## 2. Current State

### 2.1 Authentication

| Surface | Auth Method | Session | Files |
|---------|------------|---------|-------|
| instaclaw.io | Google OAuth via NextAuth | JWT cookie (`next-auth.session-token`) with `user.id`, `user.onboardingComplete` | `instaclaw/lib/auth.ts:11-162`, `instaclaw/lib/auth.config.ts` |
| Mini app | World wallet via MiniKit → custom JWT | Cookie (`session`) with `userId`, `walletAddress` | `instaclaw-mini/lib/auth.ts:1-65` |
| Cross-app proxy | `X-Mini-App-Token` header (HMAC-SHA256, 60s TTL) | Validated per-request in route handlers | `instaclaw/lib/security.ts:203-257` |

**Account linking:** Both surfaces share `instaclaw_users` table. Linked by `world_wallet_address` on the user row. Manual linking codes also supported.

### 2.2 Access Control (Current)

```
instaclaw/middleware.ts (lines 24-91):
  - Checks: authentication ONLY (is there a NextAuth session?)
  - Protected pages: /dashboard, /settings, /billing, /tasks, /history, /files, /scheduled, /env-vars, /ambassador, /live
  - Mini-app tokens: bypass auth check, validated in route handlers
  - Subscription check: NONE

instaclaw/app/(dashboard)/layout.tsx (lines 59-131):
  - Checks: authenticated + onboarding complete
  - If onboarding incomplete: redirect to /connect
  - Subscription check: NONE
```

**Gap: ANY authenticated user has full dashboard access, including WLD-only users who never subscribed.**

### 2.3 Subscription & Billing

**Tables:**
- `instaclaw_subscriptions` — one row per user (UNIQUE on `user_id`)
  - `tier`: `free_trial`, `starter`, `pro`, `power`, `byok`
  - `status`: `active`, `past_due`, `canceled`, `trialing`
  - `payment_status`: `current`, `past_due`
  - `stripe_customer_id`, `stripe_subscription_id`
  - `current_period_end`, `trial_ends_at`, `past_due_since`

**Stripe Plans:**

| Tier | All-Inclusive | BYOK | Daily Units |
|------|-------------|------|-------------|
| Starter | $29/mo | $14/mo | 600 |
| Pro | $99/mo | $39/mo | 1000 |
| Power | $299/mo | $99/mo | 2500 |

**Free trial:** 3 days default, 7 days for "renata-friends-trial" referrals. Created in `instaclaw/app/api/billing/checkout/route.ts:109-120`.

**Cancellation flow** (`instaclaw/app/api/billing/webhook/route.ts:448-541`):
1. `instaclaw_subscriptions.status` = `canceled`
2. VM stamped with `last_assigned_to` (for reuse on resubscription)
3. Telegram fields cleared (releases unique constraints)
4. Gateway stopped, VM `health_status` = `suspended`
5. 30-day retention before data wipe

**Webhook events handled** (`instaclaw/app/api/billing/webhook/route.ts`):
- `checkout.session.completed` — creates subscription + assigns/reactivates VM
- `customer.subscription.updated` — syncs tier changes to subscription + VM
- `customer.subscription.deleted` — cancels + suspends VM
- `invoice.payment_failed` — marks `past_due`
- `invoice.payment_succeeded` — clears `past_due`, restarts if suspended
- `charge.refunded` — voids ambassador commission
- `customer.subscription.trial_will_end` — sends warning email

### 2.4 Credit System

**Two independent mechanisms coexist:**

#### A. Daily Tier Limits (Stripe subscribers)
- Tracked in `instaclaw_daily_usage` table (keyed by `vm_id + usage_date`)
- Limits: Starter 600, Pro 1000, Power 2500 weighted units/day
- Resets at user's local midnight (timezone-based date calculation, no cron)
- Model cost weights: MiniMax 0.2, Haiku 1, Sonnet 4, Opus 19
- Tool continuations: 0.2x multiplier
- Heartbeats: separate 100-unit daily budget, never touches user limits

#### B. Credit Balance (WLD users, Stripe credit packs, overflow)
- Stored in `instaclaw_vms.credit_balance` (integer)
- Added via `instaclaw_add_credits()` RPC (atomic, logged to `instaclaw_credit_ledger`)
- Persistent until consumed. No auto-refresh, no expiry.
- Decremented ONLY when daily tier limit is exceeded

#### Order of checks in gateway proxy (`instaclaw_check_limit_only()` RPC):

```
1. Heartbeat? → Check heartbeat budget (100/day). Never touches user limits.
2. Daily limit not exceeded? → ALLOW (source: 'daily_limit')
3. Daily limit exceeded but credit_balance >= cost? → ALLOW + DEDUCT (source: 'credits')
4. No credits but within buffer zone (+200 units)? → ALLOW (grace, source: 'buffer')
5. Everything exhausted? → HARD BLOCK
```

**Files:**
- Check RPC: `instaclaw/supabase/migrations/20260303_merge_tier_budget_into_limit_check.sql:12-171`
- Increment RPC: `instaclaw/supabase/migrations/20260301_user_timezone.sql:155-244`
- Constants: `instaclaw/lib/credit-constants.ts`
- Gateway proxy: `instaclaw/app/api/gateway/proxy/route.ts:501-596`

### 2.5 WLD Payment System (Mini App)

**Tiers** (`instaclaw-mini/app/api/delegate/initiate/route.ts:6-10`):
```
try_it:     { wld: 25,  credits: 150,  durationDays: 3  }
starter:    { wld: 15,  credits: 500,  durationDays: 7  }
full_month: { wld: 50,  credits: 2000, durationDays: 30 }
```

**Flow:**
1. Mini app calls `/api/delegate/initiate` with tier
2. Server creates `instaclaw_wld_delegations` row (status: `pending`)
3. Frontend triggers `MiniKit.commandsAsync.pay()` with WLD amount
4. On success, calls `/api/delegate/confirm` with transaction ID
5. Credits added **immediately** to `instaclaw_vms.credit_balance` (before on-chain confirmation)
6. If new user (no VM), proxies to instaclaw.io `/api/vm/assign` then `/api/vm/configure`

**Key difference from Stripe:** WLD payments add to `credit_balance` (one-time, finite). Stripe subscriptions set `tier` which gives daily limits (renewable, infinite as long as subscribed).

### 2.6 Mini App Data Flow

```
DIRECT SUPABASE READS (server-side, service role key):
  - instaclaw_vms: credit_balance, status, health, model, etc.
  - instaclaw_users: gmail_connected, wallet address
  - instaclaw_daily_usage: message_count, heartbeat_count
  - instaclaw_wld_delegations: delegation history
  - instaclaw_world_payments: payment history

PROXIED WRITES (via X-Mini-App-Token to instaclaw.io):
  - POST /api/vm/assign (new users)
  - POST /api/vm/configure (new users)
  - POST /api/tasks/suggestions (GET, personalization)
  - POST /api/onboarding/gmail-insights (personalization)
```

### 2.7 Current Upsell Touchpoints

| Location | Trigger | What shows | Action |
|----------|---------|-----------|--------|
| Mini app Home (paused banner) | `credit_balance <= 0` | "Agent paused - credits ran out" | "Pay 25 WLD" / "Subscribe" (→ instaclaw.io/billing) |
| Mini app Home ("+ Add" button) | Always visible | Small button in credit card | Same as "Pay 25 WLD" flow |
| Mini app Settings | Always visible | "Pay with WLD" / "Subscribe" buttons | WLD payment / → instaclaw.io/billing |
| Mini app Onboarding (verify failed) | World ID verification fails | "Subscribe on instaclaw.io instead" | → instaclaw.io/billing |
| instaclaw.io Billing page | User navigates there | Full plan comparison + checkout | Stripe checkout session |

**Gap: No low-credit warning. No proactive upgrade prompts. No subscription detection in mini app.**

---

## 3. Problems Identified

### P1: No Dashboard Access Gating
WLD-only users (no Stripe subscription) can access the full instaclaw.io dashboard by signing in with the same email. There is zero subscription checking in middleware or layout. This undermines the value proposition of paid subscriptions.

### P2: No Unified Credit Model
Daily tier limits and credit_balance are two separate systems. A WLD user with 150 credits has a completely different experience than a Starter subscriber with 600 daily units. The mini app only shows `credit_balance` and has no awareness of daily limits or subscription tier.

### P3: No Subscription Awareness in Mini App
The mini app never checks `instaclaw_subscriptions`. It doesn't know if a user has an active Stripe subscription. It can't show subscriber-specific UI, hide upgrade prompts for subscribers, or reflect daily limit resets.

### P4: No Low-Credit Warning
Users get zero warning before credits hit zero. The pause banner only appears AFTER exhaustion. By then the agent is already unresponsive and the user has had a bad experience.

### P5: Upgrade Path is Unclear
"Subscribe" buttons open instaclaw.io/billing in an external browser, which requires Google sign-in (a different auth system). WLD users arriving at the billing page have no session. There's no wallet-based auth path to Stripe checkout.

### P6: WLD Users on instaclaw.io Have No VM Tier
WLD users have `instaclaw_vms.tier = NULL` (or whatever default). The daily limit check in the gateway proxy uses this tier to determine limits. With no tier, WLD users rely entirely on `credit_balance` and get zero daily limit — their credits drain on every single message with no renewable buffer.

### P7: Credit Packs Require Active Subscription Context
`instaclaw/app/api/billing/credit-pack/route.ts` requires NextAuth session and an assigned VM. WLD users arriving from the mini app can't buy credit packs via Stripe without first establishing a web session.

### P8: No Grace Period Visibility
When a subscriber's payment fails, the system sets `past_due` but the mini app has no awareness of this state. The user's agent could be suspended and they'd only see "Offline" with no explanation.

### P9: Race Conditions on Credit Balance
Both the mini app (WLD delegation confirm) and instaclaw.io (Stripe credit pack webhook) can modify `credit_balance` on the same VM. The RPC `instaclaw_add_credits` uses atomic SQL, but the mini app's confirm endpoint does a raw `.update()` with read-then-write (`credit_balance: agent.credit_balance + credits`), which is not atomic.

### P10: Duration Days are Cosmetic
WLD delegation `durationDays` (3/7/30) is stored but never enforced. Credits persist indefinitely. This is either a feature (generous) or a bug (no recurring revenue pressure).

---

## 4. Proposed Architecture

### 4.1 Access Tiers

| Tier | Source | Dashboard Access | Mini App | Telegram | Daily Limit | Credit Balance |
|------|--------|-----------------|----------|----------|-------------|---------------|
| **WLD-only** | WLD payment, no Stripe | Restricted (upgrade page) | Full | Full | None (0) | Yes (purchased) |
| **Subscriber** | Active Stripe subscription | Full | Full | Full | Per plan (600/1000/2500) | Yes (overflow + packs) |
| **BYOK** | Stripe BYOK plan | Full | Full | Full | Unlimited | N/A (own API key) |
| **Canceled** | Was subscriber, now canceled | Restricted (resubscribe page) | Full (if credits remain) | Full (if credits remain) | None (0) | Yes (remaining balance) |
| **Past Due** | Payment failed | Full (grace period: 7 days) | Full | Full | Per plan (grace) | Yes |

### 4.2 Dashboard Gating Logic

**New middleware check** in `instaclaw/middleware.ts`:

```
For protected dashboard pages (/dashboard, /tasks, /history, /files, /scheduled, /settings, /live):
  1. Authenticated? No → redirect /signin
  2. Onboarding complete? No → redirect /connect
  3. Has active subscription (status = 'active' OR 'trialing' OR ('past_due' AND past_due_since < 7 days ago))? → Full dashboard
  4. No subscription? → redirect /upgrade
```

**New page: `/upgrade`**
- Shown to WLD-only users who navigate to instaclaw.io
- "Your agent is running via World App and Telegram"
- Plan comparison cards (Starter/Pro/Power)
- One-tap Stripe checkout (no Google sign-in required if wallet-linked)
- "Or continue using World App" link back

**Exception routes** (accessible without subscription):
- `/billing` — so users can subscribe/resubscribe
- `/settings` — so users can manage account, link wallet
- `/upgrade` — the upsell page itself

### 4.3 Universal Credit System

**Principle:** Both payment methods fund the same `credit_balance`. Stripe subscribers ALSO get daily limits as a renewable buffer on top.

**For WLD-only users:**
- No daily limit (tier = NULL or `wld_only`)
- Every message costs from `credit_balance` directly
- Model cost weights still apply (Haiku = 1, Sonnet = 4, etc.)

**For Stripe subscribers:**
- Daily limit resets at local midnight (existing behavior)
- Once daily limit exceeded, `credit_balance` used as overflow (existing behavior)
- WLD top-ups add to same `credit_balance`

**No changes to the gateway proxy RPC logic needed** — it already handles both systems correctly. The check order (daily limit → credit balance → buffer → block) works for both user types. WLD-only users simply have daily limit = 0, so every message hits credit_balance first.

### 4.4 Upgrade Flow from Mini App

```
Mini App "Subscribe" button
  → GET /api/subscription/checkout-url (new endpoint on instaclaw-mini)
    → Server generates short-lived token with userId
    → Returns URL: https://instaclaw.io/api/billing/checkout-mini?token=xxx&tier=starter
  → window.open(url, "_blank") — opens in system browser

instaclaw.io /api/billing/checkout-mini (new endpoint)
  → Validates mini-app token → extracts userId
  → Looks up/creates Stripe customer for this user
  → Creates Stripe checkout session
  → Redirects to Stripe checkout

Stripe checkout completes
  → Webhook fires checkout.session.completed
  → Subscription created, VM tier updated (existing logic)
  → Redirect to /api/billing/checkout-mini/success (new page, like Gmail success page)
    → "Subscribed! Return to World App"

User returns to mini app
  → Visibility change triggers /api/subscription/status poll
  → Mini app detects subscription → updates UI (removes upgrade prompts, shows subscriber badge)
```

### 4.5 Wallet-Based Auth on Billing Page

For WLD users arriving at instaclaw.io/billing without a NextAuth session:

**Option A (Recommended): Token-based bridge** — Same pattern as Gmail connect.
- Mini app generates signed URL with userId
- instaclaw.io validates token, creates temporary session cookie
- User can interact with billing page

**Option B: Wallet connect on web** — Add "Sign in with World Wallet" to instaclaw.io.
- More complex, requires WalletConnect or similar integration
- Better long-term but higher effort

**Recommendation:** Option A for launch, Option B for v2.

### 4.6 Cancellation & Grace Period

**Current:** Immediate suspension on `customer.subscription.deleted`.

**Proposed:**
- Payment failed (`invoice.payment_failed`): 7-day grace period (existing `past_due_since` field)
  - During grace: full access, daily limits active
  - After 7 days: suspend VM, restrict dashboard
  - Mini app shows: "Payment issue - update your card to keep your agent running"
- Subscription canceled: immediate restriction of dashboard, but agent continues until `current_period_end`
  - VM suspended only after period ends
  - Mini app shows: "Subscription ends [date]. Your agent will pause after that. Top up with WLD to keep it running."

### 4.7 Credit Packs Without Subscription

**Currently:** Credit packs require NextAuth session and assigned VM. WLD users can't buy them.

**Proposed:** Allow credit packs via the mini app as an alternative to WLD:
- Add USDC credit pack purchase to mini app (MiniKit.pay with USDC)
- Same packs: 50 credits ($5), 200 ($15), 500 ($30)
- No subscription required — just adds to `credit_balance`

---

## 5. Database Changes

### New columns on `instaclaw_users`:
```sql
ALTER TABLE instaclaw_users
  ADD COLUMN IF NOT EXISTS access_tier TEXT DEFAULT 'wld_only'
    CHECK (access_tier IN ('wld_only', 'subscriber', 'byok', 'canceled'));
```

*Note: This is a DERIVED/CACHED field for fast middleware checks. Source of truth remains `instaclaw_subscriptions.status`.* Run schema verification first per CLAUDE.md rules.

### New index for fast middleware lookup:
```sql
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
  ON instaclaw_subscriptions(user_id, status);
```

### Fix atomic credit addition in mini app:
The `delegate/confirm` endpoint needs to use the `instaclaw_add_credits` RPC instead of raw `.update()` to prevent race conditions.

---

## 6. API Changes

### New Endpoints

| Endpoint | Location | Purpose |
|----------|----------|---------|
| `GET /api/subscription/status` | instaclaw-mini | Returns subscription tier, status, daily limit info |
| `GET /api/subscription/checkout-url` | instaclaw-mini | Generates signed Stripe checkout URL for external browser |
| `GET /api/billing/checkout-mini` | instaclaw.io | Validates mini-app token, creates Stripe checkout, redirects |
| `GET /api/billing/checkout-mini/success` | instaclaw.io | Success page after Stripe checkout from mini app |

### Modified Endpoints

| Endpoint | Change |
|----------|--------|
| `instaclaw/middleware.ts` | Add subscription status check for dashboard pages |
| `instaclaw-mini/app/api/delegate/confirm/route.ts` | Use `instaclaw_add_credits` RPC instead of raw `.update()` |

---

## 7. Frontend Changes

### instaclaw.io

| Component | Change |
|-----------|--------|
| New `/upgrade` page | Upsell page for WLD-only users |
| `middleware.ts` | Add subscription gating logic |
| `/billing` page | Support wallet-auth users (no NextAuth session) |

### instaclaw-mini

| Component | Change |
|-----------|--------|
| Home tab | Low-credit warning at < 20% credits |
| Home tab | Subscriber badge if active subscription |
| Home tab (paused) | Clearer two-path upgrade: WLD top-up vs Subscribe |
| Settings tab | Show subscription status (tier, renewal date, daily limit) |
| Settings tab | "Manage Subscription" link for subscribers |
| Discovery tip | Replace generic text with upgrade prompt for non-subscribers |

---

## 8. Migration Plan

### Phase 0: Fix Critical Bug (do first, no feature flags)
- Fix `delegate/confirm` to use atomic `instaclaw_add_credits` RPC
- Estimated: 1 file change, deploy same day

### Phase 1: Subscription Detection in Mini App (no gating yet)
- Add `/api/subscription/status` endpoint to mini app
- Add subscription-aware UI to Home + Settings tabs
- Show subscriber badge, daily limit info, low-credit warning
- **No access restrictions yet** — purely additive UI
- Deploy, verify, gather feedback

### Phase 2: Upgrade Flow
- Build checkout-mini bridge on instaclaw.io
- Build checkout-url generator on instaclaw-mini
- Build success page
- Add "Subscribe" buttons that use the new flow (instead of raw instaclaw.io/billing link)
- Deploy, test with real Stripe checkout (test mode)

### Phase 3: Dashboard Access Gating
- Add subscription check to middleware
- Build `/upgrade` page
- Allow `/billing` and `/settings` without subscription
- **This is the breaking change** — WLD-only users lose dashboard access
- Deploy with feature flag (env var `GATE_DASHBOARD=true/false`)
- Test thoroughly, then enable

### Phase 4: Enhanced Credit UX
- Low-credit warning (< 20% threshold)
- Credit exhaustion with clear two-path upgrade
- Past-due payment warning in mini app
- Cancellation countdown in mini app

---

## 9. Edge Cases

### E1: User has both WLD credits AND active subscription
- Daily limit used first (renewable), credit_balance used as overflow
- **Already handled by existing RPC logic** — no change needed

### E2: User cancels subscription mid-month
- Dashboard restricted immediately
- VM continues until `current_period_end`
- After period ends: VM suspended, agent paused
- WLD credits (if any) still available via mini app + Telegram
- If they top up with WLD after cancellation: agent resumes via mini app only

### E3: User links accounts after buying credits separately
- If user paid WLD on mini app (userId A) and subscribed on instaclaw.io (userId B):
  - Account linking merges to one userId
  - Credits on userId A's VM need to be transferred to userId B's VM (or VMs merged)
  - **Needs manual handling** — add admin script for this case

### E4: Subscriber buys WLD credits via mini app
- Credits add to same `credit_balance` on their VM
- Useful as overflow beyond daily limit
- No conflict — both systems coexist cleanly

### E5: WLD user goes to instaclaw.io billing, subscribes
- Stripe webhook creates subscription row
- VM tier updated from NULL to subscriber tier
- User now has daily limits + existing credit_balance
- Dashboard access unlocked
- Mini app detects subscription on next status check

### E6: Payment fails, then user tops up with WLD
- Subscription is `past_due`, dashboard gated after 7 days
- But WLD credits still fund the agent via mini app + Telegram
- Agent keeps running (credit_balance > 0)
- If user fixes Stripe payment: `past_due` cleared, dashboard restored

### E7: User has zero credits AND zero daily limit
- Agent fully paused
- Gateway proxy returns hard block
- Mini app shows pause banner with upgrade options
- Telegram bot responds: "I'm paused — ask my human to add credits"

### E8: Free trial expires
- `customer.subscription.trial_will_end` webhook fires 3 days before
- Warning email sent
- On expiration: Stripe auto-charges or cancels
- If charged: subscription continues, no change
- If canceled: standard cancellation flow

### E9: User opens instaclaw.io/billing from mini app without NextAuth session
- Currently: redirected to sign-in (broken for WLD-only users)
- With Phase 2: token-based bridge creates temporary session
- User can complete Stripe checkout without Google sign-in

### E10: Concurrent WLD payment and Stripe credit pack
- Both modify `credit_balance` on same VM
- `instaclaw_add_credits` RPC is atomic (SQL `UPDATE ... SET credit_balance = credit_balance + amount`)
- Mini app confirm endpoint currently uses non-atomic read-then-write (P9 bug)
- **Fix in Phase 0** resolves this

---

## 10. Open Questions

### Q1: Should WLD-only users see instaclaw.io at ALL?
- **Option A:** Block entirely, redirect to upgrade page
- **Option B:** Allow read-only dashboard (can see agent status, but can't use advanced features like /tasks, /files, /scheduled)
- **Option C:** Allow full access but show persistent upgrade banner
- **Recommendation:** Option A for simplicity. Clear differentiation drives upgrades.

### Q2: Should we set a tier for WLD-only users?
- Currently `instaclaw_vms.tier` is NULL for WLD users, meaning they get 0 daily limit
- Could set `tier = 'wld_only'` with a small daily limit (e.g., 50 units) as a baseline
- This would let WLD users stretch their credits further (50 free daily + credit_balance overflow)
- **Tradeoff:** Generous = better UX but less upgrade pressure

### Q3: What happens to WLD credits when a user subscribes?
- **Option A:** Credits carry over (add to overflow pool). Simple, generous.
- **Option B:** Credits converted to equivalent subscription days. Complex, feels punitive.
- **Recommendation:** Option A. Credits are a bonus on top of daily limits.

### Q4: Should we enforce WLD delegation duration?
- Currently `durationDays` is cosmetic — credits never expire
- Enforcing expiration would create recurring revenue pressure but feels aggressive
- **Recommendation:** Don't enforce. Let credits persist. The natural depletion rate + upgrade prompts are sufficient.

### Q5: Credit pack pricing for WLD users?
- Should WLD users be able to buy small credit packs (50 credits / $5 equivalent in WLD)?
- Currently only the 25 WLD = 150 credits tier is exposed in the mini app
- The `starter` (15 WLD / 500 credits) and `full_month` (50 WLD / 2000 credits) tiers exist in code but aren't surfaced
- **Recommendation:** Surface all three tiers in the mini app with clear value comparison

### Q6: Billing page auth strategy?
- Token-based bridge (quick, reuses existing pattern) vs wallet connect on web (better UX, more effort)
- **Recommendation:** Token bridge for v1. Same pattern as Gmail connect — proven, already understood.

### Q7: Grace period for past-due subscribers?
- Currently: `past_due_since` is tracked but not enforced
- Proposed: 7-day grace period before suspension
- **Question:** Should dashboard access be restricted during grace period, or only after?
- **Recommendation:** Full access during grace period. Restriction only motivates if they notice, and email + in-app warning is more effective.

### Q8: Ambassador referral credits for WLD-to-Stripe upgrades?
- Ambassadors get $10 commission per Stripe referral
- If a WLD user upgrades via mini app using a referral code, does the ambassador get credit?
- **Recommendation:** Yes, if the original WLD sign-up was referred. Track `referred_by` across the upgrade.

---

## Appendix: File Reference

| System | Key Files |
|--------|-----------|
| Auth middleware | `instaclaw/middleware.ts` |
| Dashboard layout | `instaclaw/app/(dashboard)/layout.tsx` |
| NextAuth config | `instaclaw/lib/auth.ts`, `instaclaw/lib/auth.config.ts` |
| Mini-app auth | `instaclaw-mini/lib/auth.ts` |
| Stripe webhook | `instaclaw/app/api/billing/webhook/route.ts` |
| Stripe checkout | `instaclaw/app/api/billing/checkout/route.ts` |
| Billing status | `instaclaw/app/api/billing/status/route.ts` |
| Billing page | `instaclaw/app/(dashboard)/billing/page.tsx` |
| Credit packs | `instaclaw/app/api/billing/credit-pack/route.ts` |
| Credit constants | `instaclaw/lib/credit-constants.ts` |
| Gateway proxy | `instaclaw/app/api/gateway/proxy/route.ts` |
| Credit check RPC | `instaclaw/supabase/migrations/20260303_merge_tier_budget_into_limit_check.sql` |
| Credit increment RPC | `instaclaw/supabase/migrations/20260301_user_timezone.sql` |
| Mini-app dashboard | `instaclaw-mini/app/(tabs)/home/agent-dashboard.tsx` |
| Mini-app settings | `instaclaw-mini/app/(tabs)/settings/settings-client.tsx` |
| WLD delegation init | `instaclaw-mini/app/api/delegate/initiate/route.ts` |
| WLD delegation confirm | `instaclaw-mini/app/api/delegate/confirm/route.ts` |
| Mini-app Supabase reads | `instaclaw-mini/lib/supabase.ts` |
| Mini-app proxy writes | `instaclaw-mini/lib/api.ts` |
