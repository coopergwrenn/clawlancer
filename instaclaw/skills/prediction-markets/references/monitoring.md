# Polymarket Monitoring & Alerts Reference

This document covers the watchlist system, recurring monitoring tasks, alert configuration, and integration with the heartbeat/cron system.

---

## Watchlist JSON Schema

File: `~/memory/polymarket-watchlist.json`

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
      "notes": "User is bullish, watching for entry point",
      "alerts": [
        {
          "type": "price_above",
          "value": 0.50,
          "triggered": false,
          "triggeredAt": null
        },
        {
          "type": "price_below",
          "value": 0.30,
          "triggered": false,
          "triggeredAt": null
        }
      ],
      "positionRef": null
    }
  ],
  "lastFullSync": "2026-02-24T10:00:00Z"
}
```

### Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `version` | number | Schema version (currently 1) |
| `markets` | array | Array of watched market objects |
| `markets[].id` | string | Gamma API market ID |
| `markets[].question` | string | Market question (for display) |
| `markets[].alertThreshold` | number | Price change threshold for generic alerts (0.05 = 5%) |
| `markets[].lastPrice` | number | YES price at last check (0-1) |
| `markets[].lastChecked` | string | ISO 8601 timestamp of last check |
| `markets[].notes` | string | User notes or context |
| `markets[].alerts` | array | Configured alert rules |
| `markets[].alerts[].type` | string | `price_above`, `price_below`, `resolution`, `volume_spike` |
| `markets[].alerts[].value` | number | Threshold value (price for price alerts, multiplier for volume) |
| `markets[].alerts[].triggered` | boolean | Whether alert has fired |
| `markets[].alerts[].triggeredAt` | string/null | ISO 8601 when triggered |
| `markets[].positionRef` | string/null | Reference to positions.json entry if holding |
| `lastFullSync` | string | ISO 8601 timestamp of last full watchlist sync |

---

## Recurring Task Templates

### 4-Hour Market Check

**Purpose:** Regular price monitoring for all watched markets.

**Implementation:**
```bash
# Fetch all watched market IDs from watchlist
python3 -c "
import json, os, sys, urllib.request
from datetime import datetime, timezone

wl_path = os.path.expanduser('~/memory/polymarket-watchlist.json')
if not os.path.exists(wl_path):
    sys.exit(0)

with open(wl_path) as f:
    wl = json.load(f)

if not wl.get('markets'):
    sys.exit(0)

alerts_triggered = []

