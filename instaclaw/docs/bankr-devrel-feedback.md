# Bankr Partner Integration — Dev Notes & Feedback

**From:** Cooper Wrenn (InstaClaw)  
**For:** Igor Yuzovitsky, Sinaver, Bankr DevRel  
**Started:** 2026-04-09  
**Status:** Actively integrating — updating as we go

---

## Context

InstaClaw is a hosted AI agent platform. Each user gets a dedicated VM running an OpenClaw gateway with Telegram/Discord/Slack/WhatsApp connectivity. We're integrating Bankr to:

1. **Auto-provision a Bankr wallet** for every agent at deploy (zero friction)
2. **One-click tokenization** from the dashboard ("Tokenize with Bankr" button)
3. **Self-sustaining compute loop** — trading fees from the agent's token flow back through our gateway to pay for LLM inference

We have ~170 VMs in fleet, 3 paying users, and are scaling. Every new user will get a Bankr wallet automatically.

---

## Partner Dashboard (bankr.bot/partner)

### First Impressions
- Dashboard loaded cleanly, org "Instaclaw (Test)" shows Active
- Tabs are clear: Wallets, Agent, Token Launch, LLM Gateway, Partner Keys, Members
- Wallet API + Token Launch API toggles are intuitive

### Feedback
- [ ] **TODO:** Test wallet provisioning via API after grabbing partner key
- [ ] **TODO:** Test token launch flow end-to-end

### Questions
- Is the "Org Wallet" (Create Wallet button) required before we can provision per-agent wallets via the API? Or is it only for org-level operations like gas sponsorship?
- What's the difference between "test" and "production" orgs? Will we need a separate prod org later, or does the test org get promoted?

---

## Partner Provisioning API

### What We Built (pre-integration, 2026-04-01)
Based on the API spec Igor sent (partner-provisioning-api-spec.md):

- `POST /partner/wallets` — wallet creation with idempotencyKey per user
- `GET /partner/wallets` — list provisioned wallets
- `GET /partner/wallets/:id` — wallet detail
- `POST /partner/wallets/:id/api-key` — generate/rotate API key
- `DELETE /partner/wallets/:id/api-key` — revoke key

### Our Integration Points
- **Onboarding:** Wallet provisioned in Stripe webhook between VM assignment and configureOpenClaw()
- **Dashboard:** Bankr wallet card shows address + tokenize button
- **Webhook:** `/api/integrations/bankr/webhook` for trading fee events
- **Credit injection:** Trading fees convert to InstaClaw credits via `instaclaw_add_credits()` RPC

### API Feedback
- [ ] **Idempotency behavior:** Spec says 409 on duplicate idempotencyKey but "returns existing wallet." Does the 409 response body include the existing wallet data (id, evmAddress)? If not, we'd need a separate GET call on 409, which adds latency to onboarding.
- [ ] **IP allowlisting timing:** We provision the wallet BEFORE the VM is fully configured. The VM IP is known at this point, but if the user's VM gets reassigned later (subscription cancel + re-subscribe), the IP changes. Is there an API to update allowedIps on an existing wallet? Or do we need to revoke + recreate the API key?
- [ ] **Rate limit (10/min):** Fine for normal onboarding, but if we ever do a batch provisioning run (e.g., pre-provisioning 50 wallets for the ready pool), we'd hit this. Any way to get a higher limit for batch operations?
- [ ] **API key shown once:** We encrypt and store the key. If it's ever lost (DB corruption, etc.), is `POST /partner/wallets/:id/api-key` the recovery path? (i.e., generate a new key, which replaces the old one)

---

## Token Launch API

### What We Need
The partner provisioning spec covers wallets but NOT token launches. From the dashboard, "Token Launch API" is toggled on, but we need the API spec:

- Endpoint: `POST /partner/wallets/:id/token-launch` (our assumption)
- Request body: `{ name, symbol, description?, image? }`
- Response: `{ tokenAddress, ... }`

