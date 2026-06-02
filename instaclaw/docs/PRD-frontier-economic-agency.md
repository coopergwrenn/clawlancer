# PRD — Frontier: Economic Agency for InstaClaw Agents

**Status:** DRAFT — under review (Cooper). Build nothing until a phase is greenlit.
**Author:** CC (frontier terminal) · **Created:** 2026-06-02
**Supersedes/extends:** `instaclaw/docs/prd/agent-economy-os-2026-05-12.md` (Frontier Phase 1A — the foundation). This document is the source of truth for the **economic-agency layer** (spend skill + earned budget + supplier rolodex + reputation + earn storefront). Cooper coordinates terminals against this PRD. If it isn't in here, it doesn't get built.

> Reputation layer (§ added Step 3 after a dedicated research session) lives in **§7**. Sections §1–§6 cover spend + earn.

---

## §1 — THESIS

### The frame everyone is about to get wrong
`@x402/mcp` — the official package the rest of the industry will adopt — defaults to `autoPayment: true`: detect a 402, pay it, retry. **Blind.** No budget, no memory, no judgment, no human visibility. That is not economic agency; it is a faucet pointed at a wallet, and it is exactly the unsupervised-agent behavior the industry learned to fear (the Kiro/AWS 13-hour-outage class of incident).

The plumbing is solved and proven on mainnet (Bazaar discovery, Bankr signing, CDP settlement — see §6). The product is the **brain that decides** — and a brain that **gets better, earns trust, and is watchable.**

### The invention: Economic Agency as a formal primitive
No one has formalized this. ERC-8004 gives agents identity + generic reputation, but its reputation is sybil-farmable and says nothing about how an agent should *spend*. We define an agent's **economic agency** as four owned things:

1. **An earned budget** (not a granted one) — *Invention 1, the keystone.*
2. **A self-built supplier rolodex** that compounds across sessions — *Invention 2, the moat.*
3. **A credit standing** derived from decision quality.
4. **A verified-human root of trust** (World ID) that makes 1–3 un-fakeable.

#### Invention 1 — The budget is EARNED, not granted (this is how we solve Rule 28)
Every other platform's permission model is a checkbox: human sets "$5/day," agent spends it. That's a cliff — the human must trust $5 on day one before the agent has proven anything, so they set $0 and the agent stays a toy (and per **Rule 28** the agent refuses anyway, because "the human allowed it" is a weak directive).

Graduated/progressive autonomy (Audit → Assist → Automate, "trust compounds") is a recognized 2026 pattern, but **nobody has tied it to money as an earned-budget loop.** That is what we build:

> The agent starts at **$0.10/day**. Every purchase that delivers value, stays in budget, and isn't disputed raises its **credit standing**. Credit standing unlocks a higher daily budget — `$0.10 → $0.50 → $2 → tier ceiling` — automatically, capped by the tier the human pays for. The human watches a live feed and can boost or cut with one tap.

This converts Rule 28 from a refusal problem into an *empowerment directive*: *"You've earned $2.00/day of autonomy through 180 good decisions. Spend it well — it grows as you prove judgment, and shrinks if you waste it."* The agent exercises a license it built. Prior art: rising credit limits, progressive-autonomy levels, RL reward shaping — never before pointed at an agent's wallet. The earned-trust loop is also the answer to "isn't autonomous spend scary?": no, because you *watched it earn the trust*.

#### Invention 2 — A sybil-resistant, fleet-wide supplier rolodex (the moat)
One agent buying an ETH price from `anchor-x402` is one data point. **1,200 InstaClaw agents** having bought from it (99.2% success, $0.001, p50 180ms) is *collective economic intelligence* a new agent inherits on day one.
- Single-agent platforms (Fetch, Virtuals) can't build this — each agent learns alone.
- Open reputation protocols (ERC-8004 Reputation Registry) can't *trust* it — spin up 10k fake agents, farm fake reviews. The fatal flaw of every open agent-reputation system.
- **Only InstaClaw can do both**, because every rating comes from an agent bonded to a **World-ID-verified unique human**: one human, one vote — un-sybil-able by construction.

The agent doesn't average reviews; it runs **Thompson sampling over a budgeted multi-armed bandit** (the exact formalism, logarithmic regret): mostly exploit its best supplier, occasionally explore a new one, always within budget. Its spending *provably improves over time* — the Hermes "self-improving skills" pattern, applied to **money** for the first time.

### Reframe — not a pipeline, a standing portfolio
`discover → decide → pay → remember` is a pipeline (fine for one purchase). Economic agency is a **standing model the agent maintains**: a live rolodex of suppliers-per-capability, a posterior on each, an earned budget, a credit standing. "Spend" is continuous portfolio optimization. The skill exposes one verb — *hire a specialist for this task* — behind which is a manager who always knows its options, its track record, and its budget.

### The demo we work backwards from
A 30-second screen recording of the dashboard **Agent Economy** feed: over a week the human watches the agent autonomously make 200+ micro-purchases, each annotated in plain language ("needed a current ETH price → compared 5 oracles in my rolodex → hired anchor-x402, my best ETH source, 40 prior buys, 99% reliable → $0.001 → done"), above a budget meter that **climbed from $0.10 to $2.00, earned**, a credit badge **"Automate · Level 3,"** and a rolodex the agent built itself. Caption: *"my AI agent has a job, a budget it earned, and a rolodex it vetted itself. it made 212 purchases this month. I approved zero — and watched every one."* Real money, real autonomy, visible learning, earned watchable trust.

### One identity, two sides (bridge to earn)
Credit standing that governs how much an agent can **spend** is the same standing that governs how much it's trusted to **sell**; the supplier graph (buyers rating sellers) *is* the earn-side reputation; the World-ID root works both directions. Build the economic identity on the spend side (safer to prove judgment); the earn side inherits it.

---

## §2 — ARCHITECTURE

One system. Components, by layer:

