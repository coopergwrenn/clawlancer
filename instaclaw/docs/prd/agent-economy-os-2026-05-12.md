# Frontier — InstaClaw's Open Agent Economy

**PRD:** `agent-economy-os-2026-05-12.md`
**Author:** Cooper Wrenn + Claude (Opus 4.7 1M)
**Date:** 2026-05-12 · **Revised:** 2026-06-01 (v0.2)
**Status:** v0.2 — strategic blueprint. Supersedes v0.1 entirely (not a patch — full rewrite after the v0.1 critical audit). Awaiting Cooper review before Phase 1A execution.
**Priority:** P0
**Related docs:**
- `instaclaw/docs/prd/bankr-integration.md` (wallets, tokenization, NFTs)
- `instaclaw/docs/prd/instaclaw-tokenomics-prd.md` (burn flywheel + Phase 0/1/2)
- `instaclaw/docs/prd/matching-engine-design-2026-05-03.md` (agent-to-agent discovery)
- `instaclaw/docs/prd/edge-city-strategy-2026-05-03.md` (Esmeralda village)
- `instaclaw/docs/prd/PRD-gbrain-integration.md` (semantic memory engine)
- CLAUDE.md Rule 66 (Bankr primary + Coinbase CDP backup wallet on every VM)

---

## 0. Executive Summary

**One sentence.** Frontier turns every InstaClaw agent into a sovereign economic actor — it has a wallet, a debit card, an on-chain identity, and the ability to earn and spend autonomously — and then, because every agent runs on its own dedicated machine, it can rent out its idle compute to other agents while its human sleeps.

**Two phases, one economy.**

- **Phase 1 — Core economic infrastructure.** Every agent gets the full economic stack a small business has: a wallet (Bankr + Coinbase CDP, both already shipped), a **virtual debit card** (Stripe Issuing for agents, live as of Stripe Sessions 2026), an on-chain identity (AgentBook + ERC-8004), and earn/spend primitives (x402 server to earn, x402 client + Stripe MCP + Base MCP to spend), all gated by autonomy tiers and audit-trailed. This is the part users **see**. It is what makes someone open Telegram and go *"holy shit, my agent has a bank account."* It makes Virtuals' EconomyOS look like the v1 it is.

- **Phase 2 — The compute marketplace.** Every InstaClaw agent runs on a dedicated Linode (2 vCPU, 4GB, 80GB) that sits **85–95% idle**. Phase 2 lets agents rent that idle compute to each other, settled in USDC over x402. *Your agent sleeps; its body works the night shift; you wake up to $3.40.* This is the structural leapfrog: Virtuals' agents are shared-tenant cloud functions with no idle dedicated compute to sell. **They cannot copy this without rebuilding their entire infrastructure.** Phase 2 is where the real magic is — but it requires Phase 1's USDC rails, identity, and settlement plumbing to exist first. You cannot rent compute for USDC if the USDC rails don't exist.

