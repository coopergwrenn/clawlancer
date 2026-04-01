# $INSTACLAW Tokenomics PRD

**Author:** Cooper Wrenn + Claude (Opus 4.6)
**Date:** 2026-04-01
**Status:** Draft — awaiting Bankr fee structure and legal review
**Priority:** P1

---

## The Flywheel: Every Action Burns $INSTACLAW

**One-sentence thesis:** Every dollar that flows through InstaClaw — subscriptions, credit purchases, agent token launches, trading fees, and skill provider fees — automatically buys and burns $INSTACLAW, so the more people use AI agents, the more the token accrues value.

**Design principles:**
- Crypto is invisible to the user. No wallet screens, no "connect wallet" popups, no token language in the product UI. Users pay in fiat or WLD. The burn happens silently on the backend.
- Every burn must be tied to real product usage and real revenue — not speculation, not staking theater, not governance votes nobody participates in.
- The flywheel compounds: more users -> more revenue -> more burns -> higher token value -> more attention -> more users.
- The product must work even if the token price is $0. Token mechanics create additional value accrual but the product stands on its own.

---

## Token Overview

| Parameter | Value |
|-----------|-------|
| Token | $INSTACLAW |
| Chain | Base (Coinbase L2) |
| Total Supply | Fixed at mint — deflationary via burns |
| Burn Mechanism | Automated buy-and-burn from multiple independent revenue streams |

---

## The Phases

Each phase introduces new burn sources. Each phase is its own announcement moment — a narrative arc that keeps the community engaged over months, not a single dump of information.

---

### Phase 0: Liquidity + Infrastructure

**Ships: Before any burn phase launches**
**Status: Not started — prerequisite for everything else**

No burns can happen without the on-chain infrastructure and sufficient liquidity. This phase is invisible to the community — it's pure backend setup.

#### What exists today

Nothing. No smart contracts, no liquidity positions, no multi-sig, no burn dashboard.

#### What needs to be built

**1. BurnRouter smart contract (Solidity, Base mainnet)**

```
AgentTokenBurnRouter:
  - receive(USDC) -> swap to $INSTACLAW via Uniswap V2/V3 -> burn()
  - Slippage protection: max 2% slippage, TWAP oracle for price reference
  - Split buys across time if amount > $1K (avoid moving price)
  - Event: TokenBurned(source, usdcAmount, instaclawBurned, timestamp)
  - Owner: treasury multi-sig (cannot be EOA)
```

The $INSTACLAW contract must support burning — either a native `burn()` function or transfer-to-dead-address (`0x000...dead`). Verify which mechanism the existing contract supports before building the router.

**2. Liquidity bootstrapping**

Before Phase 1 launches, seed a minimum of $50K-$100K in two-sided liquidity on Uniswap V3 (concentrated around current price). Without this, the first $500 buy-and-burn will move the price 30%+ and the burn just enriches the LP who sells into it.

Options:
- Seed from treasury
- Partner with a market maker
- Use a portion of treasury to provide two-sided liquidity

**3. Treasury multi-sig**

2-of-3 Gnosis Safe on Base. Signers: Cooper + one advisor + one technical co-signer. 24-hour timelock on burn operations exceeding $5K. Publish the Safe address so the community can verify all burn transactions.

**4. Burn dashboard (instaclaw.io/burns)**

Public-facing, real-time dashboard:

| Metric | Description |
|--------|-------------|
| Total $INSTACLAW burned (all time) | Running counter |
| Burn rate (last 24h / 7d / 30d) | Trend line |
| Burns by source | Pie chart: trading fees, subscriptions, WLD, marketplace |
| Supply remaining | Total supply minus burned |
| Next scheduled burn | Countdown to next treasury buy-and-burn |
| Transaction hashes | Every burn tx linked to BaseScan |

This dashboard is the "proof of work" — anyone can verify burns are happening and correlate them with product usage.

#### Checklist before Phase 1

- [ ] BurnRouter contract deployed and audited (or at minimum, reviewed by 2 independent devs)
- [ ] Liquidity position seeded on Uniswap V3
- [ ] Multi-sig Safe created and signers confirmed
- [ ] Burn dashboard frontend deployed
- [ ] $INSTACLAW burn mechanism verified (native burn vs dead address)
- [ ] Legal review of buy-and-burn mechanism complete

---

### Phase 1: The Agent Economy Loop

