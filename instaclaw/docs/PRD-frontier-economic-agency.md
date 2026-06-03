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
| C2 | **Credit-standing engine** — one truth, two projections: internal **earned budget** (autonomy governor) + external **on-chain score** (public trust). Merges the old budget + FICO engines (taste fix §8) | `lib/frontier-standing.ts` | **BUILT — canary-proven** (W1; subsumes W18) |
| C3 | Supplier rolodex + Thompson-sampling selection | `lib/frontier-rolodex.ts` | **BUILT — canary-proven** (W2; wired into the spend skill, `--capability` selection live-verified) |
| C4 | Category allowlist (policy dimension) | `lib/frontier-policy.ts` ext | **BUILT** (W3) |
| C5 | Spend authorize gate (real-time) | `app/api/agent-economy/authorize` | **BUILT — canary-proven** (W4; W11 gate matrix 6/6 live) |
| C6 | Spend settle / outcome | `app/api/agent-economy/settle` | **BUILT — canary-proven** (W5; incl. W27 dispute outcome) |
| C7 | Transaction ledger | `frontier_transactions` table | **DONE** (Phase 1A) |
| C8 | Spend skill — "hire a specialist" | VM skill — `frontier-spend.mjs` (+ `frontier-spend-core.mjs`); built as `frontier-spend` (PRD originally specced `frontier-hire`) | **BUILT — canary-proven** (W6; real on-chain spend `0x530cab7e`) |
| C9 | gbrain economic memory (supplier index + purchase log) | gbrain MCP + helpers (`frontier-spend-core.mjs`) | **BUILT** (W7; supplier index + W7b purchase log) |
| C10 | Rule 28 directive | SOUL.md section (`workspace-templates-v2.ts`) | **BUILT** (W8) |
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
| C21 | Spend kill switch — instant fleet-wide halt of autonomous spend, no deploy (DB flag in `instaclaw_admin_settings`, fail-open) | `lib/frontier-kill-switch.ts` (`isFrontierSpendKilled`) + `authorize` route | **BUILT — live-verified** (flip→deny→release on canary) |
| C22 | Write-once capture — supplier delivery latency + failure reason, persisted at settle (feeds W10 p50_latency + spend-health drill-down) | `frontier-spend.mjs` + `settle` route (`latency_ms`, `pay_error`) | **BUILT — live-verified** |
| C23 | Atomic reserve RPC — TOCTOU fix; per-VM advisory lock re-sums committed spend under lock before reserving (P1-4) | `frontier_reserve_spend()` (`supabase/migrations/`) | **BUILT — applied in prod** |
| C24 | Spend-health alerting cron — fleet-aggregate failure-spike + stuck-hold detection, 6h-deduped (P2-6) | `app/api/cron/frontier-spend-health` | **BUILT — live-verified (`?dryRun`)** |
| C25 | Canary proof harness — re-runnable earned-budget gate matrix incl. hard-ceiling-binds-over-human invariant (W11) | `scripts/_canary-frontier-proof.ts` | **BUILT — 6/6 live** |
| C26 | Standing-truncation flag — flags approximate standing when the ledger scan caps (P2-8) | `authorize` route (`standing_truncated`) | **BUILT** |
| C27 | **Autonomous-spend opt-in** — user-owned, default-OFF, fail-closed switch; the §8.7 "mandate". Gate denies `spend_not_enabled` unless the owner explicitly enabled spend for the agent. Prerequisite that makes W12 safe (no agent spends by default) | `instaclaw_vms.frontier_spend_enabled` + `lib/frontier-spend-optin.ts` (`isFrontierSpendEnabled`) + `authorize` route | **BUILT (gate + flag + migration)** — migration in `pending_migrations/` (Rule 56); settings-UI toggle is a follow-up |

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
| **Phase 1 — Spend agency** ✅ BUILT + CANARY-PROVEN | W1, W2, W3, W4, W5, W6, W7, W8, W11 | Earned-budget spend skill is the keystone invention + immediate "agent stops saying I can't"; safest place to prove judgment; foundation both sides share | **canary proof (W11) ✓ DONE — 6/6 live**; now gated on Cooper greenlight + §5 policy decisions to begin W12 (fleet rollout) |
| **Phase 2 — Fleet + feed** | W9, W12, W13, W14 | Roll spend to the fleet (Rule 64) + ship the viral dashboard feed; W10 graph starts accruing real data | Phase 1 green; Rule 64 approval |
| **Phase 3 — Reputation (the credit bureau)** | W10 (fleet graph) + §7: **3a** off-chain score + dashboard profile (W18, W26, W23) → **3b** on-chain registry/oracle + EAS/ERC-8004 (W19, W20, W25) → **3c** $INSTACLAW staking + burn (W21, W22, W24) | The moat + the talked-about product. 3a is the safe dashboard win (visible "agent credit score," zero contract risk); 3b makes it a composable public good; 3c adds the staking economy (highest external risk last). W10/W18 accrue data from Phase 2 onward | research §7 done; Cooper greenlight; 3c gated on $INSTACLAW token + audits |
| **Phase 4 — Earn side** | W15, W16, W17 | The differentiator (agent earns a living); inherits the identity + reputation from Phases 1–3 (sellers are trustworthy *because* they carry a sybil-resistant score) | Phases 1–3 patterns proven |

