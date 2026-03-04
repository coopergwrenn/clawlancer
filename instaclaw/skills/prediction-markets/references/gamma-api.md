# Polymarket Gamma API Reference

Base URL: `https://gamma-api.polymarket.com`

No authentication required. All endpoints are public, read-only. Responses are JSON.

---

## GET /markets

List and search prediction markets.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 100 | Number of results to return (max 100) |
| `offset` | integer | 0 | Pagination offset (skip N results) |
| `closed` | boolean | — | `false` = open markets only, `true` = resolved/closed only |
| `order` | string | — | Sort field (see table below) |
| `ascending` | boolean | true | Sort direction. `false` = descending (highest first) |
| `id` | string | — | Fetch specific market(s) by ID (comma-separated for multiple) |

**No server-side search:** The Gamma API does NOT support text search or category filtering. Parameters like `tag`, `slug_contains`, `active`, `_q`, and `search` are accepted but **silently ignored**. To find markets on a specific topic, fetch `limit=100` and filter client-side by keyword on the `question` field.

### Sortable Fields

| Field | What it sorts by |
|-------|-----------------|
| `volume24hr` | 24-hour trading volume (best for "what's hot now") |
| `volumeNum` | All-time total volume |
| `liquidityNum` | Current liquidity depth |
| `endDate` | Resolution deadline (ascending = closing soonest) |
| `createdAt` | Market creation date |

### Example: Top 10 Markets by 24h Volume

```bash
curl -s "https://gamma-api.polymarket.com/markets?limit=10&closed=false&order=volume24hr&ascending=false"
```

### Example: Search for Bitcoin Markets (client-side filter)

```bash
curl -s "https://gamma-api.polymarket.com/markets?limit=100&closed=false&order=volume24hr&ascending=false" | \
  python3 -c "
import json, sys
markets = json.load(sys.stdin)
matches = [m for m in markets if any(kw in m['question'].lower() for kw in ['bitcoin', 'btc'])]
for m in matches[:10]:
    prices = json.loads(m['outcomePrices'])
    print(f\"{m['question'][:60]} — Yes: {float(prices[0])*100:.0f}%\")
"
```

### Example: Politics Markets (client-side filter)

```bash
curl -s "https://gamma-api.polymarket.com/markets?limit=100&closed=false&order=volume24hr&ascending=false" | \
  python3 -c "
import json, sys
markets = json.load(sys.stdin)
keywords = ['trump', 'biden', 'election', 'president', 'congress', 'senate', 'fed ', 'supreme court']
matches = [m for m in markets if any(kw in m['question'].lower() for kw in keywords)]
for m in matches[:10]:
    prices = json.loads(m['outcomePrices'])
    print(f\"{m['question'][:60]} — Yes: {float(prices[0])*100:.0f}% — Vol: \${m.get('volume24hr',0):,.0f}\")
"
```

### Example: Markets Closing Within a Week

```bash
curl -s "https://gamma-api.polymarket.com/markets?closed=false&order=endDate&ascending=true&limit=20"
```
Then filter client-side for `endDate` within 7 days of today.

### Example: Paginate Through Results

```bash
# Page 1
curl -s "https://gamma-api.polymarket.com/markets?limit=20&offset=0&closed=false&order=volume24hr&ascending=false"

# Page 2
curl -s "https://gamma-api.polymarket.com/markets?limit=20&offset=20&closed=false&order=volume24hr&ascending=false"
```

### Response Schema (Market Object)