**Ships with: Bankr partnership launch**
**Burn sources: Agent token launch fee + Agent trading fees + Heartbeat compute (self-funding agents)**
**Status: Infrastructure partially built, blocked on Bankr partner key + fee structure**

This is the "holy shit" moment. The headline nobody else can claim: agents that pay for themselves and burn the parent token doing it.

#### What exists today

| Component | Status | Location |
|-----------|--------|----------|
| Bankr wallet provisioning flow | Built | `app/api/bankr/wallet/route.ts` |
| "Tokenize Your Agent" UI + form | Built | `components/dashboard/bankr-wallet-card.tsx` |
| Tokenize API endpoint (returns 503) | Skeleton | `app/api/bankr/tokenize/route.ts` |
| Trading fee webhook handler | Built (credits only) | `app/api/integrations/bankr/webhook/route.ts` |
| Dashboard Bankr card rendering | Built | `app/(dashboard)/dashboard/page.tsx` |
| Dual-tokenization guard (Virtuals vs Bankr) | Built | `app/api/bankr/tokenize/route.ts` |
| DB columns (bankr_wallet_id, etc.) | Migrated | Migration 038 |
| BurnRouter contract | **NOT BUILT** | — |
| Burn allocation in webhook | **NOT BUILT** | Webhook currently routes 100% to credits |

#### How it works

Every InstaClaw agent ships with a Bankr wallet at deploy — zero friction, happens automatically in the background. The agent can hold crypto, make trades, and earn from day one.

When a user is ready, they tap "Tokenize Your Agent" on the dashboard. Their agent launches its own token on Base through Bankr.

**On token launch (one-time burn event):**

```
User taps "Tokenize Your Agent"
       |
Agent token created on Base via Bankr
       |
Launch fee generated
       |
X% of launch fee -> BurnRouter -> open-market buy $INSTACLAW -> burn
       |
Remaining fee -> Bankr + liquidity pool
```

Every new agent tokenization = a burn event. The more agents that tokenize, the more $INSTACLAW gets burned. This scales linearly with user growth.

**On every trade (ongoing burn):**

```
Someone buys/sells an agent's token
       |
Trading fee generated (% of trade volume)
       |
Fee splits three ways:
  1. X% -> BurnRouter -> buy $INSTACLAW -> burn (feeds parent token)
  2. Y% -> convert to compute credits (agent funds its own inference)
  3. Z% -> Bankr protocol fee
       |
Agent keeps running, $INSTACLAW supply decreases
```

The agent literally pays for itself to keep running. And every trade that funds the agent also burns $INSTACLAW. Two flywheels in one action.

**Heartbeat burn (folded in — not a separate phase):**

Even when nobody's chatting, agents are alive — running heartbeats every few hours. For self-funding agents (those with active Bankr token trading), a portion of heartbeat compute cost routes through the same burn path:

```
Agent runs heartbeat cycle (MiniMax model, ~$0.001275/call)
       |
If agent is self-funding via Bankr token fees:
  Heartbeat cost paid from agent's Bankr wallet
  X% of cost -> BurnRouter -> buy-and-burn
       |
$INSTACLAW burns even while everyone sleeps
```

This is economically small (~$25/day across 200 agents, producing ~$2.55/day in burns at 10%) but narratively powerful: "InstaClaw agents burn $INSTACLAW in their sleep." Use it for social content, not as a core economic driver.

#### Honesty about trading fee burns

**Important distinction:** Launch fee burns are cleanly tied to a product action (user tokenizes their agent). Trading fee burns are tied to speculative demand for agent tokens — someone choosing to buy/sell an agent's token on the open market. This is still valid burn revenue, but it scales with speculation and market sentiment, not directly with product usage.

Most agent tokens will have negligible trading volume. If 200 agents tokenize but only 5 see meaningful trades, the ongoing burn from trading fees will be near-zero. The launch fee burn is the more reliable Phase 1 mechanism. Be honest about this when communicating to the community.

#### Why this is Phase 1

- Most novel — no one else has shipped "agents that pay for themselves"
- Tied to Bankr which is happening now
- Visually explainable in one tweet
- Creates immediate speculative interest because the mechanic is observable in real-time
- Every new user who tokenizes their agent creates a burn event (launch fee) and potentially an ongoing burn source (trading fees)

#### Key metrics to track

