---
name: prediction-markets
description: >-
  Trade on Polymarket (crypto) and Kalshi (USD) using pre-installed scripts. Use when the user mentions prediction markets, Polymarket, Kalshi, odds, probability, betting, wagers, portfolio, positions, or market browsing. ALWAYS use ~/scripts/ — never improvise.
---

## ⛔ STOP — Is This Skill Set Up?

**BEFORE doing ANYTHING Polymarket or Kalshi related, run this:**

```bash
python3 ~/scripts/polymarket-setup-creds.py status
```

**If the script is missing, errors out, or shows "not configured":**
1. **DO NOT** build your own Polymarket integration, trading bot, or daemon script
2. **DO NOT** create custom Python files, install py-clob-client yourself, or derive API credentials manually
3. **DO NOT** create wallets, store private keys, or write .env files in your workspace
4. **INSTEAD:** Tell the user: "The Polymarket skill isn't set up on your VM yet. You can enable it at https://instaclaw.io/dashboard/skills, or I can walk you through the official setup."
5. If the user insists on doing it manually, explain that the platform manages wallet security, proxy routing, and credential lifecycle — custom scripts will break and create security risks.

**This is not optional.** Agents who improvise Polymarket integrations create security vulnerabilities (exposed private keys), waste user funds, and produce bots that don't work. Use the official scripts or don't trade.

---

# Prediction Markets
```yaml
name: prediction-markets
version: 2.0.0
updated: 2026-03-04
author: InstaClaw
phase: 3  # Full stack: read-only intelligence (Tier 1), portfolio monitoring (Tier 2), autonomous trading (Tier 3)
platforms:
  - polymarket  # Polygon/USDC.e — crypto-native, CLOB API
  - kalshi      # USD — CFTC-regulated, REST API, BYOK
triggers:
  keywords: [prediction market, polymarket, kalshi, odds, probability, chances, bet on, betting, forecast, market odds, implied probability, wager, betting odds, market intelligence, event probability, market scan, prediction odds]
  phrases: ["what are the chances of", "what are the odds", "prediction market", "polymarket", "kalshi", "will X happen", "probability of", "browse markets", "top prediction markets", "hottest markets", "market analysis", "is X likely", "market scan", "what will happen", "prediction odds"]
  NOT: [stock market, stock price, financial analysis, crypto price, token price]
```

## MANDATORY RULES — Read Before Anything Else

These rules override everything else in this skill file. Violating them causes real financial harm.

**Rule 0 — ALWAYS USE SCRIPTS:** When a user mentions prediction markets, trading, portfolio, positions, Polymarket, Kalshi, or any related topic, IMMEDIATELY use the scripts in ~/scripts/. Do NOT improvise. Do NOT ask the user for API keys or credentials. Do NOT write ad-hoc Python code. You already have everything you need — scripts are pre-installed with credentials configured. Run the script first, show the output, then discuss. If you are unsure whether things are set up, run `python3 ~/scripts/polymarket-setup-creds.py status` — do NOT ask the user.

**Rule 1 — Balance Checks:**

*Polymarket:* When a user asks about their Polymarket wallet balance, funds, money, or whether they can trade, run this and NOTHING else:
```bash
python3 ~/scripts/polymarket-setup-creds.py status
```
This shows USDC.e, native USDC, POL gas, API creds, and approvals. Do NOT check balances with ad-hoc Python, manual RPC calls, or `eth_getBalance`. The script handles RPC failover automatically.

*Kalshi:* When a user asks about their Kalshi balance:
```bash
python3 ~/scripts/kalshi-portfolio.py summary
```
This shows cash balance, portfolio value, positions, and P&L. If it returns `not_configured`, run `python3 ~/scripts/kalshi-setup.py status` to check credential state.

**Rule 2 — Trade Execution:** NEVER write inline Python for trading. ALL trades MUST use these scripts:

### Polymarket Commands
| Action | Command |
|--------|---------|
| Buy (FOK) | `python3 ~/scripts/polymarket-trade.py buy --market-id <id> --outcome YES --amount 10 --json` |
| Buy (GTC limit) | `python3 ~/scripts/polymarket-trade.py buy --market-id <id> --outcome YES --amount 10 --order-type GTC --price 0.65 --json` |
| Sell (FOK) | `python3 ~/scripts/polymarket-trade.py sell --market-id <id> --outcome YES --shares 15 --json` |
| Sell (GTC limit) | `python3 ~/scripts/polymarket-trade.py sell --market-id <id> --outcome YES --shares 15 --order-type GTC --price 0.70 --json` |
| Check Price | `python3 ~/scripts/polymarket-trade.py price --market-id <id> --json` |
| Check Orders | `python3 ~/scripts/polymarket-trade.py check-orders --json` |
| Cancel One | `python3 ~/scripts/polymarket-trade.py cancel --order-id <id> --json` |
| Cancel All | `python3 ~/scripts/polymarket-trade.py cancel-all --json` |
| Convert to Market | `python3 ~/scripts/polymarket-trade.py convert-to-market --order-id <id> --json` |
| Verify | `python3 ~/scripts/polymarket-verify.py order --order-id <id> --wait --json` |
| Positions | `python3 ~/scripts/polymarket-positions.py list --json` |
| Positions (all) | `python3 ~/scripts/polymarket-positions.py list --all --json` |
| Portfolio | `python3 ~/scripts/polymarket-portfolio.py summary --json` |
| Trades | `python3 ~/scripts/polymarket-portfolio.py trades --json` |
| P&L | `python3 ~/scripts/polymarket-positions.py pnl --json` |
| Setup | `python3 ~/scripts/polymarket-setup-creds.py setup --json` |
| Status | `python3 ~/scripts/polymarket-setup-creds.py status --json` |
| Transfer | `python3 ~/scripts/polymarket-wallet.py transfer --token usdc.e --to 0x... --amount 10 --json` |
| Swap | `python3 ~/scripts/polymarket-wallet.py swap --from usdc --to usdc.e --amount 6.70 --json` |
| Ack Risk | `python3 ~/scripts/polymarket-trade.py acknowledge-risk --json` |
| Search Markets | `python3 ~/scripts/polymarket-search.py search --query "bitcoin" --json` |
| Trending Markets | `python3 ~/scripts/polymarket-search.py trending --json` |
| Market Detail | `python3 ~/scripts/polymarket-search.py detail --market-id <id> --json` |

