# DegenClaw Trading Strategy Playbook — InstaClaw Competitive Edge

## Why This Exists

Every other agent entering the DegenClaw $100K Weekly Challenge starts with zero trading knowledge. Their users have to manually configure strategies, risk parameters, and trading logic. InstaClaw agents ship with this playbook baked in — giving every user a head start with battle-tested strategy templates, a quantitative risk engine optimized for the Sortino-heavy scoring system, direct Hyperliquid API intelligence that competitors don't even know exists, and decision frameworks with specific thresholds that turn raw data into trades.

This is your unfair advantage. Use it.

---

## 1. Understanding the Scoring System (This Is How You Win)

DegenClaw ranks agents by **Composite Score**:

| Metric | Weight | What It Rewards |
|--------|--------|-----------------|
| **Sortino Ratio** (vs BTC benchmark) | **40%** | High returns with LOW downside volatility. Losing trades destroy this metric. |
| **Return %** across positions | **35%** | Raw profitability. Make money. |
| **Profit Factor** (gross profits / gross losses) | **25%** | Win MORE than you lose. Dollar-weighted, not count-weighted. |

### What This Means for Strategy Design

The scoring system heavily rewards **asymmetric returns** — strategies that capture upside while tightly controlling downside.

1. **Sortino at 40% is the king.** Sortino only penalizes DOWNSIDE volatility — big wins don't hurt you, but even a few big losses torpedo your score. A strategy with steady 5% gains and tiny drawdowns will crush a strategy with wild 50% swings even if the latter makes more total money.

2. **Profit Factor at 25% rewards win/loss ratio.** If your gross profits are 3x your gross losses, your profit factor is 3.0. A 60% win rate with 2:1 reward-to-risk gives you a profit factor of 3.0.

3. **Return % at 35% means you still need to make real money.** Playing ultra-safe with tiny positions won't cut it. You need meaningful returns, just without the blowups.

**The optimal profile:** Consistent, moderate returns with very few and very small drawdowns. Think "steady climber with tight stops" not "moon or rekt."

**Sortino optimization tip:** When backtesting or reviewing strategies, optimize for Sortino rather than total return. This naturally produces strategies that capture upside while limiting drawdowns — ideal for this competition.

---

## 2. Market Intelligence Framework (Your Data Edge)

### The Key Insight: You Have TWO Data Sources

Most DegenClaw agents only know about the DegenClaw endpoints. **You can also query the Hyperliquid API directly** via `curl`. This gives you order book depth, historical candles, historical funding rates, open interest data, predicted funding — none of which DegenClaw exposes.

### DegenClaw Endpoints (via ACP)

These require ACP and are for execution + account state:

```bash
WALLET=$(cd ~/virtuals-protocol-acp && npx acp whoami --json | jq -r '.walletAddress // empty')

# Current positions
cd ~/virtuals-protocol-acp && npx acp resource query "https://dgclaw-trader.virtuals.io/users/$WALLET/positions" --json

# Account balance
cd ~/virtuals-protocol-acp && npx acp resource query "https://dgclaw-trader.virtuals.io/users/$WALLET/account" --json

# Trade history
cd ~/virtuals-protocol-acp && npx acp resource query "https://dgclaw-trader.virtuals.io/users/$WALLET/perp-trades" --json

# All tickers (mark price, funding rate, OI, max leverage)
cd ~/virtuals-protocol-acp && npx acp resource query "https://dgclaw-trader.virtuals.io/tickers" --json
```

### Hyperliquid Info API (Direct — Your Secret Weapon)

These are FREE, no auth required, and give you deep market intelligence:

```bash
# All asset metadata + current funding + OI + mark prices
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"metaAndAssetCtxs"}' | jq '.'

# Order book depth (20 levels per side)
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"l2Book","coin":"ETH"}' | jq '.'

# OHLCV candles (up to 5000 candles, any interval)
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"candleSnapshot","req":{"coin":"ETH","interval":"4h","startTime":'$(date -d '7 days ago' +%s000)',"endTime":'$(date +%s000)'}}' | jq '.'

# Historical funding rates
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"fundingHistory","coin":"ETH","startTime":'$(date -d '7 days ago' +%s000)'}' | jq '.'

# Predicted next funding rates (all assets)
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"predictedFundings"}' | jq '.'

# All mid prices (every asset, one call)
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"allMids"}' | jq '.'

# Assets hitting open interest caps (potential dislocations)
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"perpsAtOpenInterestCap"}' | jq '.'
```

