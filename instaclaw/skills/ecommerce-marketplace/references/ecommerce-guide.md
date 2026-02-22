# E-Commerce & Marketplace Reference Guide

## Platform API Quick Reference

### Shopify (Admin REST + GraphQL)

**Authentication:** `X-Shopify-Access-Token: {token}`
**Base URL:** `https://{shop}.myshopify.com/admin/api/2024-01/`
**Rate Limits:** 1000 cost points/sec (GraphQL), 40 requests/sec (REST)

| Operation | REST Endpoint | GraphQL |
|---|---|---|
| Get orders | `GET /orders.json` | `query { orders(first:50) { edges { node { ... } } } }` |
| Get products | `GET /products.json` | `query { products(first:50) { edges { node { ... } } } }` |
| Update inventory | `POST /inventory_levels/adjust.json` | `mutation inventoryAdjustQuantities(...)` |
| Create refund | `POST /orders/{id}/refunds.json` | `mutation refundCreate(...)` |
| Create return | — | `mutation returnCreate(...)` |
| Fulfill order | `POST /orders/{id}/fulfillments.json` | `mutation fulfillmentCreateV2(...)` |

**Required Scopes:**
- `read_orders`, `write_orders`
- `read_products`, `write_products`
- `read_inventory`, `write_inventory`
- `read_fulfillments`, `write_fulfillments`

### Amazon SP-API

**Authentication:** LWA OAuth 2.0 → Access Token → Signed Request
**Base URL:** `https://sellingpartnerapi-na.amazon.com`
**Rate Limits:** 60-80 requests/hour for key endpoints

| Operation | Endpoint |
|---|---|
| Get orders | `GET /orders/v0/orders?CreatedAfter={date}` |
| Get order items | `GET /orders/v0/orders/{id}/orderItems` |
| Update inventory | `PUT /fba/inventory/v1/items/{sku}` |
| Get competitive pricing | `GET /products/pricing/v0/competitivePrice` |
| Create refund | `POST /orders/v0/orders/{id}/refund` |
| Get returns | `GET /fba/inbound/v0/returns` |

**Required Credentials (6 total):**
1. LWA Client ID
2. LWA Client Secret
3. Refresh Token (via OAuth consent)
4. AWS Access Key ID
5. AWS Secret Access Key
6. Seller ID

**Token Refresh Flow:**
```bash
curl -X POST "https://api.amazon.com/auth/o2/token" \
  -d "grant_type=refresh_token&refresh_token={token}&client_id={id}&client_secret={secret}"
```

### eBay REST API

**Authentication:** OAuth 2.0 User Token
**Base URL:** `https://api.ebay.com`
**Rate Limits:** 5,000-50,000 calls/day depending on endpoint

| Operation | Endpoint |
|---|---|
| Get orders | `GET /sell/fulfillment/v1/order` |
| Get inventory | `GET /sell/inventory/v1/inventory_item` |
| Update inventory | `PUT /sell/inventory/v1/inventory_item/{sku}` |
| Get returns | `GET /post-order/v2/return/search` |
| Issue refund | `POST /sell/finances/v1/seller_fund_transfer` |
| Create listing | `PUT /sell/inventory/v1/inventory_item/{sku}` |

### ShipStation REST API

**Authentication:** Basic Auth (API Key:Secret → Base64)
**Base URL:** `https://ssapi.shipstation.com`
**Rate Limits:** 40 requests/min (120-second rolling window)

| Operation | Endpoint |
|---|---|
| List orders | `GET /orders?orderDateStart={date}` |
| Create order | `POST /orders/createorder` |
| Create label | `POST /orders/createlabelfororder` |
| List shipments | `GET /shipments?shipDateStart={date}` |
| Get warehouses | `GET /warehouses` |
| Get carriers | `GET /carriers` |

## Platform Fee Structure

| Platform | Fee Type | Rate |
|---|---|---|
| **Shopify** | Transaction fee | 2.9% + $0.30 |
| **Shopify** | Monthly plan | $39-399/mo |
| **Amazon** | Referral fee | 8-15% (category-dependent) |
| **Amazon** | FBA fee | $3-8+ per unit (size-dependent) |
| **Amazon** | Monthly subscription | $39.99/mo (Professional) |
| **eBay** | Final value fee | 12.35% (most categories) |
| **eBay** | Insertion fee | $0.35/listing (after 250 free) |
| **ShipStation** | Monthly plan | $29-159/mo |

## Inventory Sync Rules

### Buffer Policy
- **Never** set platform inventory to exact real count
- Always subtract `inventory_buffer_units` (default: 5)
- Example: 100 real units → show 95 on each platform
- Prevents overselling during sync delays

