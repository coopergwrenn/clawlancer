# DexScreener API Reference

## Base URL
`https://api.dexscreener.com`

## Rate Limits
300 requests/minute

## Endpoints

### GET /latest/dex/tokens/{tokenAddress}
Get price and pair data for a token.

**Example:**
```
GET /latest/dex/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
```

**Response:**
```json
{
  "pairs": [
    {
      "chainId": "solana",
      "dexId": "raydium",
      "pairAddress": "...",
      "baseToken": {
        "address": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
        "name": "Bonk",
        "symbol": "BONK"
      },
      "quoteToken": {
        "address": "So11111111111111111111111111111111111111112",
        "name": "Wrapped SOL",
        "symbol": "SOL"
      },
      "priceNative": "0.0000000002345",
      "priceUsd": "0.00003456",
      "volume": {
        "h24": 12345678,
        "h6": 3456789,
        "h1": 567890,
        "m5": 12345
      },
      "priceChange": {
        "h24": -5.2,
        "h6": 2.1,
        "h1": 0.3,
        "m5": -0.1
      },
      "liquidity": {
        "usd": 4567890,
        "base": 123456789000,
        "quote": 567
      },
      "fdv": 34567890,
      "marketCap": 23456789,
      "pairCreatedAt": 1709567890000
    }
  ]
}
```

### GET /latest/dex/pairs/{chainId}/{pairAddress}
Get specific pair data.

```
GET /latest/dex/pairs/solana/PAIR_ADDRESS
```

### GET /latest/dex/search?q={query}
Search tokens by name or symbol.

```
GET /latest/dex/search?q=bonk
```

Returns same format as /tokens endpoint.

## Key Fields

| Field | Description |
|-------|-------------|
| `priceUsd` | Current USD price |
| `priceNative` | Price in quote token (usually SOL) |
| `volume.h24` | 24h trading volume in USD |
| `priceChange.h24` | 24h price change percentage |
| `liquidity.usd` | Total liquidity in USD |
| `fdv` | Fully diluted valuation |
| `marketCap` | Market cap |
| `pairCreatedAt` | Timestamp of pair creation |

## Usage Notes

- Always use the first pair in the `pairs` array (highest liquidity)
- Filter for `chainId === "solana"` when token exists on multiple chains
- `priceUsd` can be null for very new or illiquid tokens
- Use `volume.h24` and `liquidity.usd` to assess token safety
  - Very low liquidity (<$1000) = high risk of manipulation
  - No volume = likely dead token