Dependency note: Phase 1 is mostly independent pure-logic + backend (no fleet risk). Phase 2 is the first fleet-mutating step (Rule 64). Phase 3's graph (W10) should begin accruing data the moment Phase 2 ships (settle outcomes), even if scoring hardens later. Phase 4 is gated on the identity/reputation being real so sellers are trustworthy.

**Status (2026-06-03):** Phase 0 = done. **Phase 1 = code-complete and canary-proven** (W1–W8, W11 all built; W11 harness passes 6/6 live; full suite 422 passing; see §6 + §2 registry C2–C10, C21–C26). Phase 1 has cleared the canary gate; it awaits **Cooper greenlight + the §5 policy decisions** to begin **W12 (fleet rollout, the first Phase-2 step) — W12 is NOT done.** The new spend skill is canary-only until W12's manifest version bump carries it fleet-wide. Phases 3–4 and the §9 card rail remain future/not-started.

#### W12 — DEFERRED BY CHOICE (not blocked); greenlight checklist for when it's time

Phase 1 (built + canary-proven) is a complete, stable resting point. W12 — the fleet rollout of the spend skill — is deliberately **not now**, and there is **no clock on it.** Turning on real autonomous spend across the ~50 paying-customer fleet is a "calm moment, watched carefully" action that happens on Cooper's timeline, never rushed at the end of a session. It is correctly a back-of-mind item — *deferred, not blocked, not forgotten.*

**Why it waits:** W12 is the **irreversible, fleet-mutating step (Rule 64)** — it turns on real-money autonomous spend on real customer VMs. It should follow the §5 policy decisions that govern what agents actually *do* once spend is live: **Q1 funding model, Q2 starting budget / growth curve, Q3 `ask_first` UX, Q4 category taxonomy.** Rolling out before those are decided would mean real agents spending real money under unconfirmed policy.

**Preconditions to resolve before greenlighting (run this checklist):**
1. **§5 policy decisions made** — **Q2 (budget/curve) ✅ DECIDED+BUILT, Q4 (categories) ✅ DECIDED+BUILT (2026-06-03).** Remaining: **Q1 (funding model — Cooper's money call)** and **Q3 (the no-ask dollar line — Cooper's risk confirm; recommendation: keep $1/$5/$20).** Those two are the only §5 items still gating W12.
2. **Cooper greenlight (Rule 64)** — manifest version bumps require explicit approval; this is a fleet-mutating publish.
3. **Canary-first on vm-1019** — per Rule 64, validate the manifest bump on vm-1019 before the fleet. (The spend *logic* is already canary-proven on vm-1075; vm-1019 is the manifest/config canary.)
4. **Kill switch (C21) confirmed armed as the rollback lever** — `lib/frontier-kill-switch.ts` `isFrontierSpendKilled`, backed by the `instaclaw_admin_settings.frontier_spend_kill_switch` flag. Confirm it halts all autonomous spend fleet-wide instantly (no deploy) before relying on it as the stop-the-bleeding lever.
5. **Current fleet inconsistency understood** — today the canary (vm-1075) has the new spend skill; fleet VMs have it **absent or stale** (`frontier-spend.mjs` ships only via `stepSkills` on a cv-gated reconcile). The version bump is precisely what makes the fleet consistent — that consistency is the *point* of the rollout, not a separate fix.

**The bump IS the rollout (one action, not two):** `VM_MANIFEST.version 128 → 129` re-enters all cv-current VMs into the reconcile candidate set; `stepSkills` then carries the `extraSkillFiles` (`frontier-spend.mjs` + `frontier-spend-core.mjs` — the write-once/dispute/rolodex versions) to every VM, alongside the W8 SOUL directive. There is no separate "deploy the skill" step — **the manifest version bump is the rollout mechanism.**

---

## §5 — OPEN QUESTIONS (need Cooper / external)