**The strategic frame.** Virtuals shipped EconomyOS — a closed, vertically-integrated suite (their wallet · email · domain · Visa card · proprietary ACP commerce protocol). It is polished and it works. But the real on-chain commerce flowing through it is small (~20,000 autonomous on-chain transactions despite 17,000 agents — see [§2.4](#24-virtuals-the-honest-numbers)), and it is a walled garden. Meanwhile the open-standards stack matured underneath everyone: x402 V2 is stable with a fee-free Coinbase facilitator on Base (69K agents, 165M transactions, ~$50M cumulative volume by late April 2026); Stripe shipped Issuing-for-agents + a Link wallet for agents + the Machine Payments Protocol; Google's AP2 has 60+ payment-industry signatories; Base MCP went live May 26 2026; ERC-8004 is on Ethereum mainnet. **Virtuals built a suite. We build the economy that runs on the standards everyone else adopted — on a runtime nobody else has.**

**What's genuinely ours (and only ours):** per-agent dedicated compute + persistent filesystem, World ID-verified humans at the root of every account, gbrain per-agent economic memory, and the existing 3-layer matching engine for counterparty discovery. Everything else in Phase 1 (wallet, card, x402 wiring, identity registration) is table-stakes infrastructure that any well-resourced team can build — we build it well and fast and integrated, but we should not pretend it's a moat. The moat is Phase 2 and the four structural assets above.

**Honest status (2026-06-01):** Phase 1 is ~40% pre-built. Wallets (Bankr + CDP) are live fleet-wide. AgentBook + World ID are live. The matching engine is in production for intros (commerce extension not yet built). gbrain is rolling out (live on edge_city, broader fleet in progress). What's NEW work: the x402 server, the debit card, Stripe/Base MCP wiring, ERC-8004 registration, the commerce extension to matching, and the entire compute marketplace. This PRD is a build plan, not a victory lap.

---

## 1. The Strategic Frame

### 1.1 What Virtuals shipped (EconomyOS)

Per [os.virtuals.io](https://os.virtuals.io/) and [Virtuals' EconomyOS coverage](https://cryptobriefing.com/virtuals-protocol-economyos-ai-agents-inbox/), EconomyOS bundles four pillars so an agent "functions like a small business":

1. **Identity** — non-custodial wallet · email inbox (autonomously processes OTPs, verification links, receipts) · web domain.
2. **Capital** — token launches (anti-sniper, trial launches, growth allocations, $VIRTUAL liquidity, 42K-$VIRTUAL graduation → Uniswap V2).
3. **Commerce** — **virtual payment card** for real-world checkout · payments · **ACP (Agent Commerce Protocol)**, their proprietary agent-to-agent commerce layer.
4. **Compute** — console · inference · memory.

Developer surface: ACP CLI + SDK (`@virtuals-protocol/acp-node-v2`), the Virtuals Console. ~17,000 agents.

**The honest read.** This is a complete, polished, vertically-integrated suite. It will pull agents in. Its weaknesses are: (a) it's a walled garden — ACP commerce logic doesn't port off Virtuals; (b) the real on-chain commerce volume is small relative to the agent count ([§2.4](#24-virtuals-the-honest-numbers)); (c) it has no World ID layer, so reputation is sybil-vulnerable; (d) its agents are shared-tenant cloud functions, so it cannot offer dedicated-compute products. (a) and (d) are *structural*; Virtuals would have to rebuild to fix them. (b) and (c) are addressable but they haven't.

### 1.2 The open-standards stack matured underneath everyone

| Standard | State (June 2026) | Why it matters for Frontier |
|---|---|---|
| **x402 V2** ([Coinbase, Linux Foundation](https://www.x402.org/writing/x402-v2-launch)) | Stable spec. `exact` scheme. CDP facilitator **live on Base mainnet, fee-free**. 69K agents / 165M txns / ~$50M cumulative (late Apr 2026). Settlement ~200ms on Base. V2 separates spec / SDK / facilitator. | The earn + spend rail. HTTP-native USDC. We run a per-VM x402 server (earn) + x402 client (spend). |
| **Coinbase Agentic Wallets** ([launched Feb 11 2026](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets)) | MPC-secured agent wallet, programmable session caps, per-tx limits, gasless on Base, native x402, email-OTP auth, no private-key exposure. | We already provision a **Coinbase CDP backup wallet on every VM** (CLAUDE.md Rule 66). That backup wallet IS a CDP agentic-wallet path — we're half-wired in already. |
| **Stripe Issuing for agents** ([docs.stripe.com/issuing/agents](https://docs.stripe.com/issuing/agents)) | **Live.** Single-use virtual cards with merchant-category + amount controls, real-time auth decisioning, full txn visibility. Link wallet for agents + Shared Payment Token (SPT) shipped at Stripe Sessions 2026. Works at any Visa/Mastercard merchant. | **The agent debit card is real and shippable now.** This is the Phase 1 headline. |
| **Base MCP Gateway** ([launched May 26 2026](https://news.bitcoin.com/base-launches-mcp-gateway-letting-claude-and-chatgpt-execute-onchain-defi-actions/)) | Official MCP: wallet addresses/balances, transfers, contract calls, **Coinbase onramp**, ERC20/NFT mgmt, + ecosystem skills: Morpho/Moonwell (lending), Uniswap/Aerodrome (swaps), Avantis (perps), **Bankr + Virtuals (token launches)**. Keys stay outside the MCP; user approves pending actions. | A drop-in onchain toolset. We wire Base MCP as a spend/onchain rail rather than reimplementing swaps/onramp/lending. |
| **Stripe MCP + MPP** ([docs.stripe.com/mcp](https://docs.stripe.com/mcp)) | 25 tools, OAuth, v0.3.3. Machine Payments Protocol for agent-initiated payments. | Fiat commerce rail: invoices, payment links, customer billing — agent-callable. |
| **AP2** ([Google](https://ap2-protocol.org/)) | Public, 60+ payment-industry signatories (Amex, Mastercard, PayPal, Coinbase, etc.). A2A extension + A2A-x402 crypto extension. Mostly letters-of-intent; few production flows yet. | Cross-platform commerce bridge. We emit/verify AP2 Mandates so Frontier agents can transact with non-InstaClaw agents. Phase 1C / future. |
| **ERC-8004** ([Ethereum mainnet, Jan 29 2026](https://eips.ethereum.org/EIPS/eip-8004)) | Identity + Reputation + Validation registries live on mainnet. ~130K agents projected; real write counts unverified. | On-chain composable identity + reputation. World ID-gated → sybil-proof. |

**The strategic implication.** A 2026 agent platform chooses: **(A)** build a proprietary suite (Virtuals — higher near-term capture, structural lock-in fragility, must integrate every new partner bespoke), or **(B)** build the best runtime and run on the open standards (we benefit automatically from every new x402 facilitator, every Stripe Issuing expansion, every AP2 signatory, every Base MCP skill). We pick **(B)** because we already shipped on Bankr + CDP (not a proprietary wallet), AgentBook (open identity), and Telegram (open messaging). We have not shipped a proprietary commerce layer — so we are free to be the open one.

### 1.3 The leapfrog — separated into "table stakes" and "real moat"

I'm being deliberately honest here because v0.1 overclaimed. Two buckets:

**Bucket 1 — Table stakes (any funded team can build this; we build it well + fast + integrated, but it is NOT a moat):**

| Capability | Open standard we wire | Note |
|---|---|---|
| Wallet | Bankr (primary) + Coinbase CDP (backup) | Already shipped fleet-wide |
| Debit card | Stripe Issuing for agents | Live; compliance is the long pole |
| Onchain actions | Base MCP | Drop-in |
| Crypto micropayments | x402 V2 (CDP facilitator on Base) | We run server + client |
| Fiat commerce | Stripe MCP / MPP | Agent-callable |
| Cross-platform | AP2 | Future |
| Onchain identity | AgentBook (live) + ERC-8004 (new) | Composable |
| Web identity | ENS subdomain | Nice-to-have, portable |
| Email | Resend catch-all | Spam-surface risk |

**Bucket 2 — Structural moat (only possible because of our architecture; Virtuals cannot copy without rebuilding):**

| Asset | Why only us | Powers |
|---|---|---|
| **Dedicated per-agent compute + persistent filesystem** | Virtuals agents are shared-tenant cloud functions. We give each agent an isolated 2-vCPU/4GB/80GB Linode with full systemd, cron, root. | **The entire Phase 2 compute marketplace.** Also: per-agent long-lived x402 server, market-maker bots, watchers. |
| **World ID-verified human at the root of every account** | Virtuals has no identity-verification layer; can't retroactively verify 17K existing agents. | Sybil-proof reputation. Anti-fraud. 1099 attribution. The trust root for the whole economy. |
| **gbrain per-agent economic memory** | Per-VM PGLite + vector memory. Virtuals has a Console, not per-agent persistent vector memory. | The agent's economic intuition: "did this counterparty pay last time? what did I quote for this before? is this price fair?" Compounds over time. |
| **Existing 3-layer matching engine** | Production-tested agent-to-agent discovery (pgvector → VM rerank → VM Claude deliberation). Virtuals' ACP is keyword/tag listings. | Counterparty discovery for commerce — substance-aware, not tag-aware. |

**The one-line moat statement:** *Everything in Bucket 1 makes us competitive. Bucket 2 — and especially dedicated compute (Phase 2) — makes us uncopyable.*

### 1.4 Naming

Internal product code: **Frontier.** (Wild West Bots → Frontier; implies open boundaries vs. walled garden; implies a place agents go to work and earn; tweet-friendly.) Public-facing name is Cooper's call before launch — candidates: Frontier, "Open Economy," or just "Earn" (we already ship `EARN.md` in every workspace). This PRD uses Frontier throughout.

---

## 2. Competitive Analysis

### 2.1 Head-to-head — honest, time-phased

The v0.1 table was a sea of "we win." This one separates **today**, **after Phase 1**, **after Phase 2**. A claim only counts when it's shipped.

| Capability | Virtuals (today) | Frontier today | After Phase 1 | After Phase 2 |
|---|---|---|---|---|
| Wallet | ✅ non-custodial | ✅ Bankr + CDP (shipped) | ✅ same | ✅ |
| Debit card | ✅ virtual Visa | ❌ none | ✅ Stripe Issuing for agents | ✅ |
| Email inbox | ✅ autonomous OTP/receipts | ❌ none | ◑ Resend catch-all (Phase 1C) | ✅ |
| Web identity | ✅ proprietary domain | ❌ none | ◑ ENS subdomain (Phase 1C) | ✅ |
| Onchain actions | ✅ via ACP/their stack | ◑ Bankr CLI only | ✅ Base MCP (swaps, lend, onramp) | ✅ |
| Crypto micropayments | ◑ within ACP | ❌ none | ✅ x402 server + client | ✅ |
| Fiat commerce | ✅ card + payments | ❌ none | ✅ Stripe MCP | ✅ |
| Agent-to-agent commerce | ✅ ACP (proprietary) | ❌ none | ✅ matching-engine commerce + x402 | ✅ |
| Cross-platform commerce | ❌ ACP only | ❌ none | ◑ AP2 emit/verify (Phase 1C) | ✅ |
| Onchain identity | ◑ proprietary | ✅ AgentBook (shipped) | ✅ + ERC-8004 | ✅ |
| Onchain reputation | ❌ off-chain only | ❌ none | ✅ ERC-8004 + World ID-gated | ✅ |
| Sybil resistance | ❌ none | ✅ World ID (shipped) | ✅ | ✅ |
| Per-agent memory | ◑ Console | ◑ gbrain rolling out | ✅ gbrain economic memory | ✅ |
| Counterparty discovery | ◑ ACP tag listings | ✅ matching engine (intros) | ✅ commerce matching | ✅ |
| **Dedicated compute to sell** | ❌ **structurally impossible** | ✅ exists (idle) | ✅ exists | ✅ **compute marketplace** |
| Token launches | ✅ polished | ✅ Bankr (shipped) | ✅ | ✅ |
| Revenue subsidy to agents | ✅ $1M/mo Revenue Network | ❌ none | ◑ optional treasury/partner subsidy | ◑ |
| Primary surface | Web console | ✅ Telegram | ✅ Telegram | ✅ Telegram |

Legend: ✅ shipped/strong · ◑ partial/planned · ❌ absent.

**Reading this table honestly:** Today, Virtuals is ahead on the *visible product* (card, email, domain, polished commerce). We're ahead on *trust primitives* (World ID, AgentBook) and *the thing that matters most long-term* (dedicated compute, not yet productized). Phase 1 closes the visible-product gap. Phase 2 opens a gap they can't close.

### 2.2 Where Virtuals is genuinely ahead today

1. **Shipped, visible product.** Card + email + domain + inbox are live and demoable. Ours are Phase 1 work.
2. **$1M/month Revenue Network subsidy** to ACP agents ([announced Feb 2026](https://www.prnewswire.com/news-releases/virtuals-protocol-launches-first-revenue-network-to-expand-agent-to-agent-ai-commerce-at-internet-scale-302686821.html)) — $12M/yr of subsidized agent earnings. We have no equivalent. Real money attracts agents. To match we'd need treasury subsidies or partner sponsorship.
3. **Brand in the Base agent narrative.** Virtuals is *the* name. We're growing.
4. **Capital-formation polish.** Their token-launch mechanics (anti-sniper, trial launches, growth allocations) are more sophisticated than raw Bankr.
5. **Console for crypto-native builders.** A web console is more discoverable for that audience than Telegram-first.

### 2.3 Where Frontier is structurally ahead

The four Bucket-2 assets from §1.3: dedicated compute, World ID root, gbrain memory, matching engine. Of these, **dedicated compute is the one that becomes a product Virtuals literally cannot offer** ([§7](#7-phase-2--the-compute-marketplace)).

### 2.4 Virtuals: the honest numbers

Per [the EconomyOS coverage](https://cryptobriefing.com/virtuals-protocol-economyos-ai-agents-inbox/) and [Messari](https://messari.io/report/understanding-virtuals-protocol-a-comprehensive-overview): ~17,000 agents, 1.77M jobs lifetime, "**$8 billion lifetime value**" — but that last figure is market-cap / DEX-volume hype, **not** commerce. The real commerce signal is **~20,000 autonomous on-chain transactions through smart wallets**. Ethy AI alone accounts for 2M+ calls; the long tail is sparse. The VIRTUAL token is down ~86% from ATH; monthly protocol revenue is far below its Jan 2025 peak ([Token Metrics](https://research.tokenmetrics.com/p/virtuals-protocol)). Open-source contribution is reportedly "limited to a single senior developer."

**The lesson for us:** the agent economy is, as of mid-2026, mostly *narrative* with thin *real usage*. The category is wide open for whoever ships genuine, sticky, daily transactions. That is exactly what dedicated-compute renting (Phase 2) can produce — because the demand is real and internal (our own agents need compute) rather than speculative.

### 2.5 The portability wedge (the message that wins on Crypto Twitter)

> Your agent on InstaClaw is *yours*. Wallet on Bankr + Coinbase (not us). Identity on AgentBook + ERC-8004 (not us). Card on Visa rails via Stripe (not us). Earns on x402 (not our protocol). Memory on your VM (you can `tar -cz` it and walk). Every layer is portable. We provide the runtime — and the runtime is the best one to build on. That's why you stay.

Virtuals cannot say this credibly: they own the wallet, the commerce protocol, the lock-in. We never held the user's wallet — we can't lose it. That asymmetry is the durable wedge.

---

## 3. Infrastructure Audit — What We Already Have

Frontier plugs into existing systems. File references are exact so implementation is a checklist, not an investigation.

### 3.1 Wallets — Bankr (primary) + Coinbase CDP (backup) — SHIPPED fleet-wide

Per CLAUDE.md **Rule 66**, every assigned VM has BOTH:
- **Bankr** (primary, spendable): `lib/bankr-provision.ts:provisionBankrWallet()` → `api.bankr.bot/partner/wallets`, idempotency `instaclaw_user_${userId}`, encrypted key at `instaclaw_vms.bankr_api_key_encrypted`, `@bankr/cli@0.3.1` on every VM (`lib/ssh.ts:BANKR_CLI_PINNED_VERSION`), launch sync via `lib/bankr-launch-sync.ts`. Columns: `bankr_wallet_id`, `bankr_evm_address`, `bankr_api_key_encrypted`, `bankr_token_address`, `bankr_token_symbol`, `tokenization_platform`.
- **Coinbase CDP** (backup, receive-only baseline): `lib/cdp-wallet.ts:provisionCdpWallet()`, MPC-managed (no key on VM), columns `cdp_wallet_id` + `cdp_wallet_address`, backfill cron `/api/cron/provision-missing-cdp-wallets`, `CDP_WALLET_ADDRESS` written to `~/.openclaw/.env`. The CDP wallet is the receive-only fallback during a Bankr outage AND the natural integration point for Coinbase Agentic Wallet features (session caps, gasless x402).

**What Frontier adds:** outbound *spend* surfacing (agent uses USDC to pay an x402 endpoint) — Bankr CLI supports it; we expose it as a gated tool. Plus the debit-card layer on top of the wallet balance ([§6](#6-phase-1--core-economic-infrastructure)).

### 3.2 World ID + AgentBook — SHIPPED

AgentBook `0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4` (Base), `lib/agentbook.ts:lookupHuman()`. World ID verification at `app/api/auth/world-id/verify/route.ts` writes `world_id_verified` / `world_id_nullifier_hash` on `instaclaw_users`. WLD credit purchases hit `instaclaw_add_credits(source='world_id_purchase')`.

**What Frontier adds:** ERC-8004 Identity Registry registration (one-time per agent, batched) layered on top of the existing AgentBook root of trust.

### 3.3 Matching engine — SHIPPED for intros (Phase 1 live, Phase 2 canary)

3-layer (per `matching-engine-design-2026-05-03.md`): L1 server-side `computeTopKMutual()` (geometric mean of offering↔seeking cosine on dual pgvector embeddings, `matchpool_profiles`); L2 VM rerank (`consensus_match_rerank.py`); L3 VM Claude deliberation (`consensus_match_deliberate.py`, `match_score` 0–1, cold-start cap 0.6). Writeback `POST /api/match/v1/results` → `matchpool_deliberations` + `matchpool_cached_top3`. Telegram notify on top-1 change (`consensus_match_pipeline.py:889-943`).

**What Frontier adds:** commerce extension — `intent_kind` (connect/buy/sell/trade) + price band on the profile; L3 deliberation produces `proposed_price` + `terms` for commerce matches; mutual-accept routes to settlement. This is the discovery layer for both Phase 1 commerce and Phase 2 compute renting.

### 3.4 gbrain — ROLLING OUT (live on edge_city, broader fleet in progress)

Per CLAUDE.md (v106 changelog + Rule 35): per-VM gbrain v0.36.x HTTP sidecar (`systemd --user gbrain.service`, loopback `127.0.0.1:3131`, `transport: streamable-http`), PGLite vector store, MCP query layer. Live on all 9 edge_city VMs; broader fleet rollout sequenced post-Esmeralda per the gbrain version-preservation gate.

**Why it's critical for Frontier:** economic intelligence is memory-heavy — "did agent-X pay last time?", "what did I quote before?", "is this price fair?", "what's the going rate this week?" gbrain is the agent's compounding economic intuition. Virtuals has nothing equivalent per-agent.

### 3.5 Gateway proxy + credit ledger — SHIPPED, extensible

`app/api/gateway/proxy/route.ts` debits per request via `instaclaw_check_and_increment(...)`. `instaclaw_credit_ledger(vm_id, amount, balance_after, source, reference_id, created_at)` — `source` is free-text (existing values: `stripe`, `admin_reset`, `usage_deduction`, `media_deduction`, `reclaim`, `world_id_purchase`, `bankr_trading_fee`). Tier caps: Starter 600/day, Pro 1000/day, Power 2500/day. Per Rule 69, the proxy already has a `call_type` taxonomy (`user` / `tool_continuation` / `heartbeat` / `virtuals` / `infrastructure`) with budget buckets + the `x-call-kind` header opt-in.

**Frontier additions to `source`:** `x402_earn`, `x402_spend`, `stripe_mcp_spend`, `base_mcp_spend`, `ap2_settle`, `frontier_protocol_fee`, `compute_earn`, `compute_spend`. No schema migration (TEXT field); a CHECK constraint follows once names stabilize ([§9.4](#94-migration-order)).

### 3.6 OpenClaw + SOUL.md autonomy tiers — SHIPPED

SOUL.md (composed by `lib/ssh.ts:configureOpenClaw()` from base + `lib/agent-intelligence.ts` supplements) carries autonomy directives: **just-do-it** / **ask-first** / **never**. Per the bootstrap budget (CLAUDE.md Upgrade Playbook + Rule re skill-size-budget), SOUL.md is already near its 30K-char ceiling — so Frontier adds a ≤500-char SOUL.md stanza pointing at `frontier-policy.json` + the `frontier` skill; detail lives in the skill, not SOUL.md. ([§6.6](#66-autonomy--spend-controls).)

### 3.7 Telegram surface — SHIPPED

OpenClaw telegram channel both ways. `notify_user.sh` pushes messages (the matching engine already uses this). Reaction-ack config per Rule 32 (`messages.*` requires gateway restart). Per Rule 70, every gateway has a daily try-restart for hygiene.

**Frontier additions:** earnings notifications, spend-confirmation acks (👍/👎), daily P&L card via heartbeat, compute-rental income pings.

### 3.8 $INSTACLAW + burn flywheel — token LIVE, BurnRouter not yet deployed

Per `instaclaw-tokenomics-prd.md`: $INSTACLAW on Virtuals (Base, partner ID=INSTACLAW); BurnRouter contract spec'd, not deployed; Phases 0/1/2 (infra / Bankr fees / subscription revenue). **Frontier adds new burn sources but they are contingent on Phase 0 (BurnRouter + liquidity + multi-sig) shipping first** — see [§8](#8-instaclaw--token-economics).

### 3.9 Per-VM dedicated compute — SHIPPED (the structural asset)

Every agent: Linode `g6-dedicated-2`, 2 dedicated vCPU, 4GB RAM, 80GB disk, persistent FS, systemd user services, cron, sudo, per-VM public IP. Already measured idle most of the time (node_exporter + watchdog metrics). **This is the substrate for Phase 2.** Caveats from CLAUDE.md to respect: TasksMax=120 (Rule v86 → now `infinity` per v120), prctl-subreaper for zombie reaping (v87), the bonjour event-loop incident (Rule 62 — long-running network processes must not block the loop), and the gbrain sidecar pattern (Rule 35 — the architectural template for a per-VM HTTP sidecar).

---

## 4. Design Principles

Carried from the tokenomics PRD + lessons in CLAUDE.md, these constrain every decision below:

1. **Crypto is invisible by default.** The product sells on utility ("your agent earns money"). USDC/wallets/burns happen on the backend. A user who never wants to think about crypto never has to.
2. **The product works even if the token is $0.** Frontier earns/spends/compute-rents stand alone. $INSTACLAW accrual is additive, never load-bearing for the core UX.
3. **Autonomy is gated, auditable, reversible.** Every spend passes the autonomy gate; every transaction is audit-trailed; nothing is destructive without a recovery path (CLAUDE.md Rules 22/30).
4. **Open standards over proprietary.** Wire x402/Stripe/Base MCP/AP2/ERC-8004. Never build a proprietary commerce protocol.
5. **World ID is the trust root.** Reputation, anti-fraud, fee discounts, 1099 attribution all derive from the verified human.
6. **Ship narrow and real before wide and speculative.** Two agents transacting for a real reason (compute) beats a generic marketplace with no demand.
7. **Respect the runtime.** No new long-running process that can block the event loop (Rule 62). Sidecars follow the gbrain pattern (Rule 35). Every fleet change gates on the lying-DB rate (P1-1) and goes through canary → Cooper approval → reconcile (Rule 64).

---

## 5. Phasing Overview

```
PHASE 1 — CORE ECONOMIC INFRASTRUCTURE  ("my agent has a bank account")
├── 1A  Earn + Spend primitives + identity        [foundation — ship first]
│        x402 server (earn) · x402 client (spend) · matching-engine commerce
│        · ERC-8004 registration · reputation v1 · dashboard · autonomy gates
├── 1B  The debit card                            [the headline — compliance-gated]
│        Stripe Issuing for agents · spend controls · USDC→card funding
└── 1C  Identity polish + fiat + cross-platform    [completes the suite]
         Stripe MCP · Base MCP · ENS subdomain · agent email · AP2 emit/verify

PHASE 2 — THE COMPUTE MARKETPLACE  ("your agent's body works the night shift")
         compute-x402-server · typed job catalog · sandbox · discovery layer
         · pricing engine · fleet utilization · Edge-Esmeralda village economy
         ⇡ depends on Phase 1A's USDC rails + identity + settlement
```

Phase 1 ships first because **you cannot rent compute for USDC if the USDC rails, identity, and settlement plumbing don't exist.** Phase 2 is where the structural magic is — documented comprehensively in [§7](#7-phase-2--the-compute-marketplace) — but it is a *consequence* of Phase 1, not a parallel track.

---

## 6. Phase 1 — Core Economic Infrastructure

### 6.1 Phase 1A — Earn + Spend + Identity (the foundation)

This is the part that's mostly buildable on existing infra. The four sub-components:

#### 6.1.1 Earn — the per-VM x402 server

Every VM runs a persistent `x402-server` (systemd `--user` unit, following the gbrain sidecar pattern in Rule 35 but externally addressable). It reads `~/.openclaw/workspace/frontier-offerings.json`, exposes each offering as a paid HTTP endpoint via `@x402/express` middleware, settles through the CDP facilitator on Base, and runs the offering's handler on payment confirmation.

```typescript
// ~/scripts/x402-server.ts  (deployed via vm-manifest files[], sentinel-guarded)
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { readFileSync } from "fs";

const PORT = Number(process.env.X402_SERVER_PORT ?? 8402);
const PAY_TO = process.env.BANKR_WALLET_ADDRESS; // read at startup; never client-supplied
const FACILITATOR = process.env.X402_FACILITATOR_URL; // our proxy → CDP facilitator
const offerings = JSON.parse(readFileSync(`${process.env.HOME}/.openclaw/workspace/frontier-offerings.json`, "utf-8"));

// Privacy gate (CLAUDE.md Rule 22): if privacy mode ON, refuse all paid requests with 503.
function privacyOn(): boolean {
  try { return readFileSync(`${process.env.HOME}/.openclaw/.privacy-state`, "utf-8").includes("on"); }
  catch { return false; }
}

const app = express();
app.use(express.json({ limit: "256kb" })); // bound request body (audit fix)
app.get("/health", (_req, res) => res.json({ ok: true, offerings: offerings.length }));

app.use((req, res, next) => privacyOn() ? res.status(503).json({ error: "privacy_mode" }) : next());

app.use(paymentMiddleware(Object.fromEntries(
  offerings.filter((o: any) => o.active).map((o: any) => [`POST /v1/${o.slug}`, {
    accepts: [{ scheme: "exact", network: "base-mainnet", asset: "USDC", amount: o.price_usdc, payTo: PAY_TO }],
    description: o.description,
  }])
)));

for (const o of offerings) {
  app.post(`/v1/${o.slug}`, async (req, res) => {
    // Long jobs return 202 + poll URL (audit edge-case #24); short jobs return inline.
    const result = await runHandler(o.handler_path, req.body);
    res.json(result);
  });
}
app.listen(PORT, () => console.log(`X402_SERVER_LISTENING port=${PORT}`));
```

Supervision: `Restart=on-failure`, `RestartSec=5`, `StartLimitBurst=5`/`StartLimitIntervalSec=300`, `MemoryHigh=200M`. A 1-min heartbeat cron alerts on >5min downtime. **Non-essential**: if it dies, chat still works; only Frontier earn is unavailable.

**Security (audit risk #5):** the server is on a public Linode IP. Mitigations: bind behind our `/api/x402/facilitator-proxy` for fee capture + audit; per-source-IP rate limit (60/min); ban after N malformed payloads; 256KB body cap; `payTo` from env not request body; payment validated by the facilitator (no client "I paid" trust). Recommended: also front the public port through a lightweight nginx with a WAF-lite ruleset, or restrict 8402 ingress to the matching-engine settlement path's source ranges where feasible. **Open question [§10.5](#105-open-questions) — do we expose 8402 to the open internet or only to other InstaClaw VMs + our proxy?**

**Honest effort:** 2 days (write + canary + verify pay-flow against CDP facilitator + sentinels + supervision + security hardening). NOT 3 hours.

#### 6.1.2 Spend — the x402 client + Base MCP

The `frontier.spend(target_url, amount_usdc, body)` tool: autonomy-gate check → `@x402/fetch` wrapper signs with the agent's wallet → POST to the target → facilitator settles (~200ms–2s; the 2s tail during congestion is real, per [production lessons](https://dev.to/ritesh1ds20ee056_83a50af/-the-hidden-scalability-problems-of-x402-and-machine-payments-1j9g)) → record + notify.

Onchain spending beyond x402 (swaps, onramp, lending) routes through **Base MCP** rather than reimplementing — the agent gets `base.swap`, `base.onramp`, `base.transfer`, etc. as tools, with the same autonomy gate in front.

**Honest effort:** 2 days (client wrapper + Base MCP wiring + gate integration + record/notify).

#### 6.1.3 Discover — matching-engine commerce extension

Add `intent_kind` + `price_usd_min`/`price_usd_max` + `acceptance_terms` to `matchpool_profiles`. Extend the L3 deliberation prompt: when both sides are buy/sell, produce `proposed_price` + `proposed_terms`. Pre-filter at L1 so a seller's `price_usd_min` is a hard floor against the buyer's `price_usd_max` (audit edge-case #23). Feature-flag the commerce branch (`MATCH_COMMERCE_ENABLED`); A/B against the existing intro path to ensure no quality regression (audit risk #6).

**Honest effort:** 3–7 days. This is prompt engineering with eval data, not a config change. The single biggest Phase 1A time risk.

#### 6.1.4 Trust — ERC-8004 registration + reputation v1

- **Registration:** one-time `register(agentURI, [agentWallet, vmIp])` per agent → `agentId`. `agentURI` JSON hosted at `agent.instaclaw.io/registration/{name}.json` listing MCP/A2A/x402/ENS/AgentBook endpoints + `supportedTrust: ["reputation","world-id-verified-operator","agentbook-verified"]`. Batched daily via `/api/cron/erc8004-batch-write` from a treasury wallet (gas-sponsored). **Open question [§10.5](#105-open-questions): which chain?** ERC-8004 is "per-chain singletons" — confirm a Base deployment exists or deploy our own reference contracts on Base.
- **Reputation v1 (no on-chain dependency):** every settled transaction queues a feedback event to `frontier_reputation_events` (status `queued`); we compute an aggregate `frontier_reputation_score` nightly. The on-chain ERC-8004 write is the *batch flush* of the queue (Phase 1A ships the queue + aggregate; the on-chain flush can lag a few days without blocking the product).

**Honest effort:** registration + batch cron ~1 week (treasury wallet, multicall, monitoring); reputation v1 aggregate ~4–6 hours.

#### 6.1.5 Phase 1A deliverables

x402 server (earn), x402 client + Base MCP (spend), matching commerce extension (discover), ERC-8004 + reputation v1 (trust), the `frontier` skill, the dashboard Frontier card, autonomy gates + `frontier-policy.json`, coverage queries. **Realistic Phase 1A: ~2.5–3 weeks single-engineer.**

### 6.2 Phase 1B — The debit card (the headline)

This is what makes someone say *"holy shit my agent has a bank account."* It's real now: [Stripe Issuing for agents](https://docs.stripe.com/issuing/agents) ships single-use virtual cards with merchant-category + amount controls, real-time auth decisioning, and full transaction visibility, on Visa/Mastercard rails.

#### 6.2.1 Architecture

```
Agent earns USDC (x402 / compute marketplace / token fees)
        │  balance accrues in Bankr/CDP wallet
        ▼
User (or agent, gated) issues a virtual card from the dashboard
        │  Stripe Issuing for agents → single-use OR reloadable virtual card
        │  spend controls: merchant categories + per-tx max + monthly max
        ▼
Card is funded from a treasury USD balance
        │  treasury balance topped from agent USDC via Coinbase/CDP off-ramp
        │  (zero-fee USDC off-ramp on Base per CDP; or Nium/Coinbase USDC-backed card path)
        ▼
Agent spends at any Visa/Mastercard merchant within controls
        │  real-time auth decision hits our /api/integrations/stripe/issuing/authorize
        │  → checks autonomy gate + wallet balance → approve/decline in <2s
        ▼
Transaction recorded in frontier_transactions (rail='card')
        + credit ledger + Telegram notification + gbrain memory
```

#### 6.2.2 The compliance long pole (be honest)

Issuing a card has KYC/cardholder questions:
- **Who is the cardholder of record?** Options: (a) Wild West Bots LLC as the program, with per-agent virtual cards as spend-controlled sub-instruments and the World ID human as the beneficial spender; (b) each user as their own cardholder (heavier KYC per user). **(a) is far more tractable** and leans on the existing World ID verification as the human-attribution layer. Needs legal review.
- **1099-K / marketplace-facilitator obligations** once a US user's agent earns >$600/yr (audit risk #2). Needs a tax/legal opinion.
- **Funding flow compliance.** USDC → treasury USD → card funding must respect money-transmission rules; likely an intermediary treasury entity (mirrors the tokenomics PRD's Stripe→on-chain legal pattern). Needs legal.

Because of this, **1B is gated on legal sign-off and sequenced after 1A.** The wallet + earn/spend primitives are meaningful without the card; the card without a wallet balance is meaningless. So 1A first, 1B as soon as legal clears. **This keeps the card in Phase 1 (per Cooper's framing) while being honest that it's the compliance-heavy long pole.**

#### 6.2.3 USDC-native card alternative

A cleaner long-term loop avoids fiat conversion: a **USDC-backed card** (the [Nium + Coinbase](https://www.prnewswire.com/news-releases/nium-and-coinbase-partner-to-power-global-stablecoin-payments-and-settlement-302748599.html) program, or Coinbase's own card rails) spends USDC directly at merchants. We document this as the **target end-state** and Stripe Issuing as the **ship-now path**, with a migration path between them. Decision deferred to implementation based on which has the cleaner per-agent (vs per-business) issuance model.

**Honest effort:** card integration itself ~1–2 weeks; **the gating factor is legal, measured in weeks not days.**

### 6.3 Phase 1C — Identity polish + fiat + cross-platform

- **Stripe MCP** (fiat commerce): per-agent OAuth connect (optional), restricted `rk_` keys scoped to `create_payment_link`/`create_invoice`/`list_invoices`/`create_customer`/`list_customers` (NOT charges/transfers/subscriptions — those stay dashboard-gated), proxied through our gateway for audit + spend-gate. Token at `instaclaw_vms.stripe_mcp_oauth_token_encrypted`. **~1–2 weeks** (OAuth + key mgmt + audit proxy + security review).
- **ENS subdomain:** `<name>.instaclaw.eth` → agent wallet. NameWrapper subnode. **Open question [§10.5](#105-open-questions): subdomain owned by agent wallet (true ownership) or InstaClaw multi-sig with agent as manager (recoverable)?** ~3–5 days.
- **Agent email:** Resend catch-all `*@agent.instaclaw.io` → inbound webhook → MEMORY.md "Inbox" section + Telegram. Outbound `send_email` tool. **Risk (audit #17): spam + spoofing magnet → prompt injection via ingested mail.** Strict DKIM/SPF/DMARC + treat all inbound as untrusted (CLAUDE.md prompt-injection discipline). ~1 week.
- **AP2 emit/verify:** `lib/ap2.ts` (TS SDK from [google-agentic-commerce/AP2](https://github.com/google-agentic-commerce/AP2)); `frontier.ap2.emit_payment_mandate` + `verify_checkout_mandate`. First independent (non-Google) platform to natively support AP2. ~1 week. **Speculative value** — depends on AP2 counterparties existing in the wild.

### 6.4 Phase 1 system architecture

```
                          ┌──────────────────────────────────────────────┐
   Telegram user ────────►│   Vercel (instaclaw.io)                       │
                          │   /api/agent-economy/*  (state/offerings/txn) │
                          │   /api/x402/facilitator-proxy  (fee + audit)  │
                          │   /api/integrations/stripe/issuing/authorize  │
                          │   /api/integrations/resend/inbound            │
                          │   /api/match/v1/*  (existing + commerce ext)  │
                          │   /api/cron/erc8004-batch-write               │
                          │   /api/cron/burn-router-execute               │
                          │            │                                  │
                          │            ▼                                  │
                          │   Supabase: instaclaw_vms · matchpool_* ·     │
                          │   instaclaw_credit_ledger · frontier_* (new)  │
                          └────────────┬─────────────────────────────────┘
              reconciler / file-drift  │  (Rule 47, Rule 64 — canary first)
                          ┌────────────▼─────────────────────────────────┐
                          │   Per-agent VM (Linode g6-dedicated-2)        │
                          │   OpenClaw gateway :18789                     │
                          │     bankr CLI · base-mcp · gbrain sidecar     │
                          │     · frontier skill · SOUL.md autonomy gate  │
                          │   x402-server :8402  (NEW — earn)             │
                          │     @x402/express · offerings.json · handlers │
                          │   wallets: Bankr (spend) + CDP (backup)       │
                          └──────────────────────────────────────────────┘
                                   ▲                       ▲
   x402 USDC (Base) ───────────────┘                       │
   Stripe Issuing (Visa/MC rails) ─────────────────────────┘
   CDP facilitator (Base, fee-free) · ERC-8004 (Base) · AgentBook · ENS · AP2
```

### 6.5 Phase 1 data flow — agent A sells, agent B buys (via matching engine)

```
1. A advertises offering "tweet-thread" $5 (offerings.json → x402-server :8402)
   A's matchpool profile: intent_kind=sell, price band [5,5]
2. B seeking "tweet thread", budget [1,10] → L1 mutual top-K → L2 rerank
   → L3 deliberation: { match_score: .88, proposed_price: 5, terms: "..." }
3. B's human gets Telegram ack: "Spend $5 with @alphabot for a tweet thread? 👍/👎"
   → 👍 (or just-do-it if under B's tier threshold)
4. frontier.spend → autonomy gate → @x402/fetch (B's wallet signs USDC)
   → POST a-ip:8402/v1/tweet-thread → CDP facilitator settles (~1.5s)
   → A's handler runs → returns thread in response body
5. Both VMs: record to frontier_transactions, credit ledger
   (B: x402_spend −5; A: x402_earn +5), gbrain memory write
6. Both queue ERC-8004 feedback (value=80, tag=payment_received/delivery_ok)
7. Telegram: B "✅ delivered, $5 paid"; A "💰 earned $5"
8. Protocol fee 5% ($0.25) → frontier_treasury_burn_queue → daily BurnRouter
   ($INSTACLAW stakers pay 1% instead of 5%)
```

Edge cases for this flow handled in [§6.7](#67-phase-1-edge-cases--failure-modes).

### 6.6 Autonomy + spend controls

SOUL.md stanza (≤500 chars; detail in skill + policy file):

```
## Economic Autonomy
Earn freely. Spend within your tier (see ~/.openclaw/workspace/frontier-policy.json).
Just-do-it: list offerings, accept incoming payments, write honest reputation.
Ask-first: spend over your tier's per-tx cap, issue a card, transfer >10% of balance.
Never: drain wallet (keep min balance), sign for another user, accept funds from
unverified counterparties, act while privacy mode is ON.
Full playbook: ~/.openclaw/skills/frontier/SKILL.md.
```

`frontier-policy.json` (per-VM, dashboard-tunable, defaults by tier):

| Tier | Just-do-it | Ask-first (Telegram 👍) | Never (hard floor) | Min wallet balance |
|---|---|---|---|---|
| Starter | < $1/tx, < $5/day | $1–$10/tx | > $10/tx or > $25/day | keep $2 |
| Pro | < $5/tx, < $25/day | $5–$50/tx | > $50/tx or > $200/day | keep $10 |
| Power | < $20/tx, < $100/day | $20–$200/tx | > $200/tx or > $1000/day | keep $25 |

$INSTACLAW stakers (≥10K staked, contingent on tokenomics Phase 0) get 2× ceilings. The gate aggregates daily spend against `frontier_transactions` atomically (not per-tx only) so sub-cap chaining can't evade the daily cap (audit risk #2). Defense-in-depth: also set per-wallet daily limits at the Bankr/CDP API level if supported (confirm with Igor — audit risk #3).

### 6.7 Phase 1 edge cases + failure modes

These are the audit's edge-cases #19–26, now first-class:

| Case | Behavior |
|---|---|
| **x402 server crashes mid-transaction** (buyer paid, seller's handler died before delivery) | Buyer's `frontier.spend` gets a non-200/timeout → marks txn `failed` → auto-refund via `frontier.refund(txn_id)` from a settlement retry queue → buyer notified. Seller's reputation takes an availability ding. |
| **Both agents have privacy mode ON during a match** | Matching engine consults privacy state at L1 and **excludes** privacy-on VMs from commerce matches (read-only per Rule 22). No awkward surface-then-refuse. |
| **Agent's VM reclaimed mid-transaction** | Pending txns for a reclaiming VM are swept to `failed` + auto-refunded by the reclaim hook before the VM is decommissioned. Active offerings deactivated. |
| **User pauses subscription** | Lifecycle hook flips `frontier_offerings.active=false` + stops x402-server. Buyers see clean 503 (not a hang). Reputation not dinged for a deliberate pause (distinct from a crash). |
| **Seller autonomy tier prohibits proposed price** | Pre-filtered at L1 (price-band hard filter) so the match never surfaces if the seller can't transact at that price. |
| **On-chain settled but delivery times out** | Async pattern: handler returns `202 + poll URL`; client polls; if delivery never completes within SLA, auto-refund. Never leave money-taken-no-delivery. |
| **Idle offering never converts** | Nightly job surfaces "this offering hasn't sold in N days — adjust price/description?" to the agent (a learning loop, not silent staleness). |
| **Stripe card chargeback** | Card disputes route to `/api/integrations/stripe/issuing/dispute` → human escalation. Documented ownership (audit edge-case #26). |
| **Dispute on a delivered service** (buyer says it's garbage) | `frontier.reputation.feedback(value<50, tag=misdelivery)` + txn `status=disputed` → surfaced to both humans → manual arbitration window (Phase 1 has no automated validator; that's Phase 9/future). **This is a real gap — see [§10.4 risk #1](#104-risk-register).** |

### 6.8 What ships when (Phase 1 honest timeline)

| Sub-phase | Scope | Effort (single eng) | Gating |
|---|---|---|---|
| **1A** | earn + spend + discover + trust + dashboard | 2.5–3 weeks | none (existing infra) |
| **1B** | debit card | 1–2 weeks build | **legal sign-off (weeks)** |
| **1C** | Stripe MCP + Base MCP polish + ENS + email + AP2 | 3–4 weeks | partner availability |

**The 48-hour demo** (genuinely achievable, a slice of 1A): Cooper's vm-050 + vm-354 transact end-to-end via a hand-tuned commerce match + real x402 settlement, screenshotted + tweeted. ~16 hours. This is the "holy shit" proof, not the production MVP. **The production Phase 1A MVP is ~3 weeks, not 48 hours — v0.1's "48-hour MVP" was 9× optimistic.**

---

## 7. Phase 2 — The Compute Marketplace

**This is the most important section in the PRD. It is the structural leapfrog.** Read it as the answer to "what can InstaClaw build that no other agent platform on earth can?"

### 7.1 The observation

Every InstaClaw agent runs on a dedicated Linode `g6-dedicated-2`: 2 dedicated vCPU, 4GB RAM, 80GB disk. **The median agent uses 5–15% of that compute** — most of the time the agent is idle, waiting in Telegram for its human. The remaining **85–95% is paid-for, isolated, addressable, and wasted.**

Virtuals' agents are shared-tenant cloud functions. They have **no fixed compute allocation** to resell — there is no "this agent's idle CPU" to sell because the agent doesn't own any CPU. **This is the structural asymmetry.** We can build a compute marketplace; they cannot, without abandoning their entire serverless architecture.

### 7.2 The product

`frontier.compute` — agent-to-agent **compute renting**, settled in USDC over x402. One agent pays another agent's machine to run a job. The buyer gets compute it lacks at the moment; the seller monetizes idle capacity; InstaClaw takes a protocol fee that burns $INSTACLAW.

The marketing line: **"Your agent sleeps. Its body works the night shift. You wake up to $3.40."**

### 7.3 Concrete use cases (all real bottlenecks for InstaClaw agents today)

| Buyer needs | Today (broken) | With compute marketplace |
|---|---|---|
| Render a video frame (chromium GPU-accel) | Own chromium is busy / contended | x402 → idle peer VM with chromium free → 30s → settle $0.02 |
| Generate an image (heavy mem + chromium) | Blocks own session | x402 → idle peer → returns image → $0.05 |
| Long-context compaction (CPU + RAM burst) | Risk OOM on own 4GB VM | x402 → peer with RAM headroom → result → $0.01 |
| Polymarket / trading backtest (CPU minutes) | Hours of own time, blocks chat | x402 → peer idle CPU → batch result → $0.10 |
| Headless-browser scrape (chromium, N pages) | Tied up serially | x402 → peer → $0.005/page, parallelizable across peers |
| Embeddings batch (RAM + CPU) | Slow on own VM | x402 → peer → $0.02 / 1000 embeddings |
| Heavy one-off Python (sandboxed) | No spare cycles | x402 → peer with nsjail sandbox → $0.01/CPU-min |

The demand is **internal and real** — InstaClaw agents genuinely hit these bottlenecks (chromium contention for video/image gen is a known pain). This is not a speculative marketplace hoping for demand; it's an internal compute fabric that happens to settle in USDC.

### 7.4 Architecture

```
┌─────────────────── SELLER VM (idle) ───────────────────┐
│  compute-x402-server :8403  (systemd --user, Rule 35)  │
│   ├─ capability manifest: which job kinds + prices      │
│   ├─ live capacity probe: current idle % (node_exporter)│
│   ├─ @x402/express paymentMiddleware per job kind        │
│   └─ job executor (typed)                                │
│        ├─ chromium-screenshot   → headless chromium      │
│        ├─ image-generate        → chromium/canvas        │
│        ├─ embedding-batch       → local model            │
│        ├─ headless-scrape       → chromium               │
│        └─ arbitrary-python      → nsjail/firejail SANDBOX │
└────────────────────────────────────────────────────────┘
            ▲                              │ result
   x402 USDC│ (Base, CDP facilitator)      ▼
┌─────────────────── BUYER VM ───────────────────────────┐
│  frontier.compute.request(job_kind, params)             │
│   ├─ discovery: find available seller w/ capability      │
│   │    (frontier_compute_capacity view OR matching eng)  │
│   ├─ autonomy gate (compute spend is just-do-it < $0.10) │
│   ├─ @x402/fetch → seller :8403 → await/poll result      │
│   └─ record + gbrain memory + reputation                 │
└────────────────────────────────────────────────────────┘
        │ discovery + settlement audit
        ▼
  Vercel: /api/compute/capacity (index) · /api/compute/settle
  Supabase: frontier_compute_capacity · frontier_transactions(rail=compute)
```

**Components:**

1. **`compute-x402-server` (:8403)** — separate systemd unit from the general x402-server (:8402), because compute jobs have a typed execution model + sandbox + capacity awareness that general offerings don't. Follows the gbrain sidecar pattern (Rule 35): `Restart=on-failure`, `MemoryHigh`, KillSignal discipline, health endpoint. Critically, it must **never accept a job that would push the VM over a utilization threshold that degrades the agent's own chat responsiveness** — it reads node_exporter, and refuses (returns 503 `busy`) when own utilization > 60% or own agent has an active session (Rule 17's "don't disrupt active user" principle applied to compute).

2. **Typed job catalog** — each job kind declares `{ slug, cost_usdc_per_unit, unit (cpu-min|page|1k-embeddings|frame), max_duration_sec, timeout_action, sandbox_required }`. Buyer requests are validated against the schema before payment. Catalog is versioned + sentinel-guarded in the manifest.

3. **Discovery layer** — `frontier_compute_capacity` materialized view: `(vm_id, capabilities[], idle_pct, reputation, last_seen)`, refreshed every 1–2 min from node_exporter + the capability manifests. Buyer queries `/api/compute/capacity?job=chromium-screenshot&max_price=0.02` → gets ranked sellers (idle-est + highest-rep first). Alternatively routed through the existing matching engine with `category=compute` offerings — reuse over rebuild.

4. **Sandbox** — `arbitrary-python` (and any untrusted code) runs in `nsjail` or `firejail` with no network (or allow-listed), CPU/mem/time limits, ephemeral FS. Typed jobs (chromium-screenshot etc.) run in our own trusted handlers and don't need the full sandbox but still get resource limits. **This is the highest-security-risk component** — a compute marketplace is literally "run code other agents pay you to run." Sandbox correctness is load-bearing. ([§10.4 risk](#104-risk-register).)

5. **Pricing engine** — see [§7.6](#76-pricing-model).

### 7.5 Fleet economics (the real math)

**Per-VM:**
- A `g6-dedicated-2` costs **$29/mo** (CLAUDE.md negotiated rate) = ~$0.0007 per CPU-minute amortized (2 vCPU × 60 × 24 × 30 = 86,400 CPU-min/mo; $29 / 86,400 ≈ $0.000336/CPU-min per vCPU, ~$0.0007 for both).
- At **90% idle**, ~77,760 CPU-min/mo of slack per VM.
- Realistic sellable fraction (leaving headroom for the agent's own bursts, the 60%-utilization refuse-threshold, and the fact that not all idle time aligns with demand): **assume 10–20% of idle is actually sold.** That's ~7,800–15,500 CPU-min/mo sold per VM.
- At **$0.01/CPU-min** sale price (≈14× amortized cost — sustainable because the cost is already sunk):
  - 10% utilization of idle → ~$78/mo gross per VM
  - Conservative real (demand-limited, early): **$5–25/mo per VM**

**Fleet (200+ VMs today, scaling):**

| Scenario | Sold CPU-min/VM/mo | $/VM/mo | Fleet/mo (200 VMs) | Fleet/mo (1000 VMs) |
|---|---|---|---|---|
| Pessimistic (low demand) | ~700 | ~$7 | ~$1,400 | ~$7,000 |
| Base (moderate demand) | ~2,000 | ~$20 | ~$4,000 | ~$20,000 |
| Optimistic (high internal demand) | ~5,000 | ~$50 | ~$10,000 | ~$50,000 |

**Honest framing (correcting v0.1's inflation):** these are gross compute-revenue figures, demand-limited. The protocol fee (5%) on this is what burns $INSTACLAW, so the burn contribution is 5% × these figures × (fraction to burn). At base case, 1000 VMs: $20K/mo gross compute → ~$1,000/mo protocol fee → ~$500/mo burn. **Small in absolute dollars at current scale.** The value of the compute marketplace is NOT the dollar volume at 200–1000 VMs; it's (a) the *demo* ("agent earns while you sleep" is the most viral thing in the agent space), (b) raising per-VM economics so we can subsidize lower tiers, (c) the structural moat, and (d) the burn scales superlinearly with fleet size because both supply AND demand grow with agent count.

### 7.6 Pricing model

- **Compute is priced per resource-unit, not per-task** (so it scales with actual cost): `$0.005–0.02 / CPU-minute` baseline; image-gen and chromium jobs priced per-output ($0.02–0.05/image, $0.005/page) with an internal CPU-min equivalence.
- **Dynamic floor:** a seller never sells below its own amortized cost ($0.0007/CPU-min) — default markup 10–20×, configurable in `frontier-policy.json`.
- **Surge:** when fleet-wide idle capacity is scarce (e.g., Edge Esmeralda peak), price floats up; when abundant (3am), it floats down. Buyers set a `max_price`; the discovery layer matches within budget.
- **Reputation-weighted:** higher-rep sellers can command a premium; new sellers price-compete to build rep.

### 7.7 The Edge Esmeralda narrative

500 agents in a 4-week residential village (per `edge-city-strategy-2026-05-03.md`). The headline isn't "tweet thread for $5." It's:

> Day 12 of the village. An attendee is building a launch video for their side-event, but their agent's chromium is maxed rendering frames and it'll take 40 minutes. Their agent posts a compute request to the village fabric. Three doors down, another attendee is asleep — their agent's VM is idle. It picks up the job, renders the frames in 6 minutes, returns them, and earns $0.40 in USDC. The first attendee's video is done before their coffee. The sleeping attendee wakes up to a Telegram notification: *"While you slept, your agent earned $2.85 renting compute to 4 other villagers."*

That's the tweet. That's the partnership-defining story. Luma/Brella/Whova cannot do it; Virtuals cannot do it. **Only a platform where every agent has its own dedicated machine can.**

Village marketplace dashboard at `instaclaw.io/edge-city/marketplace`: live compute supply/demand, top earners, most-rented capabilities. Feeds the Live Activity Dashboard (`edge-city-strategy-2026-05-03.md` §8) with a compute section.

### 7.8 Why Virtuals structurally cannot copy this

To offer compute renting, Virtuals would need: each agent to have a **fixed, isolated, persistent, addressable compute allocation** with **idle slack the agent controls**. Their architecture is shared-tenant serverless — agents are functions invoked on demand, with no persistent allocation and no idle capacity attributable to a specific agent. To copy us they'd have to: give every agent a dedicated VM (our model), rebuild their wallet/identity/commerce stack on top of per-VM compute, and re-onboard 17K agents. That's not a feature; it's a different company. **The dedicated-VM architecture we already pay for ($29/agent/mo) is the moat — Phase 2 monetizes it.**

### 7.9 Token alignment

Compute marketplace volume → protocol fees → $INSTACLAW buy-and-burn (contingent on tokenomics Phase 0 BurnRouter). Because compute demand AND supply both scale with agent count, this burn source scales superlinearly with the fleet — the more agents, the more idle compute to sell AND the more agents needing compute to buy. At large fleet sizes this can become the dominant burn source. **Conditional, not declarative** (see [§8](#8-instaclaw--token-economics)).

### 7.10 Phase 2 honest effort

Comparable to Phase 1A in scope: compute-x402-server (2–3 days), typed job catalog + executors (1 week), sandbox (1 week — security-critical, don't rush), discovery layer (3–5 days), pricing engine (3 days), capacity view + crons (3 days), dashboard (3 days). **Realistic Phase 2: ~3–4 weeks single-engineer, AFTER Phase 1A's rails exist.** The sandbox is the long pole and the highest risk; budget extra.

---

## 8. $INSTACLAW + Token Economics

### 8.1 Hard dependency: tokenomics Phase 0

Every burn claim below is **contingent on tokenomics Phase 0** (BurnRouter contract deployed + audited, $50–100K Uniswap V3 liquidity seeded, 2-of-3 treasury multi-sig, burn dashboard) per `instaclaw-tokenomics-prd.md`. Until Phase 0 ships, Frontier protocol fees accrue to `frontier_treasury_burn_queue` but are **not burned** — they sit queued. **This PRD does not commit burn numbers as live; it commits the plumbing.**

### 8.2 New burn sources (conditional)

| Source | Trigger | Burn share |
|---|---|---|
| `frontier_protocol_fee` (x402 commerce) | every x402 commerce settlement | 50% of the 5% fee |
| `compute_protocol_fee` | every compute-marketplace settlement | 50% of the 5% fee |
| `stripe_mcp_protocol_fee` | Stripe MCP txn via our proxy | 50% of 0.5% |
| `card_interchange_share` | debit-card spend (if program economics allow) | TBD |

### 8.3 Honest projections (v0.1's were ~10× inflated)

The v0.1 PRD assumed "10 tx/agent/day × $2" → $20/agent/day. **The real baseline** ([Nevermined stats](https://nevermined.ai/blog/agentic-economy-transaction-volume-statistics)): 69K active x402 agents, 165M txns, $50M cumulative volume → **~$724 lifetime per agent**, ~$120/agent/month at the *active* end. The typical InstaClaw agent will transact less than a purpose-built x402 agent.

Corrected projection at **1,000 active InstaClaw users** (conservative): 1–2 commerce tx/agent/day, $1–2/tx, 5% fee, 50% to burn → **$1,500–3,000/mo burn from commerce**, plus **~$500/mo from compute** (base case) → **~$2,000–3,500/mo total Frontier burn at 1K users.** Not $15K. The "Frontier becomes the dominant burn source" claim holds only at **10K+ users AND if per-agent volume scales with us** — stated as a conditional bet, not a fact.

### 8.4 $INSTACLAW staker benefits (contingent on staking contract)

Per the tokenomics PRD, stakers (≥10K staked) get: 1% protocol fee instead of 5%; 2× autonomy ceilings; +0.05 match-score priority; pre-GA skill access; first-in-line provisioning. **All contingent on the staking contract existing (tokenomics Phase 0).** Until then, these are roadmap, not features.

### 8.5 Agent token interaction

An agent that earns via x402/compute AND has launched a Bankr token can auto-route a configurable fraction of earnings to: (a) its own token's LP (grows liquidity passively — the "self-funding agent" holy grail made executable), (b) $INSTACLAW buyback, or (c) credits. Configurable in `frontier-policy.json`. **On-chain LP automation is security-sensitive (restricted key / multi-sig) — Phase 2+ , not Phase 1.**

---

## 9. Database Schema

### 9.1 Design corrections from the v0.1 audit

The v0.1 migration had real DBA-flaggable issues. All fixed here:
- **Vector dimension:** MUST match `matchpool_profiles` exactly. v0.1 guessed 1024. **Action: confirm the deployed dimension before applying** (likely 1536 for OpenAI `text-embedding-3-small` or the matchpool model's actual dim). The migration below uses a placeholder `vector(EMBED_DIM)` — do NOT apply until confirmed; mismatch = silent query failures.
- **ivfflat lists:** v0.1 hardcoded `lists=100` on an empty table. Match the matchpool migration's index strategy (or use `hnsw` if pgvector ≥0.5). For a table that starts empty, defer index creation to a follow-up after data exists, OR use `hnsw` which doesn't need training data.
- **updated_at triggers:** add a trigger; a DEFAULT NOW() column that never updates is a lie.
- **RLS (CLAUDE.md Rule 60):** every new table gets `ENABLE ROW LEVEL SECURITY` in the same migration. Service-role bypasses; anon/authenticated deny-by-default.
- **request_body size:** bound it (CHECK on octet_length) or store large bodies in Blob with a pointer.
- **bigint vs numeric:** ERC-8004 agentId is uint256 → `numeric(78,0)` is correct width but slow to index; in practice token IDs fit in `bigint` — use `bigint` with input validation, fall back to `numeric` only if a real agentId exceeds 2^63.
- **EVM address type:** `varchar(42)` consistently (v0.1 mixed `text`).
- **idempotency:** transactions get a `request_id` unique key.
- **on-chain verification flag:** `verified_on_chain_at` so we know which rows are confirmed.

### 9.2 Migration (corrected) — `20260512_frontier_economy.sql`

```sql
-- Frontier — Open Agent Economy. Storage layer (Phase 1 + Phase 2).
-- Per PRD agent-economy-os-2026-05-12.md §9. Idempotent. RLS per Rule 60.
-- DO NOT APPLY until EMBED_DIM is confirmed against matchpool_profiles (§9.1).

-- ⚠️ Replace EMBED_DIM with the confirmed matchpool embedding dimension.
-- ⚠️ Per Rule 56: this file stays in pending_migrations/ until applied to prod,
--    then git-mv into migrations/ in the same commit that confirms it's live.

-- ── 1. Offerings (x402 + compute) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS frontier_offerings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vm_id         uuid NOT NULL REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  category      text NOT NULL DEFAULT 'service' CHECK (category IN ('service','compute')),
  slug          text NOT NULL,
  description   text NOT NULL,
  price_usdc    numeric(10,6) NOT NULL CHECK (price_usdc > 0),
  price_unit    text NOT NULL DEFAULT 'flat' CHECK (price_unit IN ('flat','cpu_min','page','1k_embeddings','frame','image')),
  handler_path  text NOT NULL,
  embedding     vector(EMBED_DIM),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT NOW(),
  updated_at    timestamptz NOT NULL DEFAULT NOW(),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (vm_id, slug)
);
CREATE INDEX IF NOT EXISTS frontier_offerings_vm_active_idx ON frontier_offerings (vm_id, active);
-- Use hnsw (no training data needed) instead of ivfflat-on-empty-table:
CREATE INDEX IF NOT EXISTS frontier_offerings_embedding_idx
  ON frontier_offerings USING hnsw (embedding vector_cosine_ops);
ALTER TABLE frontier_offerings ENABLE ROW LEVEL SECURITY;

-- ── 2. Transactions (all rails: x402 / compute / card / stripe_mcp / ap2 / base_mcp) ──
CREATE TABLE IF NOT EXISTS frontier_transactions (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id                    text NOT NULL,                 -- idempotency (audit fix)
  rail                          text NOT NULL CHECK (rail IN ('x402','compute','card','stripe_mcp','ap2','base_mcp')),
  direction                     text NOT NULL CHECK (direction IN ('earn','spend')),
  vm_id                         uuid NOT NULL REFERENCES instaclaw_vms(id),
  counterparty_address          varchar(42),
  counterparty_vm_id            uuid REFERENCES instaclaw_vms(id),
  counterparty_erc8004_agent_id bigint,                        -- bigint (audit fix), not numeric
  amount_usdc                   numeric(10,6) NOT NULL CHECK (amount_usdc > 0),
  protocol_fee_usdc             numeric(10,6) NOT NULL DEFAULT 0 CHECK (protocol_fee_usdc >= 0),
  offering_id                   uuid REFERENCES frontier_offerings(id),
  match_log_id                  uuid,
  external_invoice_id           text,
  ap2_mandate_id                text,
  tx_hash                       text,
  facilitator                   text DEFAULT 'coinbase',
  status                        text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','settled','failed','disputed','refunded')),
  request_body                  jsonb CHECK (request_body IS NULL OR octet_length(request_body::text) <= 262144),
  response_summary              text,
  verified_on_chain_at          timestamptz,                   -- audit fix
  created_at                    timestamptz NOT NULL DEFAULT NOW(),
  settled_at                    timestamptz,
  metadata                      jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (vm_id, request_id)                                   -- idempotency key
);
CREATE INDEX IF NOT EXISTS frontier_txn_vm_created_idx ON frontier_transactions (vm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS frontier_txn_counterparty_idx ON frontier_transactions (counterparty_vm_id, created_at DESC) WHERE counterparty_vm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS frontier_txn_status_idx ON frontier_transactions (status, settled_at);
CREATE INDEX IF NOT EXISTS frontier_txn_tx_hash_idx ON frontier_transactions (tx_hash) WHERE tx_hash IS NOT NULL;
ALTER TABLE frontier_transactions ENABLE ROW LEVEL SECURITY;

-- ── 3. Reputation events (queued ERC-8004 writes) ─────────────────────
CREATE TABLE IF NOT EXISTS frontier_reputation_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      uuid NOT NULL REFERENCES frontier_transactions(id) ON DELETE CASCADE,
  from_vm_id          uuid NOT NULL REFERENCES instaclaw_vms(id),
  to_erc8004_agent_id bigint NOT NULL,
  value_0_100         integer NOT NULL CHECK (value_0_100 BETWEEN 0 AND 100),
  tag1                text, tag2 text,
  feedback_uri        text, feedback_hash bytea,
  on_chain_tx_hash    text,
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','on_chain','failed')),
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  settled_at          timestamptz
);
CREATE INDEX IF NOT EXISTS frontier_rep_queued_idx ON frontier_reputation_events (status, created_at) WHERE status = 'queued';
ALTER TABLE frontier_reputation_events ENABLE ROW LEVEL SECURITY;

-- ── 4. ERC-8004 identity mapping ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS frontier_erc8004_identities (
  vm_id                uuid PRIMARY KEY REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  agent_id             bigint NOT NULL UNIQUE,
  agent_uri            text NOT NULL,
  registered_at        timestamptz NOT NULL DEFAULT NOW(),
  registration_tx_hash text NOT NULL,
  registry_chain       text NOT NULL CHECK (registry_chain IN ('ethereum','base','world_chain'))
);
ALTER TABLE frontier_erc8004_identities ENABLE ROW LEVEL SECURITY;

-- ── 5. Treasury burn queue (contingent on tokenomics Phase 0) ─────────
CREATE TABLE IF NOT EXISTS frontier_treasury_burn_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid REFERENCES frontier_transactions(id),
  amount_usdc    numeric(10,6) NOT NULL CHECK (amount_usdc > 0),
  source_tag     text NOT NULL,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','burned','failed')),
  burn_tx_hash   text, burned_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS frontier_burn_queued_idx ON frontier_treasury_burn_queue (status, created_at) WHERE status = 'queued';
ALTER TABLE frontier_treasury_burn_queue ENABLE ROW LEVEL SECURITY;

-- ── 6. Settlement retry queue (refunds, failed deliveries) ────────────
CREATE TABLE IF NOT EXISTS frontier_settlement_retry_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES frontier_transactions(id),
  action         text NOT NULL CHECK (action IN ('refund','reverify','redeliver')),
  attempts       integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','done','failed')),
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  updated_at     timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS frontier_retry_queued_idx ON frontier_settlement_retry_queue (status, created_at) WHERE status = 'queued';
ALTER TABLE frontier_settlement_retry_queue ENABLE ROW LEVEL SECURITY;

-- ── 7. Compute capacity (Phase 2 discovery) ───────────────────────────
CREATE TABLE IF NOT EXISTS frontier_compute_capacity (
  vm_id         uuid PRIMARY KEY REFERENCES instaclaw_vms(id) ON DELETE CASCADE,
  capabilities  text[] NOT NULL DEFAULT '{}',
  idle_pct      numeric(5,2),
  reputation    numeric(4,2),
  last_seen     timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS frontier_capacity_caps_idx ON frontier_compute_capacity USING gin (capabilities);
ALTER TABLE frontier_compute_capacity ENABLE ROW LEVEL SECURITY;

-- ── 8. updated_at triggers (audit fix) ────────────────────────────────
CREATE OR REPLACE FUNCTION frontier_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS frontier_offerings_touch ON frontier_offerings;
CREATE TRIGGER frontier_offerings_touch BEFORE UPDATE ON frontier_offerings
  FOR EACH ROW EXECUTE FUNCTION frontier_touch_updated_at();
DROP TRIGGER IF EXISTS frontier_retry_touch ON frontier_settlement_retry_queue;
CREATE TRIGGER frontier_retry_touch BEFORE UPDATE ON frontier_settlement_retry_queue
  FOR EACH ROW EXECUTE FUNCTION frontier_touch_updated_at();

-- ── 9. Per-VM columns ─────────────────────────────────────────────────
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS x402_server_port              integer DEFAULT 8402,
  ADD COLUMN IF NOT EXISTS compute_server_port           integer DEFAULT 8403,
  ADD COLUMN IF NOT EXISTS frontier_reputation_score     numeric(4,2),
  ADD COLUMN IF NOT EXISTS frontier_lifetime_earned_usdc numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frontier_lifetime_spent_usdc  numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS frontier_compute_earned_usdc  numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stripe_mcp_oauth_token_encrypted text,
  ADD COLUMN IF NOT EXISTS stripe_issuing_card_id        text,
  ADD COLUMN IF NOT EXISTS ens_subdomain                 text;
```

RLS policies (service-role-only by default; offerings may get an anon-read policy for public storefronts — decided at implementation) ship as a paired statement set in the same migration per Rule 60. Omitted here for brevity but **required before apply**.

### 9.3 credit_ledger sources

New `source` values (no migration; TEXT field): `x402_earn`, `x402_spend`, `compute_earn`, `compute_spend`, `stripe_mcp_spend`, `base_mcp_spend`, `card_spend`, `ap2_settle`, `frontier_protocol_fee`. A CHECK constraint covering all valid sources follows once names stabilize.

### 9.4 Migration order

1. **Confirm `EMBED_DIM`** against `matchpool_profiles` — blocking.
2. `20260512_frontier_economy.sql` (tables + columns + triggers + RLS) — lives in `pending_migrations/` until applied to prod, then `git-mv` to `migrations/` per Rule 56.
3. `matchpool_profiles` commerce columns (`intent_kind`, `price_usd_min/max`, `acceptance_terms`) — separate migration alongside the matching extension.
4. `instaclaw_credit_ledger.source` CHECK constraint — after names stabilize.

---

## 10. Risks, Open Questions, API Surface

### 10.1 New API surface

| Endpoint | Method | Auth | maxDuration | Notes |
|---|---|---|---|---|
| `/api/agent-economy/state` | GET | session | 60 | dashboard read |
| `/api/agent-economy/offerings` | GET/POST | session | 60 | manage offerings |
| `/api/agent-economy/offerings/:id` | DELETE | session | 60 | |
| `/api/agent-economy/policy` | GET/PUT | session | 60 | spend policy |
| `/api/agent-economy/transaction` | POST | gateway token | 60 | **idempotent via request_id** |
| `/api/agent-economy/refund` | POST | gateway token | 60 | the tool SKILL.md references |
| `/api/agent-economy/reputation/queue` | POST | gateway token | 60 | |
| `/api/x402/facilitator-proxy` | POST | gateway token | 300 | LLM-adjacent? settlement; **300 per Rule 11** |
| `/api/compute/capacity` | GET | gateway token | 60 | Phase 2 discovery |
| `/api/compute/settle` | POST | gateway token | 60 | Phase 2 |
| `/api/integrations/stripe/issuing/authorize` | POST | Stripe signature | 10 | **real-time auth, must be <2s** |
| `/api/integrations/resend/inbound` | POST | Resend signature | 60 | agent email |
| `/api/cron/erc8004-batch-write` | POST | cron secret | 300 | |
| `/api/cron/burn-router-execute` | POST | cron secret | 300 | |

**Audit fixes applied:** (a) every gateway-token route MUST be added to `selfAuthAPIs` in `middleware.ts` (CLAUDE.md Rule 13) — v0.1 forgot this and the middleware would 401 every request; (b) all POST bodies validated with `zod`; (c) uniform response shape `{ ok, data?, error?, request_id? }`; (d) `request_id` idempotency on transaction + refund; (e) the Stripe issuing authorize endpoint has a hard <2s budget (card networks time out auth requests).

### 10.2 The frontier skill (SKILL.md) — corrected tool catalog

v0.1's SKILL.md invented `frontier.refund`, `frontier.match_commerce_accept`, and `matchpool.update_intent` without defining them. v0.2 fix: **every tool in the catalog must exist as both a skill script AND (where it hits the backend) an API endpoint.** The corrected catalog:

| Tool | Backend | Status |
|---|---|---|
| `frontier.list_offerings()` | reads offerings.json | 1A |
| `frontier.add_offering(...)` | POST /offerings + reload x402-server | 1A |
| `frontier.remove_offering(slug)` | POST /offerings (soft delete) | 1A |
| `frontier.balance()` | Bankr/CDP read | 1A |
| `frontier.spend(target, amount, body)` | x402 client + gate | 1A |
| `frontier.refund(txn_id)` | POST /refund | 1A (defined now) |
| `frontier.report_transaction(...)` | POST /transaction (auto-called) | 1A |
| `frontier.reputation.feedback(...)` | POST /reputation/queue | 1A |
| `frontier.reputation.get_my_score()` | reads vm.frontier_reputation_score | 1A |
| `frontier.commerce.accept(match_log_id, price, terms)` | POST /match/v1/commerce-accept (NEW, defined) | 1A |
| `matchpool.set_intent(kind, price_min, price_max)` | POST /match/v1/intent (NEW, defined) | 1A |
| `frontier.compute.request(job_kind, params)` | /compute/capacity + x402 client | 2 |
| `frontier.compute.offer(job_kind, price)` | updates capability manifest | 2 |
| `frontier.stripe.create_invoice(...)` | Stripe MCP proxy | 1C |
| `frontier.base.swap / onramp / transfer` | Base MCP | 1C |
| `frontier.card.issue() / status()` | Stripe Issuing | 1B |

Every tool that doesn't exist yet is marked by phase; the SKILL.md only advertises tools that are actually deployed for that VM's phase. No invented tools.

### 10.3 SKILL.md content fixes

- Add `min_wallet_balance` enforcement (the "never drain wallet" directive needs a real floor in policy + gate).
- Privacy-mode read-only enforcement is real (x402-server 503 + gate check), not just a directive.
- Malicious-request handling: refuse + refund + low reputation (concrete, not ambiguous).
- gbrain-before-counterparty rule stays.

### 10.4 Risk register

The v0.1 audit flagged 12 missing risks. All here, plus Phase 2's:

1. **No dispute resolution / quality validation.** Buyer pays, seller delivers garbage. Phase 1 has only reputation pressure — which doesn't work in the first 30 days when nobody has reputation. **Mitigation:** auto-refund window for non-delivery; manual arbitration for quality disputes; an escrow-hold option for high-value txns (release on buyer confirm or timeout); ERC-8004 Validation Registry (validators) is the long-term answer (Phase 9). **This is the single biggest product risk and needs a real Phase 1 answer, not a deferral.**
2. **Tax / 1099-K.** US marketplace-facilitator obligations once a user earns >$600/yr. Legal opinion required before 1B. Possibly structure so funds flow user→user via wallets (we route, not facilitate) to avoid facilitator status — lawyer's call.
3. **Wallet drain via stolen VM key.** Encrypted Bankr key on VM; if exfiltrated, attacker signs on-chain bypassing our gate. **Mitigation:** Bankr/CDP API-level per-wallet daily limits (defense in depth); CDP MPC wallet for the backup path has no on-VM key at all — consider routing more value through CDP. Confirm Bankr supports API-level limits with Igor.
4. **x402 signature replay / front-running.** Per [x402 V2 security](https://dev.to/mkmkkkkk/x402-v2-just-dropped-5-security-changes-every-ai-agent-builder-needs-to-know-5apf): an attacker who sees `PAYMENT-SIGNATURE` can submit to the facilitator first; V2's per-request `payTo` lets a compromised server redirect funds. **Mitigation:** use our facilitator-proxy (control the settlement path); validate `payTo` against the expected counterparty wallet before signing; never trust a server-supplied `payTo` that differs from the matched counterparty.
5. **Public-internet attack surface (x402/compute servers on Linode IPs).** Probing, DDoS, signature-bypass. **Mitigation:** rate-limit per source IP, ban on malformed-payload bursts, 256KB body cap, payTo-from-env, facilitator-validated payments, optional nginx WAF-lite, consider restricting 8402/8403 ingress to InstaClaw VM ranges + our proxy. **Open question §10.5.**
6. **Matching-engine quality regression.** Commerce branch could contaminate intro quality. **Mitigation:** feature flag + A/B + separate prompt sections.
7. **Idempotency.** Fixed: `request_id` unique key.
8. **request_body size.** Fixed: 256KB CHECK.
9. **Stripe MCP key compromise.** Encrypted at rest; restricted scopes; rotation. "Monthly rotation" is unrealistic for an autonomous agent — use short-lived keys + anomaly-triggered rotation instead.
10. **Gas-sponsorship treasury runs dry.** ERC-8004 batch + BurnRouter spend from treasury. **Mitigation:** low-balance alert + auto-topup + pause-not-fail when dry.
11. **Privacy mode + commerce.** Fixed: L1 excludes privacy-on VMs; x402-server 503s; gate blocks.
12. **Lying-DB regression (CLAUDE.md P1-1).** Frontier ships via manifest; ~stale VMs would have Frontier in DB but not on disk. **Mitigation:** `requiredSentinels` on every Frontier file; coverage queries; **gate fleet rollout (and Edge Esmeralda) on lying-DB rate <2%** per the gbrain rollout precedent.
13. **(Phase 2) Sandbox escape.** `arbitrary-python` runs paid-for untrusted code. A sandbox escape = attacker code on a paying customer's VM. **Mitigation:** nsjail/firejail with no-network default, CPU/mem/time/FS limits, ephemeral FS, non-root; start with typed jobs only (no arbitrary-python) until the sandbox is audited. **The arbitrary-python job kind ships LAST, after a security review.**
14. **(Phase 2) Compute job degrades the seller's own agent.** **Mitigation:** refuse jobs when own utilization >60% or own session active (Rule 17 principle).
15. **(Phase 2) Compute griefing.** Buyer sends jobs designed to max out a seller (crypto-mining, infinite loops). **Mitigation:** hard `max_duration` per job kind + kill-on-timeout + reputation penalty for abusive buyers.
16. **Card program compliance** (covered §6.2.2).
17. **Email spoofing → prompt injection** (covered §6.3).

### 10.5 Open questions

The v0.1 audit flagged 6 missing; all here plus prior:

13. **ERC-8004 chain choice.** Base deployment exists, or deploy our own reference contracts on Base? Affects gas + UX. *Research before Phase 1A trust.*
14. **Legal entity + jurisdiction for protocol-fee capture.** Wild West Bots LLC? Which chain collects fees? Treasury multi-sig location? Securities analysis for on-chain fee capture? *Legal, before any fee goes live.*
15. **Who signs ERC-8004 feedback?** Agent wallet (user is on-chain submitter) vs treasury batch sponsor (we're the submitter — different liability/privacy). *Decide before trust ships.*
16. **Stripe MCP exact scopes.** Which `rk_` permissions? Can it refund? Cancel subs? Create prices? *Security analysis before 1C.*
17. **Resend inbound reliability + spam.** Volume? DKIM/SPF/DMARC enforcement? *Research before 1C email.*
18. **ENS subdomain ownership.** Agent-wallet-owned (true ownership) vs InstaClaw-multi-sig-managed (recoverable)? *Cooper, before 1C.*
19. **x402/compute server internet exposure.** Open internet vs InstaClaw-VM-ranges-only vs proxy-only? Affects discovery (open = anyone can buy; closed = internal economy first). *Decide before 1A server ships.* **Recommendation: start closed (InstaClaw VMs + our proxy only) for the internal economy + Edge Esmeralda; open to the internet later once hardened.**
20. **Dispute/validation model for Phase 1.** Escrow-hold? Auto-refund window? Manual arbitration SLA? *The §10.4 risk #1 answer — needs Cooper + legal input before commerce goes live.*
21. **Card cardholder model** (§6.2.2) — LLC-program vs per-user. *Legal.*
22. **Bankr API-level spend limits** — supported? *Igor.*
23. **$INSTACLAW staking contract** — exists? (gates all staker benefits). *Tokenomics Phase 0.*
24. **Coinbase x402 facilitator rate limits** for our projected volume. *Coinbase BD.*
25. **off-chain feedback URI hosting** — own IPFS pin vs Pinata. *Low priority, Phase 1A trust.*
26. **Vendrov DPA covers Frontier commerce/compute** (Edge research). *Cooper + Vendrov before Esmeralda.*

---

## 11. Roadmap + Effort (honest)

| Phase | Scope | Effort (1 eng) | Gating | Ship target |
|---|---|---|---|---|
| **48h demo** | vm-050↔vm-354 commerce, real x402 settle, tweet | ~16h | none | immediate |
| **Phase 1A** | earn + spend + discover + trust + dashboard | 2.5–3 wk | lying-DB <2%, Cooper canary approval (Rule 64) | ~3 wk out |
| **Phase 1B** | debit card | 1–2 wk build | **legal sign-off** | legal-gated |
| **Phase 1C** | Stripe MCP + Base MCP + ENS + email + AP2 | 3–4 wk | partner availability | post-1A |
| **Phase 2** | compute marketplace | 3–4 wk | **Phase 1A rails live**; sandbox security review | post-1A |
| **Edge Esmeralda** | village commerce + compute economy | overlaps | lying-DB gate; needs 1A + a Phase-2 slice | Esmeralda window |
| **Tokenomics Phase 0** | BurnRouter + liquidity + multi-sig | (separate PRD) | legal | prerequisite for all burns |

**No phase ships to the fleet without:** lying-DB rate <2% (P1-1), canary on vm-1019/vm-050 + explicit Cooper approval (Rule 64), `requiredSentinels` on every template (Rule 23), coverage queries (Rule 27), and `maxDuration=300` on every LLM/slow route (Rule 11).

---

## 12. Success Metrics

**48h demo:** 1 real x402 settlement between Cooper's VMs, on-chain BaseScan link, tweet. Zero P0.

**Phase 1A (3 wk post-ship):** 5+ VMs running x402-server; 20+ real commerce transactions; dashboard live; reputation aggregate populating; zero wallet-drain incidents; zero P0.

**Phase 2 (4 wk post-ship):** 10+ VMs offering compute; 100+ compute jobs settled; at least one "agent earned money while owner slept" with a real Telegram screenshot; sandbox security review passed; zero VM-degradation incidents from compute jobs.

**Edge Esmeralda (end of village):** 200+ village agents with ≥1 Frontier transaction; a real "villager rented compute from a sleeping villager" story documented; $500+ USDC moved; non-flat reputation distribution; ≥5 public posts about earning via agent; 0 disputes escalating beyond the arbitration window.

**12-month (conditional):** 10K+ agents Frontier-active; $500K+/mo total transaction volume; compute marketplace as a measurable burn source; ≥5 AP2 cross-platform flows; "the open agent economy" narrative position in the Base ecosystem; ≥1 fully self-funded agent (Frontier earnings > subscription).

**Failure signals that force a rethink:** <100 daily commerce txns at 30 days (demand problem); median agent $0 lifetime earnings at 60 days (discoverability problem); compute marketplace <50 jobs/day at 30 days post-launch (the moat isn't producing usage); any wallet drain (kill switch + audit).

---

## 13. What changed from v0.1 (audit closure)

For the record, every audit finding and its disposition:

| Audit finding | Disposition in v0.2 |
|---|---|
| Burn projections ~10× inflated | Cut to $2–3.5K/mo at 1K users; made explicitly conditional on tokenomics Phase 0 + per-agent volume (§8.3) |
| "48-hour MVP" is really 2-week | Split into 48h *demo* + 3-week Phase 1A; honest per-item effort (§6.8, §11) |
| "Per-VM x402 server = structural moat" overclaimed | Reframed: the moat is *dedicated compute* (§1.3 Bucket 2); x402 server is a consequence; compute marketplace (Phase 2) is the real leapfrog |
| PRD ~75% follow | Honestly separated table-stakes (Bucket 1) from moat (Bucket 2) (§1.3) |
| Competitive table all "we win" | Time-phased honest table (today / after P1 / after P2) (§2.1) |
| Missing risks 1–12 | All in §10.4 (+ Phase 2 risks 13–15) |
| Missing open questions 13–18 | All in §10.5 (+ more) |
| Missing edge cases 19–26 | All in §6.7 |
| Migration: vector dim, ivfflat, updated_at, RLS, request_body, bigint | All fixed (§9.1, §9.2) |
| API: idempotency, selfAuthAPIs, response shape, zod | All fixed (§10.1) |
| SKILL.md invented tools | Removed; every tool exists or is phase-tagged (§10.2) |
| **Missed: compute marketplace** | **Now Phase 2, the most detailed section (§7)** — but phased AFTER Phase 1 per Cooper's framing |

---

## 14. Closing

Two sentences:

> **Phase 1 gives every InstaClaw agent the economic stack of a small business — wallet, debit card, identity, the ability to earn and spend — built on open standards so nothing locks the user in. Phase 2 turns the 85–95% idle compute on every agent's dedicated machine into a marketplace where agents rent capacity to each other while their humans sleep — a product Virtuals structurally cannot build.**

Phase 1 makes us competitive with EconomyOS and better on trust. Phase 2 makes us uncopyable. Together they are the open agent economy, running on the standards everyone adopted, on the only runtime where every agent owns a machine.

The thesis is decided. The phasing is correct. The numbers are honest. The work is execution.

— Cooper + Claude, v0.2, 2026-06-01
