# Prediction Markets (Polymarket)
```yaml
name: polymarket
version: 1.0.0
updated: 2026-02-24
author: InstaClaw
phase: 1  # Read-only intelligence. Trading capabilities coming in Phase 2/3.
triggers:
  keywords: [prediction market, polymarket, odds, probability, chances, bet on, betting, forecast, market odds, implied probability, wager, betting odds, market intelligence, event probability, market scan, prediction odds]
  phrases: ["what are the chances of", "what are the odds", "prediction market", "polymarket", "will X happen", "probability of", "browse markets", "top prediction markets", "hottest markets", "market analysis", "is X likely", "market scan", "what will happen", "prediction odds"]
  NOT: [stock market, stock price, financial analysis, crypto price, token price]
```

## Overview

You have access to Polymarket, the world's largest prediction market (~$1B+ monthly volume). Use this skill to browse markets, analyze probabilities, cross-reference with news, and deliver intelligence reports on global events.

**What Polymarket is:** A prediction market where people trade on event outcomes. Prices represent crowd-consensus probabilities. A "Yes" share priced at $0.65 means the crowd thinks there's a 65% chance the event happens.

**Why this matters:** Prediction market data is crowdsourced intelligence backed by real money. Unlike polls or pundit opinions, market participants have financial skin in the game. This makes Polymarket data uniquely reliable for forecasting.

**Current phase:** Read-only intelligence. No wallet, no API keys, no trading. The agent uses the public Gamma API (no auth required) via `curl` to fetch market data, then enriches it with web search and analysis.

> Trading capabilities coming soon. Currently read-only.

## When to Use This Skill

- User asks about prediction markets, odds, or probabilities for events
- User asks "what are the chances of X happening"
- User wants market intelligence on politics, crypto, sports, tech, entertainment
- User asks to browse or search Polymarket
- User asks for an "opportunities report" or "market scan"
- User wants to compare market probability to recent news
- Another skill (competitive-intelligence, financial-analysis) needs probability data on an event

**Do NOT use this skill for:**
- Stock prices or financial instrument quotes (use financial-analysis skill)
- Crypto token prices (use financial-analysis skill)
- Sports scores or stats (only use for prediction market odds on sports outcomes)

## Gamma API Reference

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

### Get Event Details

```bash
curl -s "https://gamma-api.polymarket.com/events/{id}"
```

Returns the event with all associated markets in the `markets` array.

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

### Multi-Market Report (Top Markets / Scan)
```
**Top Prediction Markets by 24h Volume**
Updated: Feb 24, 2026

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
Use `web_search` to find 3-5 recent news articles related to the market topic:
```
web_search("Fed rate decision March 2026 latest")
web_search("FOMC meeting March 2026 expectations")
```

### Step 3: Compare Market vs. News Sentiment
- Is the market pricing consistent with the latest news?
- Has something happened that the market hasn't priced in yet?
- Are experts or data sources suggesting a different probability?

### Step 4: Present Analysis
```
**Market Analysis: Will the Fed Cut Rates in March?**

Current Market: 72% Yes ($0.72)

**Recent Developments:**
- Feb 21: CPI came in at 2.8% (above 2.6% expected)
- Feb 23: Fed Governor Waller speech hinted at "patience"
- Feb 24: CME FedWatch tool shows 68% probability of hold

**Assessment:**
The market at 72% for a cut appears slightly optimistic given the hotter-than-expected
CPI print and Waller's hawkish tone. CME FedWatch (which tracks futures pricing from
institutional traders) shows only 68% for a cut. The 4-point gap suggests the Polymarket
crowd may be slow to price in the latest inflation data.

**Key date to watch:** March 18-19 FOMC meeting

*This is market analysis based on publicly available data, not financial advice.
Prediction market prices reflect crowd consensus, not guaranteed outcomes.*
```

### Step 5: Disclaimer
ALWAYS include at the end of any analysis:
> *This is market analysis based on publicly available data, not financial advice. Prediction market prices reflect crowd consensus, not guaranteed outcomes.*

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

## Parsing API Responses

The `outcomes` and `outcomePrices` fields are JSON strings, not arrays. Parse them:

```bash
# Using jq to extract clean data
curl -s "https://gamma-api.polymarket.com/markets?limit=5&closed=false&order=volume24hr&ascending=false" | \
  jq '.[] | {
    question,
    outcomes: (.outcomes | fromjson),
    prices: (.outcomePrices | fromjson),
    volume_24h: .volume24hr,
    total_volume: .volumeNum,
    liquidity: .liquidityNum,
    end_date: .endDateIso
  }'
```

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
When researching a competitor or industry event, check if there's a related prediction market. Fetch top markets and filter client-side for relevant keywords. Include market probabilities in competitive intelligence reports for quantitative forecasting.

### With financial-analysis
When analyzing stocks or crypto, check related prediction markets for event risk. For example, Fed rate decision markets directly impact stock/bond outlooks. Fetch top markets, filter for "fed" or "rate" keywords.

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

Use 3-5 API calls total. Don't fetch individually — use `limit=20` and filter client-side.

## Safety Rules

- **Read-only** — This skill does not place trades, manage wallets, or handle money
- **No financial advice** — Always frame as "market analysis" with the disclaimer
- **Respect rate limits** — Max 1 req/sec, batch where possible
- **No hallucinated data** — If you can't reach the API, say so. Never invent prices.
- **Source attribution** — Always link to `https://polymarket.com/event/[event_slug]/[market_slug]` (get event slug from `market.events[0].slug`)
- **Price = probability** — Always explain that $0.65 = 65% implied probability

## Future Roadmap

> Phase 2 (coming): Portfolio monitoring — dedicated Polygon wallet, position tracking, watchlists, automated alerts, WebSocket price streams
> Phase 3 (coming): Autonomous trading — manual trades, thesis-driven trades, risk management, trade logging. Will require explicit user opt-in with safety guardrails.

## Quality Checklist

- [ ] Market data includes question, all outcomes with prices, volume, liquidity, end date
- [ ] Prices presented as both dollar amounts AND implied probabilities
- [ ] Analysis includes web search cross-reference (not just raw API data)
- [ ] Multi-outcome markets show all outcomes (not just top 2)
- [ ] Disclaimer included on all analysis outputs
- [ ] API errors handled gracefully (no crashes, no hallucinated data)
- [ ] Null/missing fields handled with `.get()` defaults (bestBid, oneDayPriceChange, etc.)
- [ ] Source link to Polymarket included for every market referenced (use event_slug/market_slug format)
- [ ] Rate limits respected (1 req/sec max, 3-5 calls per scan)