### Kalshi Commands
| Action | Command |
|--------|---------|
| Buy | `python3 ~/scripts/kalshi-trade.py buy --ticker <TICKER> --side yes --amount 10 --json` |
| Sell | `python3 ~/scripts/kalshi-trade.py sell --ticker <TICKER> --side yes --contracts 10 --json` |
| Cancel | `python3 ~/scripts/kalshi-trade.py cancel --order-id <id> --json` |
| Orders | `python3 ~/scripts/kalshi-trade.py orders --json` |
| Positions | `python3 ~/scripts/kalshi-positions.py list --json` |
| History | `python3 ~/scripts/kalshi-positions.py history --limit 20 --json` |
| P&L | `python3 ~/scripts/kalshi-positions.py pnl --json` |
| Portfolio | `python3 ~/scripts/kalshi-portfolio.py summary --json` |
| Detail | `python3 ~/scripts/kalshi-portfolio.py detail --json` |
| Setup | `python3 ~/scripts/kalshi-setup.py setup --api-key-id <KEY> --private-key-file <PEM> --json` |
| Setup (Telegram) | `echo "<PEM_TEXT>" \| python3 ~/scripts/kalshi-setup.py setup-interactive --api-key-id <KEY> --json` |
| Status | `python3 ~/scripts/kalshi-setup.py status --json` |
| Balance | `python3 ~/scripts/kalshi-setup.py balance --json` |
| Browse markets | `python3 ~/scripts/kalshi-browse.py search --query "bitcoin" --json` |
| Trending | `python3 ~/scripts/kalshi-browse.py trending --limit 10 --json` |
| Market detail | `python3 ~/scripts/kalshi-browse.py detail --ticker <TICKER> --json` |
| Categories | `python3 ~/scripts/kalshi-browse.py categories --json` |

**Rule 3 — No Faking (STRICT):** NEVER report a trade as executed without a real order ID and MATCHED fill status. NEVER generate fake P&L tables or dashboards from memory. NEVER show portfolio data without running a script. If a script fails, report the exact error — do not make up results. Specific cases:
- LIVE or PENDING status ≠ executed. An order sitting in the book is NOT a completed trade.
- NEVER combine pending orders and filled positions in the same P&L table. They are fundamentally different.
- If 3 trades were placed and only 1 filled, report honestly: "1 of 3 trades filled. 2 orders are pending in the orderbook."
- NEVER say "market order" if you placed a limit (GTC) order. Report what ACTUALLY happened.
- NEVER fabricate transaction hashes, share counts, or fill prices.

**Rule 4 — No Hedging:** NEVER buy both YES and NO on the same market. That's a zero-EV hedge.

**Rule 5 — Setup First:** ALWAYS run the appropriate status command before attempting ANY trade:
- Polymarket: `polymarket-setup-creds.py status`
- Kalshi: `kalshi-setup.py status`
If status shows problems (missing creds, missing approvals, wrong USDC type, no gas), tell the user what's wrong and do not proceed.

**Rule 6 — Token Transfers (Polymarket only):** To send tokens from the wallet, use:
```bash
python3 ~/scripts/polymarket-wallet.py transfer --token usdc.e --to 0x... --amount 10
```
To swap native USDC to USDC.e:
```bash
python3 ~/scripts/polymarket-wallet.py swap --from usdc --to usdc.e --amount 6.70
```
NEVER tell the user to do manual transfers via Polygonscan or MetaMask. Use the script.

**Rule 7 — US Region Warning (Polymarket):** ALWAYS check `~/.openclaw/.env` for `AGENT_REGION` BEFORE starting any Polymarket wallet setup for a new user. If `AGENT_REGION` starts with `us`, show the warning FIRST — before wallet creation, before funding, before anything.

Show the user this exact message:

> Polymarket's international markets are not officially available in the US. By proceeding, you acknowledge:
> - Your funds could be restricted to close-only or permanently frozen by Polymarket at any time
> - This access is provided as-is until US regulations change
> - Use at your own risk
>
> Reply 'I understand the risks' to enable full Polymarket trading, or 'US markets only' for CFTC-regulated markets.

If user says 'I understand the risks', run:
`python3 ~/scripts/polymarket-trade.py acknowledge-risk`
Then proceed with wallet setup.

If user says 'US markets only', suggest Kalshi as the US-regulated alternative — it's already integrated. Run `python3 ~/scripts/kalshi-setup.py status` to check if Kalshi is configured.

This warning also triggers automatically if a trade returns BLOCK with "risk acknowledgment" required (safety net for cases where the proactive check was missed).

**Rule 9 — Liquidity Awareness:** ALWAYS check 24h volume before trading. Run `python3 ~/scripts/polymarket-trade.py price --market-id <id>` to see orderbook depth. If 24h volume < $10,000, WARN the user: "This market has low liquidity ($X 24h volume). Orders may not fill or may have high slippage." NEVER place orders > $20 on markets with < $10K 24h volume without explicit user confirmation.

**Rule 10 — Order Monitoring:** For GTC orders, check order status within 60 seconds of placement using `python3 ~/scripts/polymarket-trade.py check-orders`. Inform the user if orders are PENDING (not filled). Present options: cancel (`cancel --order-id`), adjust price, convert to market (`convert-to-market --order-id`), or wait. NEVER show pending orders as part of P&L calculations.

**Rule 11 — Retry Limit:** If the same command fails with the same error TWICE, STOP. Do NOT retry a third time. Instead: (1) show the exact error message, (2) suggest an alternative approach (different price, different order type, different market, check liquidity), (3) ask the user what they want to do. NEVER bang on the same wall more than twice. NEVER blame the tools, the CLI, or the API — if something fails, investigate why.

**Rule 12 — NEVER PIVOT WITHOUT PERMISSION:** Once a user says buy or sell, execute THAT trade. Do NOT suggest alternative markets or different outcomes unless explicitly asked. If search returns no exact match, say so — do not substitute.

**Rule 13 — Memory Hygiene:** After resolving a trading infrastructure error (proxy down, RPC timeout, script missing), remove or update any MEMORY.md entries that logged the error. Stale error notes mislead future sessions.

**Rule 14 — FOK FIRST, NO BAD GTC FALLBACK:** Default order type is FOK (Fill-or-Kill) with 2% slippage. This means your buy price = best_ask × 1.02, and sell price = best_bid × 0.98. This is normal and expected — it ensures fills across multiple price levels. Key rules:
- NEVER place GTC orders below the best ask (buys) or above the best bid (sells). That creates unfilled orders that sit forever.
- If FOK fails, DO NOT automatically fall back to GTC. Report the failure to the user and ask what they want to do.
- The `--slippage` flag controls max slippage (default 2%). Example: `--slippage 5` allows 5% slippage for thin markets.
- If FOK fails even with slippage, the script reports available liquidity — share that with the user so they can decide.

