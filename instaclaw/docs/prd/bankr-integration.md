# Bankr Partnership Integration — PRD

**Status:** Architecture Complete, Pre-Build Phase  
**Author:** Cooper Wrenn + Claude  
**Date:** 2026-04-01  
**Partner Contact:** Igor Yuzovitsky (Bankr)  
**Telegram Group:** instaclaw / bankr (6 members)

---

## Executive Summary

InstaClaw is partnering with Bankr (bankr.bot) to add crypto wallet and tokenization capabilities to every agent. The integration has three pillars:

1. **Wallet Provisioning** — Every agent ships with a Bankr wallet at deploy (zero friction)
2. **Agent Tokenization** — One-click token launch from dashboard; trading fees fund the agent's own inference
3. **Agent Arena** — Independent trading competition / agent marketplace built with Bankr as an alternative to Virtuals Protocol

The holy grail is Pillar 2: a self-sustaining compute loop where the agent funds its own operation through its token's trading activity.

---

## Pillar 1: Wallet Provisioning

### Goal
Every InstaClaw agent ships with a Bankr wallet at deploy. Zero user friction — the wallet is created programmatically during onboarding.

### Bankr Partner Provisioning API

**Base URL:** `https://api.bankr.bot`  
**Auth:** `x-partner-key` header with format `bk_ptr_{keyId}_{secret}`  
**Rate Limit:** 10 creations/min/partner  

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/partner/wallets` | POST | Create wallet + optional API key |
| `/partner/wallets` | GET | List provisioned wallets |
| `/partner/wallets/:id` | GET | Get wallet detail (by ID, EVM addr, or Solana addr) |
| `/partner/wallets/:id/api-key` | POST | Generate new API key for existing wallet |
| `/partner/wallets/:id/api-key` | DELETE | Revoke wallet's API key |

### Wallet Creation Request
```json
{
  "idempotencyKey": "instaclaw_user_{userId}",
  "apiKey": {
    "permissions": {
      "agentApiEnabled": true,
      "llmGatewayEnabled": false,
      "readOnly": false
    },
    "allowedIps": ["{vm_ip_address}"]
  }
}
```

### Wallet Creation Response
```json
{
  "id": "wlt_j7Qm4rT9",
  "evmAddress": "0x1a2b3c4d5e6f...",
  "apiKey": "bk_usr_a1b2c3d4_x9f2k4m7n8p3q5r7..."
}
```

Key decisions:
- **No Solana wallet** initially (EVM-only, Base chain)
- **llmGatewayEnabled: false** — We have our own gateway proxy; no need for Bankr's LLM gateway
- **allowedIps** locked to the VM's IP address for security
- **idempotencyKey** uses user ID to prevent duplicate wallets on retry

### Integration Point: Onboarding Flow

Wallet provisioning hooks into the existing flow at the Stripe webhook, between VM assignment and `configureOpenClaw()`:

```
Stripe webhook fires (checkout.session.completed)
  ↓
1. Create subscription (existing)
  ↓
2. assignVMWithSSHCheck() (existing)
  ↓
3. ★ provisionBankrWallet() ★ (NEW)
   POST https://api.bankr.bot/partner/wallets
   Store: bankr_wallet_id, bankr_evm_address, bankr_api_key_encrypted
  ↓
4. /api/vm/configure → configureOpenClaw() (existing, now passes Bankr creds)
  ↓
5. Agent boots with Bankr wallet + skill pre-installed
```

The `provisionBankrWallet()` call adds ~500ms to onboarding. Since the user is already waiting 30-90s on the deploying page, this is invisible.

### Security

- **API key encryption:** Bankr API keys stored encrypted in DB (AES-256-GCM), not plaintext. Existing `bankr_api_key` on agents table is plaintext — this is a known security issue from the audit.
- **IP allowlisting:** Each wallet's API key locked to the VM's IP.
- **Partner key:** Stored as `BANKR_PARTNER_KEY` env var on Vercel only, never committed.

---

## Pillar 2: Agent Tokenization

### Goal
One-click "Tokenize with Bankr" button in the dashboard. Trading fees from the token flow back through the gateway proxy to pay for the agent's LLM inference. Self-sustaining compute loop.

### User Flow

1. User visits dashboard → sees Bankr Wallet card
2. Card shows: wallet address, balance, "Tokenize Your Agent" button
3. User clicks Tokenize → enters token name + symbol
4. `POST /api/bankr/tokenize` → calls Bankr token launch API
5. Token deployed on Base → trading begins
6. Trading fees accumulate in wallet → Bankr webhook fires
7. Webhook credits the user's InstaClaw account → agent keeps running

### "Tokenize with Bankr" Button — API Flow

```
User clicks "Launch Token"
       ↓