### Sync Priority
1. **Real-time webhooks** (instant, preferred)
2. **15-minute cron polling** (fallback)
3. **Full daily reconciliation** at 2:00 AM (catch drift)

### Overselling Recovery
1. Immediately pause listing on platform where sync failed
2. Alert seller via Telegram
3. Attempt manual sync
4. If resolved, unpause listing
5. Log incident for review

## Return Processing Policies

### Default Policy Template
```yaml
return_window_days: 30        # Days from delivery
auto_approve_threshold: 100   # Auto-approve returns under $100
require_human_over: 200       # Always require human for returns >$200
restocking_fee_pct: 0         # % deducted from refund
```

### Eligibility Check Order
1. Is the order within the return window?
2. Is the item eligible (non-final sale)?
3. Is the customer a frequent returner? (flag if >3 returns in 90 days)
4. Is the order value under auto-approve threshold?
5. Does it require human approval (over threshold)?

### Email Templates — Returns

**RMA Approved (Template 1 of 3):**
```
Subject: Return Approved — RMA #{rma_number}

Hi {customer_name},

Your return for order #{order_number} has been approved.

RMA Number: {rma_number}
Return Address: {return_address}

A prepaid shipping label is attached. Please ship within 14 days.

Tracking Number: {tracking_number}
Expected Refund: ${refund_amount}

Refund will be processed within 5-7 business days after we receive
and inspect the item.

Thank you,
{store_name}
```

**Refund Processed (Template 2 of 3):**
```
Subject: Refund Processed — RMA #{rma_number}

Hi {customer_name},

Your refund of ${refund_amount} for order #{order_number} has been processed.

Allow 5-7 business days for the refund to appear on your statement.

Thank you for your patience,
{store_name}
```

**Return Rejected (Template 3 of 3):**
```
Subject: Return Update — RMA #{rma_number}

Hi {customer_name},

We've reviewed your return for order #{order_number}.

Unfortunately, we cannot issue a refund: {rejection_reason}

If you have questions, please reply to this email.

{store_name}
```

## Competitive Pricing Rules

### Auto-Pricing Guardrails
- Max change: 20% per 24 hours
- Changes >15%: require human approval
- Minimum floor: never go below cost + margin
- Race-to-bottom protection: ignore competitor prices below cost
- Price change log: every adjustment logged with rollback capability

### Pricing Strategy Options
1. **Undercut by $X** — match lowest and subtract $0.50 (default)
2. **Match lowest** — set price equal to lowest competitor
3. **Floor pricing** — never go below set minimum, let algorithm find best position
4. **Manual only** — alert on changes, never auto-adjust

## Agent Daily Schedule

| Time | Action | Autonomy |
|---|---|---|
| 8:00 AM | Pull overnight orders, sync inventory, check returns | Fully autonomous |
| 8:05 AM | Generate morning summary → Telegram | Fully autonomous |
| Every 15 min | Check new orders, sync inventory | Fully autonomous |
| Every 30 min | Check customer messages | Read only (flag for human) |
| Every hour | Process new return requests | Auto if under threshold |
| Every 2 hours | Monitor competitor pricing | Check only (alert on changes) |
| Every 6 hours | Full competitive price adjustment | Auto if within limits |
| 6:00 PM | End-of-day summary → Telegram | Fully autonomous |
| Sunday 8 PM | Weekly P&L report | Fully autonomous |

## Common Mistakes to Avoid

1. **Not testing API connections during setup** — always verify credentials work before saving. A bad token that fails silently means zero orders.

2. **Syncing inventory without buffer** — one sync delay can cause an oversell. Always buffer.

3. **Auto-adjusting prices without caps** — a $0.01 competitor listing error can crash your prices. Enforce min floor.

4. **Processing returns for wrong orders** — verify the order exists in the user's account before creating RMA. Multi-channel sellers get emails about many orders.

5. **Generating labels for wrong addresses** — always validate return address against RMA before label generation.

6. **Over-communicating with customers** — exactly 3 emails per return max: (1) RMA approved + label, (2) refund processed, (3) rejection if applicable.

7. **Not handling rate limits** — Amazon is especially strict. Always respect retry-after headers.

8. **Ignoring webhook delivery failures** — if a webhook fails, fall back to polling. Don't assume events arrive.

## Credential Security

- All credentials stored in `~/.openclaw/config/ecommerce.yaml`
- Encrypted at rest via libsodium
- Never logged to console, memory files, or daily logs
- Never included in error messages
- Access restricted to MCP servers and ecommerce scripts only
- User owns all credentials — BYOK model