- Number of tokenized agents
- Daily trading volume across all agent tokens
- Daily $INSTACLAW burned from launch fees (separate from trading fees)
- Daily $INSTACLAW burned from trading fees
- Average agent self-funding rate (what % of compute is covered by trading fees)

#### Blockers

- [ ] Bankr partner key (requested from Igor, not yet received)
- [ ] Bankr fee structure confirmation — launch fee % and trading fee % available for burn split
- [ ] BurnRouter contract (Phase 0)
- [ ] Webhook handler update: add burn allocation routing alongside existing credit injection
- [ ] Tokenize endpoint: replace 503 skeleton with real Bankr token launch API integration

---

### Phase 2: The Silent Engine

**Ships with: Next pricing/billing update**
**Burn sources: Subscription revenue + WLD credit purchases**
**Status: Requires BurnRouter contract (Phase 0) + treasury operations + legal review**

This is where it gets serious for investors. Every single paying user — whether they pay with a credit card or WLD — is now silently feeding the burn. No crypto UI, no token awareness needed.

#### What exists today

| Component | Status | Location |
|-----------|--------|----------|
| Stripe subscription billing | Live | Stripe integration |
| WLD credit purchases (World Mini App) | Live | World App integration |
| Credit ledger | Live | `instaclaw_credit_ledger` table |
| Revenue tracking/ledger | **NOT BUILT** | Need `instaclaw_revenue_ledger` table |
| Automated treasury burn operations | **NOT BUILT** | — |
| Stripe -> on-chain routing | **NOT BUILT** | Needs legal review |

#### Subscription revenue burn (Stripe)

```
User pays $29/$99/$299 monthly via Stripe
       |
Stripe processes payment in USD
       |
InstaClaw treasury receives revenue
       |
Automated treasury operation (daily):
  10% of subscription revenue -> swap to USDC on Base -> BurnRouter -> buy $INSTACLAW -> burn
       |
User never knows. They just paid their subscription.
```

This is the Jordan model. The 5th largest tractor company, a record label, an insurance agency — none of them know or care that their payment is burning a token. They're just using the product because it works.

**Revenue math (current):**

| Tier | Monthly | Users (est.) | Monthly Revenue | Burn (at 10%) |
|------|---------|-------------|-----------------|---------------|
| Starter | $29 | 60 | $1,740 | $174 |
| Pro | $99 | 25 | $2,475 | $248 |
| Power | $299 | 7 | $2,093 | $209 |
| **Total** | | **92** | **$6,308** | **$631/mo** |

$631/mo in burns is small at current scale — and that's fine. This phase only matters at scale, and the mechanic is what matters: every new subscriber adds permanent recurring burn pressure. At 1,000 subscribers: ~$68K/mo revenue -> $6,800/mo in burns. At 10,000: $680K/mo -> $68K/mo in burns. Linear, predictable, unstoppable.

#### WLD credit purchase burn (World Mini App)

```
User pays 25 WLD for credits in World App
       |
WLD received in InstaClaw treasury wallet
       |
Automated treasury operation:
  Convert WLD to USD-equivalent value
  10% of USD-equivalent -> swap to USDC -> BurnRouter -> buy $INSTACLAW -> burn
  Remaining -> operational treasury (covers compute costs)
       |
User gets their credits. Token supply decreases.
```

**Critical: Calculate burn allocation in USD-equivalent terms, not raw WLD amounts.** WLD has traded from $0.10 to $11. If you burn "10% of WLD received" and WLD spikes 10x, you'd burn 10x more than intended. Peg the burn to the USD value at time of receipt.

**WLD revenue math (at ~$0.30/WLD):**

| Package | WLD Cost | USD Value | Credits | Burn (at 10%) |
|---------|----------|-----------|---------|---------------|
| Try It | 25 WLD | ~$7.50 | 150 | ~$0.75 |
| Starter | 15 WLD | ~$4.50 | 500 | ~$0.45 |
| Full Month | 50 WLD | ~$15.00 | 2,000 | ~$1.50 |

Every WLD purchase, no matter how small, contributes to the burn. World App has millions of users — even small per-user amounts compound at scale.

#### Why this is Phase 2

- Largest and most consistent revenue stream long-term
- Requires treasury infrastructure (multi-sig, automated swaps) — ships after Phase 0
- Less exciting to announce than Phase 1 but more significant for long-term value
- Announcement narrative: "Every InstaClaw subscription now powers the flywheel"

