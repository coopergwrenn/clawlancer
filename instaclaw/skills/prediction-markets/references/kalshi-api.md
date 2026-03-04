# Kalshi REST API v2 Reference

## Base URL

- **Production:** `https://trading-api.kalshi.com/trade-api/v2`
- **Demo (paper trading):** `https://demo-api.kalshi.com/trade-api/v2`

## Authentication

Kalshi uses RSA key-pair signing. Each request requires 3 headers:

| Header | Description |
|--------|-------------|
| `KALSHI-ACCESS-KEY` | API Key ID from Settings → API |
| `KALSHI-ACCESS-TIMESTAMP` | Unix timestamp in milliseconds |
| `KALSHI-ACCESS-SIGNATURE` | Base64-encoded RSA-PSS signature |

### Signature Generation

```python
import base64, time
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

timestamp = str(int(time.time() * 1000))
message = (timestamp + method.upper() + path).encode("utf-8")
# path = "/trade-api/v2/portfolio/balance" — NO query params in signature

private_key = serialization.load_pem_private_key(pem_bytes, password=None)
signature = private_key.sign(
    message,
    padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.MAX_LENGTH),
    hashes.SHA256(),
)
sig_b64 = base64.b64encode(signature).decode()
```

**Important:** The signature path MUST include the full path prefix (`/trade-api/v2/...`) but MUST NOT include query parameters.

## Key Endpoints

### Markets

```
GET /markets                — List markets (paginated, filterable)
GET /markets/{ticker}       — Get single market by ticker
```

Query params for listing:
- `limit` (1-1000, default 100)
- `cursor` — pagination cursor from previous response
- `status` — `unopened`, `open`, `closed`, `settled`

Market response fields:
- `ticker` — Market identifier (e.g., `KXBTC-26MAR14-B90000`)
- `event_ticker` — Parent event
- `market_type` — `binary` or `scalar`
- `status` — `active`, `closed`, `settled`, etc.
- `yes_bid_dollars` / `yes_ask_dollars` — Best YES bid/ask (FixedPointDollars)
- `no_bid_dollars` / `no_ask_dollars` — Best NO bid/ask
- `last_price_dollars` — Most recent trade
- `volume_24h_fp` — 24h volume (FixedPointCount)
- `open_interest_fp` — Open interest
- `rules_primary` — Resolution criteria

### Portfolio

```
GET /portfolio/balance      — Account balance and portfolio value
GET /portfolio/positions    — Open positions (market + event level)
GET /portfolio/orders       — Order history (filterable by status)
GET /portfolio/orders/{id}  — Single order details
```

Balance response (amounts in **cents**):
```json
{
  "balance": 50000,
  "portfolio_value": 75000
}
```

### Orders

```
POST /portfolio/orders              — Place an order
DELETE /portfolio/orders/{order_id}  — Cancel an order
```

Order body:
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

Fields:
- `ticker` (required) — Market ticker
- `action` (required) — `buy` or `sell`
- `side` (required) — `yes` or `no`
- `type` — `limit` or `market`
- `count` — Number of contracts (integer)
- `yes_price` / `no_price` — Price in cents (1-99)
- `time_in_force` — `fill_or_kill`, `good_till_canceled`, `immediate_or_cancel`

## Data Formats

- **Prices:** Cents (1-99). A YES price of 45 = $0.45 = 45% implied probability.
- **Balances:** Cents. `50000` = $500.00.
- **Timestamps:** Unix milliseconds.
- **Settlement:** Binary markets pay $1.00 per contract (100 cents) if correct, $0.00 if wrong.
- **Ticker format:** `KXBTC-26MAR14-B90000` = event-date-strike

## Rate Limits

- Per-endpoint limits apply
- 429 responses include `Retry-After` header
- Be respectful: max 1 request/second for browsing, batch where possible

## Python SDK

```bash
pip install kalshi-python
```

The SDK provides typed wrappers for all endpoints. For this integration we use raw HTTP with `urllib` to avoid additional dependencies.