**Rule 16 — SETTLEMENT DELAYS:** After selling a position, it can take 5–30 seconds for the USDC.e balance to become available for new trades. If a buy fails with "insufficient balance" right after a sell:
- The script will automatically wait and retry (up to 3 times, 10 seconds apart). Let it work.
- Do NOT tell the user "something is blocking trades" or "wallet is stuck."
- Do NOT suggest waiting until morning or giving up.
- Simply say: "Funds settling from your sell, retrying in a few seconds..."
- If still failing after 30 seconds, say: "Settlement is taking longer than usual, try again in a minute."

**Rule 17 — MINIMUM ORDER SIZE:** Polymarket requires minimum $1 maker amount per order. When trading cheap outcomes (under $0.20), you need at least $5-10 to clear the minimum after rounding. If a trade fails with "invalid amount" or "min size", tell the user to increase their amount — do NOT say "insufficient balance." The script auto-rounds up when the order is close to the minimum, but very small amounts will be rejected outright. Example: buying YES at $0.13 with $1 rounds to $0.99 maker — the script bumps it to $1.04 automatically. But $0.50 at $0.13 is too far below minimum.

**Rule 8 — Kalshi BYOK (Bring Your Own Key):** Kalshi API keys are created by the user on kalshi.com. The agent NEVER creates Kalshi accounts. Telegram-friendly onboarding flow:

1. Tell the user: "Go to kalshi.com → Settings → API → Create API Key"
2. Tell the user: "Copy your API Key ID (a short string like 'abc123-def456')"
3. Tell the user: "Download the private key .pem file, open it in a text editor, and paste the ENTIRE contents here in a message"
4. When user pastes PEM text (starts with `-----BEGIN` and ends with `-----END`):
   a. Save the PEM to `~/.openclaw/prediction-markets/kalshi-private-key.pem` (write file, chmod 600)
   b. Run: `python3 ~/scripts/kalshi-setup.py setup --api-key-id <KEY_ID> --private-key-file ~/.openclaw/prediction-markets/kalshi-private-key.pem --json`
   c. If verification succeeds: "Connected to Kalshi! Your balance is $X.XX"
   d. If verification fails: "That key didn't work. Double-check you copied the full PEM including the BEGIN/END lines, and the correct API Key ID."

Alternative (if PEM is already on the filesystem):
`python3 ~/scripts/kalshi-setup.py setup --api-key-id <KEY> --private-key-file /path/to/key.pem`

---

## FIRST CONTACT — New User Onboarding

When a user mentions prediction markets for the FIRST time and NO platforms are configured yet:

1. Check `~/.openclaw/.env` for `AGENT_REGION`
2. Check platform status:
   - Does `~/.openclaw/polymarket/wallet.json` exist? (Polymarket configured)
   - Does `~/.openclaw/prediction-markets/kalshi-creds.json` exist? (Kalshi configured)

3. If NEITHER is configured, present options based on region:

**FOR US USERS** (AGENT_REGION starts with "us"), say:

> I can set you up with prediction market trading. You have two options:
>
> **Polymarket** — The world's largest prediction market. Thousands of markets covering politics, crypto, sports, and world events. Uses crypto (USDC on Polygon). Important: Polymarket's international platform isn't officially available in the US — there's regulatory risk involved, and your funds could potentially be frozen. Most of our users choose this option for the wider market selection.
>
> **Kalshi** — CFTC-regulated, fully legal in the US. Fund with USD via bank transfer or debit card. Fewer markets but zero regulatory risk. Requires KYC (government ID verification) on kalshi.com.
>
> Which would you prefer? You can always add the other one later.

**FOR NON-US USERS** (AGENT_REGION does not start with "us", or is not set), say:

> I can set you up with prediction market trading on Polymarket — the world's largest prediction market with thousands of markets on politics, crypto, sports, and world events.
>
> Want me to get you set up?

Do NOT offer Kalshi to non-US users — it requires US KYC/residency.

---

## Overview

You have access to **two prediction market platforms**:

### Polymarket (Crypto-Native)
- World's largest prediction market (~$1B+ monthly volume)
- **Collateral:** USDC.e on Polygon (chain ID 137)
- **API:** Gamma (read-only, no auth) + CLOB (trading, key derivation)
- **Account:** Auto-provisioned from Polygon wallet
- **Strengths:** Massive liquidity, broad market coverage, multi-outcome markets
- **Region:** International (US agents use proxy — see Rule 7)

### Kalshi (US-Regulated)
- CFTC-regulated prediction exchange
- **Collateral:** USD (real dollars, funded via bank/card on kalshi.com)
- **API:** REST v2 with RSA key-pair auth
- **Account:** User creates on kalshi.com (BYOK model)
- **Strengths:** Legal in US, no crypto required, regulated settlement
- **Region:** US-based, no geoblock

**What prediction markets are:** Markets where people trade on event outcomes. Prices represent crowd-consensus probabilities. A YES share at $0.65 means the crowd estimates 65% probability.

**Why this matters:** Prediction market data is crowdsourced intelligence backed by real money. Unlike polls or pundit opinions, participants have skin in the game. This makes the data uniquely reliable for forecasting.

## When to Use This Skill

- User asks about prediction markets, odds, or probabilities for events
- User asks "what are the chances of X happening"
- User wants market intelligence on politics, crypto, sports, tech, entertainment
- User asks to browse or search prediction markets
- User asks for an "opportunities report" or "market scan"
- User wants to compare market probability to recent news
- User mentions Polymarket or Kalshi by name
- Another skill (competitive-intelligence, financial-analysis) needs probability data on an event

**Do NOT use this skill for:**
- Stock prices or financial instrument quotes (use financial-analysis skill)
- Crypto token prices (use financial-analysis skill)
- Sports scores or stats (only use for prediction market odds on sports outcomes)

## Platform Routing

When a user asks to trade or check positions, determine the platform:

1. **User specifies platform** — Use that platform
2. **User says "Kalshi"** — Use Kalshi scripts
3. **User says "Polymarket"** — Use Polymarket scripts
4. **User says "prediction market" generically** — Check which platforms are configured:
   - Run `kalshi-setup.py status` and `polymarket-setup-creds.py status`
   - If only one is configured, use that one
   - If both configured, ask user which platform
   - If neither configured, follow the FIRST CONTACT onboarding flow above
5. **Market browsing (read-only)** — Use Gamma API (Polymarket) by default for unauthenticated browsing. If Kalshi is configured, also use `kalshi-browse.py` for Kalshi market data.

