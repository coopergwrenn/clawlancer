---
name: financial-analysis
description: >-
  Real-time stock, crypto, forex, and options data with 50+ technical indicators via Alpha Vantage. Use when the user asks about stock prices, technical analysis, RSI, MACD, options chains, crypto prices, market briefings, or earnings reports.
---
# Financial Data & Technical Analysis
```yaml
name: financial-analysis
version: 1.0.0
updated: 2026-02-22
author: InstaClaw
triggers:
  keywords: [stock, stocks, SPX, SPY, ticker, price, chart, technical analysis, RSI, MACD, moving average, bollinger bands, support, resistance, options, calls, puts, crypto price, bitcoin, ethereum, forex, commodities, gold, oil, earnings, fundamentals, trade, trading, market, bull, bear, overbought, oversold, volume, breakout, trend]
  phrases: ["stock price of", "how's SPY looking", "SPX technical analysis", "BTC analysis", "show me options", "weekly calls", "market briefing", "what's the market doing", "earnings report", "crypto prices"]
  NOT: [execute trade, buy order, sell order, place trade, wire transfer]
```

## Overview

You have access to real-time and historical market data via Alpha Vantage API. You can pull prices, compute technical indicators, analyze options chains, and deliver trading analysis for stocks, crypto, forex, commodities, and options.

**You are a financial research assistant. You provide DATA and ANALYSIS.**
**You do NOT execute trades, give financial advice, or manage money.**
**Every analysis output includes a disclaimer.**

## Data Provider

```
Provider:    Alpha Vantage (NASDAQ-licensed)
API Base:    https://www.alphavantage.co/query
Auth:        apikey= parameter (ALPHAVANTAGE_API_KEY)
Coverage:    200,000+ tickers, 20+ global exchanges, 20+ years history
Tier:        Premium (75 req/min)
```

**What's Available:**
- Real-time & historical prices (OHLCV) — stocks, crypto, forex, commodities
- 50+ pre-computed technical indicators (RSI, MACD, Bollinger Bands, Stochastic, ADX, etc.)
- Options chains with Greeks (delta, gamma, theta, vega, IV)
- Fundamental data (financials, P/E, earnings)
- Crypto prices (BTC, ETH, 500+ coins)
- Forex rates (100+ pairs)
- Commodities (gold, oil, wheat, etc.)
- Economic indicators (GDP, CPI, Fed Funds Rate, Treasury yields)
- News sentiment (AI-scored)
- Top gainers/losers, earnings calendar

## Prerequisites (on your VM)

- `ALPHAVANTAGE_API_KEY` in `~/.openclaw/.env` (platform-provided)
- Helper scripts: `~/scripts/market-data.sh`, `~/scripts/market-analysis.py`
- Python `requests` (pre-installed)

## Helper Scripts

### market-data.sh — Alpha Vantage API Client

```bash
# Stock quotes
~/scripts/market-data.sh quote --symbol SPY
~/scripts/market-data.sh daily --symbol AAPL --outputsize compact

# Intraday prices
~/scripts/market-data.sh intraday --symbol SPY --interval 15min

# Technical indicators
~/scripts/market-data.sh indicator --function RSI --symbol SPY --interval daily --time-period 14
~/scripts/market-data.sh indicator --function MACD --symbol SPY --interval daily
~/scripts/market-data.sh indicator --function BBANDS --symbol SPY --interval daily --time-period 20

# Options
~/scripts/market-data.sh options --symbol SPY

# Crypto
~/scripts/market-data.sh crypto --symbol BTC --market USD

# Forex
~/scripts/market-data.sh forex --from-currency EUR --to-currency USD

# Commodities & economic data
~/scripts/market-data.sh commodity --function WTI
~/scripts/market-data.sh economy --function REAL_GDP

# News sentiment
~/scripts/market-data.sh news --tickers AAPL,MSFT --limit 10

# Top movers
~/scripts/market-data.sh movers

# Earnings calendar
~/scripts/market-data.sh earnings --symbol AAPL
```

### market-analysis.py — Technical Analysis Engine

```bash
# Full technical analysis for a ticker
python3 ~/scripts/market-analysis.py analyze --symbol SPY

# Generate chart image
python3 ~/scripts/market-analysis.py chart --symbol SPY --output /tmp/spy-chart.png

# Multi-ticker watchlist scan
python3 ~/scripts/market-analysis.py watchlist --symbols SPY,AAPL,NVDA,BTC

# Rate limit status
python3 ~/scripts/market-analysis.py rate-status
```

## Analysis Rules (MUST FOLLOW)

1. **Never give financial advice.** Say "The data shows..." not "You should buy/sell..."
2. **Always include disclaimer.** Every analysis ends with: "This is data analysis, not financial advice. All trading decisions are yours."
3. **Use indicator confluence.** Need 3+ indicators agreeing before calling a trend.
4. **State confidence levels.** "4/5 indicators bullish" vs "Mixed: 2 bullish, 2 bearish, 1 neutral"
5. **Mention what could go wrong.** Every bullish call includes the bear case, and vice versa.
6. **Context matters.** Pre-earnings/Fed = lower confidence on technicals.
7. **Timeframe clarity.** "On the daily chart..." vs "On the 15-minute..."
8. **Options carry extra risk.** Always note weeklies can expire worthless, theta decay accelerates.