### Spend path (agent as buyer)
```
agent task hits a capability gap
  -> [frontier-rolodex]  pick supplier per capability (Thompson sampling over posteriors;
                         priors seeded from the fleet supplier graph)
  -> [spend/authorize]   gate: evaluateSpend(policy bands) ∧ earned-budget(credit standing)
                         ∧ category allowlist ∧ atomic daily-ledger reserve  -> decision
        just_do_it -> proceed | ask_first -> human 👍/👎 | deny -> refuse with reason
  -> [Bankr /wallet/sign] sign EIP-3009 (no key on VM)  -> X-PAYMENT
  -> seller's x402 endpoint -> seller's facilitator settles on Base (we are NOT the facilitator here)
  -> [spend/settle]      finalize ledger row; update credit standing; emit supplier outcome
  -> [gbrain]            update supplier posterior + write purchase memory (the rolodex)
  -> result returned to the agent with "hired a specialist" UX framing
```
Note: on the **spend** side the buyer only signs; the *seller* settles. The facilitator proxy is **not** used for spend.

### Earn path (agent as seller)
```
agent exposes an x402-paid endpoint on its VM (a capability/service)
  -> payTo = the agent's bankr_evm_address
  -> buyer pays -> our x402 resource server -> [facilitator proxy] -> CDP facilitator verify+settle
  -> declareDiscoveryExtension metadata  -> CDP auto-catalogs the endpoint in the Bazaar (free, global)
  -> [spend/settle earn-variant] record earn row; credit standing accrues
```
The **facilitator proxy** (shipped) is the earn-side settlement relay — VMs never hold `CDP_API_KEY_SECRET`.

### Component registry (every piece named)
| # | Component | Location | State |
|---|---|---|---|
| C1 | Policy bands engine (`evaluateSpend`, tiers, tighten-only overrides) | `lib/frontier-policy.ts` | **DONE** (Phase 1A) |
| C2 | **Credit-standing engine** — one truth, two projections: internal **earned budget** (autonomy governor) + external **on-chain score** (public trust). Merges the old budget + FICO engines (taste fix §8) | `lib/frontier-standing.ts` | TO BUILD (W1, which subsumes W18) |
| C3 | Supplier rolodex + Thompson-sampling selection | `lib/frontier-rolodex.ts` | TO BUILD (W2) |
| C4 | Category allowlist (policy dimension) | `lib/frontier-policy.ts` ext | TO BUILD (W3) |
| C5 | Spend authorize gate (real-time) | `app/api/agent-economy/spend/authorize` | TO BUILD (W4) |
| C6 | Spend settle / outcome | `app/api/agent-economy/spend/settle` | TO BUILD (W5) |
| C7 | Transaction ledger | `frontier_transactions` table | **DONE** (Phase 1A) |
| C8 | Spend skill — "hire a specialist" | VM skill (`frontier-hire`) | TO BUILD (W6) |
| C9 | gbrain economic memory (supplier index + purchase log) | gbrain MCP + helpers | TO BUILD (W7) |
| C10 | Rule 28 directive | SOUL.md section | TO BUILD (W8) |
| C11 | Bankr signer integration (`/wallet/sign` EIP-3009) | VM skill | **PROVEN** (canary; productionize in W6) |
| C12 | Bazaar discovery (search/MCP) | CDP discovery API | **PROVEN** (canary; productionize in W6) |
| C13 | Facilitator proxy (earn-side relay) | `app/api/x402/facilitator/[op]` | **DONE** (`b03b5c2f`) |
| C14 | Per-VM proxy secret (replace shared) | reconciler / SECRET_ENV_VAR_SOURCES | TO BUILD (W9) |
| C15 | Fleet supplier reputation graph (the moat) | new table + aggregation + read API | TO BUILD (W10) |
| C16 | Earn storefront skill | VM skill + declareDiscoveryExtension | TO BUILD (W15) |
| C17 | Dashboard — Agent Economy feed (the viral surface) | frontend + `/state` ext | TO BUILD (W13) |
| C18 | Dashboard — policy/budget controls | frontend + `/policy` PUT (exists) | TO BUILD (W14) |
| C19 | Standing canary (test agent) | linode 98505957 | **DONE** (`da6b8424`) |
| C20 | On-chain reputation layer | see **§7** | TO RESEARCH/BUILD |

---

## §3 — WORK ITEMS

Numbered, concrete, with dependencies. Every item is testable (Rule 31: each ships a failure-mode test).

