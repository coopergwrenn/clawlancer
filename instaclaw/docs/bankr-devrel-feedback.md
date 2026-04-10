# Bankr Partner Integration — Dev Notes & Feedback

**From:** Cooper Wrenn (InstaClaw)  
**For:** Igor Yuzovitsky, Sinaver, Bankr DevRel  
**Started:** 2026-04-09  
**Status:** Actively integrating — updating as we go

---

## Context

InstaClaw is a hosted AI agent platform (~193 agents). Each user gets a dedicated VM running an OpenClaw gateway. We're integrating Bankr to auto-provision wallets at deploy, enable one-click tokenization, and build a self-sustaining compute loop where trading fees fund agent inference.

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

### What We Need
We have a "Tokenize with Bankr" button built into our dashboard. It's wired and ready but returns "API not yet available" because we don't have the token launch endpoint spec.

- What's the endpoint? Our assumption: `POST /partner/wallets/:id/token-launch`
- Request body: `{ name, symbol, description?, image? }`
- Response: `{ tokenAddress, ... }`

### Questions
- [ ] What's the token launch API endpoint and full spec?
- [ ] Igor mentioned: "fair launches, 100% supply to LP, fees 50% weth / 50% token." Is the fee structure configurable per-partner?
- [ ] Can we customize the fee split so a portion funds the agent's compute? (This is the core of our self-sustaining loop)
- [ ] Is there a programmatic equivalent to the "Token Launch" dashboard tab?
- [ ] Base only, or multi-chain?

---

## Webhook / Trading Fee Events

### What We Need
We have a webhook endpoint built (`/api/integrations/bankr/webhook`) with HMAC signature verification and automatic credit injection. When an agent's token generates trading fees, we convert USDC to compute credits so the agent funds its own inference.

### Questions
- [ ] Does Bankr support webhooks for trading fee events? If so, what's the payload spec?
- [ ] How do we register a webhook URL? Dashboard config or API call?
- [ ] What's the signature scheme? We assumed HMAC-SHA256 with a shared secret.
- [ ] If no webhook support yet, is there a polling endpoint to check wallet balance changes?

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
| Next | Verify partner fee wallet is configured in Token Launch tab, then test simulated launch |

---

## GTM Notes (from Igor, 2026-04-09)

**Two tracks:**
1. **Technical/Partnership** — Cooper tests partner dashboard, provisions wallets, gives feedback. Opens GC with 5 pilot users for Arena test launch with Bankr in chat for support.
2. **GTM** — InstaClaw has existing token on Virtuals. Open to launching new one on Bankr if it makes sense. Name change happening regardless. Careful with comms.