**IMPORTANT — Kalshi is US-only:** Kalshi requires US residency and government ID verification (KYC). Do NOT offer Kalshi to non-US users. If a non-US user asks about Kalshi, explain: "Kalshi is only available to US residents — it requires US government ID verification. Polymarket is your best option for prediction market trading."

---

## Gamma API Reference (Polymarket — Read-Only)

Base URL: `https://gamma-api.polymarket.com`

No authentication required. All endpoints are public and read-only.

### List Markets

```bash
curl -s "https://gamma-api.polymarket.com/markets?limit=10&closed=false&order=volume24hr&ascending=false"
```

**Key parameters:**
| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Number of results (default 100, max 100) |
| `offset` | int | Pagination offset |
| `closed` | bool | `false` = open markets only |
| `order` | string | Sort field: `volume24hr`, `volumeNum`, `liquidityNum`, `endDate` |
| `ascending` | bool | Sort direction (`false` = highest first) |

**Searching/filtering by topic:** The Gamma API does NOT support server-side text search or category filtering. To find markets on a specific topic, fetch a large batch (`limit=100`) and filter client-side by keyword matching on the `question` field. See the "Searching for Markets" section below.

### Get Market Details

```bash
curl -s "https://gamma-api.polymarket.com/markets/{id}"
```

### List Events (grouped markets)

```bash
curl -s "https://gamma-api.polymarket.com/events?limit=10&closed=false&order=volume&ascending=false"
```

Events group related markets (e.g., "2028 Democratic Nominee" contains 128+ candidate markets). Supports `limit`, `offset`, `closed`, `order` (use `volume`, `volume24hr`, `endDate`, `createdAt`), `ascending`.

### Key Response Fields (Markets)

```
id              — Market ID (use for /markets/{id})
question        — The prediction question (e.g., "Will Bitcoin hit $200k by June?")
outcomes        — JSON string: ["Yes", "No"] or multi-outcome (MUST parse with json.loads)
outcomePrices   — JSON string: ["0.65", "0.35"] (prices = implied probabilities, MUST parse)
volumeNum       — Total all-time trading volume (USD)
volume24hr      — 24-hour trading volume (USD)
liquidityNum    — Current market liquidity (USD)
endDate         — Resolution deadline (ISO 8601)
endDateIso      — Short date format (e.g., "2026-03-18") — sometimes missing
description     — Full market description with resolution criteria
closed          — Whether market has closed
bestAsk         — Best ask price
lastTradePrice  — Most recent trade price
slug            — URL-friendly market identifier
events          — Array of associated event objects (use events[0].slug for URLs)
```

**Sometimes-missing fields** (use `.get()` with defaults, never assume present):
- `bestBid` — missing on ~15% of markets
- `oneDayPriceChange` — missing on ~30% of markets
- `oneWeekPriceChange` — missing on ~25% of markets
- `endDateIso` — missing on ~5% of markets

### Rate Limits

Be respectful. No auth = no rate limit enforcement, but:
- **Max 1 request per second** for browsing flows
- **Batch where possible** — fetch 20 markets in one call, not 20 individual calls
- If API returns errors or empty responses, back off for 30 seconds
- **Never loop aggressively** — a market scan should be 3-5 API calls total, not 50

### Graceful Degradation

If the Gamma API is unreachable (timeout, 500 error, empty response):
1. Tell the user: "Polymarket data is temporarily unavailable. The Gamma API may be experiencing issues."
2. Suggest trying again in a few minutes
3. Do NOT crash, retry infinitely, or hallucinate market data

---

## Kalshi API Reference (Authenticated)

Base URL: `https://trading-api.kalshi.com/trade-api/v2`

All endpoints require RSA key-pair authentication. See `references/kalshi-api.md` for full details.

### Key Concepts

- **Prices:** Cents (1-99). YES at 45 = $0.45 = 45% implied probability
- **Balances:** Cents. `50000` = $500.00
- **Settlement:** Binary — pays $1.00 (100c) if correct, $0.00 if wrong
- **Ticker format:** `KXBTC-26MAR14-B90000` = event-date-strike

### Key Endpoints

```
GET /markets                — List markets (paginated)
GET /markets/{ticker}       — Single market by ticker
GET /portfolio/balance      — Cash balance + portfolio value
GET /portfolio/positions    — Open positions
GET /portfolio/orders       — Order history
POST /portfolio/orders      — Place order
DELETE /portfolio/orders/{id} — Cancel order
```

### Order Format

```json
{
  "ticker": "KXBTC-26MAR14-B90000",
  "action": "buy",
  "side": "yes",
  "type": "limit",
  "count": 10,
  "yes_price": 45
}
```

Fields: `ticker` (required), `action` (`buy`/`sell`), `side` (`yes`/`no`), `type` (`limit`/`market`), `count` (contracts), `yes_price`/`no_price` (cents 1-99), `time_in_force` (`fill_or_kill`, `good_till_canceled`, `immediate_or_cancel`).

---

## Output Formatting

When presenting market data, always use this structure:

### Single Market Report
```
**[Market Question]**
https://polymarket.com/event/[event_slug]/[market_slug]

| Outcome | Price | Implied Probability |
|---------|-------|-------------------|
| Yes     | $0.65 | 65%               |
| No      | $0.35 | 35%               |

Volume (24h): $1,234,567
Total Volume: $45,678,901
Liquidity: $890,123
Resolution: March 15, 2026
24h Change: +3.2%

[Brief context from web search if relevant]
```

### Kalshi Market Report
```
**[Market Title]**
Ticker: KXBTC-26MAR14-B90000

| Side | Bid | Ask | Last |
|------|-----|-----|------|
| YES  | 43c | 45c | 44c  |
| NO   | 55c | 57c | 56c  |

Volume (24h): $123,456
Open Interest: 5,000 contracts
Expires: March 14, 2026
```

### Multi-Market Report (Top Markets / Scan)
```
**Top Prediction Markets by 24h Volume**
Updated: Mar 4, 2026

| # | Market | Yes | No | 24h Vol | Total Vol |
|---|--------|-----|-----|---------|-----------|
| 1 | Will the Fed cut rates in March? | 72% | 28% | $5.2M | $69.3M |
| 2 | Bitcoin above $150k by April? | 41% | 59% | $3.1M | $22.7M |
| 3 | US strikes Iran by March? | 18% | 82% | $2.6M | $394.5M |

[Brief analysis of what's driving volume]
```

### Multi-Outcome Markets

Some markets have more than 2 outcomes (e.g., "Who will win the election?"). For these:
```
**Who will be the 2028 Democratic nominee?**

| Candidate | Price | Implied Probability |
|-----------|-------|-------------------|
| Gavin Newsom | $0.28 | 28% |
| Gretchen Whitmer | $0.15 | 15% |
| Pete Buttigieg | $0.12 | 12% |
| Josh Shapiro | $0.09 | 9% |
| Other | $0.36 | 36% |

Total Volume: $707M | Liquidity: $12.3M
```

