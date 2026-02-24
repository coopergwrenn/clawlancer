# Skill 13: Prediction Markets (Polymarket)
## Product Requirements Document — InstaClaw Agent Skill

---

## 1. OVERVIEW

### What
A first-class InstaClaw skill that gives every agent autonomous access to Polymarket prediction markets — browsing, analyzing, monitoring, and optionally trading on behalf of users.

### Why
- Polymarket is the largest prediction market (~$1B+ in monthly volume) and the go-to source for real-time probability data on global events
- Prediction market data is uniquely valuable for agents — it's crowdsourced intelligence that combines financial incentives with forecasting. An agent with Polymarket access becomes a real-time intelligence analyst
- Agents can use prediction market data to inform other skills (competitive intelligence, research, news analysis, financial planning)
- Trading capability turns agents into autonomous alpha generators — a massive differentiator for InstaClaw
- This intersects directly with the crypto wallet infrastructure already shipping (Baets, x402, WorldID verification)

### Why NOW
- Polymarket just published an official `agent-skills` repo (Feb 19, 2026) — they're actively building for agent integration
- Multiple Polymarket MCP servers exist (`@iqai/mcp-polymarket`, `polysolmcp`, `berlinbra/polymarket-mcp`) with full trading support
- The existing Bankr skill already supports `polymarket bets` via CLI — but it's buried inside a broader trading skill with no dedicated UX, no monitoring, no intelligence layer
- An open-source `polymarket-agent` skill exists in the community but lacks InstaClaw integration, wallet coupling, and our intelligence layer
- First-mover advantage: no agent deployment platform ships Polymarket as a native, first-class skill

---

## 2. ECOSYSTEM LANDSCAPE

### What already exists

| Tool | What it does | Limitation |
|------|-------------|------------|
| Bankr Skill (installed) | `bankr prompt "bet $5 on X"` — can place Polymarket bets via CLI | Polymarket is one feature buried in a broad trading skill. No analysis or monitoring. User has to know exactly what to bet on. |
| `@iqai/mcp-polymarket` (npm) | Full MCP server: browse markets, get prices, place orders, manage positions, redeem winnings | Requires Polygon wallet private key + CLOB API credentials. MCP server, not an AgentSkill. |
| `polysolmcp` (GitHub) | MCP server: browse, details, prices, history. Read-only. | No trading. Read-only data access. |
| `openclaw-skills-polymarket-agent` (community) | Full analyst agent: scans markets, researches news, sentiment analysis, trade execution via `poly` CLI | Independent skill, not integrated with InstaClaw wallet infrastructure or model routing. Uses `poly` CLI which requires separate setup. |
| Polymarket/agents (official) | Python framework for autonomous trading agents | Full standalone application, not a skill. Heavy dependencies (Chroma, custom connectors). |
| Polymarket/agent-skills (official) | Brand new repo (Feb 19) — agent skill definitions | Just published, minimal content so far. Worth monitoring. |

### Our advantage
- **Direct CLOB API integration** — we own the full stack. No third-party CLI dependency. Polymarket's official Python and TypeScript SDKs give us full trading capability.
- **Dedicated Polygon wallet per agent** — purpose-built for prediction markets, separate from Base wallet. Clean separation of concerns.
- **Model routing** — Polymarket analysis auto-escalates to Sonnet/Opus for complex research. Simple price checks stay on Haiku.
- **Recurring tasks** — agents can autonomously monitor markets on a schedule without user intervention
- **12-skill ecosystem** — Polymarket data feeds into competitive-intel, web research, and news skills
- **WorldID integration (coming)** — verified human behind every agent, which matters for Polymarket's compliance
- **Polymarket US now live** — CFTC-regulated, no longer geoblocked for US users. Our US user base can trade legally.
- **WebSocket support** — agents can subscribe to real-time price streams for instant alerts, not polling

---

## 3. SKILL ARCHITECTURE

### 3.1 Three Tiers of Functionality

#### Tier 1: Market Intelligence (read-only, ships first)
Every agent gets this. No wallet or API key required.

- **Browse markets**: Search and filter by category (politics, crypto, sports, tech, entertainment), status (open/closed/resolved), volume, liquidity
- **Market details**: Full info on any market — question, outcomes, current prices/probabilities, resolution date, volume, liquidity, description
- **Price tracking**: Current outcome prices and implied probabilities for any market
- **Historical data**: Price and volume time series for backtesting and trend analysis
- **Opportunities report**: Agent autonomously scans open markets, ranks by liquidity and volume, groups by category, surfaces interesting plays
- **News cross-reference**: For any market, agent uses web_search to find relevant recent news, then compares market probability to news sentiment. Identifies potential mispricings.