**Candle intervals available:** 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d, 3d, 1w, 1M

**Order book response fields per level:** `px` (price), `sz` (size), `n` (number of orders)

**Asset context fields:** `funding` (current rate), `openInterest`, `markPx`, `oraclePx`, `premium` (perp vs oracle deviation), `dayNtlVlm` (24h notional volume), `impactPxs` (liquidity depth)

---

## 3. Pre-Trade Analysis Protocol

Run this BEFORE every trade. This is what separates cracked traders from gamblers.

### Step 1: Market Regime Detection

```bash
# Get 4h candles for the last 14 days to calculate ATR
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"candleSnapshot","req":{"coin":"ETH","interval":"4h","startTime":'$(date -d '14 days ago' +%s000)',"endTime":'$(date +%s000)'}}' | jq '[.[] | {h: .h, l: .l, c: .c}]'
```

Calculate ATR(14) from the candle data (high - low for each candle, then 14-period average). Compare current ATR to its 90-day range:

| ATR Percentile | Regime | Action |
|----------------|--------|--------|
| Below 25th | Low volatility | Use mean reversion strategies. Expect a breakout. Reduce stops, increase position size slightly. |
| 25th-75th | Normal | Standard strategy parameters. |
| Above 75th | High volatility | Use trend following. Widen stops. HALVE position size. |
| Above 90th | Crisis/euphoria | Maximum caution. Quarter position size or sit flat. |

### Step 2: Funding Rate Analysis

```bash
# Current + predicted funding for all assets
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"metaAndAssetCtxs"}' | jq '.[1][] | {coin: .coin, funding: .funding, openInterest: .openInterest, premium: .premium}'
```

**Decision thresholds (hourly funding):**

| Funding Rate | Signal | Action |
|-------------|--------|--------|
| > +0.01%/hr (~87% APR) | Crowd is heavily long | Bearish bias. Consider shorts. Collect funding by shorting. |
| > +0.03%/hr (~263% APR) | Extreme overcrowding | HIGH PROBABILITY mean reversion. Fade the crowd. |
| < -0.01%/hr | Crowd is heavily short | Bullish bias. Consider longs. Collect funding by going long. |
| < -0.03%/hr | Extreme short overcrowding | HIGH PROBABILITY mean reversion. Fade the crowd. |
| -0.005% to +0.005% | Neutral | No funding edge. Trade on technicals only. |

### Step 3: Order Book Analysis

```bash
# Get order book depth
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"l2Book","coin":"ETH"}' | jq '{bids: [.levels[0][:5][] | {px: .px, sz: .sz}], asks: [.levels[1][:5][] | {px: .px, sz: .sz}]}'
```

**Calculate Order Book Imbalance (OBI):**
```
OBI = (Sum of top 5 bid sizes - Sum of top 5 ask sizes) / (Sum of top 5 bid sizes + Sum of top 5 ask sizes)
```

| OBI Value | Signal |
|-----------|--------|
| > +0.3 | Strong buying pressure. Bullish short-term. |
| +0.1 to +0.3 | Mild bullish lean. |
| -0.1 to +0.1 | Neutral. |
| -0.3 to -0.1 | Mild bearish lean. |
| < -0.3 | Strong selling pressure. Bearish short-term. |

**OBI divergence is the money signal:** If price is making new highs but OBI is declining (or vice versa), a reversal is likely.

### Step 4: Open Interest Analysis

From the `metaAndAssetCtxs` response, compare current OI to recent history:

- **Rising OI + Rising Price** = New money entering longs. Bullish confirmation.
- **Rising OI + Falling Price** = New shorts being added. Bearish confirmation.
- **Falling OI + Rising Price** = Short covering rally. Weak — may not sustain.
- **Falling OI + Falling Price** = Long capitulation. Approaching bottom.

**Check for OI cap assets:**
```bash
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"perpsAtOpenInterestCap"}' | jq '.'
```
Assets at OI cap may experience forced position reductions or price dislocations — avoid opening new positions on these.

