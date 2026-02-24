# Polymarket CLOB API Trading Reference

This document covers the Polymarket CLOB (Central Limit Order Book) API for placing trades, managing positions, and monitoring prices in real-time.

---

## Prerequisites

1. **Polygon EOA wallet** — Generated via `bash ~/scripts/setup-polymarket-wallet.sh`
2. **py-clob-client SDK** — Python client for the CLOB API (`pip3 install py-clob-client`)
3. **eth-account** — Ethereum account utilities (installed as dependency of py-clob-client)
4. **USDC.e balance** — Bridged USDC on Polygon (chain 137) for trading
5. **MATIC balance** — Native Polygon token for gas fees (~0.1 MATIC sufficient for many trades)

---

## Setup Flow

### 1. Initialize Client

```python
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs, OrderType
from py_clob_client.order_builder.constants import BUY, SELL
import json, os

# Load wallet
with open(os.path.expanduser("~/.openclaw/polymarket/wallet.json")) as f:
    wallet = json.load(f)

# Initialize CLOB client
host = "https://clob.polymarket.com"
client = ClobClient(
    host,
    key=wallet["private_key"],
    chain_id=137  # Polygon mainnet
)
```

### 2. Derive API Credentials

First-time setup — derive API credentials from your wallet:

```python
# Create or derive API credentials (idempotent — safe to call multiple times)
api_creds = client.create_or_derive_api_creds()

# Set the derived credentials on the client
client.set_api_creds(api_creds)
```

API credentials are derived deterministically from the wallet private key, so they don't need to be stored separately.

### 3. Verify Connection

```python
# Check API key validity
ok = client.get_ok()
print(f"API connection: {ok}")  # Should print "OK"
```

---

## Token IDs

Token IDs identify specific outcomes for trading. Get them from the Gamma API:

```bash
curl -s "https://gamma-api.polymarket.com/markets/654415" | \
  python3 -c "
import json, sys
m = json.load(sys.stdin)
token_ids = json.loads(m['clobTokenIds'])
outcomes = json.loads(m['outcomes'])
for outcome, tid in zip(outcomes, token_ids):
    print(f'{outcome}: {tid}')
"
```

**For binary markets (Yes/No):**
- `clobTokenIds[0]` = YES token ID
- `clobTokenIds[1]` = NO token ID

**For multi-outcome markets:**
- Each outcome has its own token ID at the corresponding index
- The event endpoint (`/events/{id}`) gives all markets with their token IDs

**Important:** Always fetch token IDs fresh from the Gamma API. Never hardcode them.

---

## Placing Orders

### Limit Buy (YES)

```python
import os, json
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs, OrderType
from py_clob_client.order_builder.constants import BUY, SELL

with open(os.path.expanduser("~/.openclaw/polymarket/wallet.json")) as f:
    wallet = json.load(f)

client = ClobClient("https://clob.polymarket.com", key=wallet["private_key"], chain_id=137)
client.set_api_creds(client.create_or_derive_api_creds())

# token_id: the YES token ID from Gamma API clobTokenIds[0]
order_args = OrderArgs(
    price=0.65,           # Limit price ($0.65 = 65% implied probability)
    size=15.38,           # Number of shares (spend = price * size = $10)
    side=BUY,
    token_id="YES_TOKEN_ID_HERE"
)

signed_order = client.create_order(order_args)
resp = client.post_order(signed_order, OrderType.GTC)  # Good-Til-Cancelled
print(f"Order placed: {resp}")
```

### Market Buy

```python
# For market orders, use a high price to fill immediately
order_args = OrderArgs(
    price=0.99,           # Near-max price ensures fill
    size=10.10,           # Shares to buy
    side=BUY,
    token_id="YES_TOKEN_ID_HERE"
)

signed_order = client.create_order(order_args)
resp = client.post_order(signed_order, OrderType.FOK)  # Fill-Or-Kill
```

### Sell Position

