# Jupiter V6 API Reference

## Base URL
`https://quote-api.jup.ag/v6`

## Rate Limits
- Quotes: 600 requests/minute
- Swaps: 60 requests/minute

## Endpoints

### GET /quote
Get a swap quote for any token pair.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| inputMint | string | Yes | Input token mint address |
| outputMint | string | Yes | Output token mint address |
| amount | integer | Yes | Input amount in **lamports** (1 SOL = 1,000,000,000) |
| slippageBps | integer | No | Slippage tolerance in basis points (100 = 1%). Default: 50 |
| swapMode | string | No | `ExactIn` (default) or `ExactOut` |
| onlyDirectRoutes | boolean | No | Only use direct routes (faster, less optimal) |
| asLegacyTransaction | boolean | No | Use legacy transaction format |

**Example:**
```
GET /v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&slippageBps=100
```

**Response:**
```json
{
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "inAmount": "100000000",
  "outAmount": "14523000",
  "otherAmountThreshold": "14377770",
  "swapMode": "ExactIn",
  "slippageBps": 100,
  "priceImpactPct": "0.001",
  "routePlan": [...]
}
```

### POST /swap
Build a swap transaction from a quote.

**Request body:**
```json
{
  "quoteResponse": { /* full quote response from /quote */ },
  "userPublicKey": "YOUR_WALLET_ADDRESS",
  "wrapAndUnwrapSol": true,
  "dynamicComputeUnitLimit": true,
  "prioritizationFeeLamports": "auto"
}
```

**Response:**
```json
{
  "swapTransaction": "<base64-encoded transaction>",
  "lastValidBlockHeight": 123456789
}
```

The `swapTransaction` must be:
1. Base64-decoded
2. Deserialized as a VersionedTransaction
3. Signed with your wallet keypair
4. Sent via `sendRawTransaction`

### POST /swap-instructions
Get swap as individual instructions (advanced).

Same request body as /swap. Returns instructions array for custom transaction building.

## Common Errors

| Error | Meaning | Action |
|-------|---------|--------|
| `ROUTE_NOT_FOUND` | No route exists for this pair | Token may have no liquidity |
| `SLIPPAGE_EXCEEDED` | Price moved too much | Retry with higher slippage |
| `INSUFFICIENT_FUNDS` | Not enough input tokens | PERMANENT — do not retry |
| `BLOCKHASH_EXPIRED` | Transaction took too long | Retry with fresh blockhash |

## Common Token Mints

| Token | Mint |
|-------|------|
| SOL (wrapped) | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` |
| WIF | `EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm` |
| JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` |