**Implementation**: Use Polymarket Gamma API (public, no auth required for read operations) via direct HTTP calls from the agent's shell. No MCP server needed for read-only.

```
# Example: Agent fetches top markets
curl -s "https://gamma-api.polymarket.com/markets?limit=10&active=true&order=volume&ascending=false" | jq '.[] | {question, outcomes, outcomePrices, volume}'
```

#### Tier 2: Portfolio & Monitoring (requires Polymarket wallet setup)
For users who complete the one-time Polymarket wallet setup.

- **Portfolio view**: Show all current Polymarket positions, current value, P&L
- **Position tracking**: Monitor specific positions and alert on significant price movements
- **Watchlist**: Agent maintains a list of markets the user is interested in, reports daily summaries
- **Automated alerts**: "Tell me if Bitcoin $200k by March drops below 10%" — agent checks on recurring schedule
- **Resolution tracking**: Alert when positions resolve, show winnings

**Implementation**: Direct Polymarket CLOB API integration using `py-clob-client` (Python) or `@polymarket/clob-client` (TypeScript). Agent generates a Polygon wallet, derives CLOB API credentials, and manages positions directly. No third-party dependency.

**Wallet Architecture**: Polymarket runs on Polygon (chain ID 137). Each agent gets a dedicated Polygon EOA wallet for Polymarket. The agent stores the private key securely on the VM. Users fund via USDC on Polygon (or we build a Base→Polygon bridge helper). This is separate from the Coinbase CDP wallet on Base — purpose-built for prediction markets.

#### Tier 3: Autonomous Trading (requires explicit user opt-in)
For power users who want their agent to trade.

- **Manual trades**: "Bet $10 on YES for 'Will Bitcoin hit $200k by March'"
- **Thesis-driven trades**: "Research the Fed rate decision market and place a bet based on your analysis"
- **Portfolio rebalancing**: "If any position drops below 5% probability, sell it"
- **Risk management**: Hard daily spend cap, position size limits, required user confirmation for trades above threshold
- **Trade logging**: Every trade logged to MEMORY.md with reasoning, entry price, thesis

**Implementation**: Direct CLOB API via official Polymarket SDK. Order flow: agent creates order → signs with Polygon wallet → posts to CLOB. Supports limit orders, market orders, and batch orders. All trades require explicit user opt-in during skill setup. Risk limits enforced in SKILL.md instructions and in a `polymarket-risk.json` config on the VM.

**Setup Flow**:
1. User says "set up Polymarket trading"
2. Agent generates Polygon wallet, stores key in `~/.openclaw/polymarket/wallet.json` (encrypted)
3. Agent derives CLOB API credentials via `createOrDeriveApiKey()`
4. Agent sets token allowances (USDC + conditional tokens for the exchange contracts)
5. User funds wallet with USDC on Polygon
6. Agent confirms setup, shows wallet address + balance
7. Trading enabled with configured risk limits

### 3.2 Safety & Compliance

**CRITICAL**: Polymarket's Terms of Service prohibit US persons from trading on the international platform. Our skill:

1. **Tier 1 (read-only) is available to everyone** — viewing market data is globally accessible
2. **Tier 2 & 3 (trading) include a compliance check** — skill instructions tell the agent to inform users about jurisdictional restrictions before enabling trading
3. **Agent never auto-trades without explicit opt-in** — trading requires the user to explicitly enable it and acknowledge risks
4. **Daily spend cap** — configurable per-user, default $50/day, hard max $500/day
5. **Trade confirmation** — for trades above $25, agent asks for confirmation before executing
6. **Loss limit** — if cumulative losses exceed $100 in a day, trading auto-pauses and agent notifies user

### 3.3 Cross-Skill Integration

The prediction markets skill becomes more powerful when combined with existing skills:

| Combined With | Use Case |
|--------------|----------|
| **competitive-intel** | "What do prediction markets say about our competitor's product launch?" |
| **web-research** | Agent cross-references market probability with latest news to find mispricings |
| **news-monitor** | Breaking news triggers automatic re-analysis of related prediction markets |
| **crypto-wallet (CDP/Base)** | User's Base wallet funds can be bridged to Polygon for Polymarket trading |
| **recurring-tasks** | Daily market scan, position monitoring, alert triggers |
| **telegram** | Agent sends market alerts directly to user's Telegram |
| **WorldID** | Verified human identity satisfies Polymarket's proof-of-personhood, enables higher trust tier |

