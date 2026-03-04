# PumpPortal API Reference

## Base URL
`https://pumpportal.fun`

## POST /api/trade-local
Execute a buy or sell on pump.fun tokens. Returns a base64-encoded transaction to sign locally.

**Request body:**
```json
{
  "publicKey": "YOUR_WALLET_ADDRESS",
  "action": "buy",
  "mint": "TOKEN_MINT_ADDRESS",
  "denominatedInSol": "true",
  "amount": 0.05,
  "slippage": 25,
  "priorityFee": 0.0005,
  "pool": "pump"
}
```

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| publicKey | string | Yes | Your wallet public key |
| action | string | Yes | `buy` or `sell` |
| mint | string | Yes | Token mint address |
| denominatedInSol | string | Yes | `"true"` for SOL amount, `"false"` for token amount |
| amount | number | Yes | Amount to buy/sell |
| slippage | integer | Yes | Slippage in percentage (25 = 25%) |
| priorityFee | number | No | Priority fee in SOL (default: 0.0005) |
| pool | string | No | `"pump"` for pump.fun, `"auto"` for any |

**Response (success):**
Base64-encoded transaction bytes. Must be:
1. Base64-decoded
2. Deserialized
3. Signed with wallet keypair
4. Sent via `sendRawTransaction`

**Response (error):**
```json
{
  "error": "Token has graduated to PumpSwap. Use Raydium or Jupiter instead."
}
```

## WebSocket — New Token Events
Connect to `wss://pumpportal.fun/api/data` for real-time new token creation events.

**Subscribe to new tokens:**
```json
{
  "method": "subscribeNewToken"
}
```

**Event payload:**
```json
{
  "signature": "5xG...",
  "mint": "TOKEN_MINT_ADDRESS",
  "traderPublicKey": "CREATOR_ADDRESS",
  "txType": "create",
  "initialBuy": 0.5,
  "bondingCurveKey": "...",
  "vTokensInBondingCurve": 1000000000,
  "vSolInBondingCurve": 30,
  "marketCapSol": 30,
  "name": "Token Name",
  "symbol": "TKN",
  "uri": "https://..."
}
```

## Important Notes

### Bonding Curve Graduation
Tokens on pump.fun have a bonding curve. When the curve reaches ~$69k market cap, the token "graduates" to PumpSwap/Raydium. After graduation:
- PumpPortal /api/trade-local returns an error
- Use Jupiter V6 API instead
- Check `bondingCurveComplete` field

### Slippage on pump.fun
pump.fun tokens are extremely volatile. Recommended slippage:
- Normal buy: 25% (2500 bps)
- Snipe (new launch): 50% (5000 bps) — expect high slippage on fresh tokens
- Sell: 25%

### Priority Fees
During high traffic, increase priority fee:
- Normal: 0.0005 SOL
- Congested: 0.001-0.005 SOL
- Time-critical snipes: 0.01 SOL

### Rate Limits
- 10 requests/second per IP
- WebSocket: no explicit limit, but sending too many subscriptions may disconnect