Note: Multi-outcome prices may not sum to exactly 100% (due to vig/spread). This is normal.

## Analysis Framework

When a user asks for analysis on a market (not just prices), follow this process:

### Step 1: Get Market Data
```bash
# Fetch top markets and filter client-side for the topic
curl -s "https://gamma-api.polymarket.com/markets?limit=100&closed=false&order=volume24hr&ascending=false" | \
  python3 -c "
import json, sys
markets = json.load(sys.stdin)
# Filter by keyword (adjust search terms for the topic)
matches = [m for m in markets if 'fed' in m['question'].lower() or 'rate' in m['question'].lower()]
for m in matches[:5]:
    prices = json.loads(m['outcomePrices'])
    print(f\"{m['question']} — Yes: {float(prices[0])*100:.0f}%\")
"
```

### Step 2: Cross-Reference with News
Use `web_search` to find 3-5 recent news articles related to the market topic.

### Step 3: Compare Market vs. News Sentiment
- Is the market pricing consistent with the latest news?
- Has something happened that the market hasn't priced in yet?
- Are experts or data sources suggesting a different probability?

### Step 4: Cross-Platform Comparison
If both Polymarket and Kalshi have the same event, compare prices:
- Price differences > 3% may indicate an arbitrage opportunity
- Note: different settlement rules mean "same event" may resolve differently
- Always check resolution criteria on both platforms

### Step 5: Present Analysis
```
**Market Analysis: Will the Fed Cut Rates in March?**

Current Market: Polymarket 72% Yes | Kalshi 68% Yes

**Recent Developments:**
- Feb 21: CPI came in at 2.8% (above 2.6% expected)
- Feb 23: Fed Governor Waller speech hinted at "patience"
- Feb 24: CME FedWatch tool shows 68% probability of hold

**Cross-Platform Note:**
Polymarket at 72% is 4 points above Kalshi at 68%. CME FedWatch aligns closer to Kalshi.

**Assessment:**
The market at 72% for a cut appears slightly optimistic given the hotter-than-expected CPI.

*This is market analysis based on publicly available data, not financial advice.
Prediction market prices reflect crowd consensus, not guaranteed outcomes.*
```

### Step 6: Disclaimer
ALWAYS include at the end of any analysis:
> *This is market analysis based on publicly available data, not financial advice. Prediction market prices reflect crowd consensus, not guaranteed outcomes.*

## Searching for Markets

The Gamma API has **no server-side text search or category filter**. To find markets on a specific topic, fetch a batch and filter client-side:

```bash
# Search by keyword in the question field
curl -s "https://gamma-api.polymarket.com/markets?limit=100&closed=false&order=volume24hr&ascending=false" | \
  python3 -c "
import json, sys
markets = json.load(sys.stdin)
# Change the keywords for your topic
keywords = ['bitcoin', 'btc', 'crypto']
matches = [m for m in markets if any(kw in m['question'].lower() for kw in keywords)]
for m in matches[:10]:
    prices = json.loads(m['outcomePrices'])
    print(f\"{m['question'][:60]} — Yes: {float(prices[0])*100:.0f}% — Vol: \${m.get('volume24hr',0):,.0f}\")
"
```

**Common keyword sets for filtering:**
- Politics: `['trump', 'biden', 'election', 'president', 'congress', 'senate', 'fed ', 'supreme court']`
- Crypto: `['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'token', 'defi']`
- Sports: `['win the', 'nba', 'nfl', 'premier league', 'champions league', 'super bowl', 'world cup']`
- Tech: `['apple', 'google', 'openai', 'ai ', 'launch', 'release']`

## Common Queries (Quick Reference)

```bash
# Top markets by 24h volume (most active right now)
curl -s "https://gamma-api.polymarket.com/markets?limit=20&closed=false&order=volume24hr&ascending=false"

# Biggest events (grouped markets)
curl -s "https://gamma-api.polymarket.com/events?limit=10&closed=false&order=volume&ascending=false"

# Markets closing soon (next 7 days)
curl -s "https://gamma-api.polymarket.com/markets?limit=20&closed=false&order=endDate&ascending=true"

# Single market by ID
curl -s "https://gamma-api.polymarket.com/markets/654415"

# Single event by ID (with all associated markets)
curl -s "https://gamma-api.polymarket.com/events/30829"
```

## Parsing API Responses

The `outcomes` and `outcomePrices` fields are JSON strings, not arrays. Parse them:

```bash
# Using Python for richer formatting
curl -s "https://gamma-api.polymarket.com/markets?limit=5&closed=false&order=volume24hr&ascending=false" | \
  python3 -c "
import json, sys
markets = json.load(sys.stdin)
for m in markets:
    outcomes = json.loads(m['outcomes'])
    prices = json.loads(m['outcomePrices'])
    print(f\"Q: {m['question']}\")
    for o, p in zip(outcomes, prices):
        pct = float(p) * 100
        print(f\"  {o}: {pct:.1f}%\")
    print(f\"  Vol 24h: \${m.get('volume24hr', 0):,.0f}\")
    print(f\"  Total:   \${m['volumeNum']:,.0f}\")
    print()
"
```

## Cross-Skill Integration

### With competitive-intelligence
When researching a competitor or industry event, check if there's a related prediction market. Include market probabilities in competitive intelligence reports for quantitative forecasting.

### With financial-analysis
When analyzing stocks or crypto, check related prediction markets for event risk. Fed rate decision markets directly impact stock/bond outlooks.

### With web-search-browser
Every market analysis should include a web search step. The analysis framework above shows this pattern. Never present market prices without context.

### With recurring tasks (heartbeat system)
For monitoring use cases, the agent can set up a recurring task via the heartbeat/cron system:
```
"Check the Bitcoin $200k market every morning and alert me if probability changes by >5%"
→ Recurring task: curl the market by ID, compare to saved price, alert via message if delta > 5%
```

## Opportunities Report

When user asks for a "market scan" or "opportunities report", produce:

1. **Top 10 by 24h volume** — What's hot right now
2. **Biggest movers (24h)** — Markets with largest price swings
3. **High-volume, close-to-resolution** — Markets ending within 7 days with >$100k volume
4. **Cross-reference top 3 with news** — Quick analysis on whether prices seem right
5. **Cross-platform comparison** — If Kalshi is configured, compare prices on overlapping events

Use 3-5 API calls total. Don't fetch individually — use `limit=20` and filter client-side.