```json
{
  "id": "654415",
  "question": "Will the Fed increase interest rates by 25+ bps after the March 2026 meeting?",
  "slug": "will-the-fed-increase-interest-rates-march-2026",
  "conditionId": "0xabc123...",
  "description": "Full description with resolution criteria...",
  "outcomes": "[\"Yes\", \"No\"]",
  "outcomePrices": "[\"0.0065\", \"0.9935\"]",
  "volume": "58584749.123",
  "volumeNum": 58584749,
  "volume24hr": 5255133,
  "volume1wk": 12345678,
  "volume1mo": 45678901,
  "liquidityNum": 1720416,
  "endDate": "2026-03-18T00:00:00Z",
  "endDateIso": "2026-03-18",
  "active": true,
  "closed": false,
  "bestAsk": 0.007,
  "lastTradePrice": 0.0065,
  "oneDayPriceChange": -0.002,
  "oneWeekPriceChange": -0.015,
  "clobTokenIds": "[\"5313507...\", \"6086987...\"]",
  "image": "https://polymarket-upload.s3.us-east-2.amazonaws.com/...",
  "events": [{ "id": "12345", "title": "..." }],
  "createdAt": "2026-01-15T10:33:13.541Z",
  "updatedAt": "2026-02-24T18:00:00.000Z"
}
```

### Key Fields Explained

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Unique market identifier. Use in `/markets/{id}` |
| `question` | string | The prediction question displayed to users |
| `slug` | string | URL-friendly identifier. Use with event slug for URLs. |
| `outcomes` | JSON string | **Must parse with `json.loads()` or `jq fromjson`**. Usually `["Yes", "No"]` but can be multi-outcome |
| `outcomePrices` | JSON string | **Must parse**. Prices in range [0, 1]. $0.65 = 65% implied probability |
| `volumeNum` | number | Total all-time volume in USD |
| `volume24hr` | number | Last 24h volume in USD. Best measure of current activity |
| `liquidityNum` | number | Current liquidity in USD. Higher = more reliable prices |
| `endDate` | string | ISO 8601 resolution deadline |
| `endDateIso` | string | Short date (e.g., "2026-03-18"). Sometimes missing (~5%) |
| `closed` | boolean | `true` = market resolved, trading stopped |
| `bestAsk` | number | Best ask price (always present) |
| `lastTradePrice` | number | Most recent trade price |
| `bestBid` | number | Best bid price. **Sometimes missing (~15%)** — use `.get('bestBid', 0)` |
| `oneDayPriceChange` | number | 24h price change. **Sometimes missing (~30%)** — use `.get('oneDayPriceChange', 0)` |
| `oneWeekPriceChange` | number | 7d price change. **Sometimes missing (~25%)** — use `.get()` |
| `description` | string | Full description including resolution criteria |
| `events` | array | Associated event objects. Use `events[0].slug` to construct Polymarket URLs |
| `clobTokenIds` | JSON string | Token IDs for the CLOB orderbook (Phase 2/3 only) |

**Important:** `outcomes` and `outcomePrices` are JSON strings, not arrays. Always parse them:
```bash
# jq
echo "$RESPONSE" | jq '.outcomes | fromjson'

# Python
outcomes = json.loads(market['outcomes'])
prices = json.loads(market['outcomePrices'])
```

---

## GET /markets/{id}

Get details for a single market by ID.

### Example

```bash
curl -s "https://gamma-api.polymarket.com/markets/654415"
```

Returns a single market object (same schema as above).

---

## GET /events

List events. Events group related markets (e.g., "2028 Democratic Primary" contains 128 candidate markets).

### Parameters

Supports: `limit`, `offset`, `closed`, `order`, `ascending`. Valid `order` values for events: `volume`, `volume24hr`, `endDate`, `createdAt`. (`volumeNum` and `liquidityNum` do NOT work on events.)

**No server-side search:** Same limitation as `/markets` — no text search or category filtering. Fetch a batch and filter client-side.

### Example: Biggest Events by Volume

```bash
curl -s "https://gamma-api.polymarket.com/events?limit=10&closed=false&order=volume&ascending=false"
```

### Response Schema (Event Object)

```json
{
  "id": "30829",
  "ticker": "democratic-presidential-nominee-2028",
  "slug": "democratic-presidential-nominee-2028",
  "title": "Democratic Presidential Nominee 2028",
  "description": "Who will be the 2028 Democratic nominee?",
  "startDate": "2025-01-20T00:00:00Z",
  "endDate": "2028-08-30T00:00:00Z",
  "active": true,
  "closed": false,
  "volume": 707262531,
  "liquidity": 12345678,
  "commentCount": 8125,
  "markets": [
    { "id": "...", "question": "...", "outcomePrices": "...", ... }
  ]
}
```