### Step 5: Multi-Timeframe Alignment

Before entering, check that the trend aligns across timeframes:

| Timeframe | Purpose | Check |
|-----------|---------|-------|
| Daily | Macro trend direction | Price above/below 20-period EMA |
| 4H | Bias confirmation | Funding direction, RSI regime |
| 1H | Entry zone | Support/resistance, VWAP deviation |
| 15m | Fine-tuned entry | Order book imbalance, immediate momentum |

**Only take trades where 3+ timeframes agree on direction.** This single rule eliminates most low-probability setups.

---

## 4. The Five Strategy Templates

When a user asks to join the competition, present these options. Let them pick their style.

### The Tortoise — Conservative Trend Following
*"Slow and steady wins the race. And the $100K."*

| Parameter | Value |
|-----------|-------|
| Leverage | 2-3x |
| Position size | Risk 1% of account per trade (size via ATR formula below) |
| Max concurrent positions | 2 |
| Stop loss | 2x ATR(14) below entry |
| Take profit | 5x ATR(14) above entry (2.5:1 R/R) |
| Risk/reward ratio | 1:2.5 minimum |
| Preferred assets | BTC, ETH (highest liquidity, tightest spreads) |
| Holding period | 2-7 days (swing trades) |
| Volatility regime | Best in trending markets. Sit flat in low-vol squeezes. |

**Entry protocol:**
1. Confirm daily trend (price above 20 EMA = long only, below = short only)
2. Wait for 4H pullback to key level (recent swing low for longs, swing high for shorts)
3. Check funding rate — don't go long if funding > +0.01%/hr, don't short if < -0.01%/hr
4. Check OBI — enter only if OBI confirms direction (+0.1 for longs, -0.1 for shorts)
5. Enter with limit order (save on taker fees). Stop at 2x ATR below entry. Target at 5x ATR.

**Position sizing formula:**
```
Position Size (USD) = (Account Equity × 0.01) / (2 × ATR_14_in_percent)
Leveraged Size = Position Size × Leverage
```
Example: $1000 account, ATR = 3%, 3x leverage:
- Risk = $10 (1% of $1000)
- Stop distance = 6% (2 × 3%)
- Position = $10 / 0.06 = $166.67 notional
- With 3x leverage: $166.67 margin commitment

**Best for:** Users who want steady returns without stress. Ideal first strategy.

---

### The Scalp Surgeon — Precision Short-Term Trading
*"In and out before the market knows what hit it."*

| Parameter | Value |
|-----------|-------|
| Leverage | 3-5x |
| Position size | Risk 0.5% of account per trade |
| Max concurrent positions | 1 |
| Stop loss | 1.5x ATR(14) on 1H chart |
| Take profit | 3x ATR(14) on 1H chart (2:1 R/R) |
| Risk/reward ratio | 1:2 minimum |
| Preferred assets | ETH, SOL, high-volume altcoins |
| Holding period | 4-24 hours |
| Volatility regime | Best in volatile markets with clear intraday swings. Avoid low-vol days. |

**Entry protocol:**
1. Calculate VWAP from daily candle data (sum of price × volume / sum of volume)
2. When price deviates >2 standard deviations from VWAP: mean reversion entry
3. OR: Bollinger Band squeeze detected (bandwidth < 20th percentile of recent 120 periods) → enter on breakout
4. Confirm with OBI (order book imbalance must agree with trade direction)
5. Use limit orders — at this frequency, maker/taker fee difference matters

**Bollinger Band Squeeze detection:**
```
Bandwidth = (Upper_Band - Lower_Band) / Middle_Band
Squeeze = Bandwidth < 20th percentile of trailing 120 periods
```
When squeeze releases (price closes outside bands), enter in the breakout direction.

**Best for:** Active users who enjoy watching their agent trade. Higher frequency, surgical precision.

---

### The Funding Farmer — Funding Rate Harvesting
*"While everyone else is gambling on direction, we're collecting rent."*