---

## Polymarket Onboarding Flow

Follow these steps IN ORDER for new Polymarket users:

1. **Check region FIRST:** Read `AGENT_REGION` from `~/.openclaw/.env`
2. **IF US region** (starts with "us"): Show Rule 7 warning BEFORE any wallet setup. Wait for user to say "I understand the risks" or choose Kalshi instead. If they acknowledge, run `python3 ~/scripts/polymarket-trade.py acknowledge-risk`.
3. **Create wallet:** `bash ~/scripts/setup-polymarket-wallet.sh`
4. **Derive CLOB credentials:** `python3 ~/scripts/polymarket-setup-creds.py setup`
5. **Show wallet address and funding instructions** (see "How to Fund" below)
6. **User funds wallet** with USDC.e + POL gas
7. **Send ERC-20 approvals:** `python3 ~/scripts/polymarket-setup-creds.py approve`
8. **Ready to trade**

## Polymarket Wallet Setup

Your agent has a dedicated Polygon wallet for Polymarket trading. To set it up:

```bash
bash ~/scripts/setup-polymarket-wallet.sh
```

This generates a Polygon EOA wallet and stores it at `~/.openclaw/polymarket/wallet.json` with `0o600` permissions (owner-read-only).

**Important chain details:**
- **Chain: Polygon (chain ID 137)** — NOT Base, NOT Ethereum mainnet
- **Gas token:** POL/MATIC (~0.1 POL is enough for many transactions)
- **Trading token:** USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` (bridged USDC on Polygon)

**CRITICAL — USDC.e vs native USDC:**
Polymarket uses **USDC.e** (bridged), NOT native USDC (`0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`). These are different tokens on the same chain. If the user sends native USDC to the agent wallet, it will show a balance but **cannot be used for trading** until converted.

## How to Fund Your Polymarket Wallet

When a user needs to fund their agent's Polymarket wallet, walk them through these options:

**OPTION 1 — User has crypto (easiest):**
"Send USDC.e to your agent's wallet on the Polygon network:
- Address: [show wallet address from wallet.json]
- Network: Polygon (NOT Ethereum, NOT Base)
- Token: USDC.e (bridged USDC, contract `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`)
- Also send ~$0.10 worth of POL to the same address for transaction fees."

**OPTION 2 — User sent wrong USDC type:**
"Your agent has native USDC but needs USDC.e. I can swap it automatically — just make sure there's a small amount of POL in the wallet for gas."
Command: `python3 ~/scripts/polymarket-wallet.py swap --from usdc --to usdc.e --amount <AMOUNT>`

**OPTION 3 — User has no crypto at all:**
"You can buy USDC on an exchange like Coinbase or Binance, then send it to your agent's Polygon wallet address. Make sure you:
1. Buy USDC (any type)
2. Withdraw to the **Polygon network** (not Ethereum — much cheaper fees)
3. Send to: [wallet address]
4. Also send a tiny amount of POL/MATIC for gas fees (~$0.10 worth)"

**Common mistakes to warn about:**
- Sending on Ethereum instead of Polygon (tokens won't show up, recovery is complex)
- Sending native USDC instead of USDC.e (fixable with swap command above)
- Forgetting gas — wallet needs POL to do any on-chain transactions

**Check balance:** `python3 ~/scripts/polymarket-setup-creds.py status` — shows both USDC.e and native USDC balances

## Kalshi Account Setup

Kalshi is a **BYOK (Bring Your Own Key)** integration. The user must create their own account and API keys. **Kalshi is US-only** — requires US residency and government ID.

### Setup Steps (Telegram-Friendly)
1. Tell user: "Go to kalshi.com, create an account (includes KYC with government ID), and fund it"
2. Tell user: "Go to Settings → API → Create API Key"
3. Tell user: "Copy your API Key ID (a short string like 'abc123-def456')"
4. Tell user: "Download the private key .pem file, open it in a text editor, and paste the ENTIRE contents here in a message"
5. When user pastes PEM text (starts with `-----BEGIN` and ends with `-----END`):
   a. Save the PEM to `~/.openclaw/prediction-markets/kalshi-private-key.pem` (write file, chmod 600)
   b. Run: `python3 ~/scripts/kalshi-setup.py setup --api-key-id <KEY_ID> --private-key-file ~/.openclaw/prediction-markets/kalshi-private-key.pem --json`
   c. If verification succeeds: "Connected to Kalshi! Your balance is $X.XX"
   d. If verification fails: "That key didn't work. Double-check you copied the full PEM including the BEGIN/END lines."

**Credentials stored at:** `~/.openclaw/prediction-markets/kalshi-creds.json` (0o600 permissions)

**Check status:** `python3 ~/scripts/kalshi-setup.py status` — shows whether API key is configured and tests authentication

**Check balance:** `python3 ~/scripts/kalshi-setup.py balance` — shows USD balance from Kalshi API

### Kalshi Funding

After connecting your Kalshi API key, fund your account on kalshi.com:
1. Log into kalshi.com
2. Click "Deposit" or go to Account → Deposit
3. Add funds via bank transfer (ACH), debit card, or wire transfer
4. Funds are in USD — no crypto needed
5. Funds available immediately for card deposits, 1-3 business days for bank transfers

Your agent can check your balance anytime: `python3 ~/scripts/kalshi-setup.py balance`

### Kalshi Risk Config

The first time a trade is attempted, a default risk config is auto-created at `~/.openclaw/prediction-markets/kalshi-risk-config.json`:
- `enabled`: `false` (user must explicitly enable)
- `daily_spend_cap`: $50
- `max_position_size`: $100
- `daily_loss_limit`: $100
- `confirmation_threshold`: $25

To enable trading, the agent updates `enabled` to `true` after user confirms. Adjust limits based on user preference ("go conservative" → lower limits, "I want to trade bigger" → raise them).

---

## Tier 2: Portfolio & Monitoring

### Market Watchlist

The watchlist file at `~/memory/polymarket-watchlist.json` tracks markets the user wants to monitor:

```json
{
  "version": 1,
  "markets": [
    {
      "id": "654415",
      "question": "Will Bitcoin hit $200k by June 2026?",
      "alertThreshold": 0.05,
      "lastPrice": 0.41,
      "lastChecked": "2026-02-24T10:00:00Z",
      "notes": "User is bullish, watching for entry",
      "alerts": [
        { "type": "price_above", "value": 0.50, "triggered": false },
        { "type": "price_below", "value": 0.30, "triggered": false }
      ],
      "positionRef": null
    }
  ]
}
```

### Recurring Monitoring

Monitoring integrates with the heartbeat/cron system for automated checks:

**4-Hour Market Check:**
- Fetch all watched markets via Gamma API
- Compare current price to `lastPrice`
- If price changed by more than `alertThreshold`, trigger alert

**Daily Summary (9am user-local time):**
- Compile all watched markets with current prices and 24h changes
- Include any open positions on both platforms with unrealized P&L

**Weekly P&L Report (Sunday):**
- Aggregate all trading activity for the week across both platforms
- Calculate realized P&L from closed positions
- Compare performance to simple hold strategies

### Alert System

Supported alert types:
| Type | Description | Example |
|------|-------------|---------|
| `price_above` | Triggers when YES price exceeds value | "Alert me if Bitcoin 200k goes above 60%" |
| `price_below` | Triggers when YES price drops below value | "Alert me if Fed rate cut drops below 50%" |
| `resolution` | Triggers when market resolves | "Tell me when the election market resolves" |
| `volume_spike` | Triggers when 24h volume increases by >2x | "Alert me if there's unusual activity" |

---

## Tier 3: Autonomous Trading (Opt-In Required)

> **All mandatory rules are at the top of this file.** See "MANDATORY RULES" section above.

### Safety First

**NEVER auto-trade without explicit user opt-in.** Before every trade, the agent checks the risk config:

**Polymarket:** `~/.openclaw/polymarket/risk-config.json`
```json
{
  "enabled": false,
  "dailySpendCapUSDC": 50,
  "confirmationThresholdUSDC": 25,
  "dailyLossLimitUSDC": 100,
  "maxPositionSizeUSDC": 100
}
```

**Kalshi:** `~/.openclaw/prediction-markets/kalshi-risk-config.json`
```json
{
  "enabled": false,
  "daily_spend_cap": 50.00,
  "max_position_size": 100.00,
  "daily_loss_limit": 100.00
}
```

- **enabled** — `false` by default. Must be explicitly set to `true` by the user.
- **daily spend cap** — Maximum total spending per day. Agent refuses trades that would exceed this.
- **max position size** — Maximum size for any single position.
- **daily loss limit** — If losses exceed this, trading halts automatically.

### Trade Execution Flow (6-Step Mandatory Process)

Every Polymarket trade MUST follow these 6 steps in order. Skipping steps causes the problems found in testing (unfilled orders, fake P&L, bad retries).

**Step 1 — RESEARCH:** Understand the market before trading.
- Search for the market: `python3 ~/scripts/polymarket-search.py search --query "topic" --json`
- Get full detail: `python3 ~/scripts/polymarket-search.py detail --market-id <condition_id> --json`
- Check resolution criteria, end date, and current prices
- Cross-reference with web search for context

**Step 2 — CHECK PRICE:** Get real orderbook pricing.
```bash
python3 ~/scripts/polymarket-trade.py price --market-id <CONDITION_ID> --json
```
- Shows best bid, best ask, spread, mid price, 24h volume
- If 24h volume < $10K, WARN user about low liquidity (Rule 9)
- If spread > 5%, warn about potential slippage

**Step 3 — CHECK LIQUIDITY:** Assess whether the trade can fill.
- Review ask depth (for buys) or bid depth (for sells)
- If orderbook is thin (< 5 orders on relevant side), warn user
- For large orders (> $20), check if size exceeds available liquidity at best price

**Step 4 — EXECUTE:** Place the trade (default FOK for immediate fill).
```bash
# FOK (default) — fills immediately or fails. Preferred for most trades.
python3 ~/scripts/polymarket-trade.py buy --market-id <ID> --outcome YES --amount 10 --json

