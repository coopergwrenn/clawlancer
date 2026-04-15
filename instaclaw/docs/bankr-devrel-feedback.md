# Bankr Partner Integration — Dev Notes & Feedback

**From:** Cooper Wrenn (InstaClaw)  
**For:** Igor Yuzovitsky, Sinaver, Bankr DevRel  
**Started:** 2026-04-09  
**Status:** Actively integrating — updating as we go

---

## Context

InstaClaw is a hosted AI agent platform (~193 agents). Each user gets a dedicated VM running an OpenClaw gateway. We're integrating Bankr to auto-provision wallets at deploy, enable one-click tokenization, and build a self-sustaining compute loop where trading fees fund agent inference.

---

## Status (2026-04-10): Ready to Ship — 3 Blockers

✅ Wallet provisioning live and verified
✅ Token launch wired and verified in simulation mode
✅ Partner share confirmed routing to our fee wallet
✅ Webhook endpoint built and waiting for Bankr's spec

❌ **3 questions need answers before we flip `simulateOnly` to false:**

1. **Wallet roles clarification.** The docs reference an "org wallet" (for funding provisioned wallets), a "deployment wallet" (for signing token launches with partner key), and a "fee wallet" (for receiving partner share of swap fees). Are these distinct wallets that need to be set up separately, or can they be the same wallet wearing three hats? Right now we have one address (`0x66eb...`) configured as both our Org Wallet and Fee Wallet — does that work for partner-key-signed token launches, or do we need a separate deployment wallet?

2. **`maxWallets` quota.** What's our current quota on the test org, and what's the path to production limits? We're scaling and want to request a bump before we hit it.

3. **Rate limit conflict in the docs.** Token-launching page says "1 deploy/min, 20 deploys/24h per fee recipient." Partner-api page says "50 deploys/24h (100 for Bankr Club)." Which is authoritative? Each agent uses a different fee recipient (its own wallet) so the per-recipient cap rarely bites, but the global cap matters at scale.

---

## Partner Dashboard (bankr.bot/partner)

### Feedback
- Dashboard is clean and intuitive. Org setup, key generation, toggle controls all worked first try.
- Generated partner key with no IP whitelist (our API calls come from Vercel serverless — dynamic IPs).

### Questions
- Is the "Org Wallet" required before we can provision per-agent wallets via the API? Or is it org-level only (gas sponsorship, etc.)?
- What's the path from "test" org to production? Separate org, or does test get promoted?
- Solana Support toggle — if we enable this, do provisioned wallets automatically get Solana addresses alongside EVM?
- Gas Sponsorship toggle — would Bankr sponsor gas for our agents' on-chain transactions if enabled?

---

## Partner Provisioning API

### How We're Using It
- Wallet provisioned automatically during user onboarding (Stripe payment confirmed → VM assigned → `POST /partner/wallets` → configureOpenClaw)
- `idempotencyKey: "instaclaw_user_{userId}"` — one wallet per user, safe to retry
- `allowedIps: [vm_ip_address]` — locked to the agent's VM
- `permissions: { agentApiEnabled: true, llmGatewayEnabled: false, readOnly: false }`