```python
# Sell existing shares
order_args = OrderArgs(
    price=0.70,           # Limit sell price
    size=15.38,           # Number of shares to sell
    side=SELL,
    token_id="YES_TOKEN_ID_HERE"
)

signed_order = client.create_order(order_args)
resp = client.post_order(signed_order, OrderType.GTC)
```

### Cancel Order

```python
# Cancel a specific order
client.cancel(order_id="ORDER_ID_HERE")

# Cancel all open orders
client.cancel_all()
```

### Order Types

| Type | Code | Description |
|------|------|-------------|
| Good-Til-Cancelled | `OrderType.GTC` | Stays open until filled or cancelled |
| Fill-Or-Kill | `OrderType.FOK` | Must fill entirely or not at all |
| Good-Til-Date | `OrderType.GTD` | Expires at specified date |

---

## Position Management

### Get Open Positions

```python
positions = client.get_positions()
for pos in positions:
    print(f"Market: {pos['market']}")
    print(f"  Outcome: {pos['outcome']}")
    print(f"  Size: {pos['size']}")
    print(f"  Avg Entry: ${pos['avgPrice']:.4f}")
```

### Position Tracking JSON Schema

The agent maintains `~/.openclaw/polymarket/positions.json`:

```json
{
  "version": 1,
  "positions": [
    {
      "marketId": "654415",
      "question": "Will Bitcoin hit $200k by June 2026?",
      "tokenId": "TOKEN_ID",
      "outcome": "Yes",
      "shares": 15.38,
      "avgEntryPrice": 0.65,
      "currentPrice": 0.72,
      "unrealizedPnl": 1.08,
      "openedAt": "2026-02-24T14:30:00Z",
      "lastUpdated": "2026-02-24T18:00:00Z"
    }
  ],
  "lastSync": "2026-02-24T18:00:00Z"
}
```

---

## WebSocket Price Monitoring

### Connection

```python
import asyncio
import json
import websockets

async def monitor_market(token_id: str, callback):
    uri = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
    async with websockets.connect(uri) as ws:
        # Subscribe to market
        await ws.send(json.dumps({
            "assets_ids": [token_id],
            "type": "market"
        }))

        async for message in ws:
            data = json.loads(message)
            if data.get("event_type") == "price_change":
                callback(data)

def on_price_change(data):
    price = float(data["price"])
    print(f"Price update: ${price:.4f} ({price*100:.1f}%)")

# Run monitoring
asyncio.run(monitor_market("YES_TOKEN_ID", on_price_change))
```

### Subscription Types

- `market` — Price and order book updates for a specific token
- `user` — Order fills and position updates for your wallet

---

## Wallet Generation

The `setup-polymarket-wallet.sh` script performs these steps internally:

1. Uses `eth_account.Account.create()` to generate a new Polygon-compatible EOA
2. Stores wallet details at `~/.openclaw/polymarket/wallet.json`:
   ```json
   {
     "address": "0x...",
     "private_key": "0x...",
     "chain_id": 137,
     "chain_name": "polygon",
     "created_at": "2026-02-24T10:00:00Z",
     "purpose": "polymarket-trading"
   }
   ```
3. Sets file permissions to `0o600` (owner read/write only)
4. Creates default `risk-config.json` with `enabled: false`
5. Creates empty watchlist at `~/memory/polymarket-watchlist.json`

---

## Risk Config Schema

File: `~/.openclaw/polymarket/risk-config.json`

```json
{
  "enabled": false,
  "dailySpendCapUSDC": 50,
  "confirmationThresholdUSDC": 25,
  "dailyLossLimitUSDC": 100,
  "maxPositionSizeUSDC": 100,
  "updatedAt": "2026-02-24T10:00:00Z"
}
```

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `enabled` | boolean | `false` | — | Master switch. MUST be `true` for any trade. |
| `dailySpendCapUSDC` | number | 50 | 1–500 | Max total spend per calendar day (UTC) |
| `confirmationThresholdUSDC` | number | 25 | 1–500 | Trades above this require user confirmation |
| `dailyLossLimitUSDC` | number | 100 | 1–500 | Auto-halt trading if daily losses exceed this |
| `maxPositionSizeUSDC` | number | 100 | 1–500 | Max size for any single position |
| `updatedAt` | string | — | ISO 8601 | Last time config was modified |