#### Implementation details

**Revenue ledger (new table: `instaclaw_revenue_ledger`):**

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| source | text | 'stripe_subscription' or 'wld_purchase' |
| nominal_amount | numeric | Raw amount (USD for Stripe, WLD for World) |
| usd_equivalent | numeric | USD value at time of receipt |
| burn_allocated | numeric | USD amount allocated to burn |
| burn_executed | boolean | Whether the burn tx has been submitted |
| burn_tx_hash | text | BaseScan transaction hash |
| created_at | timestamp | When revenue was received |

**Daily burn cron:**

```
1. Query instaclaw_revenue_ledger WHERE burn_executed = false
2. Sum burn_allocated amounts
3. If total < $10: skip (gas cost threshold — batch until meaningful)
4. Transfer burn allocation to BurnRouter contract
5. BurnRouter swaps USDC -> $INSTACLAW -> burn()
6. Update ledger rows: burn_executed = true, burn_tx_hash = tx hash
7. Post tx hash to burn dashboard
```

**Stripe -> on-chain routing:**

Stripe's ToS has restrictions on using payment proceeds for crypto purchases. The likely compliant path:
1. Stripe payouts land in a bank account (normal)
2. Treasury entity separately funds the on-chain burn wallet from that bank account
3. On-chain burn wallet executes daily burn via BurnRouter

This requires legal sign-off before implementation.

#### Key metrics to track

- Total subscription MRR
- Total WLD credit purchases per month
- Monthly $INSTACLAW burned from subscriptions
- Monthly $INSTACLAW burned from WLD purchases
- Burn rate as % of revenue

#### Blockers

- [ ] Legal review of Stripe revenue -> on-chain burn pathway
- [ ] `instaclaw_revenue_ledger` table design and migration
- [ ] Daily burn cron implementation
- [ ] Revenue tracking integration (Stripe webhook -> ledger, WLD receipt -> ledger)

---

### Future Phase: The Ecosystem Tax

**Ships with: Skill marketplace / developer platform launch (when ready)**
**Burn sources: Skill provider usage fees**
**Status: Conceptual — requires marketplace infrastructure that does not exist yet**
**Timeline: Not scheduled — launches when marketplace reaches critical mass**

This is the long game. This is where InstaClaw becomes a platform, not just a product. The key insight from Jordan: you own the distribution (the agent that users talk to), so skill providers should pay YOU for access.

This phase is intentionally not scheduled. It requires: a skill marketplace UI, a developer registration flow, a billing system for skill providers, and a meaningful number of third-party skills. The only external skill integration today is DegenClaw (Virtuals), which uses a partner revenue share model, not per-call fees. DegenClaw serves as a prototype for this phase's economics.

#### What exists today

| Component | Status | Location |
|-----------|--------|----------|
| DegenClaw skill (Virtuals partnership) | Deployed to 232 VMs | `instaclaw/skills/dgclaw/SKILL.md` |
| Partner ID revenue attribution | Placeholder | `lib/ssh.ts` (ACP_PARTNER_ID) |
| Skill marketplace UI | **NOT BUILT** | — |
| Developer registration flow | **NOT BUILT** | — |
| Per-call billing system | **NOT BUILT** | — |
| Skill usage tracking | **NOT BUILT** | — |

#### How it works

```
Third-party developer builds a skill (e.g., video generation, travel booking, data analysis)
       |
Developer registers skill in InstaClaw marketplace
       |
InstaClaw agents automatically discover and use the skill when relevant
       |
Every time an agent calls the skill:
  Developer gets paid per API call (usage-based)
  InstaClaw takes a platform fee (15-20% of each call, matching app store economics)
  10% of platform fee -> BurnRouter -> buy $INSTACLAW -> burn
       |
More skills = more useful agents = more users = more skill calls = more burns
```

**Pricing model:** Don't set skill prices centrally. Let skill providers set their own per-call prices. InstaClaw takes a 15-20% platform fee (app store economics). The platform fee feeds the burn. This aligns incentives: InstaClaw wants high-volume, high-value skills to succeed because we earn more.

**Example economics:**

| Skill | Cost per call | Platform fee (20%) | Burn (10% of fee) |
|-------|-------------|-------------------|-------------------|
| Video generation | $0.50 | $0.10 | $0.01 |
| Travel booking | $1.00 | $0.20 | $0.02 |
| Data analysis | $0.25 | $0.05 | $0.005 |
| Market research | $0.75 | $0.15 | $0.015 |