### API Feedback
- [ ] **Idempotency 409 response:** Does the 409 body include the existing wallet data (id, evmAddress)? If not, we need a separate GET call on 409, which adds ~500ms to onboarding.
- [ ] **IP rotation:** If a user's VM gets reassigned (cancel + re-subscribe), the IP changes. Is there an API to update `allowedIps` on an existing wallet without revoking the API key?
- [ ] **Rate limit (10/min):** Fine for normal onboarding. If we ever need batch provisioning (50+ wallets), would appreciate a higher limit or burst allowance.
- [ ] **Key recovery:** If an API key is lost, is `POST /partner/wallets/:id/api-key` the recovery path? (generates new key, replaces old one)
- [x] **We encrypt API keys at rest** with AES-256-GCM. Plaintext only exists in memory during provisioning and on the agent VM's .env file. Each encryption uses a random IV so identical keys produce different ciphertext.
- [x] **First API call successful (2026-04-09):** `POST /partner/wallets` returned 201 with wallet ID, EVM address, and API key. Idempotency retry returned 200 (not 409 as spec says — 200 is actually better for us, no special error handling needed).
- [ ] **Address casing inconsistency:** First call returned EIP-55 checksummed address (`0xa3d1...1923C`), idempotency retry returned lowercase (`0xa3d1...1923c`). Minor but could trip up strict address comparisons. Suggestion: always return checksummed addresses for consistency.
- [ ] **Idea — partner wallet pre-provisioning:** We could pre-provision wallets for our VM ready pool (before a user signs up) using sequential idempotency keys, then assign them at signup. This would shave ~500ms off onboarding. Would this be a supported pattern, or should wallets only be created at user signup time?

---

## Token Launch API

### How We're Using It
- **Endpoint:** `POST /token-launches/deploy` (not under `/partner/*` namespace as we initially assumed)
- **Auth:** `X-Partner-Key` (org-level deploy — our org wallet signs and pays gas)
- **`feeRecipient`:** Set to each user's own Bankr wallet address — agents own their creator fees on-chain (decision 1a)
- **Partner share routing:** 18.05% goes automatically to our configured Fee Wallet in the Token Launch tab — no per-launch config needed
- **`simulateOnly: true`** for dev/staging — returns predicted token address without broadcasting, no gas needed
- **Atomic DB lock:** prevents race-condition double-launches via single UPDATE...WHERE...RETURNING pattern

### Simulated Launch Verified (2026-04-10)
First simulated launch returned `200 OK` with all expected fields:
- `tokenAddress`: predicted contract address
- `poolId`: Uniswap V4 pool ID
- `chain`: `base`
- `simulated`: `true`
- `feeDistribution`: confirmed 5700/1805/1805/190/500 bps split totaling 10000 bps (100%)

### Tiny Doc Findings
- The example response in the docs labels the 1.9% slice as `ecosystem`, but the actual API returns it as `alt`. Just a heads-up — easy fix on the docs side.
- The `/partnership/token-launching` overview page references `/partnership/api-reference/launch-token` as a related link, but that page returns 404. Worth either creating it or removing the broken link.