### Key Event Fields

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Unique event identifier |
| `title` | string | Event title |
| `slug` | string | URL slug — use for `polymarket.com/event/{slug}` |
| `volume` | number | Total volume across all markets in this event |
| `markets` | array | All markets belonging to this event. **Note:** some placeholder markets may lack `outcomePrices` — always use `.get()` |

---

## GET /events/{id}

Get details for a single event, including all associated markets.

### Example

```bash
curl -s "https://gamma-api.polymarket.com/events/30829"
```

---

## Common Query Patterns

### Pattern 1: "What's hot right now?"
```bash
curl -s "https://gamma-api.polymarket.com/markets?limit=10&closed=false&order=volume24hr&ascending=false" | \
  jq '.[] | {question, price_yes: (.outcomePrices | fromjson | .[0]), vol_24h: .volume24hr, total_vol: .volumeNum}'
```

### Pattern 2: "All crypto prediction markets"
```bash
# Fetch large batch, filter client-side by keyword
curl -s "https://gamma-api.polymarket.com/markets?limit=100&closed=false&order=volume24hr&ascending=false" | \
  python3 -c "
import json, sys
markets = json.load(sys.stdin)
crypto_kw = ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'token', 'defi', 'solana', 'nft']
matches = [m for m in markets if any(kw in m['question'].lower() for kw in crypto_kw)]
for m in matches[:20]:
    prices = json.loads(m['outcomePrices'])
    print(f\"{m['question'][:60]} — Yes: {float(prices[0])*100:.0f}% — Vol: \${m.get('volume24hr',0):,.0f}\")
"
```

### Pattern 3: "Markets about a specific topic"
```bash
# Client-side keyword filter (replace keywords for your topic)
curl -s "https://gamma-api.polymarket.com/markets?limit=100&closed=false&order=volume24hr&ascending=false" | \
  python3 -c "
import json, sys
markets = json.load(sys.stdin)
matches = [m for m in markets if 'fed' in m['question'].lower() or 'rate' in m['question'].lower()]
for m in matches[:10]:
    prices = json.loads(m['outcomePrices'])
    print(f\"{m['question'][:60]} — Yes: {float(prices[0])*100:.0f}%\")
"
```

### Pattern 4: "What's the probability of X?"
```bash
# Fetch markets, find the specific one, extract probabilities
curl -s "https://gamma-api.polymarket.com/markets?limit=100&closed=false&order=volume24hr&ascending=false" | \
  python3 -c "
import json, sys
for m in json.load(sys.stdin):
    if 'bitcoin' in m['question'].lower() and '200k' in m['question'].lower():
        prices = json.loads(m['outcomePrices'])
        outcomes = json.loads(m['outcomes'])
        print(f\"{m['question']}\")
        for o, p in zip(outcomes, prices):
            print(f\"  {o}: {float(p)*100:.1f}%\")
"
```

### Pattern 5: "Biggest price movers today"
```bash
curl -s "https://gamma-api.polymarket.com/markets?limit=50&closed=false&order=volume24hr&ascending=false" | \
  python3 -c "
import json, sys
markets = json.load(sys.stdin)
# Sort by absolute price change
movers = sorted(markets, key=lambda m: abs(m.get('oneDayPriceChange', 0)), reverse=True)
for m in movers[:10]:
    change = m.get('oneDayPriceChange', 0)
    sign = '+' if change >= 0 else ''
    print(f\"{sign}{change*100:.1f}% | {m['question'][:60]}\")
"
```

### Pattern 6: "Markets resolving this week"
```bash
curl -s "https://gamma-api.polymarket.com/markets?closed=false&order=endDate&ascending=true&limit=30" | \
  python3 -c "
import json, sys
from datetime import datetime, timedelta
markets = json.load(sys.stdin)
cutoff = (datetime.utcnow() + timedelta(days=7)).isoformat()
for m in markets:
    if m.get('endDate', '9999') <= cutoff:
        prices = json.loads(m['outcomePrices'])
        print(f\"{m['endDate'][:10]} | {m['question'][:50]} | Yes: {float(prices[0])*100:.0f}%\")
"
```