**Validation rules:**
- `enabled` must be explicitly set by the user — never auto-enable
- All USD amounts must be positive numbers
- `dailySpendCapUSDC` max 500 (hard limit enforced by dashboard)
- `dailyLossLimitUSDC` max 500 (hard limit enforced by dashboard)
- If any field is missing or invalid, treat as default value
- If `risk-config.json` doesn't exist, trading is disabled

---

## Trade Log Format

File: `~/.openclaw/polymarket/trade-log.json`

```json
{
  "version": 1,
  "trades": [
    {
      "id": "trade_1708785600_001",
      "timestamp": "2026-02-24T14:30:00Z",
      "marketId": "654415",
      "question": "Will Bitcoin hit $200k by June 2026?",
      "outcome": "Yes",
      "side": "BUY",
      "price": 0.65,
      "shares": 15.38,
      "totalUSDC": 10.0,
      "orderId": "ORDER_ID",
      "orderType": "GTC",
      "status": "filled",
      "reasoning": "Market pricing 65% for BTC $200k. CPI data and ETF inflows suggest 70%+ probability. 5% edge identified.",
      "thesisDriven": true
    }
  ]
}
```

Every trade MUST be logged with:
- Full market details (ID, question, outcome)
- Trade mechanics (side, price, shares, total)
- Reasoning (why the trade was made)
- Whether it was thesis-driven or user-directed

Additionally, append a summary to `~/MEMORY.md`:
```
## Trade: [Market Question]
- Date: 2026-02-24
- Action: BUY 15.38 YES @ $0.65 ($10.00 total)
- Reasoning: [Brief reasoning]
```

**NEVER log the private key or wallet details in trade logs or MEMORY.md.**

---

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `InsufficientBalance` | Not enough USDC.e | Tell user to fund wallet. Show address. |
| `NonceTooLow` / `NonceTooHigh` | Transaction nonce collision | Retry with fresh nonce (client handles this) |
| `GasEstimationFailed` | Not enough MATIC for gas | Tell user to add MATIC to wallet |
| `OrderRejected` | Price/size out of bounds | Adjust order parameters and retry |
| `APIError 429` | Rate limited | Wait 60s and retry once |
| `APIError 500` | CLOB server error | Wait 30s, retry once. If still fails, report to user. |
| `WebSocketDisconnect` | Connection dropped | Reconnect with exponential backoff (max 5 retries) |

**General rules:**
- Never retry more than 3 times for any single operation
- If a trade fails, DO NOT automatically retry — report to user
- If the CLOB API is down, fall back to read-only mode (Gamma API still works)

---

## Rate Limits

| Endpoint | Limit | Notes |
|----------|-------|-------|
| CLOB API (authenticated) | 10 req/sec | Per API key |
| Order placement | 1 order/sec | Recommended to avoid nonce issues |
| WebSocket | 1 connection per stream | Don't open multiple WS to same market |
| Gamma API (public) | 1 req/sec | Same as Phase 1 |

---

## Security Rules

1. **Private key NEVER logged** — not in MEMORY.md, not in chat, not in trade-log.json
2. **Private key only read from wallet.json** — never stored elsewhere, never passed as argument
3. **wallet.json permissions: 0o600** — owner read/write only
4. **API credentials derived, not stored** — `create_or_derive_api_creds()` is deterministic
5. **Risk config checked before every trade** — no exceptions, no bypasses
6. **Trade confirmation for large amounts** — always ask user if amount > threshold
7. **Daily limits enforced** — trading halts when spend cap or loss limit reached
