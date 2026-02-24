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
| `active` | boolean | — | Filter by active status |
| `closed` | boolean | — | `false` = open markets only, `true` = resolved/closed only |
| `order` | string | — | Sort field (see table below) |
| `ascending` | boolean | true | Sort direction. `false` = descending (highest first) |
| `tag` | string | — | Category filter: `Politics`, `Crypto`, `Sports`, `Tech`, `Pop Culture` |
| `slug_contains` | string | — | Text search on market slug (URL-friendly title) |
| `id` | string | — | Fetch specific market(s) by ID (comma-separated for multiple) |

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

### Example: Search for Bitcoin Markets

```bash
curl -s "https://gamma-api.polymarket.com/markets?slug_contains=bitcoin&closed=false&limit=10&order=volumeNum&ascending=false"
```

### Example: Politics Markets by Total Volume

```bash
curl -s "https://gamma-api.polymarket.com/markets?tag=Politics&closed=false&limit=10&order=volumeNum&ascending=false"
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
  "category": "Politics",
  "active": true,
  "closed": false,
  "bestBid": 0.006,
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
| `slug` | string | URL-friendly identifier. Use for Polymarket links: `polymarket.com/event/{slug}` |
| `outcomes` | JSON string | **Must parse with `JSON.parse()` or `jq fromjson`**. Usually `["Yes", "No"]` but can be multi-outcome |
| `outcomePrices` | JSON string | **Must parse**. Prices in range [0, 1]. $0.65 = 65% implied probability |
| `volumeNum` | number | Total all-time volume in USD |
| `volume24hr` | number | Last 24h volume in USD. Best measure of current activity |
| `liquidityNum` | number | Current liquidity in USD. Higher = more reliable prices |
| `endDate` | string | ISO 8601 resolution deadline |
| `closed` | boolean | `true` = market resolved, trading stopped |
| `bestBid` / `bestAsk` | number | Current orderbook best bid/ask prices |
| `oneDayPriceChange` | number | Absolute price change in last 24h (e.g., -0.03 = dropped 3 cents) |
| `description` | string | Full description including resolution criteria |
| `clobTokenIds` | JSON string | Token IDs for the CLOB orderbook (used in trading, not needed for Phase 1) |

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

Same as `/markets`: `limit`, `offset`, `active`, `closed`, `order`, `ascending`, `tag`, `slug_contains`.

### Example: Biggest Events by Volume

```bash
curl -s "https://gamma-api.polymarket.com/events?limit=10&closed=false&order=volume&ascending=false"
```

### Response Schema (Event Object)

```json
{
  "id": "4690",
  "ticker": "2028-democratic-presidential-nominee",
  "slug": "2028-democratic-presidential-nominee",
  "title": "Democratic Presidential Nominee 2028",
  "description": "Who will be the 2028 Democratic nominee?",
  "startDate": "2025-01-20T00:00:00Z",
  "endDate": "2028-08-30T00:00:00Z",
  "category": "Politics",
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
| `volume` | number | Total volume across all markets in this event |
| `markets` | array | All markets belonging to this event (full market objects) |
| `category` | string | Event category |

---

## GET /events/{id}

Get details for a single event, including all associated markets.

### Example

```bash
curl -s "https://gamma-api.polymarket.com/events/4690"
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
curl -s "https://gamma-api.polymarket.com/markets?tag=Crypto&closed=false&limit=20&order=volumeNum&ascending=false"
```

### Pattern 3: "Markets about a specific topic"
```bash
# Search by slug (URL-friendly text)
curl -s "https://gamma-api.polymarket.com/markets?slug_contains=fed-rate&closed=false&limit=10"
```

### Pattern 4: "What's the probability of X?"
```bash
# Search, then extract the specific market's outcomePrices
curl -s "https://gamma-api.polymarket.com/markets?slug_contains=bitcoin-200k&closed=false&limit=5" | \
  python3 -c "
import json, sys
for m in json.load(sys.stdin):
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
# Fetch event with all markets
curl -s "https://gamma-api.polymarket.com/events/4690" | \
  python3 -c "
import json, sys
event = json.load(sys.stdin)
print(f\"Event: {event['title']}\")
print(f\"Volume: \${event['volume']:,.0f}\")
print()
for m in sorted(event.get('markets', []), key=lambda x: -float(json.loads(x['outcomePrices'])[0])):
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

To link users to a market on Polymarket's website:
```
https://polymarket.com/event/{event_slug}
```

The `slug` field from the market or event response is the URL path. Example:
- Market slug: `will-the-fed-increase-interest-rates-march-2026`
- URL: `https://polymarket.com/event/will-the-fed-increase-interest-rates-march-2026`

---

## Error Handling

```bash
# Robust fetch with error handling
RESPONSE=$(curl -s --max-time 10 "https://gamma-api.polymarket.com/markets?limit=10&closed=false&order=volume24hr&ascending=false")

if [ -z "$RESPONSE" ] || [ "$RESPONSE" = "[]" ]; then
  echo "Polymarket data is temporarily unavailable."
  exit 0
fi

# Validate JSON
echo "$RESPONSE" | python3 -c "import json, sys; json.load(sys.stdin)" 2>/dev/null
if [ $? -ne 0 ]; then
  echo "Polymarket API returned invalid data."
  exit 0
fi
```