## Workflow 1: Stock Technical Analysis

When user says: "Give me SPX technical analysis" or "How's SPY looking?"

```
STEP 1: Pull current data
├── GET daily prices — last 100 days
├── GET intraday prices (15min) — today's session
└── GET current quote — latest price + volume + change

STEP 2: Compute key indicators
├── RSI (14-period) — overbought >70 / oversold <30
├── MACD (12,26,9) — trend direction + crossover signals
├── Bollinger Bands (20,2) — volatility squeeze / expansion
├── SMA 50 + SMA 200 — golden cross / death cross
├── ADX (14) — trend strength (>25 trending, <20 ranging)
├── Stochastic (14,3,3) — momentum confirmation
└── Volume — compare to 20-day average (conviction check)

STEP 3: Identify key levels
├── Support: Recent swing lows, SMA 50, lower Bollinger
├── Resistance: Recent swing highs, SMA 200, upper Bollinger
└── Options-relevant strikes: Round numbers near current price

STEP 4: Generate analysis
├── Trend assessment (bullish/bearish/neutral with confidence)
├── Key levels to watch
├── Indicator confluence (how many agree?)
├── Risk factors (earnings, Fed, economic data)
└── DISCLAIMER: Not financial advice

STEP 5: Deliver via Telegram/Discord
```

**Example output:**
```
📊 SPY Technical Analysis — Feb 22, 2026

PRICE: $508.32 (+0.45%) | Volume: 42.1M (vs 38.5M avg)

TREND: BULLISH (moderate conviction)
├── Above SMA 50 ($501.20) ✅
├── Above SMA 200 ($487.50) ✅
├── MACD bullish crossover 2 days ago ✅
├── ADX at 28 (trending) ✅

MOMENTUM:
├── RSI: 62 (neutral, room to run)
├── Stochastic: 71 (approaching overbought)
├── Bollinger Band: Mid-to-upper (expanding)

KEY LEVELS:
├── Resistance: $512.50 (recent high), $515 (round number)
├── Support: $504 (SMA 20), $501.20 (SMA 50)

OPTIONS INSIGHT (weekly expiry):
├── IV relatively low — premium cheap
├── Max pain: $507
├── Highest OI calls: $510, $515
├── Highest OI puts: $505, $500

⚠️ WATCH: Fed minutes Wednesday, PCE data Friday
⚠️ This is data analysis, not financial advice.
```

## Workflow 2: Crypto Technical Analysis

When user says: "BTC analysis" or "How's ETH looking?"

Same indicator stack as stocks, but:
- Crypto trades 24/7 (daily = midnight UTC close)
- More volatile — widen Bollinger Band interpretation
- Add crypto-specific context: BTC dominance, macro correlation (DXY, rates)
- Use Alpha Vantage news sentiment for crypto-specific news
- Use Brave Search for on-chain metrics when available

## Workflow 3: Options Chain Analysis

When user says: "Show me SPY options" or "Weekly calls?"

```
STEP 1: Pull options chain
├── GET options chain with Greeks
├── Filter by expiry (default: nearest weekly/monthly)
└── Include IV, delta, gamma, theta, vega

STEP 2: Analyze
├── Open interest distribution (where's the crowd?)
├── Put/call ratio
├── IV rank vs historical
├── Max pain calculation
├── Unusual activity detection (OI spikes)

STEP 3: Present with risk context
├── Greeks explained in plain English
├── Theta decay warning for weeklies
├── IV percentile context
└── DISCLAIMER: Options can expire worthless
```

## Workflow 4: Daily Market Briefing (Heartbeat Integration)

Runs automatically every morning if user has financial interests in USER.md:

```
🌅 Morning Market Briefing — Feb 22, 2026

OVERNIGHT: S&P futures +0.3%, Nasdaq +0.5%, BTC $97,800 (+2.1%)

YOUR WATCHLIST:
├── SPY: $508 — RSI 62, above 50 SMA ✅
├── NVDA: $820 — Earnings next week ⚠️
├── BTC: $97,800 — Testing $100K resistance 👀

TODAY'S CATALYSTS:
├── 8:30 AM: PCE Price Index
├── 10:00 AM: Michigan Consumer Sentiment

⚠️ Automated market data, not financial advice.
```

## SPX Weekly Options — Specific Guidance

Optimal workflow for weekly options trader:
1. Monday morning: Full technical analysis + options chain overview
2. Daily: Key level updates + indicator changes
3. Pre-market: Overnight futures + gap analysis
4. During session: Alert on key level breaks (via heartbeat)
5. Thursday: Theta decay warning for weeklies
6. Friday pre-expiry: Final levels, max pain, volume analysis

**Agent can:** Pull data, compute indicators, identify levels, track options Greeks, calculate max pain, send alerts.
**Agent cannot:** Execute trades, recommend strikes, guarantee outcomes, replace a financial advisor.