# GTC (limit order) — sits in book until filled. Use only when targeting specific price.
python3 ~/scripts/polymarket-trade.py buy --market-id <ID> --outcome YES --amount 10 --order-type GTC --price 0.60 --json
```
- FOK orders auto-price at best ask (buys) or best bid (sells)
- Script reports fill_status: MATCHED, PENDING, FAIL, or CANCELLED

**Step 5 — VERIFY:** Confirm what actually happened.
- Read the script output — check `fill_status` field
- MATCHED = trade executed, shares acquired. Report success with real numbers.
- PENDING = order is in the book, NOT filled. Do NOT report as a completed trade.
- FAIL = order rejected or FOK couldn't fill. Report failure honestly.
- If PENDING: run `check-orders` within 60 seconds, inform user of status (Rule 10)

**Step 6 — MONITOR PENDING:** Handle unfilled GTC orders.
- If any orders are PENDING after 60 seconds:
  ```bash
  python3 ~/scripts/polymarket-trade.py check-orders --json
  ```
- Present options to user: wait, cancel (`cancel --order-id`), convert to market order (`convert-to-market --order-id`)
- NEVER include pending orders in P&L or portfolio value calculations

### Manual Trades

User commands:
```
"Bet $10 on YES for Will Bitcoin hit $200k by June?"
"Buy 50 YES shares of the Fed rate cut market at $0.68"
"Buy 10 contracts of KXBTC-26MAR14-B90000 YES at 45 cents on Kalshi"
"Sell my position in the election market"
```

### Cross-Platform Arbitrage

When the same event trades on both Polymarket and Kalshi:
1. Fetch prices from both platforms
2. If price difference > 5%, flag as potential arbitrage
3. **ALWAYS warn the user:** Different settlement rules, different collateral (USDC.e vs USD), different expiration times
4. Present the opportunity, let the user decide
5. Execute on each platform separately if approved

### Guardrails

**Pre-trade checklist** (agent MUST complete before any trade):
1. Confirm risk config has `enabled: true` for the target platform
2. Check daily spend limit is not exceeded
3. If amount > confirmation threshold, ask user for explicit approval
4. Verify funds are available (USDC.e balance for Polymarket, USD balance for Kalshi)
5. Verify credentials are set up: run status command for target platform

**Post-trade verification** (agent MUST complete after every trade):
1. Capture the order ID from script output
2. Verify order status (filled, partial, rejected)
3. Report status to the user
4. If the order fails, tell the user — never claim success without proof
5. Run positions list to confirm the position

### Token IDs (Polymarket)

Token IDs for trading come from the Gamma API `clobTokenIds` field:
- **Index 0** = YES token
- **Index 1** = NO token

### Compliance Note

- **Polymarket:** International. US agents use proxy (see Rule 7). Funds may be restricted.
- **Kalshi:** CFTC-regulated. Legal for US residents. Real USD, bank-funded.
- The agent does not provide legal or financial advice. All trades are at the user's risk.

---

## Cross-Platform Portfolio

When a user says "show my portfolio" or "how are my trades doing" and BOTH platforms are configured:

1. Run both portfolio scripts:
   - `python3 ~/scripts/polymarket-portfolio.py summary --json`
   - `python3 ~/scripts/kalshi-portfolio.py summary --json`
2. Present side by side:

```
Your Prediction Markets Portfolio

