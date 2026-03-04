# Solana RPC Reference

## Default RPC URL
`https://api.mainnet-beta.solana.com`

Configured via `SOLANA_RPC_URL` in `~/.openclaw/.env`. Serious traders should use Helius or QuickNode for lower latency.

## Core Methods

### getBalance
Get SOL balance for an account.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getBalance",
  "params": ["WALLET_ADDRESS"]
}
```

**Response:**
```json
{
  "result": {
    "value": 1500000000
  }
}
```
Value is in lamports. 1 SOL = 1,000,000,000 lamports.

### getTokenAccountsByOwner
List all SPL token accounts for a wallet.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getTokenAccountsByOwner",
  "params": [
    "WALLET_ADDRESS",
    { "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
    { "encoding": "jsonParsed" }
  ]
}
```

**Response:**
```json
{
  "result": {
    "value": [
      {
        "pubkey": "TOKEN_ACCOUNT_ADDRESS",
        "account": {
          "data": {
            "parsed": {
              "info": {
                "mint": "TOKEN_MINT_ADDRESS",
                "owner": "WALLET_ADDRESS",
                "tokenAmount": {
                  "amount": "1000000",
                  "decimals": 6,
                  "uiAmount": 1.0,
                  "uiAmountString": "1"
                }
              }
            }
          }
        }
      }
    ]
  }
}
```

### getLatestBlockhash
Get a recent blockhash for transaction building.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getLatestBlockhash",
  "params": [{ "commitment": "finalized" }]
}
```

### sendTransaction
Submit a signed transaction.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "sendTransaction",
  "params": [
    "BASE64_ENCODED_SIGNED_TX",
    {
      "encoding": "base64",
      "skipPreflight": false,
      "preflightCommitment": "confirmed",
      "maxRetries": 3
    }
  ]
}
```

### getSignatureStatuses
Check if a transaction was confirmed.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "getSignatureStatuses",
  "params": [
    ["TRANSACTION_SIGNATURE"],
    { "searchTransactionHistory": true }
  ]
}
```

**Confirmation levels:** `processed` → `confirmed` → `finalized`
- Use `confirmed` for trading (1-2 seconds)
- Use `finalized` for important operations (6-12 seconds)

## Error Codes

| Code | Meaning |
|------|---------|
| -32002 | Transaction simulation failed |
| -32003 | Transaction precompile verification failure |
| -32004 | Slot skipped (node behind) |
| -32005 | Node unhealthy |
| -32007 | Slot not available |
| -32009 | Slot not rooted |
| -32014 | Transaction too large |

## Public RPC Limits
The default `api.mainnet-beta.solana.com`:
- Rate limited (exact limits vary)
- Not suitable for high-frequency trading
- Sufficient for balance checks and occasional swaps

For better performance, recommended providers:
- Helius: `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`
- QuickNode: custom endpoint URL
- Triton: `https://YOUR_ID.mainnet.rpcpool.com`