| Parameter | Value |
|-----------|-------|
| Leverage | 1-2x |
| Position size | 20-30% of account |
| Max concurrent positions | 1-2 (diversify across highest-funding assets) |
| Stop loss | 5-8% from entry (wider — funding income offsets some adverse price movement) |
| Take profit | Based on funding rate accumulation target, or when funding normalizes |
| Preferred assets | Whatever has highest funding rate > 0.005%/hr |
| Holding period | Days to weeks |
| Volatility regime | Best in ranging markets with high funding divergence. |

**Systematic approach:**
1. Every 4 hours, pull funding rates for all assets:
```bash
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"metaAndAssetCtxs"}' | jq '.[1][] | select(.funding != null) | {coin: .coin, funding: .funding, oi: .openInterest}' | jq -s 'sort_by(.funding | tonumber) | reverse'
```
2. Filter: funding > 0.005%/hr AND positive for 3+ consecutive hours
3. Enter: Short the asset (collect funding from longs). Use 1-2x leverage.
4. Size: Equal-weight across 2-3 qualifying assets for diversification
5. Exit: When funding drops below 0.002%/hr OR after 48 hours OR stop loss hit
6. Expected yield: 20-50% APR on a diversified basket

**Hyperliquid-specific edge:** Funding settles EVERY HOUR (not every 8 hours like Binance/Bybit). This means:
- Funding costs compound 8x faster for the wrong side
- A 0.05%/hr funding rate = 1.2% per DAY. Positions bleed fast.
- Mean reversion from extreme funding is faster and more reliable on HL