### Open Questions
- **Rate limit conflict in the docs.** The token-launching page says "1 deploy/min, 20 deploys/24h per fee recipient" but the partner-api page says "50 deploys/24h (100 for Bankr Club)" — which is authoritative? Our setup uses a different fee recipient per agent, so the per-recipient limit basically never bites. But the global limit matters at scale.
- **Custom fee splits.** The `feeSplitPercentage` parameter is mentioned in passing but not in the partner API request body schema. Is custom split configurable per-launch via API, or only in the dashboard's Token Launch tab? If it's tied to a partner-wide config, can we negotiate a higher partner share (e.g., 75% of Bankr's portion instead of 50%)?
- **Multi-chain.** Token launches show `chain: "base"` in the response. Is Base the only supported chain for launches, or can we specify another?

---

## Webhook / Trading Fee Events

### Status
**Webhooks scrapped — polling approach adopted.** Bankr provided public REST endpoints for reading fees directly, making webhooks unnecessary for MVP.

### Fee Reading Endpoints (confirmed 2026-04-14, public, no auth needed)

**All fees for a token (last N days):**
```
GET https://api.bankr.bot/public/doppler/token-fees/:tokenAddress?days=30
```

**Claimable fees for a specific beneficiary (our polling cron will use this):**
```
GET https://api.bankr.bot/public/doppler/claimable-fees/:tokenAddress?beneficiary=0x...
```

Not yet in the docs — Sinaver confirmed they're updating. We asked for a bulk endpoint (all fees across all tokens under a partner key in one call) for when we scale to hundreds of agents. Per-wallet works for now.

### Gas Sponsorship Update (2026-04-14)
Sinaver: *"UPDATE - gas sponsorship, wip, target before Friday: you will be able to top up gas credits with your org wallet."* Users currently need ETH to claim fees, but after Friday we can sponsor gas from our org wallet — enabling automated claim flows.

### Fee Wallet Retroactivity (confirmed 2026-04-14)
Sinaver: *"It affects only the future launches. But you can update fee recipient for prev launches, requires fee recipient signature either on contract level or we have an api."* **Not locked forever — can migrate existing tokens to multisig later.**

### What We Built (waiting for spec)
- Webhook endpoint at `POST /api/integrations/bankr/webhook`
- HMAC-SHA256 signature verification (`x-bankr-signature` header)
- `trading_fee.collected` event handler
- Idempotent credit injection via `instaclaw_add_credits()` RPC with `source: "bankr_trading_fee"` and stable `reference_id` per event
- USDC value → InstaClaw compute credits at a configurable rate

### Spec We Sent
We drafted a full proposal at `instaclaw/docs/bankr-webhook-spec.md`. Highlights:
- 3 events: `trading_fee.collected` (critical), `token.launched` (nice to have), `wallet.fee_claimed` (nice to have)
- Payload schemas with both decimal and wei amounts (avoid float precision issues)
- HMAC-SHA256 signature scheme
- Standard retry policy (exponential backoff, 6 retries over 24h)
- Test mode option (separate test webhook URL, or `X-Bankr-Test: true` header)
- Stable event `id` for dedupe on retry

### Open Questions for Bankr Side
- Are token swap fees collected per-swap or batched per block?
- Per-swap or aggregated event delivery?
- Minimum fee threshold below which webhook is skipped?
- Do fee-claim webhooks fire for all claims or only partner-key initiated?

---

## Bankr Skill (OpenClaw Integration)

### How We're Using It
Every agent VM auto-installs the Bankr skill during provisioning:
```bash
git clone --depth 1 https://github.com/BankrBot/skills ~/.openclaw/skills/bankr/
```

Plus env vars:
```
BANKR_API_KEY=bk_usr_...
BANKR_WALLET_ADDRESS=0x...
```

### Questions
- [ ] Is `https://github.com/BankrBot/skills` the correct/stable repo?
- [ ] What commands does the skill expose? (swap, balance, transfer, token-launch, etc.)
- [ ] Does the skill read `BANKR_API_KEY` from env automatically?
- [ ] Any minimum OpenClaw version required? We're on 2026.4.5.

---

## x402 Cloud (Future — Arena)

We want agents to charge for services (market signals, research, analysis) via x402 paid endpoints. This maps to our "Agent Arena" concept.

### Questions
- [ ] Can agents register as x402 service providers programmatically?
- [ ] How does service discovery work? Can we build a custom frontend?
- [ ] Pricing: Free tier 1,000 req/month — per-agent or per-org?

---

## Bugs / Issues Found

| # | Date | Severity | Description | Status |
|---|------|----------|-------------|--------|
| 1 | 2026-04-09 | Low | Address casing inconsistency: 201 returns EIP-55 checksummed, 200 idempotency retry returns lowercase. Could trip strict comparisons. | Open |
| 2 | 2026-04-09 | Note | Idempotency returns 200 (not 409 as spec says). Prefer this behavior — just noting the spec divergence. | Informational |
| 3 | 2026-04-10 | Low | Token launch response uses `feeDistribution.alt` but docs example shows `feeDistribution.ecosystem`. Field rename or doc typo? | Open |
| 4 | 2026-04-10 | Doc | `/partnership/api-reference/launch-token` returns 404 — referenced from token-launching page but doesn't exist. Either the page should be created or the link removed. | Open |
| 5 | 2026-04-10 | Doc | Rate limit conflict: token-launching page says "1 deploy/min, 20/24h per fee recipient", partner-api page says "50/24h (100 Bankr Club)". | **Resolved** — Sinaver confirmed: 1/min + 20/24h per fee recipient is correct for partner-key deploys. The 50/100 was for direct API-key deploys. |
| 6 | 2026-04-10 | Spec ambiguity | Docs reference 3 wallet types (org wallet, deployment wallet, fee wallet) but never clarify whether they must be distinct, can be the same, or what each one is responsible for. We're using one address for all three roles — works in simulation, untested for real launches. | Open |
| 7 | 2026-04-10 | UX clarity | Dashboard shows two distinct wallet concepts: the user's personal Bankr account login (top-right user dropdown, e.g. `0x94ab...`) and the org wallet (e.g. `0x66eb...`). These are clearly different things, but a label distinguishing "Personal Wallet" vs "Org Wallet" in the dropdown would prevent confusion. | Suggestion |
| 8 | 2026-04-15 | UX clarity | Setting fee wallet in Token Launch tab — the "Authentication required" message is confusing. It seemed to require a wallet signature but no MetaMask prompt appeared. It just worked after having MetaMask open in the browser. No signature was actually needed. Suggestion: either remove the "Authentication required" label or clarify what action the user needs to take (e.g., "Wallet detected" vs "Please sign to confirm"). | Suggestion |

---

## Feature Requests

| # | Priority | Description | Rationale |
|---|----------|-------------|-----------|
| 1 | High | Webhook for trading fee events | Core to self-sustaining compute loop |
| 2 | High | Token launch API spec | "Tokenize with Bankr" button is built and waiting |
| 3 | Medium | Batch wallet provisioning (higher rate limit) | Pre-provisioning for VM ready pool |
| 4 | Medium | Update allowedIps on existing wallet | VM reassignment scenario |
| 5 | Low | Webhook for token launch events | Update our DB when token goes live |

---

## Integration Progress

| Date | Milestone |
|------|-----------|
| 2026-04-01 | Architecture designed, all endpoints pre-built, DB ready |
| 2026-04-02 | Dev org setup requested |
| 2026-04-09 | Test org active, partner key generated, provisioning wired into onboarding |
| 2026-04-09 | First wallet provisioned via API — `wlt_02hhmvrxhhljjy5g` on Base. Idempotency verified. |
| 2026-04-10 | Read live docs end-to-end. Token launch endpoint corrected (`/token-launches/deploy`, not `/partner/wallets/:id/token-launch`). |
| 2026-04-10 | Tokenize endpoint wired up. Partner key auth, feeRecipient = user's own wallet (1a), simulateOnly env-driven, atomic DB lock to prevent race conditions. |
| 2026-04-10 | Webhook spec drafted at instaclaw/docs/bankr-webhook-spec.md to send to Sinaver. |
| 2026-04-10 | **First simulated launch successful.** `POST /token-launches/deploy` returned 200 OK with predicted token address, pool ID, and full fee distribution. Partner share confirmed routing to our fee wallet (`0x66eb...`), creator share routing to user wallet. Math checks out: 5700+1805+1805+190+500 = 10000 bps. |
| 2026-04-14 | **ALL BLOCKERS RESOLVED.** Sinaver answered all 5 questions — fee reading endpoints exist, gas sponsorship ships Friday, fee wallet migration is possible, rate limits clarified, alt/ecosystem doc nit confirmed. |
| 2026-04-14 | Celebration animation + post-launch token card redesign with live DexScreener price feed |
| Next | First real token launch test, then build Tier 2 polling cron using public fee endpoints |

---

## GTM Notes (from Igor, 2026-04-09)

**Two tracks:**
1. **Technical/Partnership** — Cooper tests partner dashboard, provisions wallets, gives feedback. Opens GC with 5 pilot users for Arena test launch with Bankr in chat for support.
2. **GTM** — InstaClaw has existing token on Virtuals. Open to launching new one on Bankr if it makes sense. Name change happening regardless. Careful with comms.