At 10,000 daily active agents making an average of 5 skill calls per day:
- 50,000 daily skill calls
- ~$5,000 daily platform fees
- ~$500 daily burns = ~$15,000/month

This is the network effect phase. Every new skill makes every agent more useful, which attracts more users, which makes the platform more attractive to skill developers. Classic marketplace flywheel, with token burns baked into every transaction.

#### Key metrics to track (when launched)

- Number of registered skills
- Daily skill API calls
- Revenue from skill provider fees
- $INSTACLAW burned from marketplace transactions

---

## Combined Burn Model

At scale, all phases compound:

| Phase | Source | Monthly Burn (1K users) | Monthly Burn (10K users) | Monthly Burn (100K users) |
|-------|--------|----------------------|------------------------|-------------------------|
| 1 | Agent token launches + trading fees | ~$2,000 | ~$20,000 | ~$200,000 |
| 2 | Subscriptions + WLD purchases | ~$6,800 | ~$68,000 | ~$680,000 |
| Future | Skill marketplace fees | — | ~$15,000 | ~$150,000 |
| **Total** | | **~$8,800/mo** | **~$103,000/mo** | **~$1,030,000/mo** |

These are estimates. Phase 1 trading fee burns in particular depend on speculative demand for agent tokens, not just user growth. Key insight: burns scale with users across ALL sources simultaneously. There's no single point of failure — if trading slows down, subscriptions still burn. If subscriptions plateau, the marketplace (when live) keeps growing.

---

## User Experience

**What the user sees:**
- "Pay $29/month for your AI agent" (Stripe)
- "Activate with 25 WLD" (World App)
- "Tokenize Your Agent" button on dashboard
- Credit balance, usage stats, agent performance

**What the user NEVER sees:**
- Token burns happening
- Smart contract interactions
- Wallet connections (Bankr wallet is invisible, provisioned automatically)
- Any mention of $INSTACLAW in the core product UI

**Where $INSTACLAW IS visible (separate from core product):**
- instaclaw.io/token — dedicated tokenomics page
- instaclaw.io/burns — public burn dashboard
- CoinGecko / DEX listings
- X/Twitter announcements
- Community Discord/Telegram

This separation is critical. The product sells on utility ("your AI agent that works 24/7"). The token accrues value from that utility silently. Users who care about the token can follow it. Users who don't never have to think about it.

---

## Revised Phase Structure

| Phase | Name | Ships With | Core Burn | Dependency |
|-------|------|-----------|-----------|------------|
| **0** | Liquidity + Infrastructure | Before anything else | Deploy BurnRouter, seed liquidity, set up multi-sig, burn dashboard | Legal review |
| **1** | Agent Economy Loop | Bankr partner key | Token launch fees + trading fees -> burn + compute credits + heartbeat burn for self-funding agents | Phase 0 + Bankr fee structure |
| **2** | Silent Engine | Next billing cycle | Subscription + WLD revenue -> daily treasury burn | Phase 0 + Stripe legal review |
| **Future** | Ecosystem Tax | Skill marketplace (when ready) | Skill provider platform fees -> burn | Marketplace infrastructure + critical mass |

---

## Technical Implementation

### Phase 0 Implementation (Liquidity + Infrastructure)

**BurnRouter contract spec:**

```solidity
// AgentTokenBurnRouter.sol (Base mainnet)
// Owner: Gnosis Safe multi-sig (2-of-3)
// Receives USDC, swaps to $INSTACLAW via Uniswap, burns

interface IAgentTokenBurnRouter {
    function executeBurn(uint256 usdcAmount, string calldata source) external;
    function setMaxSlippage(uint256 bps) external; // owner only
    function setMinBurnThreshold(uint256 usdcAmount) external; // owner only

    event TokenBurned(
        string source,        // "launch_fee", "trading_fee", "subscription", "wld_purchase"
        uint256 usdcAmount,
        uint256 instaclawBurned,
        uint256 timestamp
    );
}

// Safety:
// - Max slippage: 200 bps (2%) default
// - TWAP oracle for price reference (prevents sandwich attacks)
// - If amount > $1K USDC, split into multiple swaps across blocks
// - Only callable by multi-sig or approved automation address
```