## Indicator Reference

### Trend Indicators
| Indicator | Bullish Signal | Bearish Signal |
|-----------|---------------|----------------|
| SMA 50/200 | Price > SMA 50 > SMA 200 | Price < SMA 50 < SMA 200 |
| MACD | Line crosses above signal | Line crosses below signal |
| ADX | ADX > 25 + rising +DI | ADX > 25 + rising -DI |
| Aroon | Aroon Up > 70 | Aroon Down > 70 |

### Momentum Indicators
| Indicator | Overbought | Oversold |
|-----------|-----------|----------|
| RSI (14) | > 70 | < 30 |
| Stochastic (14,3) | > 80 | < 20 |
| CCI (20) | > 100 | < -100 |
| Williams %R | > -20 | < -80 |

### Volatility Indicators
| Indicator | What It Tells You |
|-----------|------------------|
| Bollinger Bands (20,2) | Low vol → squeeze → breakout coming |
| ATR (14) | Higher = more volatile, wider stops needed |
| IV Rank | High = expensive options (good for selling) |

### Volume Indicators
| Indicator | What It Tells You |
|-----------|------------------|
| OBV | Rising OBV + rising price = strong trend |
| MFI (14) | > 80 overbought, < 20 oversold |
| Volume vs 20d avg | Above avg on breakout = real move |

## Alpha Vantage API Endpoints Reference

| Category | Function | What It Returns |
|----------|----------|----------------|
| Prices | `GLOBAL_QUOTE` | Latest price, volume, change |
| Prices | `TIME_SERIES_DAILY` | OHLCV daily bars |
| Prices | `TIME_SERIES_INTRADAY` | 1/5/15/30/60 min bars |
| Indicators | `RSI` | Relative Strength Index |
| Indicators | `MACD` | MACD line, signal, histogram |
| Indicators | `BBANDS` | Upper, middle, lower bands |
| Indicators | `SMA` / `EMA` | Moving averages |
| Indicators | `STOCH` | Stochastic oscillator |
| Indicators | `ADX` | Average Directional Index |
| Indicators | `CCI` | Commodity Channel Index |
| Indicators | `AROON` | Aroon Up/Down |
| Indicators | `OBV` | On-Balance Volume |
| Indicators | `ATR` | Average True Range |
| Indicators | `MFI` | Money Flow Index |
| Options | `REALTIME_OPTIONS` | Options chain + Greeks |
| Fundamentals | `COMPANY_OVERVIEW` | P/E, market cap, EPS |
| Fundamentals | `INCOME_STATEMENT` | Revenue, net income |
| Fundamentals | `EARNINGS` | EPS actual vs expected |
| Crypto | `DIGITAL_CURRENCY_DAILY` | Crypto daily OHLCV |
| Crypto | `CRYPTO_INTRADAY` | Crypto intraday |
| Forex | `CURRENCY_EXCHANGE_RATE` | Real-time FX rate |
| Forex | `FX_DAILY` | FX daily bars |
| Commodities | `WTI` / `BRENT` / `NATURAL_GAS` | Energy prices |
| Commodities | `COPPER` / `GOLD` / `SILVER` | Metals |
| Economy | `REAL_GDP` | GDP data |
| Economy | `TREASURY_YIELD` | Treasury rates |
| Economy | `FEDERAL_FUNDS_RATE` | Fed rate |
| Economy | `CPI` / `INFLATION` | Inflation data |
| Intelligence | `NEWS_SENTIMENT` | AI-scored news |
| Intelligence | `TOP_GAINERS_LOSERS` | Market movers |
| Intelligence | `EARNINGS_CALENDAR` | Upcoming earnings |

## Rate Limiting & Caching

```
Premium tier: 75 requests/minute
Agent daily budget: 500 requests max (alert at 400)

Cache TTL:
  Intraday prices:       60 seconds
  Daily prices:          5 minutes
  Technical indicators:  5 minutes
  Options chain:         2 minutes
  Fundamentals:          24 hours
  News sentiment:        30 minutes
  Economic indicators:   1 hour
  Forex rates:           60 seconds
  Crypto prices:         60 seconds
```

## Common Mistakes

1. **Over-interpreting single indicators** — Need confluence, not just "RSI is 65"
2. **Ignoring macro context** — Day before Fed decision overrides technicals
3. **Presenting analysis as advice** — "Data shows X" never "You should do Y"
4. **No timeframe specified** — Always state daily vs intraday vs weekly
5. **Stale data without acknowledgment** — Always show timestamp, note if market is open/closed
6. **Hammering the API** — Cache responses, check rate-status before bulk requests

## Quality Checklist

- [ ] All price data includes timestamp
- [ ] At least 3 indicators for any trend call
- [ ] Confidence level stated
- [ ] Bull AND bear case presented
- [ ] Disclaimer included
- [ ] Timeframe clearly stated
- [ ] Upcoming events mentioned
- [ ] Options analysis includes Greeks + IV context
- [ ] Chart generated as image when requested
- [ ] Rate limits checked before bulk operations