---

## 4. TECHNICAL IMPLEMENTATION

### 4.1 File Structure
```
~/.openclaw/skills/polymarket/
├── SKILL.md              # Main skill definition (agent reads this)
├── references/
│   ├── gamma-api.md      # Polymarket Gamma API reference (endpoints, params, responses)
│   ├── trading.md        # Trading via CLOB API (commands, safety, limits)
│   ├── analysis.md       # How to analyze markets (framework for mispricings, edge detection)
│   └── examples.md       # Example workflows and outputs
└── scripts/
    └── poly-scan.sh      # Helper script for market scanning (called by agent)
```

### 4.2 Data Flow

```
User: "What are the hottest prediction markets right now?"
    ↓
Agent reads SKILL.md → knows to use Polymarket Gamma API
    ↓
Agent calls: curl "https://gamma-api.polymarket.com/markets?limit=20&active=true&order=volume&ascending=false"
    ↓
Agent parses JSON, filters for high-volume/high-liquidity
    ↓
Agent uses web_search for context on top 5 markets
    ↓
Agent writes formatted report with probabilities, volume, news context, analysis
    ↓
Model routing: Haiku for simple price checks, Sonnet for analysis reports, Opus for thesis-driven trading
```

### 4.3 API Endpoints (Gamma API — no auth required for reads)

| Endpoint | Purpose |
|----------|---------|
| `GET /markets` | List/search markets (filters: active, closed, volume, category) |
| `GET /markets/{id}` | Market details (question, outcomes, prices, dates, description) |
| `GET /markets/{id}/prices` | Current prices and implied probabilities |
| `GET /markets/{id}/history` | Historical price/volume time series |
| `GET /events` | Browse events (groups of related markets) |
| `GET /events/{id}` | Event details with all associated markets |

### 4.4 Trading Flow (Direct CLOB API — no third-party dependency)

```python
# Setup (one-time per agent)
from py_clob_client.client import ClobClient
from ethers import Wallet

HOST = "https://clob.polymarket.com"
CHAIN_ID = 137  # Polygon mainnet

# Agent's dedicated Polymarket wallet (generated during setup)
private_key = load_from_encrypted("~/.openclaw/polymarket/wallet.json")
client = ClobClient(HOST, key=private_key, chain_id=CHAIN_ID)

# Derive API credentials (deterministic from wallet)
api_creds = client.create_or_derive_api_creds()
client.set_api_creds(api_creds)

# Place a trade
order = client.create_and_post_order({
    "token_id": "71321045...",  # From Gamma API market lookup
    "price": 0.55,              # 55 cents = 55% probability
    "size": 10,                 # 10 shares
    "side": "BUY"
}, {"tickSize": "0.01", "negRisk": False})

# Check positions
positions = client.get_positions()

# Cancel an order
client.cancel_order(order["orderID"])
```

```bash
# Agent can also use the TypeScript SDK via shell
npx @polymarket/clob-client --host https://clob.polymarket.com \
  --key $POLYMARKET_PRIVATE_KEY \
  --chain-id 137 \
  order --token-id 71321045 --price 0.55 --size 10 --side BUY
```

**WebSocket for real-time monitoring:**
```python
# Agent subscribes to price updates for watched markets
import websockets, json

async with websockets.connect("wss://ws-subscriptions-clob.polymarket.com/ws/market") as ws:
    await ws.send(json.dumps({
        "type": "subscribe",
        "market": "71321045...",
        "channel": "price"
    }))
    async for message in ws:
        data = json.loads(message)
        # Check against alert thresholds
```

### 4.5 Recurring Market Monitor

```bash
# Agent sets up via recurring task system
# Runs every 4 hours, checks watchlist markets for significant moves

# Fetch watched markets
curl -s "https://gamma-api.polymarket.com/markets?id=MARKET_ID_1,MARKET_ID_2"

# Compare current prices to last saved prices in ~/memory/polymarket-watchlist.json
# If price moved >5%, alert user via Telegram
```

---

## 5. SKILL.md OUTLINE