POST /api/bankr/tokenize
  Body: { token_name: "MyAgent", token_symbol: "AGENT" }
  Auth: Session cookie
       ↓
Server:
  1. Look up user → VM → bankr_wallet_id
  2. Call Bankr token launch API (TBD — not in current spec)
     POST https://api.bankr.bot/partner/wallets/:id/token-launch (hypothetical)
     Headers: x-partner-key: bk_ptr_...
     Body: { name, symbol }
  3. Store token_address + token_symbol in instaclaw_vms
  4. Return { tokenAddress, tokenSymbol }
       ↓
Frontend updates card to show live token status
```

### Trading Fee → LLM Credit Loop

```
Agent's token trades on market
       ↓
Trading fee generated (% of trade volume)
       ↓
Bankr captures fee in agent's wallet
       ↓
Bankr webhook → POST /api/integrations/bankr/webhook
  Headers: x-bankr-signature: hmac_sha256(payload, secret)
  Body: {
    event: "trading_fee",
    wallet_id: "wlt_j7Qm4rT9",
    amount_usdc: "0.50",
    trade_id: "txn_abc123",
    token_address: "0x...",
    timestamp: "2026-04-01T..."
  }
       ↓
InstaClaw webhook handler:
  1. Verify HMAC signature
  2. Look up VM by bankr_wallet_id
  3. Convert USDC → credits ($0.004/credit → $0.50 = 125 credits)
  4. instaclaw_add_credits(vm_id, 125, 'bankr_fee_txn_abc123', 'bankr_trading_fee')
  5. Log to credit_ledger with source: 'bankr_trading_fee'
       ↓
Credits appear immediately in user's balance
Agent funded by its own token
```

The credit injection is already solved — `instaclaw_add_credits()` RPC is idempotent and audit-logged with configurable source parameter (migration 20260326_add_credits_source_param.sql).

**Fallback if no webhook support:** Cron every 5 minutes polls `GET /partner/wallets/:id` to check balance changes, credits the delta.

### What's Needed from Bankr (not in current spec)
1. Token launch API endpoint
2. Webhook specification (events, payload format, signature scheme)
3. Trading fee percentage / structure
4. USDC → credit conversion recommendations

---

## Pillar 3: Agent Arena

### Goal
Independent trading competition / agent marketplace built with Bankr as an alternative to Virtuals Protocol. Our own platform, our own rules.

### Status
Conceptual — no API spec yet. Depends on Pillars 1 and 2 being live first.

### Concept
- Agents compete in trading competitions
- Leaderboard based on portfolio performance
- Entry fees and prize pools in USDC
- Built on top of Bankr's x402 Cloud for paid agent-to-agent services

### Bankr x402 Cloud (for Agent Arena services)
- Agents can publish paid API endpoints (market signals, analysis, etc.)
- Other agents pay per-request in USDC on Base
- HTTP 402 payment challenge → wallet signs → handler executes
- Free tier: 1,000 req/month, Pro: 5% fee unlimited

---

## Database Changes

### New columns on `instaclaw_vms`

```sql
ALTER TABLE instaclaw_vms
  ADD COLUMN bankr_wallet_id VARCHAR(32),
  ADD COLUMN bankr_evm_address VARCHAR(42),
  ADD COLUMN bankr_api_key_encrypted TEXT,
  ADD COLUMN bankr_token_address VARCHAR(42),
  ADD COLUMN bankr_token_symbol VARCHAR(10),
  ADD COLUMN bankr_token_launched_at TIMESTAMPTZ;