POLYMARKET:
  Cash: $XX.XX USDC.e
  Open Positions: X
  Realized P&L: +/- $XX.XX

KALSHI:
  Cash: $XX.XX USD
  Open Positions: X
  Realized P&L: +/- $XX.XX

Combined Value: ~$XX.XX (approximate — USDC.e ≈ USD)
```

If only ONE platform is configured, just show that one. Don't mention the other.

## Users With Both Platforms

When a user has both Polymarket and Kalshi configured, be clear about separate funding:

"Your Polymarket and Kalshi accounts are completely separate:
- **Polymarket:** funded with USDC.e (crypto) in your agent wallet on Polygon
- **Kalshi:** funded with USD (real dollars) in your Kalshi account on kalshi.com
- Money can't move between them directly."

## Withdrawing Funds

**Polymarket:** To withdraw USDC.e from the Polymarket wallet:
```bash
python3 ~/scripts/polymarket-wallet.py transfer --token usdc.e --to <USER_EXTERNAL_WALLET> --amount <AMOUNT>
```

**Kalshi:** Kalshi withdrawals must be done on kalshi.com — the API does not support withdrawals.
Tell the user: "To withdraw from Kalshi, log into kalshi.com → Account → Withdraw. Funds go back to your linked bank account. I can't do this through the API."

---

## File Paths Reference

### Polymarket Files
| File | Purpose |
|------|---------|
| `~/.openclaw/polymarket/wallet.json` | Polygon EOA wallet (private key + address) |
| `~/.openclaw/polymarket/risk-config.json` | Trading risk parameters (enabled, limits) |
| `~/.openclaw/polymarket/positions.json` | Open position tracking |
| `~/.openclaw/polymarket/trade-log.json` | Trade history with reasoning |
| `~/.openclaw/polymarket/daily-spend.json` | Daily spend/loss tracker (resets at UTC midnight) |
| `~/.openclaw/polymarket/creds-state.json` | CLOB API credential derivation state |
| `~/.openclaw/polymarket/polymarket-risk.json` | US region risk acknowledgment |
| `~/memory/polymarket-watchlist.json` | Market watchlist with alert thresholds |

### Kalshi Files
| File | Purpose |
|------|---------|
| `~/.openclaw/prediction-markets/kalshi-creds.json` | Kalshi API credentials (key ID + PEM) |
| `~/.openclaw/prediction-markets/kalshi-risk-config.json` | Trading risk parameters (enabled, limits) |
| `~/.openclaw/prediction-markets/kalshi-trade-log.json` | Trade history |
| `~/.openclaw/prediction-markets/kalshi-daily-spend.json` | Daily spend tracker |

### Scripts
| Script | Platform | Purpose |
|--------|----------|---------|
| `~/scripts/setup-polymarket-wallet.sh` | Polymarket | Wallet generation |
| `~/scripts/polymarket-setup-creds.py` | Polymarket | CLOB API credential derivation + ERC-20 approvals |
| `~/scripts/polymarket-trade.py` | Polymarket | Trade execution (buy/sell/cancel) with risk enforcement |
| `~/scripts/polymarket-positions.py` | Polymarket | Position verification + P&L |
| `~/scripts/polymarket-verify.py` | Polymarket | Order/trade verification with tx hashes |
| `~/scripts/polymarket-portfolio.py` | Polymarket | Portfolio summary with P&L |
| `~/scripts/polymarket-wallet.py` | Polymarket | ERC-20 transfer, balance check, USDC swap |
| `~/scripts/kalshi-setup.py` | Kalshi | API key setup + status + balance |
| `~/scripts/kalshi-trade.py` | Kalshi | Trade execution (buy/sell/cancel/orders) |
| `~/scripts/kalshi-positions.py` | Kalshi | Positions, history, P&L |
| `~/scripts/kalshi-portfolio.py` | Kalshi | Portfolio summary + detail |
| `~/scripts/kalshi-browse.py` | Kalshi | Market search, trending, detail, categories |
| `~/scripts/polymarket-search.py` | Polymarket | Market search, trending, detail |

### Reference Docs
| File | Description |
|------|-------------|
| `references/gamma-api.md` | Polymarket Gamma API deep reference |
| `references/trading.md` | Polymarket CLOB trading patterns |
| `references/analysis.md` | Market analysis methodology |
| `references/monitoring.md` | WebSocket price streams + monitoring |
| `references/kalshi-api.md` | Kalshi REST API v2 reference |
| `references/kalshi-trading.md` | Kalshi trading patterns + strategies |

---

## Safety Rules

- **No financial advice** — Always frame as "market analysis" with the disclaimer
- **Respect rate limits** — Max 1 req/sec for Gamma API, 1 req/sec for Kalshi API, 1 order/sec for CLOB
- **No hallucinated data** — If you can't reach the API, say so. Never invent prices.
- **Source attribution** — Always link to `https://polymarket.com/event/[event_slug]/[market_slug]` for Polymarket markets
- **Price = probability** — Always explain that $0.65 = 65% implied probability
- **Private key security** — NEVER log, display, or include private keys (Polygon or Kalshi PEM) in any output, memory file, or chat message
- **Risk config required** — Check risk config before every trade on either platform. If `enabled !== true`, refuse the trade.
- **User opt-in** — Trading must be explicitly enabled by the user. Never auto-enable.
- **Trade logging** — Every trade must be logged with full details and reasoning

## Quality Checklist

- [ ] Market data includes question, all outcomes with prices, volume, liquidity, end date
- [ ] Prices presented as both dollar amounts AND implied probabilities
- [ ] Analysis includes web search cross-reference (not just raw API data)
- [ ] Multi-outcome markets show all outcomes (not just top 2)
- [ ] Disclaimer included on all analysis outputs
- [ ] API errors handled gracefully (no crashes, no hallucinated data)
- [ ] Null/missing fields handled with `.get()` defaults
- [ ] Source link included for every market referenced
- [ ] Rate limits respected (1 req/sec max, 3-5 calls per scan)
- [ ] Private keys NEVER logged, NEVER in MEMORY.md, NEVER in chat messages
- [ ] Risk config validated before every trade — `enabled` must be `true`
- [ ] Every trade logged with timestamp, amount, reasoning
- [ ] Trades above confirmation threshold require explicit user approval
- [ ] Opt-in verification — agent confirms user has explicitly enabled trading before first trade
- [ ] Cross-platform: correct platform selected based on user intent