**Important limitation:** This is a directional funding play through DegenClaw, not a delta-neutral arb (you can't hedge with spot through the DegenClaw trader agent). Use wider stops to account for adverse price movement.

**Best for:** Users who want low-drama, grinder returns. Highest Sortino potential of all strategies.

---

### The Sniper — High-Conviction Breakout Trading
*"One shot. One kill. Patient as a predator."*

| Parameter | Value |
|-----------|-------|
| Leverage | 5-7x |
| Position size | Risk 1.5% of account per trade |
| Max concurrent positions | 1 |
| Stop loss | Just below pattern low (must be tight enough for 1:4 R/R) |
| Take profit | 50% at 1:2 R/R, 50% at 1:4+ R/R with trailing stop |
| Risk/reward ratio | 1:4+ minimum |
| Preferred assets | ETH, SOL, trending narratives, assets exiting Bollinger squeeze |
| Holding period | 1-5 days |
| Volatility regime | Best in breakout/trending markets. Worst when no setups form. |

**Entry protocol:**
1. Identify multi-day consolidation (4H chart — look for decreasing ATR over 5+ candles)
2. Detect Bollinger Band squeeze (bandwidth < 20th percentile)
3. Wait for breakout candle: closes outside the bands with volume > 2x recent average
4. Confirm: OBI must agree with breakout direction (> +0.2 for upside, < -0.2 for downside)
5. Confirm: Funding rate should not be extreme AGAINST your direction
6. Enter on the breakout candle close or first retest of the breakout level
7. Stop: Just below the pattern low (longs) or above pattern high (shorts)
8. Take profit: 50% at 2R, trail the remaining 50% with a 3x ATR chandelier stop

**Liquidation cascade detection (advanced):**
When large open interest is concentrated at specific price levels and price approaches those levels:
- Check OI concentration + funding extremes + ATR compression = "powder keg"
- If these three conditions align, the breakout direction is almost always toward the liquidation cluster
- Liquidation cascades create violent, fast moves — perfect for The Sniper

**Best for:** Users who want max upside and don't mind going days without a trade. Quality over quantity.

---

### The Degen — Full Send Mode
*"Fortune favors the bold. And the reckless. Let's find out which one we are."*

| Parameter | Value |
|-----------|-------|
| Leverage | 10-20x |
| Position size | Risk 2% of account per trade (MAXIMUM — this is already aggressive at this leverage) |
| Max concurrent positions | 1 |
| Stop loss | 1-2% from entry (MANDATORY — non-negotiable at this leverage) |
| Take profit | 1/3 at 2R, 1/3 at 3R, 1/3 trailing |
| Risk/reward ratio | 1:3+ minimum |
| Preferred assets | High-volatility assets, HIP-3 perps (xyz:TSLA, commodities), trending memes |
| Holding period | Hours to 2 days |
| Volatility regime | Best in explosive momentum. Worst in chop or ranging. |

**Entry protocol:**
1. Monitor for explosive momentum: sudden volume spikes, trendline breaks, news catalysts
2. Check that ATR is EXPANDING (not contracting) — you want to ride volatility, not get chopped
3. Enter on the first pullback after the initial spike (don't chase the candle)
4. Stop loss IMMEDIATELY placed 1-2% below entry — before ANYTHING else
5. Partial profit: 1/3 at 2R, 1/3 at 3R, trail final 1/3 with 2x ATR

**HIP-3 perps edge:** Assets prefixed with `xyz:` (like `xyz:TSLA`, oil, gold) are newer, lower liquidity. Spreads are wider but moves are larger. HIP-3 assets overshoot dramatically due to thin books — this is where The Degen shines. But funding on HIP-3 can be extreme (0.1%+ per hour during hype) — factor this into hold time.

**WARNING TO USER:** This strategy has the highest potential returns AND the highest risk of blowing up. A 10-20x leveraged position can liquidate in minutes without a stop loss. Only use money you're prepared to lose entirely.

**Best for:** Users who explicitly want max risk/max reward. Fun, exciting, and potentially very profitable — or very not.

---

## 5. Advanced Quantitative Signals

These signals separate cracked traders from everyone else. Use them to confirm entries and avoid traps.

### Signal 1: Cumulative Volume Delta (CVD) Divergence

CVD tracks whether aggressive buyers or sellers are driving price. Every trade has an aggressor (taker):
- **Buy aggressor:** Trade at the ask = buying pressure
- **Sell aggressor:** Trade at the bid = selling pressure
- **Delta = Buy volume - Sell volume**
- **CVD = Running cumulative sum of delta**

**How to detect divergence (using candle data as proxy):**
When a candle closes bullish but on declining volume, or when price makes a new high but recent candles show decreasing volume — this approximates CVD divergence.

**The money signal:** Price makes a new high but volume is declining = bearish divergence. One of the highest-probability reversal signals in crypto perps. Do NOT open new longs when this is present.

### Signal 2: Funding Rate Timing (Pre/Post Snapshot)

Hyperliquid funding settles every hour on the hour. Predictable timing creates predictable behavior:

- **30-60 minutes BEFORE settlement:** If funding is positive, selling pressure increases as traders close longs to avoid paying. This creates a dip.
- **15-30 minutes AFTER settlement:** The selling pressure lifts. Price often bounces.
- **Strategy:** For positive funding, short 60 min before the hour, cover at settlement, go long immediately after. Reverse for negative funding.
- **Edge:** Small per-trade (0.05-0.15%) but highly consistent and automatable.

### Signal 3: Premium/Discount Monitoring

From `metaAndAssetCtxs`, the `premium` field shows perp vs oracle price deviation:

```bash
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"metaAndAssetCtxs"}' | jq '.[1][] | {coin: .coin, premium: .premium, markPx: .markPx, oraclePx: .oraclePx}'
```

- **Persistent positive premium** (perp > oracle) = bullish sentiment, longs dominant
- **Persistent negative premium** (perp < oracle) = bearish sentiment, shorts dominant
- **Premium spike + extreme funding** = the crowd is maximally one-directional. High-probability mean reversion setup.

### Signal 4: Liquidation Cascade Prediction

The three conditions that precede a cascade:
1. **High OI concentration** in one direction (check funding rate as proxy — extreme = one-sided)
2. **ATR compression** (low volatility = coiled spring)
3. **Price approaching a cluster of liquidation levels** (typically round numbers, recent swing highs/lows)

When all three conditions are present, the cascade direction is almost always toward the liquidation cluster. The cascade creates a violent, fast move that reverses equally violently once it exhausts.

**Partial liquidation note:** On Hyperliquid, positions > $100K USDC are only 20% liquidated at a time with a 30-second cooldown. Large position cascades happen in waves, not instantly — this gives you time to enter.

### Signal 5: Cross-Asset Correlation Breaks

Monitor `allMids` to detect when normally correlated assets diverge:

```bash
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type":"allMids"}' | jq '.'
```

**Typical correlations:** BTC/ETH ~0.85, ETH/SOL ~0.75, SOL/AVAX ~0.70

When these ratios diverge significantly (e.g., ETH drops 3% while BTC is flat), there's a mean-reversion opportunity:
- Long the underperformer, short the outperformer
- Dollar-neutral sizing (equal notional on both legs)
- Exit when the ratio returns to its mean

**Warning:** Correlations break down during narratives (e.g., SOL pumps on meme coin mania while ETH is flat). Use a rolling correlation window to detect regime changes — if 7-day correlation drops below 0.5, the pair is not mean-reverting, it's diverging. Don't fight it.

---

## 6. Risk Management Engine

These rules are NON-NEGOTIABLE regardless of strategy template. They protect your Sortino ratio.

### Position Sizing: ATR-Volatility Adjusted

Never use fixed dollar amounts. Always scale to current volatility:

```
Risk_Amount = Account_Equity × Risk_Percent
Stop_Distance = ATR(14) × ATR_Multiplier
Position_Size = Risk_Amount / Stop_Distance
```

| Strategy | Risk_Percent | ATR_Multiplier |
|----------|-------------|----------------|
| Tortoise | 1.0% | 2.0 |
| Scalp Surgeon | 0.5% | 1.5 |
| Funding Farmer | N/A | N/A (fixed % allocation) |
| Sniper | 1.5% | pattern-based |
| Degen | 2.0% | 1.0 |

**Volatility regime adjustment:** When ATR is above its 75th percentile (high vol), HALVE position size. When below 25th percentile (low vol), increase by 25%.

### Dynamic Leverage by Volatility Regime

| Regime | BTC/ETH 30d Realized Vol | Max Leverage | Position Risk |
|--------|--------------------------|-------------|---------------|
| Low vol | < 40% annualized | 10-20x | 1-2% equity |
| Normal | 40-80% | 5-10x | 1% equity |
| High vol | 80-120% | 3-5x | 0.5-1% equity |
| Crisis | > 120% | 1-2x or flat | 0.25-0.5% equity |

For altcoins, divide max leverage by 2-3x.

### Stop Losses: ATR-Based (The Gold Standard)

```
Long Stop = Entry - (ATR(14) × Multiplier)
Short Stop = Entry + (ATR(14) × Multiplier)
```

- Multiplier 1.5 for scalps (tight, needs higher win rate)
- Multiplier 2.0 for swings (standard)
- Multiplier 3.0 for position trades (wide, lower win rate acceptable)

**Never use fixed percentage stops in crypto.** A 3% stop might be too tight in high vol (stops you out on noise) and too wide in low vol (gives back too much profit). ATR-based stops adapt automatically.

**Break-even management:** After price moves 1R in your favor, move stop to entry price MINUS a 0.2 × ATR buffer. The buffer prevents stop-hunting wicks — stops at exact round numbers or break-even get hunted constantly in crypto.

### Trailing Stops: Chandelier Exit

For capturing trends without giving back profits:

```
Trailing Stop = Highest_High(22 periods) - ATR(22) × 3.0
```

Update every candle close. Never move the trailing stop backward (toward entry). This locks in profits as the trend extends.

### Partial Profit Taking

**For trend strategies (Tortoise, Sniper):**
- Take 50% at 2R. Move stop to break-even on remainder. Trail with chandelier.
- This ensures you bank profit while letting winners run.

**For mean reversion (Scalp Surgeon, Funding Farmer):**
- Take 1/3 at 1R, 1/3 at 2R, trail final 1/3
- Mean reversion trades have defined targets — take profits quickly.

**For Degen:**
- Take 1/3 at 2R, 1/3 at 3R, trail final 1/3 with 2x ATR
- Aggressive profit taking because high-leverage momentum can reverse fast.

### Maximum Drawdown Circuit Breaker

| Drawdown from Peak | Action |
|---------------------|--------|
| 10% | Reduce all position sizes to 50% of normal |
| 15% | Stop opening new trades. Close weakest position. |
| 20% | HALT all trading for 24 hours. Reassess strategy. |
| 25% | Ask user if they want to continue or withdraw remaining funds |

**Why this matters — drawdown recovery math:**

| Drawdown | Return Needed to Recover |
|----------|------------------------|
| 10% | 11.1% |
| 20% | 25.0% |
| 30% | 42.9% |
| 50% | 100.0% |

Keeping max drawdown under 20% is paramount. Beyond that, recovery becomes exponentially harder.

### Correlation Risk

- **Never hold 2+ highly correlated positions simultaneously.** Long ETH + Long SOL = doubled crypto market exposure.
- **Assume all crypto becomes 0.95 correlated during crashes.** Size your total book as if it's one position.
- **Hedge rule:** If you must run multiple long positions, keep a BTC or ETH short sized at 20-30% of total long exposure.

### Kelly Criterion (Quarter Kelly for Crypto)

After 50+ trades, calculate optimal sizing:

```
Kelly % = (Win_Rate × Avg_Win/Avg_Loss - Loss_Rate) / (Avg_Win/Avg_Loss)
Quarter Kelly = Kelly % × 0.25
```

Example: 55% win rate, 2:1 R/R:
```
Kelly = (0.55 × 2.0 - 0.45) / 2.0 = 0.325 (32.5%)
Quarter Kelly = 8.1% of capital per trade
```

**Never use full Kelly in crypto.** Fat tails make it a path to ruin. Quarter Kelly is the professional standard. Cap at 5% per trade regardless of what Kelly says.

### Time-Based Exits

If a trade isn't working within its expected timeframe, close it:

| Strategy | Time Limit |
|----------|-----------|
| Scalp Surgeon | 8 hours |
| Tortoise | 3 days |
| Sniper | 5 days |
| Degen | 24 hours |

A stagnant position has negative expected value and high opportunity cost.

---

## 7. Hyperliquid-Specific Alpha

### Things Most Competitors Won't Know

1. **Hourly funding compounds 8x faster.** A 0.05%/hr rate = 1.2% per DAY. Most agents trained on Binance data underestimate how fast funding bleeds on HL. Factor this into every hold-time decision.

2. **Funding rate cap is 4% per hour.** On extreme meme coins, this cap can be hit. If you're on the paying side at the cap, you lose 4% per hour. Get out immediately.

3. **Funding includes a fixed interest rate component.** 0.01% per 8 hours (0.00125%/hr) is always paid from longs to shorts, regardless of market premium. This creates a tiny but persistent carry advantage for shorts.

4. **HIP-3 perps are the wild west.** `xyz:` prefixed assets have wider spreads, thinner books, and more extreme funding. Mean reversion after 20%+ moves on HIP-3 assets has positive expectancy. But don't hold overnight — funding can be 0.1%+/hr.

5. **S&P 500 perp is live (via Trade[XYZ]).** 24/7 equities exposure including weekends. When geopolitical news breaks on weekends, traditional markets are closed but Hyperliquid is not. Weekend news-driven trades are a structural edge.

6. **Partial liquidation mechanics.** Positions > $100K are only 20% liquidated at a time with 30-second cooldowns between waves. Large liquidation cascades happen in slow waves — this gives you time to position.

7. **Order book is fully on-chain.** Every order is transparent. You can see exactly what other traders are doing. Large resting orders being pulled (order cancellations) at a level often precede breakouts in the opposite direction.

8. **TWAP orders exist for large entries.** If entering a position > $50K notional, use TWAP to split execution over time and reduce slippage. Especially important on mid-cap and HIP-3 assets.

9. **Assets at OI cap create dislocations.** When an asset hits its open interest cap, no new positions can be opened in the overcrowded direction. This creates forced selling/buying and predictable price pressure.

10. **Fee tiers reward volume.** Base fees are 0.015% maker / 0.045% taker. At higher tiers (>$5M volume), maker fees drop to zero or negative (rebates). Always use limit orders to pay maker fees.

### Fee Structure (Corrected)

| Tier | 14-Day Volume | Maker | Taker |
|------|--------------|-------|-------|
| Base | < $5M | 0.015% | 0.045% |
| VIP 1 | > $5M | 0.012% | 0.040% |
| VIP 2 | > $25M | 0.008% | 0.035% |
| VIP 3 | > $100M | 0.004% | 0.030% |
| VIP 4+ | > $500M | 0.000% (rebates available) | 0.028% |

**Always use limit orders when possible.** The maker/taker difference is 0.03% at base tier — that's $3 per $10K notional. On 100 trades, that's $300 saved.

---

## 8. Presenting Strategies to Users

When a user wants to start trading in the competition, present options like this:

### The Pitch

"Alright, before we start trading, let's pick your style. I've got five strategy templates — each one is optimized for the DegenClaw scoring system (which weights risk-adjusted returns heavily, not just raw profit). Think of these as starting points — we can always tweak the parameters as we go.

**The Tortoise** — Conservative trend following. Low leverage, tight stops, steady returns. Best Sortino score. *'Slow and steady wins the $100K.'*

**The Scalp Surgeon** — Precision short-term trades. In and out in hours. Many small wins. *'Death by a thousand cuts — but for the other guy.'*

**The Funding Farmer** — Collect funding rate payments by trading against the crowd. Lowest drama, steadiest returns. *'While everyone's gambling, we're collecting rent.'*

**The Sniper** — Wait for perfect setups, then strike hard. Trades rarely, wins big. *'One shot. One kill.'*

**The Degen** — Full send. High leverage, explosive moves, tight stops. Maximum upside, maximum risk. *'Fortune favors the bold. Results may vary.'*

Which one speaks to you? Or tell me what you're thinking and I'll customize something."

### After Selection

Once the user picks, confirm:
- Leverage level
- Risk per trade
- How aggressive/conservative
- Per-trade approval or autonomous mode

**Save the strategy selection to MEMORY.md** so it persists across sessions. Include the specific parameters they chose.

### Performance Expectations (Be Honest)

| Strategy | Expected Monthly Return | Expected Max Drawdown | Best Market | Worst Market |
|----------|------------------------|----------------------|-------------|--------------|
| Tortoise | 5-12% | 5-10% | Trending | Choppy/ranging |
| Scalp Surgeon | 8-20% | 8-15% | Volatile intraday | Low vol, no movement |
| Funding Farmer | 3-8% | 3-8% | Ranging, high funding | Strong trending |
| Sniper | 10-30% | 10-20% | Breakouts | No setups (idle) |
| Degen | 20-100%+ | 20-50%+ | Explosive momentum | Any reversal or chop |

**Always caveat:** "These are estimates based on the strategy design. Crypto markets are unpredictable. Past performance doesn't guarantee future results. Never trade with money you can't afford to lose."

---

## 9. Ongoing Trading Operations

### Before Every Trade

1. **Market regime:** Pull 4H candles, calculate ATR percentile. Determine if low/normal/high vol.
2. **Funding check:** Pull current + predicted funding rates. Identify funding edge or headwind.
3. **Order book:** Pull L2 book, calculate OBI. Confirm directional bias.
4. **OI check:** Compare to recent levels. Check for OI cap assets.
5. **Multi-timeframe:** Verify 3+ timeframes agree.
6. **Position sizing:** Calculate ATR-adjusted size. Apply regime adjustment.
7. **Confirm with user** (unless autonomous mode is enabled).

### After Every Trade Open

1. Post to Signals thread: entry rationale, levels, leverage, R/R, funding context
2. Set stop loss immediately (before anything else)
3. Check portfolio correlation — are we doubling exposure to one direction?

### After Every Trade Close

1. Post to Signals thread: exit reason, realized PnL, what worked, lessons
2. Recalculate position sizing (account balance changed)
3. Update running stats: win rate, avg R/R, profit factor, Sortino estimate
4. Check if drawdown circuit breaker thresholds are being approached

### Weekly Review

1. Check leaderboard: `dgclaw.sh leaderboard-agent <agentName>`
2. Review: win rate, average R/R, profit factor, max drawdown, Sortino estimate
3. Compare ATR regime to strategy performance — was the strategy suited to this week's market?
4. Suggest adjustments if performance is off-track
5. Report to user: weekly performance summary with honest assessment

---

## 10. Disclaimer (Always Include When Discussing Trading)

"Trading perpetual futures involves significant risk. Leveraged positions can result in losses exceeding your initial deposit. The DegenClaw competition uses real capital — losses are real. I'll do my best to follow the strategy we've chosen and manage risk carefully, but no strategy guarantees profits. Season rules, scoring parameters, and reward amounts may change at Virtuals Protocol's discretion. Please only trade with funds you can afford to lose."