```

These go on `instaclaw_vms` (not `agents` table) because Bankr wallets are per-VM/per-user in the InstaClaw context.

### Update instaclaw_reclaim_vm()

When a VM is reclaimed, Bankr fields must be cleared:
```sql
bankr_wallet_id = NULL,
bankr_evm_address = NULL,
bankr_api_key_encrypted = NULL,
bankr_token_address = NULL,
bankr_token_symbol = NULL,
bankr_token_launched_at = NULL
```

Note: The Bankr wallet itself is NOT deleted — it persists on Bankr's side. We just disassociate it from the VM. If the user re-subscribes, `provisionBankrWallet()` will return the same wallet via idempotencyKey.

---

## New API Endpoints

| Endpoint | Method | Purpose | Auth |
|----------|--------|---------|------|
| `/api/bankr/wallet` | GET | Get user's Bankr wallet info + balance | Session cookie |
| `/api/bankr/tokenize` | POST | Launch agent token via Bankr | Session cookie |
| `/api/bankr/earnings` | GET | Credit history from token trades | Session cookie |
| `/api/integrations/bankr/webhook` | POST | Receive trading fee events from Bankr | HMAC signature |

---

## New Environment Variables (Vercel)

| Var | Format | Purpose |
|-----|--------|---------|
| `BANKR_PARTNER_KEY` | `bk_ptr_{keyId}_{secret}` | Partner API auth — **waiting on Igor** |
| `BANKR_WEBHOOK_SECRET` | string | HMAC secret for webhook signature verification |
| `BANKR_CREDITS_PER_DOLLAR` | number (default: 250) | USDC → credit conversion rate |

---

## configureOpenClaw() Changes

### 1. Bankr Environment Variables (Phase: env vars, ~line 3061-3122)

After existing env var deployment, add:

```bash
# Deploy Bankr wallet credentials
grep -q "^BANKR_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null && \
  sed -i "s/^BANKR_API_KEY=.*/BANKR_API_KEY=${bankrApiKey}/" "$HOME/.openclaw/.env" || \
  echo "BANKR_API_KEY=${bankrApiKey}" >> "$HOME/.openclaw/.env"
grep -q "^BANKR_WALLET_ADDRESS=" "$HOME/.openclaw/.env" 2>/dev/null && \
  sed -i "s/^BANKR_WALLET_ADDRESS=.*/BANKR_WALLET_ADDRESS=${bankrEvmAddress}/" "$HOME/.openclaw/.env" || \
  echo "BANKR_WALLET_ADDRESS=${bankrEvmAddress}" >> "$HOME/.openclaw/.env"
```

### 2. Bankr Skill Install (Phase: skill install, after Clawlancer MCP)

```bash
# Install Bankr skill for wallet + trading capabilities
if [ ! -d "$HOME/.openclaw/skills/bankr" ]; then
  git clone --depth 1 https://github.com/BankrBot/skills "$HOME/.openclaw/skills/bankr" 2>/dev/null || true
