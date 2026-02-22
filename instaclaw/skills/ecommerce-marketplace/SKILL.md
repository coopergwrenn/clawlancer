# Skill: E-Commerce & Marketplace Operations

## Metadata

```yaml
name: ecommerce-marketplace-ops
version: 1.0.0
updated: 2026-02-22
author: InstaClaw
triggers:
  keywords: [Shopify, Amazon, eBay, Walmart, orders, inventory, returns, RMA, fulfillment, shipping, marketplace, e-commerce, ecommerce, SKU, listing, pricing, ShipStation]
  phrases: ["process this return", "check my orders", "sync inventory", "what sold today", "update my prices", "create a listing", "generate RMA", "daily sales report", "ship this order", "how much did I sell", "low stock alert"]
  NOT: [personal shopping, buy this item, add to cart, consumer purchase]
```

## Overview

Transforms your InstaClaw agent into a full-time e-commerce operations manager. Connects to Shopify, Amazon, and eBay (user provides their own API credentials — BYOK), syncs inventory across channels, processes returns end-to-end, monitors competitor pricing, and generates unified P&L reports.

**What this replaces:** $2,000-4,000/month in VAs + SaaS tools for multi-channel sellers ($50k-$5M/year).

## Prerequisites

- **Platform API credentials** (BYOK — user's own accounts)
- **ShipStation API** (for fulfillment/RMA workflows)
- **Email skill** (Skill 8 — for sending RMA emails to customers)
- **Heartbeat/Cron** (for scheduled inventory sync, order monitoring, daily reports)

## Credential Storage

All credentials are stored in `~/.openclaw/config/ecommerce.yaml` and encrypted at rest via libsodium. Never log credentials. Access restricted to MCP servers only.

```yaml
# ~/.openclaw/config/ecommerce.yaml
platforms:
  shopify:
    enabled: true
    shop: mystore.myshopify.com
    access_token: <encrypted>

  amazon:
    enabled: true
    lwa_client_id: <encrypted>
    lwa_client_secret: <encrypted>
    refresh_token: <encrypted>
    aws_access_key: <encrypted>
    aws_secret_key: <encrypted>
    seller_id: <encrypted>
    marketplace_id: "ATVPDKIKX0DER"

  ebay:
    enabled: true
    app_id: <encrypted>
    cert_id: <encrypted>
    user_token: <encrypted>

fulfillment:
  system: shipstation
  api_key: <encrypted>
  api_secret: <encrypted>

policies:
  return_window_days: 30
  auto_approve_threshold: 100
  require_human_over: 200
  restocking_fee_pct: 0
  low_stock_threshold: 10
  inventory_buffer_units: 5
  max_price_change_pct: 20
```

## Platform Integration Matrix

| Platform | API Quality | Setup Difficulty | Rate Limits | Cost to User |
|---|---|---|---|---|
| **Shopify** | 10/10 | EASY (10 min) | 1000 pts/sec GraphQL | FREE |
| **Amazon** | 8/10 | HARD (30-45 min) | 60-80/hour key endpoints | FREE |
| **eBay** | 9/10 | MEDIUM (15-20 min) | 5K-50K/day | FREE |
| **ShipStation** | 8/10 | EASY (5 min) | 40 calls/min | FREE |
| **Walmart** | Unknown | Unknown | Unknown | FREE (planned) |

### Capabilities per Platform

| Operation | Shopify | Amazon | eBay | ShipStation |
|---|---|---|---|---|
| Read orders | ✅ | ✅ | ✅ | ✅ |
| Update inventory | ✅ | ✅ | ✅ | ✅ |
| Process returns/RMAs | ✅ | ✅ | ✅ | ✅ |
| Create/edit listings | ✅ | ✅ | ✅ | — |
| Adjust pricing | ✅ | ✅ | ✅ | — |
| Manage fulfillment | ✅ | ✅ | ✅ | ✅ |
| View analytics | ✅ | ✅ | ✅ | ✅ |
| Customer messages | ⚠️ Limited | ✅ | ✅ | — |
| Generate shipping labels | — | — | — | ✅ |

## Workflow 1: RMA / Return Processing (End-to-End)

The killer workflow. Fully automated return handling.

**Manual process:** 10-15 min per return × 10 returns/day = 2+ hours daily.
**Agent process:** Seconds per return, human only inspects item when it arrives.

```
Return Request → Parse → Fetch Order → Check Eligibility
  → Create RMA → Generate Label → Email Customer → Track Shipment
  → [Item Arrives] → Human Inspects → Agent Processes Refund → Done
```

### Steps

1. **Parse return request** (email, platform notification, direct message)
2. **Find order across all platforms** — search Shopify, Amazon, eBay by order number
3. **Validate eligibility** — check return window, order value, customer history
4. **Create RMA** in warehouse system (ShipStation)
5. **Generate return shipping label** (USPS Priority Mail default)
6. **Email customer** with RMA number + prepaid label
7. **Update platform order status** to return_initiated
8. **Track return shipment** — daily cron monitors tracking
9. **Notify seller when item arrives** — human inspects
10. **Process refund** after human approval (full/partial/reject)

### Autonomy Matrix — Returns

```yaml
fully_autonomous:
  - Parse return request
  - Fetch order from any platform
  - Check eligibility against policy
  - Create RMA number
  - Generate shipping label
  - Email customer with RMA + label
  - Track return shipment
  - Notify seller when item arrives

human_approval_required:
  - Returns outside policy window
  - Orders over configured threshold ($200 default)
  - Frequent returner flag
  - Item condition inspection
  - Final refund decision (full/partial/reject)
```

### Platform-Specific Return APIs

**Shopify (GraphQL):**
```graphql
mutation { returnCreate(input: {
  orderId: "gid://shopify/Order/123"
  returnLineItems: [{ lineItemId: "...", quantity: 1 }]
}) { return { id, name } } }

mutation { refundCreate(input: {
  orderId: "gid://shopify/Order/123"
  refundLineItems: [{ lineItemId: "...", quantity: 1 }]
  transactions: [{ amount: "29.99", kind: REFUND }]
}) { refund { id } } }
```

**Amazon (SP-API):**
```python
returns_api.get_return(return_id)
orders_api.create_refund(order_id=order_id, refund_amount=29.99, refund_reason="CustomerReturn")
```

**eBay (REST):**
```javascript
ebay.sell.return.getReturn(returnId)
ebay.sell.finances.issueRefund({ orderId, refundAmount: { value: "29.99", currency: "USD" } })
```

## Workflow 2: Cross-Platform Inventory Sync

**Problem:** Item sells on Amazon → still shows available on Shopify + eBay → overselling.

### Sync Logic

1. Sale event on any platform triggers sync
2. Adjust central inventory count
3. Push updated count to all OTHER platforms (minus buffer)
4. If sync fails → pause listing on failed platform immediately
5. Full reconciliation cron at 2am catches any drift

### Buffer Policy

Never set platform inventory to exact real count. Always subtract `inventory_buffer_units` (default: 5) to prevent overselling during sync delays.

### Sync Schedule

- **Real-time:** Webhook listeners for order events (preferred)
- **Fallback:** 15-minute cron polling all platforms
- **Reconciliation:** Full daily sync at 2:00 AM

## Workflow 3: Competitive Pricing Monitor

1. Every 6 hours: fetch competitor pricing for all tracked ASINs/listings
2. Compare against current prices
3. If competitor lower: calculate undercut price (-$0.50 default)
4. Check if price change exceeds `max_price_change_pct` (20% default)
5. If within limits: auto-adjust across all platforms
6. If exceeds limits: notify human for approval
7. Always enforce minimum price floor (cost + margin)

### Pricing Guardrails

- Max auto-adjustment: 20% per 24 hours
- Changes >15%: require human approval
- Minimum price floor: never go below cost
- Race-to-bottom protection: ignore competitor prices below floor
- Price change log with full rollback capability

## Workflow 4: Unified Order Management & Daily Reports

### Morning Report (8 AM)

```
📦 Daily Orders Report — [Date]

SUMMARY
Total Orders: X
Total Revenue: $X.XX

By Platform:
• Shopify: X orders ($X.XX)
• Amazon: X orders ($X.XX)
• eBay: X orders ($X.XX)

NEEDS ATTENTION
X unfulfilled orders
X pending payment
X returns pending

LOW STOCK ALERTS
• SKU-123: 3 remaining (threshold: 10)
• SKU-456: 7 remaining (threshold: 10)
```

### Weekly P&L (Sunday 8 PM)

- Revenue by platform and product
- COGS, platform fees, shipping costs
- Net profit/loss per channel
- Top/bottom selling products
- Slow-moving inventory recommendations
- Competitor pricing analysis
- Strategic recommendations for next week

## Workflow 5: Agent Daily Operations Schedule

```yaml
morning_8am:
  - Pull overnight orders from all platforms
  - Sync inventory across channels
  - Check for new return requests
  - Generate morning summary → send via Telegram
  - Flag low stock items

continuous_monitoring:
  every_15_min: Check new orders, sync inventory
  every_30_min: Check customer messages across platforms
  every_hour: Process return requests
  every_2_hours: Monitor competitor pricing
  every_6_hours: Full competitive price adjustment run

evening_6pm:
  - End-of-day summary (orders, revenue, returns, issues)
  - Tomorrow's prep (orders to ship, stock to reorder, returns arriving)

weekly_sunday_8pm:
  - Weekly P&L report with charts
  - Top/bottom selling products
  - Slow-moving inventory recommendations
  - Competitor pricing analysis
  - Strategic recommendations for next week
```

## Risk Assessment & Guardrails

### RISK 1: Inventory Overselling
- **Mitigation:** Real-time sync with 5-unit buffer across platforms
- **Guardrail:** If sync fails, pause listing on that platform until resolved
- **Recovery:** Full reconciliation cron at 2am catches any drift

### RISK 2: Wrong Pricing
- **Mitigation:** Max auto-adjustment capped at 20% per 24 hours
- **Guardrail:** Changes >15% require human approval
- **Recovery:** Price change log with rollback capability

### RISK 3: Fraudulent Returns
- **Mitigation:** Flag frequent returners, cross-reference return history
- **Guardrail:** Returns >$200 always require human approval
- **Recovery:** Configurable auto-approve thresholds

### RISK 4: Shipping to Wrong Address
- **Mitigation:** Validate address against order before label generation
- **Guardrail:** International orders always confirmed by human

### RISK 5: Customer Communication Errors
- **Mitigation:** Template-based emails for standard flows (RMA, refund, rejection)
- **Guardrail:** Any email mentioning refund/legal/complaint flagged for review

## Integration with Other Skills

| Skill | Integration |
|---|---|
| **Email (Skill 8)** | Agent emails customers for returns, RMA numbers, refund confirmations |
| **Competitive Intel (Skill 10)** | Monitor competitor prices, feed into auto-pricing engine |
| **Financial Analysis (Skill 7)** | Pull sales data for P&L, COGS, margins, platform fee breakdowns |
| **Voice & Audio (Skill 3)** | Generate audio summary of daily sales for Telegram voice message |

## Setup Guide for Users

### Shopify (10 minutes)

1. Go to Shopify Admin → Settings → Apps and sales channels → Develop apps
2. Create a new app, enable Admin API access
3. Select scopes: `read_orders`, `write_orders`, `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_fulfillments`, `write_fulfillments`
4. Install the app, copy the Admin API Access Token
5. Tell your agent: "Connect my Shopify store" and provide the token + store domain

### Amazon (30-45 minutes)

1. Register as SP-API Developer at Seller Central
2. Create IAM user with appropriate permissions
3. Generate LWA credentials (Client ID + Secret)
4. Complete OAuth flow for Refresh Token
5. Provide all 6 credentials to your agent
6. Guide: docs.instaclaw.io/ecommerce/amazon

### eBay (15-20 minutes)

1. Create developer account at developer.ebay.com
2. Create a new application (Production)
3. Get App ID (Client ID) and Cert ID
4. Generate User Token via OAuth
5. Tell your agent: "Connect my eBay account" and provide credentials

### ShipStation (5 minutes)

1. Go to ShipStation → Settings → API Settings
2. Generate API Key + API Secret
3. Tell your agent: "Connect ShipStation" and provide both values

## services.yaml Configuration

```yaml
ecommerce:
  enabled: true
  platforms:
    - shopify
    - amazon
    - ebay

  automations:
    returns:
      auto_approve_threshold: 100
      require_human_approval_over: 200
      auto_reject_outside_window: true
    inventory:
      sync_interval_minutes: 15
      low_stock_alert_threshold: 10
      buffer_units: 5
    pricing:
      competitor_monitoring: true
      max_price_change_pct: 20
      require_human_over_pct: 15

  reports:
    daily_summary: true
    weekly_pnl: true
    monthly_analytics: true

  notifications:
    low_stock: telegram
    return_arrived: telegram
    order_issues: email
    daily_summary: telegram
```

## Quality Checklist

- [ ] All platform API connections verified
- [ ] Inventory sync running at configured interval (default: 15 min)
- [ ] Buffer units applied to all platform inventory counts
- [ ] RMA workflow tested end-to-end
- [ ] Return eligibility checks matching configured policy
- [ ] Human approval triggered for orders over threshold
- [ ] Competitor pricing capped at max change % per 24 hours
- [ ] Daily report delivered at scheduled time
- [ ] Weekly P&L generated with cross-platform data
- [ ] Credential encryption verified (never logged)
- [ ] Sync failures alerting and pausing affected listings

## Common Mistakes

1. **Not testing API connections during setup** — always verify credentials work before saving
2. **Syncing inventory without buffer** — never set exact count, always subtract buffer
3. **Auto-adjusting prices without caps** — competitor listing errors ($0.01) can trigger race to bottom
4. **Processing returns for other sellers' orders** — verify order exists in user's account first
5. **Generating labels for wrong addresses** — always validate address against order
6. **Over-communicating with customers** — exactly 3 emails per return max: RMA approved, refund processed, rejection

## Scripts

- `~/scripts/ecommerce-ops.py` — Main operations: orders, inventory, returns, reports
- `~/scripts/ecommerce-setup.sh` — Platform credential setup and validation
- `~/.openclaw/skills/ecommerce-marketplace/references/ecommerce-guide.md` — API reference
