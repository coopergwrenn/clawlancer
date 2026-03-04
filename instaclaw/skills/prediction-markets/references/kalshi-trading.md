# Kalshi Trading Patterns & Strategies

## Market Discovery

### Find markets by category
```bash
# Kalshi organizes markets into events and series
# Browse open markets sorted by volume
curl -s "https://trading-api.kalshi.com/trade-api/v2/markets?status=open&limit=50" \
  -H "Accept: application/json"
```

Note: Unlike Polymarket's Gamma API, Kalshi's market listing requires authentication for most useful filtering. Use the `kalshi-positions.py` and `kalshi-trade.py` scripts.

### Ticker format
- `KXBTC-26MAR14-B90000` — Bitcoin above $90,000 by March 14, 2026
- `KXFED-26MAR19-T425` — Fed rate target at 4.25% on March 19
- Pattern: `{EVENT}-{DATE}-{STRIKE}`

## Order Types

### Limit orders (default)
- Specify exact price in cents
- Sits on book until filled or cancelled
- Use `time_in_force: "good_till_canceled"` (default)

### Market orders
- Fill immediately at best available price
- Higher slippage risk on thin markets
- Use `type: "market"` (no price needed)

### Fill-or-Kill
- Must fill entire order immediately or cancel
- Use `time_in_force: "fill_or_kill"`
- Good for ensuring full execution

## Strategy Patterns

### News-driven trading
1. Identify upcoming event (Fed meeting, earnings, election)
2. Research expected outcome using web search
3. Compare market price to your estimated probability
4. If edge > 5%, place a trade
5. Monitor and exit before expiration if thesis changes

### Cross-platform arbitrage
- Same event may trade on both Polymarket and Kalshi
- Price differences = arbitrage opportunity
- Example: "Fed cuts rates" at 72% on Polymarket, 68% on Kalshi
- Buy on cheaper platform, sell on expensive one
- Complexity: different settlement, different collateral (USDC vs USD)

### Position sizing
- Never risk more than 5% of portfolio on a single trade
- Use the risk config to enforce daily limits
- Scale into positions — don't go all-in at once

## Risk Management

### Daily limits
The `kalshi-risk-config.json` file controls:
- `enabled` — Must be `true` to trade
- `daily_spend_cap` — Max USD spent per day
- `max_position_size` — Max single trade size
- `daily_loss_limit` — Stop trading if losses exceed this

### When to exit
- Your thesis was wrong — news contradicts your position
- You've hit your profit target (e.g., 2x on the trade)
- Market is approaching expiration with unclear resolution
- Better opportunity elsewhere

## Common Mistakes

1. **Ignoring liquidity** — Thin markets have wide spreads. Check bid/ask before trading.
2. **Overconcentration** — Don't put all funds in one market.
3. **Chasing losses** — Don't double down on a losing position.
4. **Ignoring fees** — Kalshi charges per-contract fees. Factor into P&L.
5. **Not reading rules** — Each market has specific resolution criteria. Read `rules_primary` before trading.