**Price oracle considerations:**

The BurnRouter needs slippage protection. Options:
1. Uniswap V3 TWAP oracle (preferred — on-chain, no external dependency)
2. Chainlink price feed (if $INSTACLAW gets listed)
3. Simple max-slippage guard (minimum viable — check spot price vs expected, revert if >2% deviation)

Start with option 3 (simplest), upgrade to option 1 when volume justifies it.

### Phase 1 Implementation (Agent Economy Loop)

**On agent token launch:**

```
1. Bankr creates token on Base via their API
2. Launch fee collected by Bankr
3. Bankr sends burn allocation to BurnRouter (or: webhook -> treasury -> BurnRouter)
4. BurnRouter.executeBurn(amount, "launch_fee")
5. Router swaps USDC -> $INSTACLAW via Uniswap
6. Router calls burn() on $INSTACLAW contract (or transfers to dead address)
7. Event emitted: TokenBurned("launch_fee", amount, burned, timestamp)
```

**On agent token trade:**

```
1. Trading fee collected by Bankr
2. Bankr webhook fires to /api/integrations/bankr/webhook
3. Webhook handler splits fee:
   a. Burn allocation -> queue for BurnRouter (batch with daily burn)
   b. Compute credits -> instaclaw_add_credits() RPC (existing flow)
4. Daily burn cron picks up queued burn allocations
5. BurnRouter.executeBurn(batchedAmount, "trading_fee")
```

**Changes to existing webhook handler (`/api/integrations/bankr/webhook/route.ts`):**

Currently converts 100% of trading fees to credits via `usdcToCredits()`. Needs modification:
- Read burn split percentage from config (start at 10%)
- Route burn allocation to `instaclaw_revenue_ledger` (burn_allocated column)
- Route remaining 90% to credits via existing `instaclaw_add_credits()` flow

### Phase 2 Implementation (Silent Engine)

**Revenue tracking pipeline:**

```
Stripe webhook (invoice.paid) -> insert into instaclaw_revenue_ledger
WLD delegation confirm -> insert into instaclaw_revenue_ledger (USD-equivalent calculated at receipt time)

Daily burn cron:
1. SELECT SUM(burn_allocated) FROM instaclaw_revenue_ledger WHERE burn_executed = false
2. If total < $10: skip (gas cost threshold)
3. Transfer USDC to BurnRouter
4. BurnRouter.executeBurn(total, "subscription" or "wld_purchase")
5. UPDATE instaclaw_revenue_ledger SET burn_executed = true, burn_tx_hash = ?
```

---

## Answers to Open Questions

### 1. Burn percentages

**Answer: Start at 10% across all sources.**

10% is round, easy to communicate, and leaves 90% for operations. You can always increase later — the community loves "we're increasing the burn!" Decreasing is a nightmare. At current revenue ($6,308/mo), 10% = $631/mo. Small but real. At 10K users, it's $6,800/mo — meaningful.

Model at various levels before committing:

| Burn % | Monthly burn (current) | Monthly burn (1K users) | Impact on margins |
|--------|----------------------|------------------------|-------------------|
| 5% | $315 | $3,400 | Negligible |
| 10% | $631 | $6,800 | Minor |
| 15% | $946 | $10,200 | Noticeable |
| 20% | $1,262 | $13,600 | Significant |

Recommendation: 10% at launch. Announce a path to 15% or 20% if revenue milestones are hit. Never announce a decrease.

### 2. Burn frequency

**Answer: Daily burns, batched.**

One transaction per day. Post the tx hash to the burn dashboard automatically. The community wants to see daily burns — weekly is too slow for narrative purposes. Per-transaction burns would be ideal for transparency but are unnecessary given Base's low gas costs ($0.001-$0.01 per tx). A single daily batch is transparent enough and operationally simpler.

Exception: set a minimum burn threshold of $10/day. If daily revenue is too low, batch until it crosses the threshold. This avoids gas costs exceeding burn value in the early days.

### 3. Bankr fee structure

**Answer: BLOCKER — cannot finalize this PRD without these numbers.**

Need from Igor:
- What % trading fee does Bankr charge on agent token trades?
- What portion of that fee is available for InstaClaw to split (burn + credits)?
- Is there a token launch fee? If so, what % can we route to burns?

The entire Phase 1 burn projection depends on these numbers. If Bankr takes 1% and gives us 30%, the math is very different than if they take 3% and give us 50%.