```markdown
# Polymarket — Prediction Markets Skill

## Purpose
You have access to Polymarket, the world's largest prediction market. Use this skill to browse markets, analyze probabilities, track positions, and optionally execute trades.

## When to use this skill
- User asks about prediction markets, odds, probabilities for events
- User asks "what are the chances of X happening"
- User wants market intelligence on politics, crypto, sports, tech, entertainment events
- User asks to monitor or track specific markets
- User asks to place bets or manage Polymarket positions

## Tier 1: Market Intelligence (always available)
[API reference, example commands, output formatting]

## Tier 2: Portfolio & Monitoring (requires Bankr)
[Position tracking, watchlists, alerts, recurring monitor setup]

## Tier 3: Trading (requires explicit opt-in)
[Trade execution, safety rules, risk limits, compliance notice]

## Analysis Framework
When analyzing a market:
1. Get current prices/probabilities
2. Search for recent news on the topic
3. Compare market probability to news sentiment
4. Identify if market seems overpriced or underpriced
5. Present analysis with clear reasoning
6. Never present as financial advice — always frame as analysis

## Safety Rules
- NEVER auto-trade without explicit user opt-in
- ALWAYS inform users about jurisdictional restrictions before enabling trading
- ALWAYS enforce daily spend cap ($50 default)
- ALWAYS require confirmation for trades >$25
- ALWAYS log trade reasoning to MEMORY.md
- IF cumulative daily losses >$100, pause trading and notify user
```

---

## 6. ROLLOUT PLAN

### Phase 1: Read-Only Intelligence (ship this week)
- Build SKILL.md with Tier 1 (market browsing, analysis, news cross-reference)
- Add `references/gamma-api.md` with full API documentation
- Add `references/analysis.md` with market analysis framework
- Add `scripts/poly-scan.sh` helper for market scanning
- Push to all VMs as Skill 13
- Update CAPABILITIES.md

### Phase 2: Portfolio & Monitoring (ship next week)
- Add Tier 2 to SKILL.md (wallet setup flow, position tracking)
- Install `py-clob-client` on all VMs during configure
- Build wallet generation + encrypted storage (`~/.openclaw/polymarket/wallet.json`)
- Build CLOB credential derivation flow
- Add `references/trading.md` with direct API trading commands
- Add recurring task template for market monitoring
- Add WebSocket price stream script for real-time alerts
- Test with 3-5 internal agents before user rollout

### Phase 3: Autonomous Trading (ship week 3)
- Add Tier 3 to SKILL.md with full safety guardrails
- Build `polymarket-risk.json` config (daily spend cap, position limits, confirmation threshold)
- Add compliance check flow (US users can trade via Polymarket US, inform non-US users of restrictions)
- Add trade logging to MEMORY.md (every trade logged with reasoning, entry price, thesis)
- Add token allowance setup (USDC + conditional tokens for exchange contracts)
- Build Base→Polygon USDC bridge helper (optional, for users who have USDC on Base)
- Test extensively on internal agents before user rollout

---

## 7. SUCCESS METRICS

| Metric | Target |
|--------|--------|
| Agents using Tier 1 (market data) | 50%+ of active agents within 2 weeks |
| Agents using Tier 2 (monitoring) | 20%+ of agents with Polymarket wallet within 1 month |
| Agents using Tier 3 (trading) | 10%+ of agents with Polymarket wallet within 2 months |
| Market data queries per day (fleet) | 500+ within 1 month |
| Zero compliance incidents | 100% — proper jurisdictional disclosures |
| Zero unauthorized trades | 100% — no trades without explicit user opt-in |
| Zero lost funds | 100% — risk limits prevent catastrophic losses |

---

## 8. COMPETITIVE MOAT

No other agent deployment platform ships:
1. Native Polymarket integration as a first-class skill with direct CLOB API access
2. Dedicated Polygon wallet per agent for instant trading — no third-party dependency
3. Intelligent model routing that auto-escalates for complex market analysis
4. Cross-skill intelligence (prediction data feeds into research, competitive intel, news monitoring)
5. WorldID verification (coming) that satisfies Polymarket's proof-of-personhood requirements
6. Recurring task system for autonomous market monitoring without user intervention
7. Real-time WebSocket price streams for instant alerts
8. Full trading stack owned end-to-end — wallet generation, credential derivation, order signing, position management

This is the skill that makes InstaClaw agents genuinely useful for anyone in crypto, politics, finance, or anyone who wants to know "what are the real odds of X happening" — backed by billions in market volume, not vibes.