### Pattern 7: "Event deep-dive (multi-outcome)"
```bash
# Fetch event with all markets (note: some placeholder markets may lack outcomePrices)
curl -s "https://gamma-api.polymarket.com/events/30829" | \
  python3 -c "
import json, sys
event = json.load(sys.stdin)
print(f\"Event: {event['title']}\")
print(f\"Volume: \${event['volume']:,.0f}\")
print()
# Filter to markets that have prices (skip placeholders)
priced = [m for m in event.get('markets', []) if m.get('outcomePrices')]
for m in sorted(priced, key=lambda x: -float(json.loads(x['outcomePrices'])[0]))[:20]:
    prices = json.loads(m['outcomePrices'])
    print(f\"  {float(prices[0])*100:.1f}% — {m['question'][:60]}\")
"
```

---

## Rate Limiting

The Gamma API is public and doesn't enforce strict rate limits, but be a good citizen:

| Guideline | Limit |
|-----------|-------|
| Browsing/scanning | Max 1 request per second |
| Market scan workflow | 3-5 total API calls |
| Daily monitoring | Max 20 API calls per check |
| Burst limit | Never >5 requests in 1 second |

**If you get errors:**
- HTTP 429: Rate limited. Wait 60 seconds.
- HTTP 500/502/503: Server issue. Wait 30 seconds, retry once.
- Empty response `[]`: Query may be too specific. Broaden search terms.
- Timeout: API may be under load. Wait 30 seconds.

**Best practices:**
- Use `limit=20` and filter client-side rather than making many small requests
- Cache results for at least 60 seconds if querying the same market repeatedly
- For market scans, batch everything: one call for top markets, one for events, one for specific topic

---

## Constructing Polymarket URLs

To link users to a specific market on Polymarket's website, you need BOTH the event slug and the market slug:
```
https://polymarket.com/event/{event_slug}/{market_slug}
```

Get the event slug from `market.events[0].slug` (embedded in every market response).

**Example:**
```python
market_slug = market['slug']  # "will-tottenham-win-the-202526-english-premier-league"
event_slug = market['events'][0]['slug']  # "english-premier-league-winner"
url = f"https://polymarket.com/event/{event_slug}/{market_slug}"
# → https://polymarket.com/event/english-premier-league-winner/will-tottenham-win-the-202526-english-premier-league
```

For event-level links (showing all markets in an event):
```
https://polymarket.com/event/{event_slug}
```

---

## Error Handling

```bash
# Robust fetch with error handling
RESPONSE=$(curl -s --max-time 10 -w "\n%{http_code}" "https://gamma-api.polymarket.com/markets?limit=10&closed=false&order=volume24hr&ascending=false")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

# Check HTTP status
if [ "$HTTP_CODE" != "200" ]; then
  echo "Polymarket API returned HTTP $HTTP_CODE. Data temporarily unavailable."
  exit 0
fi

# Check for empty or error response
if [ -z "$BODY" ] || [ "$BODY" = "[]" ]; then
  echo "Polymarket data is temporarily unavailable."
  exit 0
fi

# Check for JSON error response (API sometimes returns {"type":"validation error",...})
echo "$BODY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
if isinstance(data, dict) and 'error' in data:
    print(f'Polymarket API error: {data[\"error\"]}')
    sys.exit(1)
" 2>/dev/null
if [ $? -ne 0 ]; then
  echo "Polymarket API returned an error."
  exit 0
fi
```

**Handling null fields in Python:**
```python
# Always use .get() with defaults for sometimes-missing fields
change = m.get('oneDayPriceChange', 0) or 0  # handles both missing and None
bid = m.get('bestBid', 0) or 0
end_date = m.get('endDateIso', m.get('endDate', 'N/A')[:10])
```