for market in wl['markets']:
    try:
        url = f'https://gamma-api.polymarket.com/markets/{market[\"id\"]}'
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.load(resp)

        prices = json.loads(data['outcomePrices'])
        current_price = float(prices[0])
        old_price = market.get('lastPrice', current_price)
        price_change = abs(current_price - old_price)

        # Check generic threshold
        if price_change >= market.get('alertThreshold', 0.05):
            direction = 'up' if current_price > old_price else 'down'
            alerts_triggered.append(
                f\"{market['question']}: {old_price*100:.0f}% -> {current_price*100:.0f}% ({direction} {price_change*100:.1f}%)\"
            )

        # Check specific alerts
        for alert in market.get('alerts', []):
            if alert['triggered']:
                continue
            if alert['type'] == 'price_above' and current_price >= alert['value']:
                alert['triggered'] = True
                alert['triggeredAt'] = datetime.now(timezone.utc).isoformat() + 'Z'
                alerts_triggered.append(f\"ALERT: {market['question']} above {alert['value']*100:.0f}% (now {current_price*100:.0f}%)\")
            elif alert['type'] == 'price_below' and current_price <= alert['value']:
                alert['triggered'] = True
                alert['triggeredAt'] = datetime.now(timezone.utc).isoformat() + 'Z'
                alerts_triggered.append(f\"ALERT: {market['question']} below {alert['value']*100:.0f}% (now {current_price*100:.0f}%)\")

        # Update market data
        market['lastPrice'] = current_price
        market['lastChecked'] = datetime.now(timezone.utc).isoformat() + 'Z'
    except Exception as e:
        print(f'Error checking {market[\"id\"]}: {e}', file=sys.stderr)

# Save updated watchlist
wl['lastFullSync'] = datetime.now(timezone.utc).isoformat() + 'Z'
with open(wl_path, 'w') as f:
    json.dump(wl, f, indent=2)

# Output alerts for the agent to relay
if alerts_triggered:
    print('POLYMARKET ALERTS:')
    for a in alerts_triggered:
        print(f'  - {a}')
else:
    print('No watchlist alerts triggered.')
"
```

**Heartbeat integration:** Register this as a recurring check at the desired interval (default 4h). The heartbeat system will run it and the agent relays any alerts to the user.

### Daily Summary (9am User-Local)

**Purpose:** Morning briefing on all watched markets and positions.

**Template output:**
```
📊 Daily Polymarket Summary — Feb 24, 2026

WATCHED MARKETS:
1. Will Bitcoin hit $200k by June? — 41% (▲2% from yesterday)
2. Fed rate cut in March? — 72% (▼3% from yesterday)
3. US strikes Iran by March? — 18% (unchanged)

OPEN POSITIONS:
- BTC $200k YES: 15.38 shares @ $0.65 → now $0.72 (+$1.08 unrealized)

TODAY'S SPEND: $10.00 / $50.00 cap
DAILY P&L: +$1.08 (unrealized)
```

**Integration:** Set up as a heartbeat task at `0 9 * * *` (cron for 9am daily, adjusted to user's timezone).

### Weekly P&L Report (Sunday)

**Purpose:** Weekly performance summary with aggregate metrics.

**Template output:**
```
📈 Weekly Polymarket P&L — Week of Feb 17-23, 2026

TRADING ACTIVITY:
- Trades placed: 3
- Total spent: $30.00
- Total received: $12.50
- Net invested: $17.50

P&L BREAKDOWN:
- Realized P&L: +$2.50 (1 closed position)
- Unrealized P&L: +$3.20 (2 open positions)
- Total P&L: +$5.70

BEST TRADE: Fed rate cut NO @ $0.28 → sold @ $0.35 (+$2.50)
WORST TRADE: None closed at a loss this week

WATCHLIST SUMMARY:
- Markets watched: 5
- Alerts triggered: 2
- New markets added: 1
```

**Integration:** Set up as a heartbeat task at `0 10 * * 0` (cron for 10am Sunday).

---

## Alert System Design

### Alert Types

| Type | Trigger Condition | Value Meaning |
|------|-------------------|---------------|
| `price_above` | YES price >= value | Price threshold (0-1) |
| `price_below` | YES price <= value | Price threshold (0-1) |
| `resolution` | Market `closed` becomes `true` | Not used (any resolution triggers) |
| `volume_spike` | 24h volume >= value * avg_7d_volume | Multiplier (e.g., 2.0 = 2x normal) |

### Alert Lifecycle

1. **Created** — User requests alert, added to watchlist with `triggered: false`
2. **Checked** — Every monitoring cycle, conditions are evaluated
3. **Triggered** — Condition met, `triggered: true`, `triggeredAt` set, user notified
4. **Acknowledged** — User sees alert (delivered via Telegram/Discord/etc.)
5. **Reset/Removed** — User can reset (set `triggered: false`) or remove the alert

### Alert Message Format

When an alert triggers, the agent sends:
```
🔔 Polymarket Alert

[Market Question]
https://polymarket.com/event/[slug]/[slug]

Alert: Price crossed above 50%
Current price: 52% YES / 48% NO
Your threshold: 50%

24h Volume: $1.2M | Total Volume: $45M
```

---

## File Paths

| File | Path | Purpose |
|------|------|---------|
| Watchlist | `~/memory/polymarket-watchlist.json` | Market watchlist with alert config |
| Wallet | `~/.openclaw/polymarket/wallet.json` | Polygon EOA wallet (0o600 perms) |
| Risk Config | `~/.openclaw/polymarket/risk-config.json` | Trading risk parameters |
| Positions | `~/.openclaw/polymarket/positions.json` | Open position tracking |
| Trade Log | `~/.openclaw/polymarket/trade-log.json` | Trade history with reasoning |
| Wallet Script | `~/scripts/setup-polymarket-wallet.sh` | Wallet generation script |

---

## Integration with Heartbeat System

The heartbeat system (cron-like recurring tasks) can be configured to run Polymarket monitoring:

### Register a Recurring Check

Tell the agent:
```
"Check my Polymarket watchlist every 4 hours and alert me if anything moves more than 5%"
```

The agent will:
1. Ensure the watchlist file exists
2. Register a heartbeat task with the monitoring script
3. On each heartbeat, run the 4-hour market check
4. Relay any triggered alerts via the user's primary messaging channel

### Monitoring Cadence Guidelines

| Use Case | Recommended Interval | Notes |
|----------|---------------------|-------|
| Active trading | 1h | High-frequency, more heartbeat credits used |
| Casual monitoring | 4h | Default recommendation |
| Long-term positions | 12h | Low overhead, sufficient for multi-week positions |
| Weekly review only | off (manual) | User triggers checks manually |

### WebSocket vs Polling

- **Polling (heartbeat):** Better for infrequent checks, lower resource usage, works with existing heartbeat system
- **WebSocket:** Better for real-time alerts, but requires persistent connection (higher resource usage)
- **Recommendation:** Use heartbeat polling for most users. Only suggest WebSocket for active traders who need sub-minute price alerts.

### WebSocket Connection Pattern

```python
import asyncio
import json
import websockets

async def connect_polymarket_ws(token_ids: list, on_update):
    uri = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
    retry_count = 0
    max_retries = 5

    while retry_count < max_retries:
        try:
            async with websockets.connect(uri) as ws:
                retry_count = 0  # Reset on successful connection

                # Subscribe to all token IDs
                for tid in token_ids:
                    await ws.send(json.dumps({
                        "assets_ids": [tid],
                        "type": "market"
                    }))

                # Process incoming messages
                async for message in ws:
                    data = json.loads(message)
                    if data.get("event_type") == "price_change":
                        on_update(data)

        except websockets.ConnectionClosed:
            retry_count += 1
            wait = min(30, 2 ** retry_count)
            await asyncio.sleep(wait)
        except Exception as e:
            retry_count += 1
            wait = min(30, 2 ** retry_count)
            await asyncio.sleep(wait)
```

**Rules:**
- Maximum 1 WebSocket connection per market stream
- Reconnect with exponential backoff (2^n seconds, max 30s)
- Max 5 reconnection attempts before giving up
- Always clean up connections when monitoring stops
