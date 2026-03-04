# InstaClaw Skill 15: Solana DeFi Trading — Product Requirements Document

**Author:** Cooper Wrenn (Wild West Bots LLC)
**Date:** March 4, 2026
**Status:** Ready for Claude Code handoff
**Priority:** P1 — User demand validated (Chidi incident, multiple support requests)
**Skill Number:** 15 (after Language Teacher #14)

---

## 1. Context & Motivation

### 1.1 The Incident That Triggered This

On March 4, 2026, user Chidi (chidiobiapuna@gmail.com, instaclaw-vm-064, Pro plan) had his agent attempt to build a pump.fun sniping bot. Without a proper skill to guide it, the agent:

- Raw-dogged pump.fun with exec/curl in a brute-force loop
- Failed 69 times consecutively, filling the session with 320KB of error output
- The last 2 assistant responses were EMPTY ([]) — the agent was completely frozen
- Telegram WebSocket died and restarted 31 times (stale-socket loop)
- User lost all conversation history from Feb 26–Mar 3
- Agent was completely bricked for 4+ days before we caught it

**Root cause:** No skill existed to teach the agent how to trade on Solana safely. The agent improvised, failed catastrophically, and had no guardrails to stop it.

### 1.2 User Demand

- Chidi was doing 600+ messages/day, mostly crypto trading tasks
- His workspace contained 28+ custom skills, pump.fun bot code, Polymarket tools
- Multiple users have asked about crypto trading capabilities
- This is the #1 use case for web3-native users on InstaClaw

### 1.3 Strategic Fit

- InstaClaw is positioned as web3-native (dual token economy, $INSTACLAW on Base, $CLAWLANCER on Solana)
- Agents already have Polymarket/Kalshi prediction market skills
- aGDP and Clawlancer integrate crypto earning
- Solana DeFi trading is the natural next step — agents that can trade, not just analyze

---

## 2. Product Overview

### 2.1 What This Skill Does

Gives every InstaClaw agent the ability to trade tokens on Solana — swaps, sniping new launches, portfolio tracking, and autonomous trading strategies — with built-in safety rails that prevent the exact session-bricking failure Chidi experienced.

### 2.2 What This Skill Does NOT Do

- Does NOT make InstaClaw a custodian. Wallets live on user VMs, private keys never leave the VM.
- Does NOT make InstaClaw an exchange. Trades go directly to Jupiter/pump.fun/Raydium. We're infrastructure, not the house.
- Does NOT require any platform-level API keys. Users bring their own RPC endpoints for speed; we provide a free default.
- Does NOT auto-trade without user consent. The agent asks before executing real trades.

### 2.3 Two-Phase Approach

**Phase 1 (this PRD): SKILL.md + Wallet Provisioning**
Ship a skill that teaches agents to trade using tools they already have (code execution, web APIs). Zero new dependencies. Includes auto-provisioned Solana wallets per VM and safety rails.

**Phase 2 (future): Solana MCP Server via mcporter**
Install SendAI's solana-mcp (60+ pre-built Solana actions) as an MCP server. Replaces code-execution trading with structured tool calls. Requires Phase 1 wallet infrastructure.

---

## 3. Wallet Provisioning System

### 3.1 Architecture

Every InstaClaw agent gets its own Solana wallet. The private key lives ONLY on the user's VM. InstaClaw never custodies funds.

```
┌─────────────────────────────────────────────────┐
│  User's VM (instaclaw-vm-XXX)                   │
│                                                 │
│  ~/.openclaw/.env                               │
│    SOLANA_PRIVATE_KEY=<base58>    ← never leaves│
│    SOLANA_WALLET_ADDRESS=<pubkey>               │
│    SOLANA_RPC_URL=<endpoint>                    │
│                                                 │
│  Agent signs transactions locally               │
│  Trades go directly to Jupiter/pump.fun/etc.    │
└─────────────────────────────────────────────────┘
```

### 3.2 Wallet Generation

**When:** During `configureOpenClaw()` in ssh.ts, after VM setup is complete.

**How:** Generate a Solana keypair directly on the VM using a lightweight Node.js script:

```javascript
// generate-wallet.mjs — runs on the VM during provisioning
import { Keypair } from '@solana/web3.js';
import { encode } from 'bs58';
import { appendFileSync } from 'fs';

const keypair = Keypair.generate();
const privateKey = encode(keypair.secretKey);
const publicKey = keypair.publicKey.toBase58();

appendFileSync('/home/openclaw/.openclaw/.env', `\nSOLANA_PRIVATE_KEY=${privateKey}\n`);
appendFileSync('/home/openclaw/.openclaw/.env', `SOLANA_WALLET_ADDRESS=${publicKey}\n`);
appendFileSync('/home/openclaw/.openclaw/.env', `SOLANA_RPC_URL=https://api.mainnet-beta.solana.com\n`);

console.log(publicKey); // stdout captured by ssh.ts
```

**Post-generation:**
- Save `solana_wallet_address` to Supabase `instaclaw_vms` table (new column)
- Private key NEVER leaves the VM. NEVER stored in Supabase. NEVER logged.
- Agent can read its own wallet address from .env

**Dependencies to install on VM:** `@solana/web3.js`, `bs58` (one-time npm install during provisioning)

### 3.3 Import Path (Power Users)

Power users who already have a Solana wallet can import their own private key:

**Via Dashboard Settings:**
- "Solana Wallet" section in Settings page
- Input field: "Import your Solana private key (base58)"
- On submit: SSH into VM, replace SOLANA_PRIVATE_KEY and SOLANA_WALLET_ADDRESS in .env
- Validate key format before saving (decode bs58, check length = 64 bytes)
- Show success: "Wallet updated. Your agent now uses wallet [first 4]...[last 4]"

**Via Agent (Telegram):**
- User says "use my wallet [base58 key]"
- Agent validates, stores in .env, confirms with public key
- Agent should warn: "I've updated my wallet. The old wallet's private key is no longer stored. Make sure you saved it if it had funds."

### 3.4 Wallet Security Rules

- Private key is stored in .env with file permissions 600 (owner-only read/write)
- Agent NEVER displays the private key in conversation. If user asks: "Your private key is stored securely on your VM. You can retrieve it by SSHing into your VM."
- Agent NEVER sends the private key over Telegram, the dashboard, or any API
- Agent NEVER includes the private key in session logs, MEMORY.md, or any file that could be backed up externally
- If a session backup captures .env contents, the private key lines must be redacted

### 3.5 Rollout Strategy

- **New VMs:** Auto-generate wallet during provisioning. Immediate.
- **Existing VMs:** Do NOT auto-generate. Users opt-in by enabling the Solana DeFi skill, which triggers wallet generation on first enable.
- **Migration script:** `fleet-push-solana-wallet.sh` with `--dry-run`, `--canary` (5 VMs), `--all` flags. Canary first, monitor for 24h, then fleet-wide.

---

## 4. Dashboard UX

### 4.1 Skills Page — Solana DeFi Card

On the existing Skills page (alongside E-Commerce, Clawlancer, aGDP, etc.):

```
┌─────────────────────────────────────────────────────┐
│  ☀ Solana DeFi Trading                    [TOGGLE]  │
│                                                     │
│  Trade tokens, snipe launches, and manage a         │
│  portfolio on Solana. Your agent gets its own        │
│  wallet and trades directly on Jupiter, pump.fun,   │
│  and Raydium.                                       │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │  Agent Wallet                               │    │
│  │  ████...████  [COPY]                        │    │
│  │                                             │    │
│  │  Balance: 0.000 SOL  [↻ Refresh]           │    │
│  │                                             │    │
│  │  Fund your agent: Send SOL to this address  │    │
│  │  from Phantom, Coinbase, or any wallet.     │    │
│  └─────────────────────────────────────────────┘    │
│  └─ Import existing wallet  [Import]                │
│  └─ Trading limits: 0.1 SOL max/trade  [Edit]       │
└─────────────────────────────────────────────────────┘
```

### 4.2 Toggle Behavior

**Turning ON:**
1. Confirmation modal: "This will create a Solana wallet for your agent and install trading capabilities. Your agent can trade tokens using funds you send to its wallet. You are responsible for any trading activity. Continue?"
2. Loading state: "Setting up wallet..." → "Installing skill..." → "Done!"
3. On completion: show wallet address, copy button, balance (0.000 SOL), funding instructions
4. API call: `POST /api/settings/update` with `{ action: "toggle_solana_defi", enabled: true }`
5. Backend: generate wallet on VM → save to .env → save pubkey to Supabase → deploy SKILL.md → restart gateway

**Turning OFF:**
1. Confirmation modal: "This will disable trading but keep your wallet and funds intact. You can re-enable anytime."
2. Backend: remove SKILL.md from skills dir → restart gateway. Do NOT delete wallet or funds.

### 4.3 Settings Page — Solana Wallet Section

Below the "Solana DeFi Trading" toggle card, when enabled:

**Wallet Display:**
- Full wallet address with copy button
- SOL balance (fetched from RPC on page load, with refresh button)
- "View on Solscan" link → opens `https://solscan.io/account/{address}`
- Token balances if any (top 5 by value)

**Advanced Settings:**
- **RPC Endpoint:** Dropdown with "Public (Free)" default + text input for custom URL
  - Hint text: "Serious traders should use Helius or QuickNode for faster execution"
  - Validate URL on save (make a test RPC call)
- **Import Wallet:** "Replace your agent's wallet with an existing Solana wallet"
  - Warning: "This will replace your current agent wallet. Make sure to transfer any remaining funds first."
  - Input field for base58 private key
  - Validate → update .env on VM → update Supabase pubkey
- **Max Trade Size:** Slider or input, default 0.1 SOL
  - Stored in agent config, enforced by SKILL.md instructions
  - Range: 0.01 SOL to 10 SOL
- **Daily Loss Limit:** Input field, default 0.5 SOL
  - Agent pauses trading and notifies user if cumulative losses exceed this
- **Auto-Trade:** Toggle (default OFF)
  - OFF: Agent always asks before executing trades
  - ON: Agent can execute trades autonomously within configured limits
  - Warning when enabling: "Your agent will trade without asking. Stay within your risk limits."

### 4.4 First-Time User Flow (Zero to Trading)

The goal: a user with zero crypto knowledge can get their agent trading in under 5 minutes.

```
Step 1: User enables "Solana DeFi Trading" toggle
        → Wallet auto-created, address shown

Step 2: Dashboard shows "Fund your agent" card
        → QR code of wallet address
        → "Send SOL from Phantom, Coinbase, etc."
        → Balance updates automatically when funded

Step 3: User messages agent on Telegram:
        "buy some memecoins" or "snipe new launches on pump.fun"

Step 4: Agent checks wallet balance, confirms with user:
        "I have 0.5 SOL. Want me to watch for new pump.fun
         launches and buy in with 0.05 SOL each? I'll stop
         after 5 trades or 0.25 SOL spent, whichever comes first."

Step 5: User confirms, agent executes
```

### 4.5 Funding UX Details

Since many InstaClaw users are web3-native, this should be dead simple:

- **QR Code:** Generate a Solana pay-compatible QR code from the wallet address. Display prominently on the skill card when balance is 0.
- **Balance Polling:** After user enables the skill and sees the "fund your agent" prompt, poll balance every 30 seconds for 5 minutes (or until funded). Show a subtle animation when balance arrives.
- **Insufficient Funds UX:** If user asks agent to trade but balance is 0, agent says: "Your wallet is empty. Send SOL to [address] and I'll start trading once it arrives. I'll check your balance every few minutes."

---

## 5. SKILL.md Specification

### 5.1 File Structure

```
skills/solana-defi/
├── SKILL.md                          # Main skill document (agent reads this)
├── references/
│   ├── jupiter-api.md                # Jupiter V6 swap API reference
│   ├── pumpportal-api.md             # PumpPortal trading API reference
│   ├── dexscreener-api.md            # DexScreener price/token data API
│   ├── solana-rpc.md                 # Core Solana RPC methods reference
│   └── safety-patterns.md           # Error handling, retry logic, circuit breakers
└── assets/
    ├── generate-wallet.mjs           # Wallet generation script (runs during provisioning)
    └── check-balance.mjs             # Balance checking utility script
```

### 5.2 SKILL.md — Critical Sections

The SKILL.md is what the agent actually reads. It must be written as instructions TO the agent. Every section should be actionable.

#### Section 1: SAFETY RAILS (Top of file, most important)

```markdown
## CRITICAL: Safety Rails

YOU MUST follow these rules. They exist because a real user's agent destroyed
its own session by looping on failed trades 69 times until it couldn't respond.

### Rule 1: Maximum 3 Retries Per Operation
If a trade, API call, or script fails 3 times in a row:
- STOP immediately
- Tell the user exactly what failed and why
- Ask if they want you to try a different approach
- Do NOT retry a 4th time under any circumstances

### Rule 2: Context Budget
Never dump raw transaction data, full error stack traces, or complete API
responses into the conversation. Always summarize:
- GOOD: "Bought 0.05 SOL of BONK at $0.00003 — tx: 4xK7m..."
- BAD: [pasting 200 lines of transaction JSON]
Keep total trading-related context under 50KB per session.

### Rule 3: Error Classification
TRANSIENT (retry with backoff 5s → 15s → 45s → STOP):
  - HTTP 429 (rate limit)
  - Network timeout
  - RPC node congestion
  - "blockhash not found" (retry with fresh blockhash)

PERMANENT (do NOT retry, tell user immediately):
  - Insufficient funds / balance
  - Invalid mint address
  - Wallet not found
  - Signature verification failed
  - "Program failed to complete" (bad instruction)

DANGEROUS (stop ALL trading, alert user):
  - 3+ consecutive empty responses
  - Session file exceeding 200KB
  - Process killed by SIGKILL (out of memory)
  - Same error message appearing 5+ times

### Rule 4: Position Sizing
- Check user's configured max trade size (default: 0.1 SOL)
- Check user's daily loss limit (default: 0.5 SOL)
- NEVER exceed these limits
- If no limits configured, use defaults and inform user

### Rule 5: Confirmation Before Execution
- ALWAYS tell the user what you're about to do before doing it
- Example: "I'm going to swap 0.1 SOL for BONK on Jupiter with 1% slippage.
  Estimated output: 3,450,000 BONK. Proceed?"
- Only skip confirmation if user has explicitly enabled auto-trade mode
```

#### Section 2: Wallet Management

```markdown
## Wallet Management

### Check Wallet Status
Before any trading operation, verify wallet setup:
1. Check if SOLANA_PRIVATE_KEY exists in ~/.openclaw/.env
2. If yes: read SOLANA_WALLET_ADDRESS, check SOL balance via RPC
3. If no: tell user "You don't have a wallet set up yet. Enable Solana
   DeFi Trading in your dashboard at instaclaw.io/dashboard, or I can
   generate one for you right now."

### Balance Checking
Use this pattern (Node.js via exec):
```js
// Quick balance check — always use this before trading
const { Connection, PublicKey } = require('@solana/web3.js');
const conn = new Connection(process.env.SOLANA_RPC_URL);
const balance = await conn.getBalance(new PublicKey(process.env.SOLANA_WALLET_ADDRESS));
console.log(JSON.stringify({ sol: balance / 1e9 }));
```
Parse the JSON output. Never dump the raw response.

### NEVER display or log the private key
If user asks for their private key: "Your private key is stored securely
on your VM at ~/.openclaw/.env. I can't display it here for security.
You can SSH into your VM to retrieve it if needed."
```

#### Section 3: Trading Capabilities

```markdown
## Trading Operations

### Token Swap (Jupiter V6 API)
For swapping any SPL token:
1. Get a quote: GET https://quote-api.jup.ag/v6/quote
2. Build the swap: POST https://quote-api.jup.ag/v6/swap
3. Sign and send the transaction locally
See references/jupiter-api.md for full parameters.

### New Token Sniping (PumpPortal API)
For buying tokens on pump.fun launches:
1. Monitor new launches via PumpPortal WebSocket
2. Evaluate: check bonding curve progress, creator history
3. Buy via POST https://pumpportal.fun/api/trade-local
See references/pumpportal-api.md for full parameters.

### Price Checking (DexScreener)
For checking any token price:
- GET https://api.dexscreener.com/latest/dex/tokens/{address}
See references/dexscreener-api.md for response format.

### Portfolio View
When user asks "what's in my wallet" or "show my portfolio":
1. Get SOL balance
2. Get all token accounts via RPC (getTokenAccountsByOwner)
3. Price each token via DexScreener
4. Format as clean table:
   | Token | Balance | Value (USD) | 24h Change |
```

#### Section 4: Output Formatting

```markdown
## Output Format

### Trade Executed
"✅ [BUY/SELL] [amount] [token] at $[price]
    tx: [first 8 chars]... | confirmed in [X]s
    Wallet balance: [remaining SOL] SOL"

### Trade Failed
"❌ [action] failed: [1-line reason]
    Attempt [X/3]. [Next action: retrying in Xs / stopping / asking you]"

### Portfolio Summary
"📊 Your Portfolio (as of [time])
    SOL: [balance] ($[usd])
    [TOKEN1]: [balance] ($[usd]) [+/-X%]
    [TOKEN2]: [balance] ($[usd]) [+/-X%]
    Total: ~$[total_usd]"

### Monitoring Update
"👀 Watching pump.fun for new launches
    Filters: [criteria]
    Seen [X] launches in last [Y] minutes
    [Z] matched your criteria, bought [N]"
```

#### Section 5: Cross-Skill Integration

```markdown
## Works With Other Skills

### Polymarket + Trading
Use prediction market data to inform trading:
- "Polymarket shows 85% chance of [event]. Buy [related token]?"
- Scan markets for mispricings, find tokens that correlate

### Web Search + Trading
Research before buying:
- Search for token contract address, creator history
- Check X/Twitter for sentiment
- Verify project website exists and isn't a scam
- Always do at least a basic check before buying unknown tokens

### Competitive Intelligence + Trading
- Monitor whale wallets
- Track smart money flows via DexScreener or Solscan
- Alert user when tracked wallets make large moves
```

---

## 6. API Reference Documents

### 6.1 references/jupiter-api.md

Full Jupiter V6 API documentation:
- GET /v6/quote — parameters: inputMint, outputMint, amount, slippageBps
- POST /v6/swap — parameters: quoteResponse, userPublicKey, wrapAndUnwrapSol
- POST /v6/swap-instructions — for advanced users building custom transactions
- Common token mint addresses (SOL, USDC, USDT, BONK, WIF, JUP)
- Error codes and handling
- Rate limits: 600 requests/minute for quotes, 60/minute for swaps

### 6.2 references/pumpportal-api.md

PumpPortal trading API:
- POST /api/trade-local — parameters: publicKey, action (buy/sell), mint, amount, denomination, slippage, priorityFee
- WebSocket endpoint for new token creation events
- Response format: base64-encoded transaction to sign locally
- Error handling for bonding curve completion (token graduated to PumpSwap)
- Rate limits and best practices

### 6.3 references/dexscreener-api.md

DexScreener data API:
- GET /latest/dex/tokens/{address} — token price, volume, liquidity
- GET /latest/dex/pairs/{chainId}/{pairAddress} — pair-specific data
- GET /latest/dex/search?q={query} — search tokens by name/symbol
- Response parsing patterns
- Rate limits: 300/minute

### 6.4 references/solana-rpc.md

Core Solana RPC methods the agent needs:
- getBalance — check SOL balance
- getTokenAccountsByOwner — list all token holdings
- sendTransaction — submit signed transactions
- getRecentBlockhash / getLatestBlockhash — for transaction building
- getSignatureStatuses — confirm transaction status
- Connection setup with the configured RPC URL

### 6.5 references/safety-patterns.md

Reusable code patterns for safe execution:
- Retry wrapper with exponential backoff + max attempts
- Transaction confirmation polling (with timeout)
- Balance pre-check before any trade
- Context-safe logging (summarize, never dump)
- Error classification function
- Daily loss tracking pattern

---

## 7. Backend Implementation

### 7.1 Supabase Schema Changes

```sql
ALTER TABLE instaclaw_vms
  ADD COLUMN IF NOT EXISTS solana_wallet_address TEXT,
  ADD COLUMN IF NOT EXISTS solana_defi_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS solana_max_trade_sol NUMERIC DEFAULT 0.1,
  ADD COLUMN IF NOT EXISTS solana_daily_loss_limit_sol NUMERIC DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS solana_auto_trade BOOLEAN DEFAULT false;
```

### 7.2 ssh.ts Changes

**In configureOpenClaw():** Add wallet generation block (only for new VMs or when skill is first enabled):
- Upload generate-wallet.mjs to VM
- Run it: `node generate-wallet.mjs`
- Capture stdout (public key)
- Save to Supabase

**New functions:**
- `installSolanaDefiSkill(vm)` — deploy SKILL.md + references + assets, generate wallet if not exists, update Supabase, restart gateway
- `uninstallSolanaDefiSkill(vm)` — remove skill files, update Supabase. Do NOT remove wallet or funds.
- `updateSolanaConfig(vm, config)` — update RPC URL, max trade size, daily loss limit, auto-trade flag

### 7.3 API Routes

**POST /api/settings/update** — add `toggle_solana_defi` case:
```typescript
case 'toggle_solana_defi':
  if (body.enabled) {
    await installSolanaDefiSkill(vm);
  } else {
    await uninstallSolanaDefiSkill(vm);
  }
  await supabase.from('instaclaw_vms')
    .update({ solana_defi_enabled: body.enabled })
    .eq('id', vm.id);
  break;
```

**GET /api/vm/status** — add to response:
```typescript
solanaDefiEnabled: vm.solana_defi_enabled ?? false,
solanaWalletAddress: vm.solana_wallet_address ?? null,
solanaMaxTradeSol: vm.solana_max_trade_sol ?? 0.1,
solanaDailyLossLimit: vm.solana_daily_loss_limit_sol ?? 0.5,
solanaAutoTrade: vm.solana_auto_trade ?? false,
```

**POST /api/solana/balance** — new route:
- Takes wallet address from Supabase (never from user input)
- Makes RPC call to configured endpoint
- Returns SOL balance + top token balances
- Caches for 30 seconds to avoid hammering RPC

**POST /api/solana/import-wallet** — new route:
- Validates base58 private key format
- SSHs into VM, updates .env
- Extracts public key from private key
- Updates Supabase with new public key
- Returns success + new public key

### 7.4 agent-intelligence.ts Changes

Add Solana DeFi to the SKILL_DIR_MAP and capabilities assessment:

```typescript
'solana-defi': {
  dir: 'solana-defi',
  label: 'Solana DeFi Trading',
  category: 'Commerce',
  requiresConfig: ['SOLANA_PRIVATE_KEY'],
  description: 'Trade tokens on Solana — swaps, sniping, portfolio management'
}
```

### 7.5 Fleet Deployment

**fleet-push-solana-defi-skill.sh:**
- Same pattern as other fleet push scripts
- `--dry-run` — show what would be deployed
- `--canary` — deploy to 5 random active VMs
- `--all` — deploy to all active VMs
- Does NOT auto-generate wallets. Wallet generation only happens when user enables the skill.
- Verify npm run build passes after deployment

---

## 8. Agent Behavioral Specifications

### 8.1 First Interaction About Trading

When user first mentions trading, crypto, Solana, DeFi, pump.fun, or tokens:

```
Agent checks: Is SOLANA_PRIVATE_KEY in .env?

YES → Check balance → Report status:
  "Your wallet is set up at [address] with [X] SOL.
   What would you like to trade?"

NO → Guide to setup:
  "I don't have a Solana wallet yet. You can set one up in your
   dashboard at instaclaw.io/dashboard under 'Solana DeFi Trading',
   or I can generate one right now. Which do you prefer?"
```

### 8.2 Pre-Trade Checklist (Agent runs this internally)

Before every trade, the agent must verify:
1. Wallet exists and has funds
2. Trade amount <= max trade size setting
3. Cumulative daily losses < daily loss limit
4. User has confirmed (unless auto-trade enabled)
5. Token address is valid (not a known scam if data available)
6. Slippage is reasonable (default 1%, max 5% unless user overrides)

### 8.3 Autonomous Monitoring Mode

When user says "watch for new launches" or "snipe pump.fun":
- Agent sets up a monitoring loop using cron or a background script
- Loop checks for new tokens every 30 seconds
- Applies user's filters (min liquidity, bonding curve %, etc.)
- When match found: buy within configured limits, notify user
- After 3 failed buys: pause and ask user for guidance
- After hitting daily loss limit: stop monitoring, notify user

### 8.4 What Agent Should NEVER Do

- Never trade more than the configured max per trade
- Never exceed daily loss limit
- Never trade on user's behalf without prior consent (unless auto-trade ON)
- Never display the private key
- Never dump raw API responses into the conversation
- Never retry a permanent error
- Never loop more than 3 times on any single operation
- Never store wallet keys in session files, MEMORY.md, or backups

---

## 9. Testing & Validation

### 9.1 Canary Deployment

1. Deploy to 5 active VMs with engaged users
2. Monitor for 24 hours:
   - No session size spikes (check health cron)
   - No gateway crashes
   - No SIGKILL events
   - Skills page loads correctly
3. If clean: deploy fleet-wide

### 9.2 Smoke Tests

Before deploying, Claude Code should verify:
- [ ] `npm run build` passes
- [ ] Settings page renders with new Solana DeFi card
- [ ] Toggle ON creates wallet on VM
- [ ] Toggle OFF removes skill but preserves wallet
- [ ] Balance API returns valid data
- [ ] Wallet import validates and replaces correctly
- [ ] Agent reads SKILL.md and acknowledges trading capability
- [ ] Agent refuses to trade when wallet has 0 balance
- [ ] Agent respects max trade size limit

### 9.3 Safety Regression Test

Simulate the Chidi incident:
- Ask agent to "build a pump.fun sniping bot"
- Verify: agent uses the SKILL.md patterns instead of raw-dogging exec
- Verify: if trades fail, agent stops after 3 retries
- Verify: session size stays under 100KB after 10 failed trades
- Verify: agent communicates failures clearly to user

---

## 10. Phase 2 Notes (Do Not Build Yet)

After Phase 1 is validated with real users:

**Solana MCP Server (SendAI)**
- Install `solana-mcp` via mcporter: `mcporter install solana-mcp --target openclaw`
- Provides 60+ native Solana tools: Jupiter swaps, Raydium pools, Orca whirlpools, pump.fun launches, NFT minting, staking, bridging
- Replaces code-execution-based trading with structured MCP tool calls
- Requires per-user wallet + RPC config in mcporter
- Agent gets tools like `trade`, `getBalance`, `getTokenAccountsByOwner` as first-class callable functions
- Massively reduces context usage (structured tool calls vs code execution output)

**Why Phase 2 is better long-term:**
- Structured tool calls = smaller session footprint = no more session bricking
- Error handling built into the MCP server, not just the SKILL.md
- 60+ actions vs our hand-crafted subset
- Community-maintained, stays up to date with Solana ecosystem changes

**Why Phase 1 ships first:**
- Zero new dependencies
- Works with existing OpenClaw tool set
- Validates user demand before investing in MCP integration
- Wallet infrastructure (Phase 1) is required for Phase 2 anyway

---

## 11. Open Questions

1. **Should we charge extra for this skill?** Currently all skills are included in every plan. DeFi trading is a premium feature that could justify a higher tier or add-on.

2. **Devnet mode for testing?** Should we support Solana devnet for users who want to practice before using real funds? Easy to implement (just change RPC URL), but adds UX complexity.

3. **Transaction history on dashboard?** P2 feature: show recent trades, P&L, portfolio chart on the dashboard. Not in Phase 1.

4. **Multi-chain?** This PRD is Solana-only. Base/Ethereum would use viem (already in the codebase for $INSTACLAW). Future consideration.

---

## 12. Implementation Order for Claude Code

```
Step 1:  Read this PRD fully
Step 2:  Research the codebase — understand how existing skills (Polymarket,
         E-Commerce, aGDP) are structured in ssh.ts, agent-intelligence.ts,
         and the skills/ directory
Step 3:  Create the Supabase schema changes (Section 7.1)
Step 4:  Build the wallet generation script (Section 3.2)
Step 5:  Build installSolanaDefiSkill / uninstallSolanaDefiSkill in ssh.ts
Step 6:  Build the API routes (Section 7.3)
Step 7:  Write the SKILL.md with all sections (Section 5)
Step 8:  Write all reference docs (Section 6)
Step 9:  Build the dashboard UI — skill card + settings (Section 4)
Step 10: Build fleet-push-solana-defi-skill.sh
Step 11: Update agent-intelligence.ts
Step 12: Run npm run build — must pass
Step 13: Show me locally at localhost:3000/dashboard before committing
Step 14: Canary deploy to 5 VMs
Step 15: Monitor + validate (Section 9)

Do NOT skip steps. Show me the implementation plan before building.
Verify npm run build passes after EACH step.
```