### Questions
- [ ] What's the token launch API endpoint and spec?
- [ ] Igor mentioned: "fair launches, 100% supply to LP, fees 50% weth / 50% token." Is this configurable per-partner, or fixed for all Bankr launches?
- [ ] Can we customize the fee split for InstaClaw agents? (e.g., a portion goes to the agent's wallet to fund compute)
- [ ] Is there a "Token Launch" tab API equivalent, or is it dashboard-only for now?
- [ ] What chain is the token launched on? Base only?

---

## Webhook / Trading Fee Events

### What We Built
Webhook endpoint at `/api/integrations/bankr/webhook` with:
- HMAC-SHA256 signature verification (`x-bankr-signature` header)
- `trading_fee` event handler that converts USDC to credits
- Idempotent credit injection via reference_id

### Questions
- [ ] Does Bankr support webhooks for trading fee events? What's the payload spec?
- [ ] What's the webhook registration flow? Dashboard config, or API call?
- [ ] What's the signature scheme? We assumed HMAC-SHA256 with a shared secret.
- [ ] If no webhook support yet, is there a polling endpoint to check wallet balance changes?

---

## Bankr Skill (OpenClaw Integration)

### What We Built
Every agent VM gets the Bankr skill auto-installed:
```bash
git clone --depth 1 https://github.com/BankrBot/skills ~/.openclaw/skills/bankr/
```

Plus env vars deployed to `~/.openclaw/.env`:
```
BANKR_API_KEY=bk_usr_...
BANKR_WALLET_ADDRESS=0x...
```

### Questions
- [ ] Is `https://github.com/BankrBot/skills` the correct/stable repo for the OpenClaw skill?
- [ ] What commands does the skill expose? (swap, balance, transfer, token-launch, etc.)
- [ ] Does the skill read `BANKR_API_KEY` from env automatically, or does it need explicit configuration?
- [ ] Any minimum OpenClaw version required? We're on 2026.4.5.

---

## x402 Cloud (Future — Arena)

### Interest Level: High
We want agents to charge for services (market signals, research, analysis) via x402 paid endpoints. This maps directly to our "Agent Arena" concept.

### Questions
- [ ] Can agents register as x402 service providers programmatically? (not just via `bankr x402 deploy`)
- [ ] How does service discovery work? Can we build a custom frontend that queries available x402 services?
- [ ] Pricing: Free tier is 1,000 req/month — is this per-agent or per-org?

---

## Bugs / Issues Found

| # | Date | Severity | Description | Status |
|---|------|----------|-------------|--------|
| 1 | 2026-04-09 | Note | Partner key generated from dashboard. Key name: "InstaClaw Production". IP whitelist left open (Vercel dynamic IPs). | Resolved |
| 2 | 2026-04-09 | Note | Partner dashboard UX is clean — org setup, key generation, and toggle controls all intuitive. No issues. | N/A |

---

## Feature Requests

| # | Priority | Description | Rationale |
|---|----------|-------------|-----------|
| 1 | High | Webhook support for trading fee events | Core to our self-sustaining compute loop |
| 2 | High | Token launch API spec | Need this for "Tokenize with Bankr" button |
| 3 | Medium | Batch wallet provisioning (higher rate limit) | Pre-provisioning for ready pool |
| 4 | Medium | Update allowedIps on existing wallet | VM reassignment scenario |
| 5 | Low | Webhook for token launch events | Update our DB when token goes live |

---

## Timeline / Milestones

| Date | Milestone | Status |
|------|-----------|--------|
| 2026-04-01 | PRD + pre-build complete (DB, endpoints, dashboard card, webhook skeleton) | Done |
| 2026-04-01 | Bankr conflict analysis with Virtuals/ACP — 3 conflicts fixed | Done |
| 2026-04-02 | Dev org setup, partner dashboard access | Done |
| 2026-04-09 | Test org "Instaclaw (Test)" active on bankr.bot/partner | Done |
| 2026-04-09 | Partner key obtained + added to Vercel production | Done |
| 2026-04-09 | provisionBankrWallet() wired into billing webhook | Done |
| TBD | First wallet provisioned via API (next new user signup) | Pending |
| TBD | First agent tokenized via Bankr | Pending (blocked on token launch API) |
| TBD | Trading fee credit loop live | Pending (blocked on webhook spec) |
| TBD | Arena pilot with 5 users | Pending |

---

## GTM Notes (from Igor, 2026-04-09)

**Two tracks:**
1. **Technical/Partnership** — Cooper tests partner dashboard, provisions wallets, gives feedback. Then 5 pilot users for Arena test launch with Bankr in the GC for support.
2. **GTM** — InstaClaw has existing token on Virtuals. Open to launching new one on Bankr if it makes sense. Name change happening regardless of token relaunch. Be careful with comms around this.