1. **Wallet funding model. ⏳ OPEN — Cooper's money call.** Who funds the agent's wallet for spend. The manual path already works (the /economy wallet card shows the real Bankr address; send USDC on Base). **Recommendation (hard, but "open the company wallet" is Cooper's yes):** a small platform-sponsored seed at the moment the user flips the opt-in — only engaged users, and it must clear the starter drain floor to be useful. The starter `minWalletBalance` is **$2**, so a $1 seed is inert (can't spend below the floor); a **~$5 seed** gives ~$3 of headroom for real autonomous spend. **Per-agent cost $5; fleet cost = $5 × (opted-in count)** — realistically $50–250, not $5×150, since it's gated on opt-in. NOT built (no code spends company money); flagged for Cooper.
2. **Starting budget / growth curve. ✅ DECIDED (2026-06-03) — keep as-is.** Already implemented in `lib/frontier-standing.ts` + `lib/frontier-policy.ts:DEFAULT_BANDS_BY_TIER`. Floor `$0.10/day`, `sat(goodDecisions, 50)` growth, level ceilings (audit 0.2 / assist 0.6 / automate 1.0) × tier band. Bands (starter `$1/tx·$5/day` no-ask → `$10/$25` hard cap; pro `$5/$25→$50/$200`; power `$20/$100→$200/$1000`) validated against real service costs (search ~$0.003, inference ~$0.001–0.01, media ~$0.01–0.04, A2A ~$0.10–5) — well-calibrated, kept. The real build was the **gate-read wiring**: the authorize route passed `overrides: null` (a latent lie — `/policy` PUT accepted band overrides the gate ignored); now reads them via the canonical `lib/frontier-overrides-db.readPolicyOverrides`.
3. **`ask_first` line. ✅ DECIDED — keep $1/$5/$20 per-tx, flagged for Cooper's risk confirm.** The no-ask threshold = `justDoItPerTx` ($1 starter / $5 pro / $20 power), further gated by earned budget (a new agent effectively asks for everything until it ramps from the $0.10/day floor). Recommendation: keep — a $1 autonomous starter purchase is low-stakes and earned-gated. **Risk-tolerance confirm is Cooper's** (the specific no-ask dollar line). The mechanism (Telegram-style ask) is the existing 👍/👎 flow.
4. **Category taxonomy. ✅ DECIDED + BUILT (2026-06-03).** Our own 8-category taxonomy (`data/search/inference/compute/market/media/agent/other`) — kept. **Allowlist, not denylist**; `market` (trading) excluded from every tier default — opt-in only. Per-VM override is **TIGHTEN-ONLY** (`lib/frontier-policy.ts:effectiveAllowedCategories` = tierDefault ∩ override): a user can remove categories but can NEVER widen into a category above their tier — in particular `market` can never be enabled via the dashboard (deliberate — widening into trading is a deferred, explicitly-gated risk feature). Storage: `frontier_policy_overrides.allowed_categories text[]` (migration `20260603220000`). Surfaced as checkboxes on /economy.
5. **Per-VM proxy secret rotation. ✅ DECIDED (2026-06-03) — reuse existing infra.** Scope clarified: this is the EARN-side x402 proxy secret (C14/W9, TO BUILD) — the spend path authenticates with the per-VM gateway token (`lookupVMByGatewayToken`), not a proxy secret, and that token already rotates via `resyncGatewayToken`. So no new rotation mechanism is needed: when W9 builds the per-VM proxy secret it slots into `SECRET_ENV_VAR_SOURCES` and inherits the canonical `SECRET_VERSION` distribution (the "rotating secrets" runbook in CLAUDE.md — bump `SECRET_VERSION`, the reconciler re-distributes to caught-up VMs via the OR'd `secret_version.lt` filter). **Cadence: on-demand (compromise/suspicion), no fixed calendar rotation** — per-VM secrets aren't a shared blast-radius, so scheduled rotation buys little. Decision: don't build a bespoke rotation path; reuse `SECRET_VERSION` when W9 lands.
6. **Staking ($INSTACLAW) multiplier. ✅ DECIDED — keep gated, do NOT proxy via credit standing.** The 2x is a CEILING multiplier (loosens caps). Granting it to high-standing agents as a staking proxy would **double-count the standing signal** — the earned daily budget already scales with standing (`levelCeilFrac` audit 0.2 / assist 0.6 / automate 1.0 in `frontier-standing.ts`). Staking is meant to be an ORTHOGONAL signal (skin-in-the-game / token alignment), independent of behavioral track record; conflating them over-loosens for already-trusted agents. Keep `isStaker: false` until $INSTACLAW staking is genuinely live, then wire it from the staking-contract read. No interim proxy.
7. **Dashboard ownership. ◑ EFFECTIVELY ANSWERED — this terminal; formal assignment is Cooper's.** This terminal built `/economy` (the page) + the spend-policy controls (the category editor + live limits display) on 2026-06-03 — it is now the de-facto owner of the Agent Economy dashboard surface (W13/W14). Recommendation: keep it here for continuity. Formal team assignment remains Cooper's coordination call, but the natural owner is established by what shipped.
8. **Earn-side legal/compliance. ⏳ FLAGGED — Cooper / counsel, not an engineering call.** Agents selling services for money raises money-transmission / KYC questions (echoed in §risk-register #5). The World-ID-human-accountable framing is our story; whether it's a sufficient posture before W15 is a legal judgment I can't make. No decision — hard flag for Cooper / counsel before any earn-side (W15+) work begins.
9. **gbrain economic-memory durability. ✅ DECIDED (2026-06-03) — the quantitative moat is Postgres-durable; gbrain layer is re-learnable.** Audited against the code: `frontier-rolodex.ts` states `SupplierStat` is *"the sufficient statistic — there is no separately-stored posterior to drift; it is recomputed from the ledger each selection (one source of truth)."* So the Thompson-sampling win/loss statistics that drive supplier selection are **re-derived from `frontier_transactions` (Postgres)**, NOT read from gbrain. A gbrain wipe therefore degrades but does NOT destroy the moat: lost are (a) the discovery index of suppliers seen-but-not-yet-transacted, and (b) the qualitative "was-it-useful" diary — both **re-learnable** as the agent transacts again; preserved is the hard win/loss record (durable in the ledger). **Decision:** economic-memory CORRECTNESS has no hard dependency on the upstream `snapshot_brain` tool — the ledger is the durability guarantee. `snapshot_brain` only preserves the convenience cache (faster cold-start, retained qualitative notes). The cross-agent FLEET prior (rolodex layer 2) is a separate shared store, not per-VM gbrain, and the W10 mirror remains the right plan for it. **This corrects the over-stated risk-register #6** (which claimed "the moat lives in brain.pglite") — see the reconciled line there.
10. **Reputation: on-chain vs off-chain** — resolved in §7 (Step 2 research).

> **W12 gating (updated 2026-06-03):** Q2 (budget/curve) and Q4 (categories) are now **DECIDED + BUILT** — bands kept as-is, the per-VM override is wired into the gate (closing the `overrides: null` lie), and the category override + dashboard control shipped on a preview branch. What still gates W12 is down to **two Cooper calls**: **Q1** (open the company wallet for a sponsored seed — money) and the **Q3 no-ask dollar line** (risk-tolerance confirm; recommendation: keep $1/$5/$20). Resolve those two before greenlighting — see the W12 deferral note + greenlight checklist in §4.

### §5.1 — Self-audit of the shipped §5 work + gaps the live feature exposes (2026-06-03)

**Self-audit verdict: CLEAN — no bugs found, no STOP required.** Re-audited the live policy work (gate wiring, `frontier-overrides-db.ts`, `effectiveAllowedCategories`, `/policy` GET/PUT, the dashboard control) with adversarial eyes. Evidence:

- **Branch composition on main is correct.** The opt-in branch and the policy-controls branch both touched `authorize/route.ts` and merged separately; verified on `origin/main` the order is kill-switch (329) → opt-in `spend_not_enabled` (341) → override read (418) → `evaluateSpend` (421), with `overrides: null` count = **0** (lie fully removed), exactly one opt-in gate + one `readPolicyOverrides` call (no duplication). The opt-in gate is BEFORE the override read, so an opted-out VM never pays for the extra DB read.
- **The column-absent fallback is NOT dead code now that the column exists.** `readPolicyOverrides` reads `allowed_categories` via `select("*")` + `Array.isArray` guard: the column is NULLABLE, so `null` (no override) is the common live path the guard handles; it also covers the PostgREST schema-cache-staleness window right after the ALTER, and rollback safety. Keep.
- **`/policy` PUT's `PGRST204` retry is a cold path now, not dead.** Fires only if the category column is missing (schema-cache lag immediately post-apply, or a rollback). Degrades to bands-only + `allowed_categories_persisted: false` instead of a 500. Keep.
- **Tighten-only edge cases all sound:** dedup (Set), `[]` → everything-off (denies categorized spend; uncategorized still `ask_first` via authz 2b — consistent), above-tier categories dropped, out-of-taxonomy strings inert. Verified by `_test-frontier-categories.ts` (14/14).
- **No gate ↔ /policy drift:** both compute effective values from the same canonical reader / same pure functions; PUT's response uses the validated request values which equal what the gate re-derives from storage.

**Gaps documented (none are bugs; ranked):**

- **GAP-1 (real, user-facing) — the earned daily budget has no UI surface.** `/economy` limits display shows the tier BAND ceiling (e.g. starter `$5/day no-ask`) but NOT the agent's CURRENT `earnedDailyBudgetUsd` (~$0.10/day for a new agent) — the actual binding autonomy number. `/api/agent-economy/state` returns `reputation_score` but not `earnedDailyBudgetUsd`. Copy mitigates ("a new agent starts well below these"), but the real number is invisible. **Fix (buildable now, no Cooper gate):** add `earnedDailyBudgetUsd` to `/state` and surface it on `/economy` as "what your agent can spend on its own today."
- **GAP-2 (control-with-no-UI) — per-band tightening exists in the API + gate but has no dashboard control.** `/policy` PUT accepts `justDoItPerTx`/`justDoItPerDay`/etc. (tighten-only, clamped) and the gate now honors them, but the dashboard only exposes the CATEGORY editor. **Fix (buildable now):** band-tightening sliders ("ask me before any single purchase over $X").
- **GAP-3 (observability) — no gate-decision distribution.** Nothing surfaces how often an agent hits `just_do_it` vs `ask_first` vs `deny` (or the deny reason breakdown). `/state` has `window_24h` transaction counts but no outcome breakdown. This is the data needed to TUNE the bands post-W12. **Fix:** record/aggregate authorize outcomes (a counter or a lightweight `frontier_authz_events` rollup) — defer until W12 produces real volume.
- **GAP-4 (test coverage) — the DB reader + route wiring are verified-by-inspection only.** `readPolicyOverrides` (snake→camel parse, `Array.isArray` guard, table/column-missing paths) and the `/policy` PUT category validation (route-level 400s) have no automated test; the authorize-route→gate wiring (route actually feeds the stored override) is integration-untested. Pure logic is 14/14. **Fix:** a fake-supabase unit test for `readPolicyOverrides` + a route-level test for the category PUT. → ops-followups.
- **GAP-5 (cosmetic) — PUT stores a redundant full-tier-default array when the user re-checks all boxes** instead of clearing to `null`. Functionally identical (effective result is the same), just stores redundant data. Optional optimization; not a bug.

**Cleanest next build (unblocked — needs neither Cooper call):** finish the `/economy` economic surface — **GAP-1 (earned-budget display) + GAP-2 (band sliders)** first (they complete the "see + control my agent's money" loop the live page half-delivers), then the **W13/W14 transaction feed** (the `/state` `recent[]` already returns the data; it just needs a view), then close **GAP-4** test coverage. All are doc/UI/test work with zero W12 / funding dependency, and each makes the already-live page more honest and complete. The two Cooper calls (Q1 funding, Q3 no-ask line) gate W12 (fleet rollout), not this dashboard work.

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

**Phase 1 — BUILT + CANARY-PROVEN (this session, 2026-06-03):** the keystone spend agency is code-complete and proven on the canary (vm-1075); **W11 harness passes 6/6 live**, including the hard-ceiling-binds-over-human-approval invariant. NOT yet rolled to the fleet — W12 (fleet rollout) is gated on Cooper greenlight + the §5 policy decisions (see §4).
- **W1 credit-standing engine** (`lib/frontier-standing.ts`) — earned budget + FICO-for-agents score, wash-trade integrity (same-human exclusion via `isSameHuman`, counterparty diversity, rep-weighting), good-decision definition. — C2.
- **W2 supplier rolodex** (`lib/frontier-rolodex.ts`) — Thompson sampling; wired into the spend skill via `--capability` (selection + cold-start live-verified). — C3.
- **W3 category allowlist** (`lib/frontier-policy.ts`) — taxonomy + per-tier defaults + tag→category mapping. — C4.
- **W4 authorize gate** (`app/api/agent-economy/authorize`) — real World-ID read, server-side wallet-balance read, atomic reserve (C23), kill-switch check (C21). — C5.
- **W5 settle** (`app/api/agent-economy/settle`) — CAS single-winner, immutable amount, idempotent terminal-state handling; **W27 dispute outcome** (`disputed` → supplier→avoid); write-once capture (C22). — C6.
- **W6 spend skill** (`frontier-spend.mjs` + `frontier-spend-core.mjs`) — probe→authorize→Bankr-sign→pay→settle→remember; rolodex-wired; real on-chain spend proven (`0x530cab7e`). — C8.
- **W7 gbrain economic memory** — supplier index + **W7b purchase log** (per-buy diary). — C9.
- **W8 Rule-28 SOUL directive** (`workspace-templates-v2.ts`) — earned-budget empowerment text. — C10.
- **W11 canary proof harness** (`scripts/_canary-frontier-proof.ts`) — C25.
- **Hardening (this session):** spend kill switch (C21), write-once latency+failure capture (C22), atomic reserve RPC / P1-4 (C23), spend-health alerting cron / P2-6 (C24), standing-truncation flag / P2-8 (C26). Full test suite: 422 passing.
- **Known fleet state:** the new `frontier-spend.mjs` (write-once + dispute + rolodex) is **canary-only**; it deploys via `stepSkills` (cv-gated `extraSkillFiles`), so it reaches the fleet only on a manifest version bump — i.e., **W12 carries it fleet-wide** (it is NOT there yet).

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
6. **gbrain durability (Rule 35) — RECONCILED 2026-06-03, less fragile than first written.** The earlier claim ("the rolodex moat lives in `brain.pglite`") over-stated the risk. Per `frontier-rolodex.ts`, the Thompson-sampling `SupplierStat` is the *sufficient statistic, recomputed from the `frontier_transactions` ledger each selection (one source of truth)* — so the quantitative win/loss moat is **Postgres-durable**, not gbrain-resident. A gbrain wipe loses only the re-learnable layer (discovery index of not-yet-transacted suppliers + the qualitative "useful?" diary), never the hard track record. So the moat degrades-and-relearns rather than vanishing. `snapshot_brain` (upstream) would preserve the convenience cache but is NOT required for moat correctness. The W10 fleet-graph mirror remains the right plan for the cross-agent prior (a separate shared store, not per-VM gbrain). See §5 Q9 for the full decision.

### §8.6 — Changelog (this pass)
- **Inline:** §7.2 frame upgrade (KYA / autonomous+accountable / vs Experian); §7.3.1 wash-trade integrity (NEW, critical); §7.3.2 good-decision definition (NEW, critical); C2 + W1 merged into `frontier-standing` engine; W18 marked merged; **W27** added (spend dispute/recourse).
- **New forward phase:** **Phase 5 — Reputation-underwritten agent credit / deferred settlement (W28)** — the score underwrites x402 credit lines. Gated on Phases 1–3; named + reserved.
- **New §8.7** below: cold-start, user journeys, privacy posture.
- **New open questions:** demand-validation (the §8.5#3 risk) should be answered *before* Phase 1 — recommend a 1-week measurement of how often real fleet agents actually hit x402-fillable gaps. Possible reorder: pull A2A/earn (Phase 4) earlier if spend demand is thin.

### §8.7 — Gap fills: journeys, cold-start, privacy
**Human journey:** enable autonomous spend (opt-in, the "mandate") → set/accept a starting budget + category allowlist → watch the Agent Economy feed → tap to boost/cut budget → (optional) stake $INSTACLAW to signal confidence → see the credit score climb. Every step is consent + visibility — "more autonomy requires more visibility" as literal UX.

> **Mandate — BUILT (2026-06-03, C27).** The "enable autonomous spend (opt-in)" step is now enforced in code: `instaclaw_vms.frontier_spend_enabled` (default OFF, fail-closed) gated FIRST in `authorize` (`deny: spend_not_enabled`). Until a user opts in, no agent spends — autonomous spend is no longer on-by-default, which is what makes a quiet W12 rollout safe (the rollout deploys the *capability*; this flag keeps it *dormant per agent* until the owner turns it on). **Still on the flag (follow-ups, not built):** the settings-UI toggle, and the per-user budget / category / `ask_first` choices (§5 Q1–Q4) — `frontier_spend_enabled` is the first field of what becomes per-agent spend preferences. The W8 SOUL directive is intentionally left unchanged: an un-opted-in agent that reaches for `frontier.spend` is denied and surfaces the feature to its human ("you can enable autonomous spend"), which is acceptable discovery UX; an optional one-line directive softening (frame the denial as a setting, not a failure) is a noted follow-up.
**Agent journey:** day 1 — low score, $0.10/day, empty personal rolodex but **inherits fleet-graph priors** (knows the fleet's best suppliers immediately) → makes small good decisions → standing rises → budget + score climb → builds its own rolodex on top of the fleet priors → unlocks Assist then Automate. Cold-start is a *feature* (graduated trust), de-frictioned by fleet priors + optional staking — not a wall.
**Privacy posture:** the on-chain identity is the **agent's wallet + score**, never the human's real identity. World ID proves the operator is a *unique human* via a nullifier **without revealing who they are** (that is World ID's entire design). The score + receipts are public (the point — composable trust), but the human stays pseudonymous. Dashboard credit profiles are private-by-default; the shareable card is opt-in. This must be stated in product copy so "public credit score" never reads as "my spending is doxxed."

---

## §9 — THE CARD RAIL (Frontier as a standalone economic-agency product)

**STATUS: FUTURE PHASE — researched and recommended, NOT started. Internal build-order is intentionally left open; we sequence cleanly when we begin. This section is the durable record of the decision and all its logic so nothing is re-derived later. Consolidates three card-rail research passes (2026-06-03): the Model A/B distinction, the deciding-fact doc evidence, the Rung-1 program-manager call, closed-loop prefunding, the two-rail product decision, and the write-once flags.**

### §9.1 — Thesis
For **Rail 1 (the agent's own card), per-swipe governance IS the product.** The headline is not "your agent has a card with a limit" (commodity — Crossmint, anyone). It is: *"your agent spends under a reputation brain that governs every transaction with dynamically-earned, standing-driven limits."* Combined with the earning wallet (x402 income) and the agency engine governing both sides, the agent becomes a **real economic actor — it earns and it spends, anywhere Visa is accepted (~150M merchants), under one governing brain carrying a portable, sybil-resistant reputation.** No competitor has all three. The card is what makes "real economic actor" literally true; x402 alone confines the agent to a machine-to-machine sandbox.

### §9.2 — Layer doctrine
Two layers, cleanly separated:
- **Agency engine** (earned-budget gate, standing, rolodex, dispute) — **ours, rail-agnostic.** Already built (Phase 1). It decides *whether / how much / to whom*.
- **The regulated card rail** (issuance, PCI L1 vaulting, network membership, BIN sponsor, KYC/KYB/AML, fraud) — **a commodity we rent from a NEUTRAL infrastructure processor, never from a product competitor.** Renting commodity plumbing (PCI/KYC/BIN/bank) from a utility is normal; routing our core IP's *execution path* through a competitor is not (see §9.6).

### §9.3 — The deciding fact (Model A vs Model B), with doc evidence
**Model A — static scoped-credential limits, network-enforced.** Confirmed from Crossmint's docs (`how-agents-pay`): spending rules are *"enforced at the network level via Visa VIC and Mastercard Agent Pay"*; each payment yields a *"secure one-time card number"* that *"only works within the spending rules."* Credentials are *"short-lived and merchant-scoped. Fetch fresh on each purchase."* There is **no real-time third-party authorization webhook** — no developer endpoint approves/declines a transaction live. Their docs TOC has enroll/save-card/create-virtual-card/register-agent/order-intents — **and no authorization-webhook page.** Our dynamic per-swipe gate **cannot run on Crossmint.**
**Model B — true per-swipe JIT authorization.** Confirmed from vendor docs:
- **Stripe Issuing:** `issuing_authorization.request` synchronous webhook → respond `{approved: true|false}`, **2-second** window, auto-decision on timeout.
- **Lithic Auth Stream Access (ASA):** HTTP POST at authorization with full transaction metadata → respond within **6 seconds**; static Auth Rules run *before* ASA (guardrails **and** dynamic decisioning).
**Conclusion: per-swipe governance is achievable only on Model B; it is structurally impossible on Crossmint.**

### §9.4 — Two-rail structure (both ship; the user chooses which they want)
**Rail 1 — the agent's OWN card (the moat product).** Model B on **Stripe Issuing (lead) / Lithic (fallback)**; **our gate governs every swipe** via the JIT hook; **closed-loop prefunded** from the earning wallet. This is where the thesis lives.
**Rail 2 — BRING YOUR OWN CARD (the convenience option).** The user connects their existing personal card; the agent spends on the user's real card; the user keeps their rewards. Model A via **Crossmint** (their VIC / Mastercard-Agent-Pay tokenization + MiCA coverage). The per-swipe-gate loss is acceptable here because **BYO on someone's existing card can't be live-gated by anyone** — the networks enforce scoped credentials, full stop. **But governance is not zero on Rail 2:** Crossmint mints a *fresh scoped credential per purchase*, so if our backend brokers each mint we set a **dynamic, standing-derived cap per purchase intent** (`maxAmount` + period + merchant scope; `maxAmount` carries `value`/`currency`/`period` e.g. `"monthly"`, plus `frequency` and merchant/MCC scoping). Net: Rail 2 is **"standing-driven scoped caps, re-derived at each purchase, network-enforced"** — coarse governance that still uses the moat, just below per-swipe fidelity. (Research note: building BYO ourselves without Crossmint = becoming a vetted Visa-Intelligent-Commerce / Mastercard-Agent-Pay network partner — KYA vetting, network certification via key registration, GA still rolling out — *plus* a MiCA/KYC/AML regulatory wrapper. Months-to-quarters, partnership-gated; not weeks/SDK. Crossmint for Rail 2 is the right rent.)

### §9.5 — Rung-1 framing (we are NOT the bank)
Program-manager-on-a-neutral-processor delivers the **full moat**: sponsor bank (e.g., Celtic) is **issuer of record**; the processor (Stripe/Lithic) is **BIN sponsor + processor + PCI**; **we are the program manager + the authorization brain.** We never touch card numbers, never settle with merchants, never hold network membership. Per-swipe governance is **fully achieved at this rung** — Stripe-processor-only already puts us here. **Deeper rail-ownership** (direct bank program, network membership, our own licenses) does **not** improve the product; it only changes *economics* (interchange margin) and *independence*. It is a **later, volume-justified graduation, not a launch decision** — and at pre-scale it makes public-scale compliance *harder*, not easier. A clean migration path exists *because* Rung 1 already makes us the program manager.

### §9.6 — Why NOT Crossmint for Rail 1 (both gates fail)
1. **Technical:** no live authorization hook (§9.3) — the per-swipe gate, our entire product, cannot run on it.
2. **Strategic:** Crossmint is actively installing a competing payments skill on **OpenClaw, our own substrate.** Running Rail 1's auth pipe through them would put a competitor in the execution path of our headline IP — able to see our flow, price/throttle/deprecate the pipe, and bundle their own governance to disintermediate us. **Commodity layers from a neutral utility = fine; the auth pipe from a direct competitor = a structural vulnerability.** Both gates fail; the Rail-1 Crossmint hybrid is a trap.

### §9.7 — Why Crossmint IS right for Rail 2
BYO tokenization of a user's existing card (keep-your-rewards) + MiCA/KYC/AML coverage is **exactly what Crossmint is best at and what we'd otherwise rebuild a company to do** (§9.4 research note). The per-swipe gate isn't achievable on BYO by *anyone* (§9.4), so we give up nothing we could have had. Competitor-dependency is **lighter here** because BYO is explicitly the *convenience* option, not the moat surface — if Crossmint ever turned hostile, Rail 1 (our actual product) is unaffected.

### §9.8 — The closed-loop prefunding advantage (Rail 1)
The agent's **earning wallet (x402 USDC income) prefunds the card balance**: earn → fund card → spend under the gate → settle. A structural advantage no generic card product has:
- **Zero external credit risk** — the agent can only spend money already on deposit; NSF is impossible by construction.
- **"Strangers' agents spend real money" becomes safe-by-construction** — the gate declines beyond the prefunded balance, on top of the standing/earned-budget gate.
- **It makes conservative sponsor-bank approval far more likely** — a prefunded, closed-loop, no-credit-exposure program is the easiest version of a novel "autonomous AI spend" risk category for a bank to underwrite.

### §9.9 — Public-scale risk surface
A public "anyone signs up" product inherits: signup KYC/KYB, fraud (stolen funding, bust-out), chargebacks (merchant + friendly fraud), treasury/funding reconciliation, and **the sponsor bank's audit/oversight of our program** (the bank holds liability and can shut us down). **Stripe Issuing survives this cleanest** — Stripe + sponsor bank provide multi-tenant onboarding/KYC (Connect), fraud tooling (Radar for Issuing), chargeback handling, and bank relationships proven across thousands of platforms onboarding the public. Building deeper makes this *worse* until we're large (we'd own more of the BSA/AML/fraud burden directly). Our **dispute logic (W27) + standing are themselves a differentiated fraud control**: a high-chargeback agent's standing tanks → autonomy shrinks → spend throttles.

### §9.10 — Funding model
**Prefunded stored-value, never credit, at public scale.** The user (or the agent's earnings) funds a balance held in the program funding account (Stripe Treasury / sponsor-bank FBO); we reconcile per-agent sub-balances in our ledger. For the user-funded path, **top-up can charge the user's existing Stripe payment method — we already hold it for the InstaClaw subscription, a single-vendor flow** (this extends and resolves §5 Q1, the wallet-funding open question, for the card case). **Prefer non-reversible funding rails (USDC / instant debit)** over ACH/card top-ups that can reverse weeks later — and the earning wallet (USDC) is exactly such a rail, closing the loop with no reversible payment method in the critical path. Hold a **reserve against chargeback liability** (standard program-manager practice), sized by aggregate spend. NSF cannot occur (can't spend what isn't deposited); chargebacks flow through the issuer with the program reserve as backstop.

### §9.11 — Scope-staging (stage by SCOPE, never by model)
1. **Stage 1 — private fleet (our own vetted InstaClaw users), Rail 1 on Stripe + gate + closed-loop USDC prefunding.** Low compliance risk; proves the per-swipe gate, funding loop, chargeback handling, and the auth hot-path; builds the sponsor-bank track record.
2. **Stage 2 — public standalone Frontier**: add public KYC/KYB onboarding + reserve; same architecture, widened audience; introduce Rail 2 (BYO/Crossmint) as the user-chosen alternative.
3. **Stage 3 (optional, volume-justified)** — graduate toward deeper rail-ownership for interchange/independence; clean migration *because Stage 1 already made us the program manager*.
**Explicit trap to avoid: launching Rail 1 on Crossmint "to validate demand" is wrong on three counts** — the per-swipe gate doesn't exist there (you'd validate the *wrong* product), you'd teach the market "Frontier ≈ Crossmint," and migrating Model A → Model B is a full re-architecture of the core. Stage by scope inside the right (Model B) architecture from day one.

### §9.12 — Stripe vs Lithic fork
**Lead Stripe Issuing** — the public product's hardest problem is onboarding/KYC/funding/compliance-at-scale, where Stripe's Connect + Treasury + Radar + proven platform-scale program is cleanest, plus we already run InstaClaw billing on Stripe (funding synergy). **Lithic ASA is the strong fallback.** **The single deciding diligence input: the gate's real per-swipe hot-path latency.** If standing + reserve computation can't reliably fit Stripe's **2s** window, Lithic's **6s** ASA window (and decisioning-native design) wins. Measurable, not a guess.

### §9.13 — Integration architecture (rail #2 under the same gate)
The card flow **inverts** x402 (merchant-initiated) but **reuses the same brain**: processor real-time-auth webhook → **reuse `decideAuthorization`** (evaluateSpend ∧ earned-budget ∧ standing ∧ category) within the auth window (≤2s Stripe / ≤6s Lithic, see §9.12) → approve+fund / decline → settlement webhook → ledger row `rail='card'` → standing/rolodex/dispute update. New: `mapMccToCategory` (the card analog of `mapTagsToCategory`), **merchant-as-counterparty** in the rolodex, a **lean gate hot-path** sized to the latency window. The shipped **kill switch (`isFrontierSpendKilled`) gates the card-auth webhook too** — instant fleet-wide card-spend halt. The `rail='card'` enum value already exists in `frontier_transactions` and `RAILS`; the gate itself needs no change — only new state and the inverted (auth-webhook) entry point.

### §9.14 — First real card use case
x402 covers machine-to-machine (APIs, data, compute, A2A). The **first card use case is a real-world merchant purchase**, and the obvious anchor is already adjacent: **StableTravel booking a flight/hotel** — airlines/OTAs take Visa, not x402. This reshapes the design in ways the x402 path never forced: **(1) High value, not micro** — a flight is $100s–$1000s vs x402's $0.001–$0.05, so the per-tx/per-day ceilings and the `ask_first`/human-approved flow become the *primary* path, not the exception (an $800 flight on a starter agent is almost always `ask_first`); this is where graduated autonomy earns its keep. **(2) Funding is real** — an $800 auth needs a funded card (§9.10), not a micro-USDC draw. **(3) Real disputes/chargebacks** — merchant disputes become network chargebacks (real money, real recourse), making the dispute path (W27) financially load-bearing and the World-ID-human-as-recourse story concrete.

### §9.15 — Future UI/UX surface: the funding / wallet / cards management page (REQUIREMENT, not a spec to build now)
A first-class **"funding / wallet / cards" management page** where a user manages: their agent's funding (top-up, balance, earnings inflow), the agent's own card (Rail 1), and their connected BYO card (Rail 2) — and **chooses which rail(s) they want.** This is the user-facing home for the entire card capability; **UX quality here matters disproportionately** — it's where trust in "my agent spends my money" is won or lost. Flagged as a placeholder requirement; full spec deferred to phase start.

### §9.16 — Write-once schema flags (immutable from the first swipe; also regulatory audit evidence)
Model B makes the **per-swipe authorization decision the write-once record** — and at public scale it is *regulatory evidence* (the sponsor bank will audit our controls), so it must be a complete, immutable audit log from swipe #1:
- **`frontier_cards`** (mutable registry, listed here for completeness) — agent ↔ processor card token ↔ cardholder ↔ funding source ↔ status. The card object itself.
- **`frontier_card_auths`** (immutable) — per `authorization.request`/ASA: inputs (amount, MCC, merchant, card token, timestamp) **+ our gate's decision + reason + standing/earned-budget snapshot at that instant.** Needed to show *why the gate approved* a later-disputed transaction (fraud forensics + bank audit). Unrecoverable if not captured live.
- **`frontier_card_funding`** (immutable) — every top-up: source, amount, rail, **reversibility class** (non-reversible USDC vs reversible ACH), running per-agent sub-balance.
- **`frontier_cardholders`** — legal cardholder per signup (the user) + KYC reference id (the reference, not the PII).
- **auth_id ↔ settlement_id ↔ chargeback_id linkage**; **authorized-vs-settled amount** (card auths settle for different amounts — tips, partial captures, FX).

### §9.17 — Open decisions for Cooper
1. **Stripe vs Lithic** — pending the gate hot-path latency measurement (2s vs 6s).
2. **Cardholder KYC posture** — is the legal cardholder the user, or InstaClaw as program manager issuing to the user? (Affects KYC flow + liability.)
3. **Sponsor-bank/network approval for an autonomous-agent-spend program** — the real timeline gate (mitigated by closed-loop prefunding, §9.8).
4. **US-first vs EU** — Rail 1 US-first on Stripe; Rail 2/Crossmint's MiCA coverage is the EU on-ramp.

### §9.18 — Next concrete step (entry action WHEN this phase begins — not now)
A **two-part diligence spike, no production code:** (a) **measure the gate's per-swipe hot-path latency** (cold authorize → decision, p99, with standing + reserve reads) against the 2s Stripe / 6s Lithic budgets; and (b) a **sponsor-bank/network program-approval conversation** for an *autonomous-agent-spend, prefunded, closed-loop* program (Stripe's bank and Lithic's, in parallel). Those two answers pick the vendor and de-risk the phase; program approval (not the integration) is the real timeline gate.