### 4. Token launch fee structure

**Answer: See #3 — same blocker.** Depends entirely on Bankr's API spec for token launches.

### 5. Legal/compliance

**Answer: Buy-and-burn from operational revenue is generally safer than buybacks, but needs legal review.**

Key distinction: we're buying to burn (permanently destroy), not buying to hold or distribute. This is closer to a stock buyback where shares are retired. BNB, MKR, and many other tokens have done this without securities issues.

Specific areas needing legal sign-off:
- Stripe ToS compliance for routing payment proceeds to crypto purchases (likely needs an intermediary treasury entity)
- Whether automated treasury burns constitute market manipulation (they shouldn't — burns are proportional to revenue, not timed for market impact)
- Whether the burn mechanism creates unregistered securities implications (unlikely if token has no governance rights and burns are one-directional)

### 6. Multi-sig setup

**Answer: 2-of-3 Gnosis Safe on Base.**

Signers:
1. Cooper (operational)
2. One advisor (oversight)
3. One technical co-signer (security)

24-hour timelock on burn operations exceeding $5K. Publish the Safe address publicly so the community can verify all burn transactions on BaseScan.

### 7. Skill marketplace pricing

**Answer: Don't set prices centrally. Let skill providers set their own.**

InstaClaw takes a 15-20% platform fee on each call (app store economics). The platform fee feeds the burn. This aligns incentives: InstaClaw wants high-volume, high-value skills to succeed because we earn more.

### 8. $INSTACLAW liquidity

**Answer: This is a prerequisite, not an afterthought. Must be solved in Phase 0.**

Minimum $50K-$100K in two-sided liquidity on Uniswap V3 before any burn phase launches. Without sufficient liquidity:
- Buy-and-burn causes excessive slippage (inefficient burns)
- Price spikes artificially, then crashes when someone sells into thin orderbook
- Burns just enrich LPs who sell into the buy pressure

Options: seed from treasury, partner with a market maker, or provide two-sided liquidity from a dedicated treasury allocation.

---

## Rollout Timeline

| Phase | Target | Dependency | Announcement |
|-------|--------|------------|-------------|
| Phase 0: Infrastructure | April 2026 | Legal review + contract audit | (No public announcement — backend only) |
| Phase 1: Agent Economy Loop | May-June 2026 | Phase 0 + Bankr partner key + fee structure | "Your agent pays for itself — and burns $INSTACLAW with every trade" |
| Phase 2: Silent Engine | June-July 2026 | Phase 0 + Stripe legal review | "Every InstaClaw subscription now powers the flywheel" |
| Future: Ecosystem Tax | When marketplace launches | Marketplace infrastructure + developer critical mass | "The App Store for AI agents — every transaction burns $INSTACLAW" |

---

## Summary

$INSTACLAW tokenomics are designed around one principle: **every action in the InstaClaw ecosystem creates buy pressure and burns, tied directly to real product usage, completely invisible to the end user.**

Three phases, each escalating:
1. **Agent Economy Loop** — agents pay for themselves and burn the parent token (including heartbeat self-funding)
2. **Silent Engine** — every subscription and credit purchase silently burns
3. **Ecosystem Tax** (future) — third-party developers pay to access the agent network

Preceded by Phase 0: the on-chain infrastructure (BurnRouter, liquidity, multi-sig, dashboard) that makes all burns possible.

The result: a deflationary token whose value is mathematically linked to product adoption. Not speculation. Not governance theater. Real usage -> real revenue -> real burns.

**The one-sentence test:** "If a billion people use InstaClaw agents every day, paying subscriptions, buying credits, tokenizing agents, and calling skills, every one of those actions generates revenue that automatically buys and burns $INSTACLAW."

---

## Current Blockers (Action Items)

1. **Bankr fee structure from Igor** — Phase 1 cannot be finalized without trading fee % and launch fee % numbers
2. **Legal review** — Buy-and-burn mechanism, Stripe -> on-chain routing, securities implications
3. **BurnRouter contract** — Needs to be designed, built, and audited
4. **Liquidity bootstrapping plan** — Source of $50-100K for Uniswap V3 position
5. **$INSTACLAW contract audit** — Verify burn mechanism (native burn() vs dead address)
6. **Multi-sig signer selection** — Identify advisor and technical co-signer for Gnosis Safe