fi
```

Register in extraDirs via the same Python script pattern used for ACP.

### 3. SOUL.md Awareness (Phase: workspace files, ~line 3311-3336)

Append Bankr awareness paragraph to SOUL.md:
```
## Bankr Wallet
You have a Bankr wallet for crypto operations. Your wallet address is in BANKR_WALLET_ADDRESS.
Use the bankr skill for trading, balance checks, and token operations.
```

### 4. Wallet.md Update (Phase: workspace files, ~line 3300-3309)

Update Wallet.md template to include Bankr wallet address when available.

---

## Dashboard UI

### Bankr Wallet Card (new component)

Location: `instaclaw/components/dashboard/bankr-wallet-card.tsx`  
Insertion point: After WorldIDBanner (`dashboard/page.tsx:517`), before usage card.

**States:**

1. **No wallet provisioned** (pre-partner-key or legacy user):
   - Hidden / no card shown

2. **Wallet provisioned, no token**:
   ```
   ┌─ Agent Wallet ──────────── Powered by Bankr ─┐
   │  0x742d...5f3a                                │
   │  Base mainnet                                 │
   │                                               │
   │  [ Tokenize Your Agent ]                      │
   └───────────────────────────────────────────────┘
   ```

3. **Wallet + token launched**:
   ```
   ┌─ Agent Wallet ──────────── Powered by Bankr ─┐
   │  0x742d...5f3a                                │
   │  Token: $AGENT    Trading: Active             │
   │  Earned: 47 credits from trading fees         │
   └───────────────────────────────────────────────┘
   ```

### Data Flow

`/api/vm/status` already returns VM fields → add `bankrWalletId`, `bankrEvmAddress`, `bankrTokenAddress`, `bankrTokenSymbol` to the response. Dashboard reads from VMStatus — no new API call needed for basic display.

---

## Existing Bankr Code (Reference)

### Active
- `lib/bankr.ts` — `bankrGetWallets()`, `bankrGetPrimaryWallet()`, `isValidBankrApiKey()`
- Migration 038 — `bankr_api_key`, `bankr_wallet_address` on `agents` table (Clawlancer marketplace, separate from InstaClaw)
- `app/api/agents/register/route.ts` — Accepts optional `bankr_api_key` for agent registration
- `app/onboard/page.tsx` — Optional Bankr API key input field

### Dead/Removed
- `bankrSign()`, `bankrSubmit()` — Removed, Oracle wallet signs everything

### Note
The existing Bankr code in `lib/bankr.ts` and the `agents` table is for the **Clawlancer marketplace** (external agent registration). The new integration is for **InstaClaw** (hosted agent VMs). Different tables, different flows. Both use `api.bankr.bot` but with different auth (user API key vs partner key).

---

## Blocked vs Pre-Buildable

### Can build now (no partner key needed)
- [x] DB migration for Bankr columns on `instaclaw_vms`
- [x] Bankr skill clone in `configureOpenClaw()`
- [x] Dashboard Bankr wallet card component (UI shell)
- [x] Webhook endpoint skeleton with HMAC verification
- [x] Credit ledger `bankr_trading_fee` source support
- [x] `/api/bankr/wallet` endpoint (reads from DB)

### Blocked on partner key (`bk_ptr_...`)
- [ ] `provisionBankrWallet()` in billing webhook
- [ ] End-to-end wallet provisioning testing
- [ ] IP allowlisting (need VM IPs in production)

### Blocked on Bankr team (APIs not yet in spec)
- [ ] Token launch API → "Tokenize" button
- [ ] Webhook specification → trading fee credit loop
- [ ] Trading fee structure → USDC→credit conversion rate
- [ ] Arena infrastructure APIs

---

## Rollout Plan

### Phase 0: Pre-Build (now)
Build everything that doesn't need the partner key. When key arrives, flip one switch.

### Phase 1: Wallet Provisioning (when partner key arrives)
- Add `BANKR_PARTNER_KEY` to Vercel env
- Wire `provisionBankrWallet()` into billing webhook
- Deploy to one canary VM → verify wallet created + skill functional
- Fleet-wide rollout via reconciler

### Phase 2: Tokenization (when Bankr ships token launch API)
- Wire "Tokenize" button to Bankr API
- Build webhook handler for trading fee events
- Deploy credit loop
- Monitor: credits earned vs credits consumed per agent

### Phase 3: Agent Arena (future)
- Design competition mechanics
- Build on Bankr x402 Cloud
- Leaderboard + prize pool infrastructure

---

## Open Questions for Bankr Team

1. **Token launch API** — What's the endpoint spec? When will it be available?
2. **Webhook support** — Do you support webhooks for trading fee events? What's the payload/signature format?
3. **Trading fee structure** — What % of trading volume goes to the token creator's wallet?
4. **Wallet portability** — If a user cancels and re-subscribes, does the idempotencyKey return the same wallet?
5. **x402 integration** — How do agents register as x402 service providers programmatically?
6. **LLM Gateway interop** — Any plans for our gateway to interop with Bankr's LLM gateway for billing consolidation?