**Spend agency (the core)**
- **W1 — `lib/frontier-standing.ts`** (the credit-standing engine — subsumes the former W18 FICO engine; see §8 merge): one pure function over the track record producing BOTH projections — `creditStanding(trackRecord) -> {score (300–850, FICO-for-agents §7.3), level, earnedDailyBudget}`. Earned budget starts $0.10, grows on **good decisions (§7.3.2 — settled ∧ used ∧ undisputed ∧ not-self-dealt)**, capped by tier `justDoItPerDay`; decays on dispute/waste. Score uses the §7.3.1 anti-wash-trade weighting (same-human exclusion, counterparty diversity, rep-weighting, cost-anchoring). Deterministic, no I/O. Tests incl. wash-trade + decay cases. **Dep:** C1. *The keystone — internal autonomy and external reputation are one truth.*
- **W2 — `lib/frontier-rolodex.ts`**: pure supplier-selection. `selectSupplier(capability, posteriors[], budget) -> supplier` via Thompson sampling (Beta posteriors on success; cost/latency as secondary ranking); `updatePosterior(prior, outcome) -> posterior`. Budgeted-bandit aware. Tests. **Dep:** none.
- **W3 — category allowlist in `lib/frontier-policy.ts`**: add `category` + `allowedCategories` to `SpendContext`; deny if category ∉ allowlist; default category sets per tier; Bazaar-tag → category mapping. Tests. **Dep:** C1.
- **W4 — `POST /api/agent-economy/spend/authorize`**: gateway-token auth → resolve VM → gather context (tier, isStaker, overrides, privacy, spentToday from ledger 24h, walletBalance via viem from `bankr_evm_address`, category) → `evaluateSpend` ∧ earned-budget (W1) → if approved, atomic reserve (insert `frontier_transactions` pending) → return decision + request_id + effective bands + earned budget. Middleware allow-list (Rule 13), `maxDuration=300` (Rule 11). Tests (over-cap, drain, daily-race, privacy, category-deny). **Dep:** W1, W3, C7.
- **W5 — `POST /api/agent-economy/spend/settle`**: finalize the reserved row (pending→settled|failed, tx_hash, response_summary); update credit standing (W1 inputs); emit supplier outcome to the fleet graph (W10). **Dep:** W4, W10.
- **W6 — spend skill `frontier-hire`** (VM script + `SKILL.md`): the productionized loop — rolodex-select (W2) → authorize (W4) → Bankr `/wallet/sign` pay (C11) → settle (W5) → gbrain memory (W7) → return with "hired a specialist" UX. Hardened from the proven `frontier-acquire.mjs`. Tests + canary scenario. **Dep:** W2, W4, W5, W7, C11, C12.
- **W7 — gbrain economic memory**: schema + helpers for (a) supplier index (posteriors per capability), (b) purchase log (what/whom/cost/result/useful). Read at discover-time, write at settle-time. Handle gbrain-absent gracefully. **Dep:** gbrain installed on VM (Rule 35). Tests.
- **W8 — Rule 28 SOUL.md directive**: empowerment-with-boundaries text ("you've earned $X; spend it well; it grows; decline only if [list]"). Written like a contract. **Dep:** W1 (budget framing). Canary behavior test (does the agent spend when it should, refuse when it shouldn't).

**Fleet + visibility**
- **W9 — per-VM proxy secret**: replace the single shared `X402_PROXY_SECRET` with per-VM secrets distributed via `SECRET_ENV_VAR_SOURCES` / reconciler; proxy validates per-VM. **Dep:** C13. (Earn-side only; spend doesn't use the proxy.)
- **W10 — fleet supplier reputation graph**: table `frontier_supplier_stats` (endpoint, capability, n, success_rate, avg_cost, p50_latency, last_seen) aggregated from settle outcomes (W5); read API to seed new agents' priors (W2). Sybil-resistant (one row-contribution per World-ID human via VM→user bond). Coverage query (Rule 27). **Dep:** W5. *The moat — needs a migration → Rule 56 (pending_migrations first).*
- **W11 — canary proof harness**: the multi-step scenario (gap → rolodex pick → earned-budget gate → real purchase → result used in a real user answer → posterior + standing update visibly change). **Dep:** W1, W2, W4, W5, W6.
- **W12 — fleet rollout of spend skill**: manifest `files[]` entry + reconciler step + SOUL.md directive deploy + canary-first per **Rule 64** (Cooper approval). **Dep:** W6, W8, W11 green; W9.
- **W13 — dashboard Agent Economy feed** (the viral surface): live transaction feed w/ plain-language annotations, budget meter (earned), credit badge, rolodex view. Extends `/api/agent-economy/state`. **Dep:** W5, W7. (Frontend — terminal TBD.)
- **W14 — dashboard policy/budget controls**: human sets enable/budget/categories; extends `/policy` PUT (exists). **Dep:** W3, W4.

**Earn side**
- **W15 — earn storefront skill**: VM-side x402 server skill, `payTo = bankr_evm_address`, `declareDiscoveryExtension` metadata, settles via facilitator proxy (C13). **Dep:** C13, W9.
- **W16 — earn auto-listing verification**: confirm settle-through-proxy auto-catalogs the endpoint in the Bazaar; coverage. **Dep:** W15.
- **W17 — A2A intra-fleet commerce**: InstaClaw agents hiring each other (buyer = W6, seller = W15) inside the fleet first; observability. **Dep:** W6, W15.

**Reputation (see §7 for detail — added Step 3)**
- **W18+ —** reputation work items in §7.

---

## §4 — PHASE MAP

| Phase | Contents | Why this order | Gates |
|---|---|---|---|
| **Phase 0 — Rail proof** | Bankr signing, facilitator proxy, mainnet settlement, autonomous Bazaar acquisition, canary | Prove money moves before building product on it | **DONE** (§6) |
| **Phase 1 — Spend agency** | W1, W2, W3, W4, W5, W6, W7, W8, W11 | Earned-budget spend skill is the keystone invention + immediate "agent stops saying I can't"; safest place to prove judgment; foundation both sides share | canary proof (W11) + Cooper greenlight |
| **Phase 2 — Fleet + feed** | W9, W12, W13, W14 | Roll spend to the fleet (Rule 64) + ship the viral dashboard feed; W10 graph starts accruing real data | Phase 1 green; Rule 64 approval |
| **Phase 3 — Reputation (the credit bureau)** | W10 (fleet graph) + §7: **3a** off-chain score + dashboard profile (W18, W26, W23) → **3b** on-chain registry/oracle + EAS/ERC-8004 (W19, W20, W25) → **3c** $INSTACLAW staking + burn (W21, W22, W24) | The moat + the talked-about product. 3a is the safe dashboard win (visible "agent credit score," zero contract risk); 3b makes it a composable public good; 3c adds the staking economy (highest external risk last). W10/W18 accrue data from Phase 2 onward | research §7 done; Cooper greenlight; 3c gated on $INSTACLAW token + audits |
| **Phase 4 — Earn side** | W15, W16, W17 | The differentiator (agent earns a living); inherits the identity + reputation from Phases 1–3 (sellers are trustworthy *because* they carry a sybil-resistant score) | Phases 1–3 patterns proven |

Dependency note: Phase 1 is mostly independent pure-logic + backend (no fleet risk). Phase 2 is the first fleet-mutating step (Rule 64). Phase 3's graph (W10) should begin accruing data the moment Phase 2 ships (settle outcomes), even if scoring hardens later. Phase 4 is gated on the identity/reputation being real so sellers are trustworthy.

---

## §5 — OPEN QUESTIONS (need Cooper / external)

1. **Wallet funding model.** Who funds the agent's Bankr wallet for spend — human top-up, a slice of subscription, or earn-funded only? Starting balance vs starting budget are different levers (budget caps autonomy; balance caps capability). Recommend: human opt-in top-up + earn-funded growth; budget governs autonomy.
2. **Starting budget / growth curve.** $0.10/day start, geometric growth on good decisions, tier ceiling cap — confirm the numbers + the "good decision" definition (delivered value? no dispute? under budget?).
3. **`ask_first` UX.** Reuse the existing Telegram 👍/👎 ack flow for human-in-the-loop confirmations? Or dashboard approve?
4. **Category taxonomy.** Use Bazaar tags directly, or our own (data/search/inference/compute/market/…)? Default allowlist per tier?
5. **Per-VM proxy secret rotation** mechanism + cadence.
6. **Staking ($INSTACLAW).** 2x ceilings are gated on staking (not live). Keep gated, or use a different multiplier signal (e.g., credit standing) until staking ships?
7. **Dashboard ownership.** Which terminal builds the Agent Economy feed frontend (W13/W14)?
8. **Earn-side legal/compliance.** Agents selling services for money — the World-ID human accountability is our story; confirm posture before W15.
9. **gbrain economic-memory durability.** Rule 35 P1: version bumps wipe brain.pglite. Economic memory (rolodex) must survive — depends on the upstream `snapshot_brain` tooling. Until then, mirror critical rolodex stats to the fleet graph (W10) so memory is recoverable.
10. **Reputation: on-chain vs off-chain** — resolved in §7 (Step 2 research).

---

## §6 — WHAT'S ALREADY DONE (the foundation)

**This session (rail proof):**
- **Bankr `/wallet/sign` EIP-3009 signing — PROVEN.** Bankr signs arbitrary EIP-712; signature ecrecovers to the wallet address; Base USDC (FiatTokenV2_2) accepts it via the `isContract`-branched `SignatureChecker` (ecrecover path). 10/10 sampled fleet Bankr wallets are EOAs → ecrecover path. No private key on the VM.
- **Facilitator proxy — SHIPPED** (`b03b5c2f`): `app/api/x402/facilitator/[op]` relays verify/settle/supported to the CDP facilitator with CDP creds backend-only; `X402_PROXY_SECRET` gate; middleware allow-listed.
- **Real mainnet settlement** — Bankr-signed → proxy → CDP → Base, tx `0xfe0c5962…` ($0.01 real USDC, payer EOA, gasless).
- **Testnet proofs** — `0xfae7e695…` (x402.org), `0x748f987b…` (CDP via proxy).
- **Autonomous Bazaar acquisition** — `frontier-acquire.mjs`: discover (live Bazaar) → policy gate → Bankr-sign → real $0.001 purchase of `anchor-x402` ETH price → result. (canary, not yet in repo — productionized by W6.)
- **Standing canary** — linode 98505957, protected (`da6b8424`), sshd `MaxStartups` hardened.

**Frontier Phase 1A (pre-session, merged `67b5ae2f`):**
- `frontier_transactions` ledger (idempotent, vm-authed) — C7.
- `lib/frontier-policy.ts` — `evaluateSpend` bands engine — C1 (`74e0100a`, refined).
- Routes: `/policy` GET+PUT (`f9aaf6a5`), `/offerings` (`a81a1463`), `/transaction`, `/state`, `/refund`, `/reputation/queue`.
- `frontier_policy_overrides`, `frontier_erc8004_identities`, lifetime-rollup cron (`41d8d971`), refund-reconcile (`0a1eb163`), `_coverage-frontier.ts` (`6137b61d`).

---

## §7 — ON-CHAIN REPUTATION / AGENT CREDIT STANDING (the credit bureau for the agent economy)

### §7.1 — Thesis addition: we already have the ledger, we're missing the score

Every x402 settlement is an **immutable on-chain receipt on Base.** Ethereum is, literally, a permanent record of every economic interaction an agent has ever had. We are sitting on the raw data for an agent credit bureau and haven't computed the score.

We have all four ingredients and nobody has assembled them:
- **AgentBook** (`0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4`) — agent ↔ World-ID-human identity (the sybil-resistant root).
- **ERC-8004** — the emerging identity (ERC-721) + reputation + validation standard (we have `frontier_erc8004_identities`).
- **World ID nullifiers** — one-human-one-identity (sybil resistance).
- **x402 receipts on Base** — the immutable transaction history (the "FICO data").

The missing primitive is **the score** — the aggregation that turns receipts + identity + sybil-resistance into a single, readable **agent credit standing.** Research findings that shape it:
- **EAS** (Ethereum Attestation Service — free, tokenless, composable public good on Base) is the right substrate to *publish* reputation, but its open attestation reputation is **sybil-farmable** ("anti-sybil remains an open challenge for attestation-based reputation"). **World ID is exactly the missing sybil resistance.** So InstaClaw's attestations become the *high-value* ones in the EAS graph: backed by a verified-unique human + real on-chain receipts.
- **FICO** gives a principled, instantly-graspable model. Its 5 factors translate directly to agents (see §7.3).
- **TCR / costly-signaling theory** grounds the $INSTACLAW staking mechanic (§7.5): staking is a costly signal — cheap for a good agent (returned), expensive for a bad one (burned). Self-selecting honest signal.

### §7.2 — The frame: the trust layer (Know-Your-Agent + credit) for the agent economy
a16z (April 2026): *"the real bottleneck in the agent economy is no longer intelligence, but identity"* — agents already outnumber humans ~100:1 in financial services — and the named gap is **"Know Your Agent" (KYA): cryptographically signed credentials linking each agent to its principal, permissions, constraints, and reputation.** That is *verbatim our architecture*: principal = the World-ID human (AgentBook), constraints = the earned budget + policy, reputation = the on-chain credit standing. **We are the reference implementation of KYA** — the thing the smartest investors just said the economy is missing, which our four ingredients uniquely deliver.

Within that, we run **the credit bureau** — FICO/Equifax for agents. Experian launched "Agent Trust" in 2026, so the frame is validated *and* contested. Our edge is categorical: theirs is centralized, proprietary, off-chain; **ours is on-chain (one-RPC read), composable (EAS/ERC-8004 public good on Base), and the only sybil-resistant one in existence** (rooted in verified-unique humans + real on-chain receipts). Any counterparty — an InstaClaw agent, any x402 service judging a buyer, any buyer judging a seller — reads an agent's standing in one call.

The deepest frame: InstaClaw agents are the first that are **autonomous AND accountable.** Truth Terminal is autonomous-not-accountable (a meme with a wallet); enterprise agents are accountable-not-autonomous (a human approves everything). We are the only ones who are both — a verified human behind every agent, an earned budget that makes autonomy safe, and a credit score the world can read. *The first agents you can actually trust with money.*

### §7.3 — FICO-for-Agents (the scoring model)
Off-chain, deterministic, computed from the ledger + on-chain receipts. Five factors (FICO weights, adapted):
| Factor | Weight | Agent meaning |
|---|---|---|
| **Settlement reliability** | 35% | Did its transactions settle successfully? dispute rate, failed-settlement rate. (Like payment history — the dominant factor.) |
| **Budget discipline** | 30% | Stays well within earned budget; never drains wallet; spends responsibly. (Like utilization.) |
| **Tenure** | 15% | How long economically active. (Like length of history.) |
| **Activity diversity** | 10% | Earns AND spends; multiple categories + counterparties — a rounded actor, not a one-trick bot. (Like credit mix.) |
| **Velocity / anomaly** | 10% | Sudden bursts of new counterparties/spend = risk flag. (Like new credit / fraud signal.) |
Output: a **score** (e.g., 300–850, FICO-familiar) + a **level** mapped to graduated autonomy: Audit → Assist → Automate (or named: Provisional → Established → Trusted → Elite). **World-ID-verified** is a hard gate/boost (unverified agents are capped low). Score is the SAME signal feeding the off-chain earned budget (§1 Invention 1) — internal autonomy and external reputation share inputs.

#### §7.3.1 — Integrity: cost-anchoring + anti-wash-trade (NON-NEGOTIABLE — the score is worthless without it)
Research is unambiguous: *"any reputation oracle without cost-anchoring is Sybil-fragile by design"* (Chainlink/MakerDAO), and ~70% of DEX pools show wash trading. The obvious attack on our score AND earned budget: an agent transacts with **itself or a colluding agent** to manufacture settlement history → inflate score → unlock budget/reputation → game staking. World ID stops one-human-many-identities, but a single human's agent paying that same human's own seller-endpoint is **self-dealing inside one identity** — and money moving in a circle costs only gas. Defenses, baked into the score (not bolted on):
1. **Same-human exclusion.** Counterparties bonded to the *same World-ID human* (via AgentBook) contribute **zero** to score-positive history. Self-dealing is invisible to the score by construction.
2. **Counterparty diversity.** Reliability credit is weighted by the *number of distinct, verified counterparties* — N real partners ≫ N transactions with one. A thousand trades with one peer ≈ one relationship.
3. **Reputation-weighting (EAS principle: value = the attester's standing).** A settlement with a *high-score, World-ID-verified* counterparty counts more than one with an unknown/new wallet. You cannot bootstrap a score by trading with other zeros.
4. **Cost-anchoring.** Only **real value transferred to distinct trusted parties** counts — wash loops (value returns to the same human) net to ~zero economic substance and are filtered.
5. **Anomaly factor (the 10% velocity factor doing real work).** Sudden bursts of new counterparties / circular flows → risk flag → score freeze pending review (AI-driven anomaly detection, per the cited multi-layer defenses).
Same discipline as the burn-executor double-spend firewall: **never let an unverified or self-dealt claim move the score.**

#### §7.3.2 — What counts as a "good decision" (the soft center of the earned-budget loop — name it or it's hollow)
The earned budget grows on "good decisions," so "good" must be objective or the loop degenerates (budget rises on *any* successful settlement → agents buy junk → "earned trust" is theater). A purchase counts as **good** only if ALL hold: (a) it **settled**; (b) the result was **used** (the agent incorporated it into a response/task — measurable from the session, not self-asserted); (c) **no human refund/complaint** within the window; (d) it was **not self-dealing** (§7.3.1). Pure "value delivered" is a research frontier (we honestly cannot perfectly measure usefulness); v1 uses these four proxies and is explicit about it. Wasteful or disputed purchases **decay** standing — the budget shrinks, closing the loop in both directions.

### §7.4 — The on-chain primitive (fast to read, deep to audit, automatic to build, composable)
- **`FrontierCreditRegistry`** — a lightweight Base contract. `getScore(address agent) -> {score uint16, level uint8, txCount uint32, worldIdVerified bool, stakedInstaclaw uint, updatedAt uint40}`. **One RPC call, milliseconds** — any agent inside or outside InstaClaw checks it before transacting. Updated by an InstaClaw **score oracle** (backend) from the off-chain FICO-for-agents computation.
- **Deep audit** = the x402 receipts already on Base + the off-chain ledger. Anyone drills score → receipts. Nothing to trust blindly.
- **Composable public good**: mirror the score as an **EAS attestation** + integrate the **ERC-8004 Reputation Registry**, so non-InstaClaw systems read it via open standards. We don't own the rail; we own the *quality* (sybil resistance).
- **Replace vs complement the off-chain budget engine?** COMPLEMENT. Off-chain earned budget = the agent's *private autonomy governor* (how much THIS agent may spend today — fast, mutable, internal). On-chain registry = the *public trust signal* (what OTHERS see). Shared inputs, different consumers. Internal trust (we trust our agent with money) ↔ external trust (the world trusts our agent). The same "one identity, two sides" thesis extended.

### §7.5 — $INSTACLAW staking: skin in the game, burn on betrayal (the implementation of the promised holder perk)
This is the IMPLEMENTATION of the already-promised "$INSTACLAW holders stake for agent priority + reputation" — designed *into* the reputation layer, not bolted on.

**Mechanics:**
- **Stake** N $INSTACLAW on your own agent (v1: operator-on-own-agent only; third-party trust-staking is a noted extension) → recorded on a Base staking contract → factored into the on-chain score as a **bounded** skin-in-the-game component (capped weight — staking is a SIGNAL, the FICO behavioral factors dominate; you cannot *buy* a great score, only signal confidence) + raises the budget **ceiling** (reuses the existing `STAKER_CEILING_MULTIPLIER` in `lib/frontier-policy.ts`).
- **Burn on bad behavior:** during a probation window, if objective, on-chain-verifiable conditions breach (dispute resolved against the agent, failed-settlement rate above threshold, fraud flag) → the staked $INSTACLAW is **BURNED** (to `0x…dead`, not returned, not to treasury). Bounded: you can lose at most what you staked.
- **Return:** maintain good behavior through the window → stake unlocks, fully withdrawable. **Staking a genuinely good agent is free.**
- **Game theory (grounded in TCR + costly-signaling):** self-selecting — confident operators stake (costless to them); operators who stake on bad agents subsidize the token via burn. Cheap talk becomes a costly signal. **Deflationary:** bad behavior destroys supply, rewarding honest holders — the whole community is incentivized to let bad agents fail.

### §7.6 — Dashboard UX: the agent's social-credit profile (where it becomes a product people talk about)
At `instaclaw.io/dashboard`, every agent has a **living credit profile** (Credit-Karma-meets-LinkedIn):
- **The score** (big), the **level** badge, and the **trend** (↑12 this week).
- **Why** — the FICO-for-agents breakdown (§7.3), each factor with a sub-score + one-line explanation.
- **Timeline** — score over time with annotated events: *"+12 this week — 47 settlements, 100% success."*
- **Actionable recommendations** (Credit-Karma style): *"Verify with World ID → +40,"* *"3 failed settlements dragged reliability — here's what happened,"* *"Stake $INSTACLAW to boost while you build history."* The dashboard doesn't just show the score — it helps the human improve it.
- **Staking widget**: current stake, the boost it confers, the **burn-risk warning** + probation countdown (*"5,000 $INSTACLAW staked · at risk if [conditions] · withdrawable in 12 days of good behavior"*).
- **Shareable profile card** (the viral surface): *"my agent: Trusted · 812 · 1,240 settlements · World-ID verified · 3,200 $INSTACLAW staked."*
- Sits atop the **Agent Economy feed** (W13) — score + the live transaction stream that produced it.

### §7.7 — Reputation work items
- **W18 — [MERGED INTO W1]** — the FICO-for-agents score is produced by the same `lib/frontier-standing.ts` engine as the earned budget (one track record, two projections; see §8 taste fix). The *score-specific* remaining work is the wash-trade integrity weighting (§7.3.1) + the good-decision definition (§7.3.2), now part of W1's spec.
- **W27 — spend-side dispute / recourse + quality signal**: x402 settles-then-serves, so a seller can take payment and deliver garbage. The agent flags a bad delivery → the supplier posterior (W2) tanks AND a dispute row is recorded on the ledger (feeds the velocity/anomaly + reliability factors). No per-tx clawback (x402 has none), but the statistical + reputational penalty is real and the human sees it in the feed. **Dep:** W2, W5, C7.
- **W19 — `FrontierCreditRegistry` (Base contract)**: `getScore` view + oracle-write; audited; deployed. + EAS attestation schema + ERC-8004 Reputation Registry integration. **Dep:** W18. *External: contract audit, Base deploy, gas.*
- **W20 — score oracle (cron)**: compute (W18) → publish on-chain (W19) + EAS attestation. Idempotent, signed. **Dep:** W18, W19.
- **W21 — $INSTACLAW staking contract + burn**: stake/unlock/burn, probation window, objective breach conditions; integrates `STAKER_CEILING_MULTIPLIER`. Audited; deployed. **Dep:** W19, $INSTACLAW token. *External: token contract, audit.*
- **W22 — burn-trigger watcher (cron)**: detect breach conditions from the ledger + on-chain receipts → execute burn; fully audited trail (never burn on an unverifiable claim — same discipline as the burn-executor double-spend firewall). **Dep:** W21.
- **W23 — dashboard credit profile** (score, trend, FICO breakdown, timeline, insights/recs, share card). **Dep:** W18, W13.
- **W24 — dashboard staking widget** (stake/boost/burn-risk/return). **Dep:** W21, W23.
- **W25 — public score read API + "credit bureau" positioning** (any agent queries getScore; docs as a public good). **Dep:** W19, W20.
- **W26 — x402-receipt ↔ ledger reconciliation for the score's audit trail** (receipts are already on Base; verify off-chain ledger against on-chain receipts before they count toward the score). Overlaps the existing chain-verify worker (`frontier-verify-settlements`). **Dep:** C7.

### §7.8 — Phase placement
**Phase 3 — Reputation** (after Phase 1 spend + Phase 2 fleet/feed). Sub-order:
1. **3a (off-chain, no external deps):** W18 (score engine) + W26 (receipt reconciliation) + W23 (dashboard profile, reading off-chain score). Ships a *visible credit score* with zero smart-contract risk — the dashboard-feature win.
2. **3b (on-chain):** W19 (registry) + W20 (oracle) + W25 (public read) + EAS/ERC-8004 mirror. Makes the score a composable on-chain public good.
3. **3c (staking):** W21 (staking+burn contract) + W22 (burn watcher) + W24 (staking widget). Gated on the $INSTACLAW token + contract audits.
Rationale: deliver the *visible* score early (off-chain, safe), then publish it on-chain (composable), then add the staking economy (highest external risk last). W18's score engine should begin computing the moment Phase 2's ledger has real data.

### §7.9 — Reputation open questions (add to §5)
- **OQ-R1:** Score range/branding — FICO-familiar 300–850, or a native 0–1000? Level names (Audit/Assist/Automate vs Provisional/Established/Trusted/Elite)?
- **OQ-R2:** Smart-contract scope — do we build/audit `FrontierCreditRegistry` + staking on Base ourselves, or lean on EAS + ERC-8004 contracts and only deploy the staking piece? (Less custom Solidity = less audit risk.)
- **OQ-R3:** $INSTACLAW token status — is the token live with a known address + supply? Staking/burn needs it. Probation window length + breach thresholds (need numbers).
- **OQ-R4:** Third-party trust-staking (a prediction market on agent trustworthiness) — v2, or never? (Powerful but griefing/complexity risk.)
- **OQ-R5:** Oracle trust — the score oracle is an InstaClaw-signed write. Acceptable as "InstaClaw is the bureau," or do we want a more decentralized attestation (multiple attesters) for the public-good framing?
- **OQ-R6:** Burn optics/legal — burning a user's staked tokens on agent misbehavior needs crisp, fair, pre-disclosed conditions (ToS) + an appeal path. Confirm posture.

---

## §8 — AUDIT NOTES (deep-research + 5-round adversarial pass, 2026-06-02)

Read end-to-end as a stranger, a competitor, and a demanding investor. Fresh research sweep + five thinking rounds. What changed and why.

### §8.0 — Research deltas (things I missed the first time)
- **a16z (Apr 2026): identity, not intelligence, is the bottleneck — and they named "Know Your Agent" (KYA).** Their described missing primitive (signed credentials linking agent → principal, permissions, constraints, reputation) is *verbatim our architecture*. → Reframed §7.2: **we are the reference implementation of KYA.** Validation from the smartest room, not a me-too.
- **Experian launched "Agent Trust" (a credit bureau for agents).** The frame is real AND contested by an incumbent. → §7.2 now states our categorical edge: on-chain, composable (EAS/ERC-8004), sybil-resistant — vs their centralized/proprietary/off-chain.
- **Chainlink/MakerDAO: "any reputation oracle without cost-anchoring is sybil-fragile by design"; ~70% of DEX pools show wash trading.** This exposed the PRD's #1 structural hole — the score + earned budget were wash-tradeable by self-dealing. → Added **§7.3.1 (integrity: same-human exclusion, counterparty diversity, rep-weighting, cost-anchoring, anomaly freeze).** Non-negotiable.
- **Cloudflare/x402 are adding deferred payments + "credit lines to trusted agents."** Validated a genuine forward invention (§8.2): the ecosystem wants agent credit but has no trustworthy score to underwrite it. We have it.
- **Market is early: x402 ~$1.6M/month; Stripe/Tempo 34K txns/first-week.** Real but nascent → sharpens the demand-thinness fear (§8.5).

### §8.1 — Round 1: GAPS (structural) — and resolutions
1. **Wash trading / self-dealing** (critical). The whole reputation + budget + staking edifice was gameable. → **FIXED inline, §7.3.1.**
2. **"Good decision" was hand-waved** — the soft center of the earned-budget loop. → **FIXED inline, §7.3.2** (settled ∧ used ∧ undisputed ∧ not-self-dealt; honest that pure value-measurement is a frontier).
3. **Spend-side dispute/recourse** (paid-but-not-delivered). → **Added W27.**
4. **Cold-start** (new agent: low score → tiny budget → can't build history). → **Resolved §8.7** (fleet-graph priors seed the rolodex; staking can boost; graduated start is intentional, not a wall).
5. **User journeys unmapped.** → **Added §8.7** (human journey + agent journey).
6. **Privacy** — public on-chain profile tied to a verified human. → **Resolved §8.7** (pseudonymity: the on-chain identity is the agent wallet + score; World ID proves *uniqueness without revealing the human*; the human is never doxxed by the score).

### §8.2 — Round 2: INVENTIONS (authentic — only what's genuinely new)
The two prior inventions (earned budget, sybil-resistant rolodex) stand. Honest assessment: most audit additions are *fixes and frames*, not new mechanisms — except one, which the research independently validated as a direction nobody can execute:

> **Invention 3 — Reputation-underwritten agent credit (deferred settlement / agent credit lines).** Cloudflare + x402 are building deferred-payment rails and musing about "credit lines to trusted agents," but **no one has a sybil-resistant score to underwrite them.** We do. A high-standing InstaClaw agent can transact on **net terms** (pay-after-delivery) or draw a **small credit line** — underwritten by its on-chain score, with the World-ID human as ultimate recourse. This is genuinely new (credit requires trustworthy underwriting; trustworthy underwriting requires sybil resistance; sybil resistance requires World ID — only we close the loop) and it *composes the entire system*: identity → receipts → score → credit → more economic capability. → **Added as Phase 5 / W28** (forward; not near-term, but named and reserved).

I considered and *rejected* padding with: tradeable rolodexes (the fleet graph already socializes this for free), fleet bulk-purchasing (real but a distraction now), agent-to-agent lending markets (Invention 3 covers the credit primitive more cleanly). Naming three real inventions is better than ten filler ones.

### §8.3 — Round 3: TASTE (elegance / merges)
- **Merged the earned-budget engine and the FICO score engine into one `lib/frontier-standing.ts`** (C2; W18→W1). They were always the same computation over the same track record — one *truth* (the agent's standing) with two *projections* (internal budget, external score). The system now feels more inevitable: there is one credit-standing engine, and autonomy + reputation fall out of it. **Applied inline.**
- **Unifying principle (noted, not over-merged):** the fleet supplier graph (W10, "which sellers are good") and the agent credit registry (W19, "which agents are good") are one reputation substrate queried in two directions (buyers rate sellers; the network rates agents). Kept as two tables (different shapes) but one conceptual graph — over-merging would hurt clarity.
- Nothing removed — every component maps to a work item, and the merge reduced the count.

### §8.4 — Round 4: THE PITCH (60s)
The "credit bureau" frame is strong but reputation-only, and Experian now says it too. **Upgraded frame (applied §7.2): InstaClaw agents are the first that are autonomous AND accountable — the reference implementation of "Know Your Agent" + the only sybil-resistant credit bureau.**
> *60s:* "The agent economy's bottleneck isn't intelligence — a16z says it's identity. We solved identity: every InstaClaw agent is bonded to a World-ID-verified human, spends within a budget it *earned* through good decisions, and carries an on-chain credit score built from real receipts — readable by anyone in one RPC call. So our agents are the first you can actually trust with money: autonomous, but accountable. We're the KYA layer and the credit bureau for the agent economy — on-chain, composable, sybil-resistant. Nobody else has the verified human, so nobody else can build trust that can't be faked."
This survives Vitalik (public good, on-chain, composable), Sam (the autonomy+accountability tension is the real product), and the Coinbase x402 team (we're the trust layer atop their rail, and we *settle through CDP*, so we feed their Bazaar).

### §8.5 — Round 5: WHAT SCARES ME (brutally honest)
1. **The "value-delivered" measurement is the soft underbelly.** §7.3.2's four proxies (settled ∧ used ∧ undisputed ∧ not-self-dealt) are defensible but imperfect — "used" is the hardest to measure honestly, and if it's weak, the earned-budget loop rewards busywork. This is the assumption most likely to be wrong, and it's central. Mitigation: start conservative (budget grows slowly), lean on human refund/complaint as the strongest signal, iterate.
2. **Wash trading is an arms race, not a one-time fix.** §7.3.1 raises the cost a lot, but sophisticated colluders across *distinct* humans (real sybil rings of real people) can still slowly farm. World ID is our best defense; it's not perfect. We must monitor + treat the score as adversarial forever.
3. **Demand-side thinness — the scariest product risk.** x402 is only ~$1.6M/month industry-wide; a normal user's agent may rarely hit a capability gap that an x402 endpoint fills (its skills + the LLM cover most tasks). The viral "212 purchases this month" feed assumes heavy autonomous buying that **may not occur naturally.** If true, the economy is a beautiful machine with little to do. Mitigation: the **earn side + intra-fleet A2A** may be what *creates* demand (agents hiring each other), which argues for pulling Phase 4 earlier than its slot. Flagging this as the thing most likely to make the whole vision underwhelm — worth a hard conversation before Phase 1 even.
4. **Phase 3c (smart contracts + $INSTACLAW token + burn) carries the most external risk:** token status unknown (OQ-R3), audits are weeks + real money, and **burning a user's staked tokens has genuine legal/regulatory exposure** (OQ-R6). This phase could 3x slip and is the one I'd most want to de-risk by leaning on EAS/ERC-8004 rather than custom Solidity (OQ-R2).
5. **Regulatory: agents moving real money at scale** invites money-transmission/KYC questions. The World-ID-human-accountable framing helps, but this is unbudgeted risk.
6. **gbrain durability (Rule 35):** the rolodex moat lives in `brain.pglite`, which version bumps wipe. Until upstream `snapshot_brain` ships, the moat is fragile — mitigated by mirroring critical rolodex stats to the fleet graph (W10) so memory is reconstructable.

### §8.6 — Changelog (this pass)
- **Inline:** §7.2 frame upgrade (KYA / autonomous+accountable / vs Experian); §7.3.1 wash-trade integrity (NEW, critical); §7.3.2 good-decision definition (NEW, critical); C2 + W1 merged into `frontier-standing` engine; W18 marked merged; **W27** added (spend dispute/recourse).
- **New forward phase:** **Phase 5 — Reputation-underwritten agent credit / deferred settlement (W28)** — the score underwrites x402 credit lines. Gated on Phases 1–3; named + reserved.
- **New §8.7** below: cold-start, user journeys, privacy posture.
- **New open questions:** demand-validation (the §8.5#3 risk) should be answered *before* Phase 1 — recommend a 1-week measurement of how often real fleet agents actually hit x402-fillable gaps. Possible reorder: pull A2A/earn (Phase 4) earlier if spend demand is thin.

### §8.7 — Gap fills: journeys, cold-start, privacy
**Human journey:** enable autonomous spend (opt-in, the "mandate") → set/accept a starting budget + category allowlist → watch the Agent Economy feed → tap to boost/cut budget → (optional) stake $INSTACLAW to signal confidence → see the credit score climb. Every step is consent + visibility — "more autonomy requires more visibility" as literal UX.
**Agent journey:** day 1 — low score, $0.10/day, empty personal rolodex but **inherits fleet-graph priors** (knows the fleet's best suppliers immediately) → makes small good decisions → standing rises → budget + score climb → builds its own rolodex on top of the fleet priors → unlocks Assist then Automate. Cold-start is a *feature* (graduated trust), de-frictioned by fleet priors + optional staking — not a wall.
**Privacy posture:** the on-chain identity is the **agent's wallet + score**, never the human's real identity. World ID proves the operator is a *unique human* via a nullifier **without revealing who they are** (that is World ID's entire design). The score + receipts are public (the point — composable trust), but the human stays pseudonymous. Dashboard credit profiles are private-by-default; the shareable card is opt-in. This must be stated in product copy so "public credit score" never reads as "my spending is doxxed."
