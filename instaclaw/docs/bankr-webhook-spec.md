# Bankr Webhook Spec — InstaClaw Proposal

**From:** Cooper Wrenn (InstaClaw)
**For:** Sinaver, Bankr DevRel
**Date:** 2026-04-10

This is a proposal for the trading fee webhook flow we need to close our self-sustaining compute loop. Open to changes — let us know what makes sense from your side.

---

## Why This Matters

The InstaClaw + Bankr integration is built around a simple loop:
1. Every InstaClaw agent gets a Bankr wallet at deploy
2. Users tokenize their agents via our "Tokenize with Bankr" button (live now, defaults to your fee splits)
3. Trading fees from the agent's token accumulate as creator fees in the agent's own wallet
4. We want to detect those fee events in real time and credit the user's compute account in InstaClaw — so the agent literally funds its own inference

Without webhooks, we'd have to poll wallet balances on a cron, which is wasteful (most agents will have no activity most of the time) and adds latency between trade and credit. Webhooks let us react in real time.

---

## Events We Need

### 1. `trading_fee.collected` — **CRITICAL, the core event**
Fires whenever a swap on a deployed token generates fees that route to a creator (`feeRecipient`) we've registered.

**Payload:**
```json
{
  "id": "evt_01HK...",
  "type": "trading_fee.collected",
  "createdAt": "2026-04-10T15:30:00.000Z",
  "data": {
    "tokenAddress": "0x1234...abcd",
    "poolId": "0xabcd...1234",
    "feeRecipient": "0x742d...5f3a",
    "swapTxHash": "0x9876...fedc",
    "weth": {
      "amount": "0.0012",
      "amountWei": "1200000000000000"
    },
    "token": {
      "amount": "1234.56",
      "amountWei": "1234560000000000000000",
      "symbol": "AGENT"
    },
    "swapVolumeUsd": "12.45",
    "creatorBps": 5700,
    "chain": "base"
  }
}
```

**Notes:**
- We need `feeRecipient` so we can map back to the agent in our DB.
- `weth.amount` and `token.amount` as decimal strings (avoid float precision issues).
- Including raw wei values lets us avoid client-side decimal math.
- `swapVolumeUsd` is helpful for analytics but not strictly required.
- Idempotency: please use a stable `id` per event so we can dedupe on retry.

### 2. `token.launched` — confirmation event (nice to have)
Fires after a successful `POST /token-launches/deploy`. Useful as a confirmation channel in case the API response gets lost on our end (network blip, function timeout).

**Payload:**
```json
{
  "id": "evt_01HK...",
  "type": "token.launched",
  "createdAt": "2026-04-10T15:00:00.000Z",
  "data": {
    "tokenAddress": "0x1234...abcd",
    "poolId": "0xabcd...1234",
    "txHash": "0x9876...fedc",
    "tokenName": "MyAgent",
    "tokenSymbol": "AGENT",
    "feeRecipient": "0x742d...5f3a",
    "chain": "base"
  }
}
```

### 3. `wallet.fee_claimed` — visibility into claims (nice to have)
Fires when fees are claimed from a token (either via CLI or web). Helps us reconcile our internal credit ledger with on-chain reality.

**Payload:**
```json
{
  "id": "evt_01HK...",
  "type": "wallet.fee_claimed",
  "createdAt": "2026-04-10T15:45:00.000Z",
  "data": {
    "tokenAddress": "0x1234...abcd",
    "claimerAddress": "0x742d...5f3a",
    "weth": { "amount": "0.05" },
    "token": { "amount": "10000.0", "symbol": "AGENT" },
    "txHash": "0xfeed...beef",
    "chain": "base"
  }
}
```

---

## Signature Scheme

We propose **HMAC-SHA256** of the raw request body, using a shared secret per partner. This is the standard most webhook providers use (Stripe, GitHub, etc.) and we already have the verification logic built.

**Header:** `X-Bankr-Signature: <hex_digest>`

**Verification (on our end):**
```javascript
const expected = crypto
  .createHmac("sha256", BANKR_WEBHOOK_SECRET)
  .update(rawBody)
  .digest("hex");
const valid = crypto.timingSafeEqual(
  Buffer.from(signature, "hex"),
  Buffer.from(expected, "hex")
);
```

If you'd prefer a different scheme (e.g., signed JWT, ECDSA, Stripe-style `t=...,v1=...` format), let us know — we can adapt.

---

## Retry Policy

Standard webhook retry behavior:
- **HTTP 2xx response within 10 seconds** = success, no retry
- **Any non-2xx, timeout, or network error** = retry
- **Backoff:** exponential — 30s, 2m, 10m, 1h, 6h, 24h
- **Max attempts:** 6 retries over 24 hours, then give up
- **Idempotency:** Same event `id` on retry so we can dedupe (we will store seen IDs for 7 days)

---

## Test Mode

We'd love a way to receive webhooks in dev/staging without affecting production:

**Option A (preferred):** A separate "test webhook URL" field in the partner dashboard. All events from our test org go to the test URL.

**Option B:** A special header on test events: `X-Bankr-Test: true`. Production webhook URL receives both, we filter on our end.

**Option C:** An API endpoint we can call to fire a test event of any type (great for integration testing).

Any of these works. Option A is the cleanest because it keeps test traffic out of our production logs.

---

## Webhook Configuration

We need a way to register the webhook URL. Two options:

**Dashboard:** Add a "Webhooks" tab to bankr.bot/partner where we can:
- Set the URL
- Set the test URL (if Option A above)
- Subscribe to specific event types (or default to all)
- Generate/rotate the signing secret
- View recent deliveries (success/fail/payload preview)

**API:** Endpoints like `POST /partner/webhooks`, `GET /partner/webhooks/deliveries`. Useful for programmatic management.

We'd start with the dashboard — much simpler to ship.

---

## Open Questions

1. **Are token swap fees collected per-swap or batched?** If batched (e.g., once per block), we'd want to know the batching window so we can attribute to the right swaps.
2. **Do you fire one event per token swap, or aggregated per token over a time window?** Per-swap is more useful for our credit-on-demand model.
3. **Is there any minimum fee threshold below which you'd skip the webhook?** (e.g., to avoid spamming for sub-cent swaps)
4. **For the fee claim webhook — does it fire for all claims, or only claims initiated via our partner key?**

---

## Implementation Status on Our Side

We've already built:
- Webhook endpoint at `POST /api/integrations/bankr/webhook`
- HMAC-SHA256 signature verification
- Event handler for `trading_fee` (assumes the schema above)
- Idempotent credit injection via our `instaclaw_add_credits()` RPC with `source: "bankr_trading_fee"` and a stable `reference_id` per event
- Conversion: USDC value → InstaClaw compute credits at a configurable rate (env var)

So the moment your end goes live with a webhook spec close to this, we can be receiving events the same day. Just need:
- Your final payload schema (any tweaks vs above)
- A signing secret to put in our env vars
- Your webhook URL config form/API to point at us

Happy to jump on a call if it's faster to hash this out live.
