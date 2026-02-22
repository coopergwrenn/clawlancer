# Financial Analysis Reference Guide

## Alpha Vantage API

**Base URL:** `https://www.alphavantage.co/query`
**Auth:** `apikey=` query parameter (ALPHAVANTAGE_API_KEY)
**Tier:** Premium (75 requests/minute, 500/day agent budget)

## Quick API Reference

### Stock Prices
```bash
# Real-time quote
~/scripts/market-data.sh quote --symbol SPY

# Daily OHLCV (last 100 days)
~/scripts/market-data.sh daily --symbol AAPL --outputsize compact

# Full history (20+ years)
~/scripts/market-data.sh daily --symbol AAPL --outputsize full

# Intraday (1/5/15/30/60 min)
~/scripts/market-data.sh intraday --symbol SPY --interval 15min
```

### Technical Indicators
```bash
# All indicators follow this pattern:
~/scripts/market-data.sh indicator --function <FN> --symbol <SYM> [--interval daily] [--time-period 14]

# Common indicators:
~/scripts/market-data.sh indicator --function RSI --symbol SPY --time-period 14
~/scripts/market-data.sh indicator --function MACD --symbol SPY
~/scripts/market-data.sh indicator --function BBANDS --symbol SPY --time-period 20
~/scripts/market-data.sh indicator --function SMA --symbol SPY --time-period 50
~/scripts/market-data.sh indicator --function SMA --symbol SPY --time-period 200
~/scripts/market-data.sh indicator --function EMA --symbol SPY --time-period 20
~/scripts/market-data.sh indicator --function STOCH --symbol SPY
~/scripts/market-data.sh indicator --function ADX --symbol SPY
~/scripts/market-data.sh indicator --function CCI --symbol SPY --time-period 20
~/scripts/market-data.sh indicator --function AROON --symbol SPY
~/scripts/market-data.sh indicator --function OBV --symbol SPY
~/scripts/market-data.sh indicator --function ATR --symbol SPY
~/scripts/market-data.sh indicator --function MFI --symbol SPY
```

### Options
```bash
~/scripts/market-data.sh options --symbol SPY
```

### Crypto
```bash
~/scripts/market-data.sh crypto --symbol BTC --market USD
~/scripts/market-data.sh crypto --symbol ETH --market USD
```

### Forex
```bash
~/scripts/market-data.sh forex --from-currency EUR --to-currency USD
~/scripts/market-data.sh forex --from-currency GBP --to-currency JPY
```

### Commodities
```bash
~/scripts/market-data.sh commodity --function WTI          # Crude oil
~/scripts/market-data.sh commodity --function BRENT        # Brent crude
~/scripts/market-data.sh commodity --function NATURAL_GAS  # Natural gas
~/scripts/market-data.sh commodity --function COPPER        # Copper
~/scripts/market-data.sh commodity --function GOLD          # Gold (not a function — use forex XAUUSD)
~/scripts/market-data.sh commodity --function SILVER        # Silver
```

### Economic Data
```bash
~/scripts/market-data.sh economy --function REAL_GDP
~/scripts/market-data.sh economy --function TREASURY_YIELD
~/scripts/market-data.sh economy --function FEDERAL_FUNDS_RATE
~/scripts/market-data.sh economy --function CPI
~/scripts/market-data.sh economy --function INFLATION
~/scripts/market-data.sh economy --function UNEMPLOYMENT
```

### Intelligence
```bash
~/scripts/market-data.sh news --tickers AAPL,MSFT --limit 10
~/scripts/market-data.sh movers
~/scripts/market-data.sh earnings --symbol AAPL
~/scripts/market-data.sh search --keywords "artificial intelligence"
```

## Indicator Interpretation Guide

### Trend Indicators

| Indicator | Bullish | Bearish |
|-----------|---------|---------|
| SMA 50/200 | Price > SMA 50 > SMA 200 (golden cross) | Price < SMA 50 < SMA 200 (death cross) |
| MACD | MACD line > signal line | MACD line < signal line |
| ADX (14) | ADX > 25 with +DI > -DI | ADX > 25 with -DI > +DI |
| Aroon | Aroon Up > 70 | Aroon Down > 70 |

### Momentum Indicators

| Indicator | Overbought | Oversold | Neutral Zone |
|-----------|-----------|----------|-------------|
| RSI (14) | > 70 | < 30 | 30-70 |
| Stochastic (14,3) | > 80 | < 20 | 20-80 |
| CCI (20) | > 100 | < -100 | -100 to 100 |
| Williams %R | > -20 | < -80 | -80 to -20 |
| MFI (14) | > 80 | < 20 | 20-80 |

### Volatility Indicators

| Indicator | Signal |
|-----------|--------|
| Bollinger Bands (20,2) | Squeeze (narrow) → breakout imminent; Price at upper = overbought, lower = oversold |
| ATR (14) | Higher = more volatile, widen stop-losses |
| IV Rank | > 50% = expensive options (favor selling); < 50% = cheap options (favor buying) |

### Volume Indicators

| Indicator | Signal |
|-----------|--------|
| OBV | Rising OBV + rising price = confirmed uptrend |
| Volume vs 20d avg | Breakout on high volume = conviction; Breakout on low volume = suspect |

## Standard Analysis Template

For any stock/crypto/forex analysis, use this structure:

```
📊 [SYMBOL] Technical Analysis — [DATE]

PRICE: $X.XX (+X.XX%) | Volume: X.XM (vs X.XM avg)

TREND: [BULLISH/BEARISH/NEUTRAL] ([confidence])
├── [Indicator 1]: [detail] [✅/❌]
├── [Indicator 2]: [detail] [✅/❌]
├── [Indicator 3]: [detail] [✅/❌]
└── [Indicator 4]: [detail] [✅/❌]

MOMENTUM:
├── RSI: XX ([overbought/neutral/oversold])
├── Stochastic: XX ([status])
├── Bollinger Band: [position]

KEY LEVELS:
├── Resistance: $X, $Y
├── Support: $X, $Y

[Optional: OPTIONS INSIGHT]
[Optional: UPCOMING CATALYSTS]

⚠️ This is data analysis, not financial advice. All trading decisions are yours.
```

## Rate Limits

| Budget | Limit |
|--------|-------|
| Premium tier | 75 requests/minute |
| Agent daily budget | 500 requests/day |
| Alert threshold | 400 requests (80%) |

### Cache TTLs

| Data Type | Cache Duration |
|-----------|---------------|
| Intraday prices | 60 seconds |
| Daily prices | 5 minutes |
| Technical indicators | 5 minutes |
| Options chain | 2 minutes |
| Fundamentals | 24 hours |
| News sentiment | 30 minutes |
| Economic indicators | 1 hour |
| Forex/crypto rates | 60 seconds |

## Mandatory Disclaimer

Every analysis output MUST end with one of:

- "This is data analysis, not financial advice. All trading decisions are yours."
- "Automated market data, not financial advice."

NEVER say "you should buy/sell" — say "the data shows..."
