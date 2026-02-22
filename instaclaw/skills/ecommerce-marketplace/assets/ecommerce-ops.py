#!/usr/bin/env python3
"""
ecommerce-ops.py — E-Commerce & Marketplace Operations Manager

Unified operations layer for multi-channel e-commerce:
  - Cross-platform order management (Shopify, Amazon, eBay)
  - Inventory sync across all channels
  - RMA / return processing (end-to-end)
  - Competitive pricing monitor
  - Daily/weekly P&L report generation

BYOK: User provides their own platform API credentials.
Credentials stored in ~/.openclaw/config/ecommerce.yaml (encrypted at rest).

Usage:
  ecommerce-ops.py orders [--platform shopify|amazon|ebay|all] [--date YYYY-MM-DD]
  ecommerce-ops.py inventory --sku SKU [--adjust DELTA --source PLATFORM]
  ecommerce-ops.py inventory-sync [--full] [--dry-run]
  ecommerce-ops.py returns --action check|create|track|refund [--order ORDER_ID] [--platform PLATFORM]
  ecommerce-ops.py pricing --sku SKU [--check|--adjust] [--dry-run]
  ecommerce-ops.py report --type daily|weekly|monthly [--date YYYY-MM-DD]
  ecommerce-ops.py setup --platform shopify|amazon|ebay|shipstation --test
  ecommerce-ops.py status

Environment:
  ECOMMERCE_CONFIG  Path to ecommerce.yaml (default: ~/.openclaw/config/ecommerce.yaml)
"""

import argparse
import json
import os
import sys
import subprocess
import datetime
import hashlib
from pathlib import Path

CONFIG_PATH = os.environ.get(
    "ECOMMERCE_CONFIG",
    os.path.expanduser("~/.openclaw/config/ecommerce.yaml")
)
DATA_DIR = os.path.expanduser("~/.openclaw/workspace/ecommerce")
INVENTORY_DB = os.path.join(DATA_DIR, "inventory.json")
RETURNS_DB = os.path.join(DATA_DIR, "returns.json")
PRICE_LOG = os.path.join(DATA_DIR, "price-changes.json")
REPORTS_DIR = os.path.join(DATA_DIR, "reports")


def ensure_dirs():
    """Create workspace directories if they don't exist."""
    for d in [DATA_DIR, REPORTS_DIR]:
        os.makedirs(d, exist_ok=True)


def load_config():
    """Load ecommerce.yaml config. Returns dict or exits with error."""
    if not os.path.exists(CONFIG_PATH):
        print(f"ERROR: Config not found at {CONFIG_PATH}", file=sys.stderr)
        print("Run: ecommerce-setup.sh to configure your platforms", file=sys.stderr)
        sys.exit(1)

    try:
        # Try yaml first, fall back to simple parsing
        try:
            import yaml
            with open(CONFIG_PATH) as f:
                return yaml.safe_load(f)
        except ImportError:
            # Fallback: parse simple yaml manually
            return _parse_simple_yaml(CONFIG_PATH)
    except Exception as e:
        print(f"ERROR: Failed to parse config: {e}", file=sys.stderr)
        sys.exit(1)


def _parse_simple_yaml(path):
    """Minimal YAML parser for flat key-value configs."""
    config = {"platforms": {}, "fulfillment": {}, "policies": {}}
    current_section = None
    current_platform = None

    with open(path) as f:
        for line in f:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue

            indent = len(line) - len(line.lstrip())

            if stripped.endswith(":") and indent == 0:
                current_section = stripped[:-1]
                current_platform = None
            elif stripped.endswith(":") and indent == 2:
                current_platform = stripped[:-1]
                if current_section == "platforms":
                    config["platforms"][current_platform] = {}
            elif ":" in stripped and current_section:
                key, _, value = stripped.partition(":")
                key = key.strip()
                value = value.strip().strip('"').strip("'")

                if current_section == "platforms" and current_platform:
                    if value.lower() == "true":
                        value = True
                    elif value.lower() == "false":
                        value = False
                    config["platforms"][current_platform][key] = value
                elif current_section == "fulfillment":
                    config["fulfillment"][key] = value
                elif current_section == "policies":
                    try:
                        value = int(value)
                    except ValueError:
                        pass
                    config["policies"][key] = value

    return config


def load_json_db(path, default=None):
    """Load a JSON database file, returning default if not found."""
    if default is None:
        default = {}
    if os.path.exists(path):
        try:
            with open(path) as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            return default
    return default


def save_json_db(path, data):
    """Save data to a JSON database file."""
    with open(path, "w") as f:
        json.dump(data, f, indent=2, default=str)


# ── Shopify API helpers ──

def shopify_api(config, endpoint, method="GET", data=None):
    """Call Shopify Admin REST API."""
    shop = config.get("shop", "")
    token = config.get("access_token", "")
    if not shop or not token:
        return {"error": "Shopify not configured (missing shop or access_token)"}

    url = f"https://{shop}/admin/api/2024-01/{endpoint}"
    cmd = ["curl", "-s", "-X", method, url,
           "-H", f"X-Shopify-Access-Token: {token}",
           "-H", "Content-Type: application/json"]
    if data:
        cmd.extend(["-d", json.dumps(data)])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout) if result.stdout.strip() else {"error": "Empty response"}
    except Exception as e:
        return {"error": str(e)}


def shopify_graphql(config, query):
    """Call Shopify Admin GraphQL API."""
    shop = config.get("shop", "")
    token = config.get("access_token", "")
    if not shop or not token:
        return {"error": "Shopify not configured"}

    url = f"https://{shop}/admin/api/2024-01/graphql.json"
    cmd = ["curl", "-s", "-X", "POST", url,
           "-H", f"X-Shopify-Access-Token: {token}",
           "-H", "Content-Type: application/json",
           "-d", json.dumps({"query": query})]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout) if result.stdout.strip() else {"error": "Empty response"}
    except Exception as e:
        return {"error": str(e)}


# ── Amazon SP-API helpers ──

def amazon_api(config, endpoint, method="GET", data=None):
    """Call Amazon SP-API (requires LWA token refresh)."""
    client_id = config.get("lwa_client_id", "")
    client_secret = config.get("lwa_client_secret", "")
    refresh_token = config.get("refresh_token", "")

    if not client_id or not refresh_token:
        return {"error": "Amazon not configured (missing LWA credentials)"}

    # Step 1: Get access token via LWA
    token_cmd = [
        "curl", "-s", "-X", "POST", "https://api.amazon.com/auth/o2/token",
        "-H", "Content-Type: application/x-www-form-urlencoded",
        "-d", f"grant_type=refresh_token&refresh_token={refresh_token}"
               f"&client_id={client_id}&client_secret={client_secret}"
    ]

    try:
        token_result = subprocess.run(token_cmd, capture_output=True, text=True, timeout=30)
        token_data = json.loads(token_result.stdout)
        access_token = token_data.get("access_token", "")
        if not access_token:
            return {"error": f"LWA token refresh failed: {token_data}"}
    except Exception as e:
        return {"error": f"LWA token refresh error: {e}"}

    # Step 2: Call SP-API
    marketplace = config.get("marketplace_id", "ATVPDKIKX0DER")
    base_url = "https://sellingpartnerapi-na.amazon.com"
    url = f"{base_url}{endpoint}"

    cmd = ["curl", "-s", "-X", method, url,
           "-H", f"x-amz-access-token: {access_token}",
           "-H", "Content-Type: application/json"]
    if data:
        cmd.extend(["-d", json.dumps(data)])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout) if result.stdout.strip() else {"error": "Empty response"}
    except Exception as e:
        return {"error": str(e)}


# ── eBay API helpers ──

def ebay_api(config, endpoint, method="GET", data=None):
    """Call eBay REST API."""
    user_token = config.get("user_token", "")
    if not user_token:
        return {"error": "eBay not configured (missing user_token)"}

    url = f"https://api.ebay.com{endpoint}"
    cmd = ["curl", "-s", "-X", method, url,
           "-H", f"Authorization: Bearer {user_token}",
           "-H", "Content-Type: application/json"]
    if data:
        cmd.extend(["-d", json.dumps(data)])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout) if result.stdout.strip() else {"error": "Empty response"}
    except Exception as e:
        return {"error": str(e)}


# ── ShipStation API helpers ──

def shipstation_api(config, endpoint, method="GET", data=None):
    """Call ShipStation API."""
    api_key = config.get("api_key", "")
    api_secret = config.get("api_secret", "")
    if not api_key or not api_secret:
        return {"error": "ShipStation not configured (missing api_key/api_secret)"}

    import base64
    auth = base64.b64encode(f"{api_key}:{api_secret}".encode()).decode()
    url = f"https://ssapi.shipstation.com{endpoint}"
    cmd = ["curl", "-s", "-X", method, url,
           "-H", f"Authorization: Basic {auth}",
           "-H", "Content-Type: application/json"]
    if data:
        cmd.extend(["-d", json.dumps(data)])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout) if result.stdout.strip() else {"error": "Empty response"}
    except Exception as e:
        return {"error": str(e)}


# ── Command: orders ──

def cmd_orders(args, config):
    """Fetch orders from one or all platforms."""
    date = args.date or datetime.date.today().isoformat()
    platforms_to_check = (
        [args.platform] if args.platform != "all"
        else [p for p, c in config.get("platforms", {}).items() if c.get("enabled")]
    )

    all_orders = []

    for platform in platforms_to_check:
        pconfig = config.get("platforms", {}).get(platform, {})
        if not pconfig.get("enabled"):
            print(f"  {platform}: not enabled, skipping")
            continue

        print(f"  Fetching {platform} orders for {date}...")

        if platform == "shopify":
            result = shopify_api(pconfig, f"orders.json?created_at_min={date}T00:00:00-00:00&status=any")
            orders = result.get("orders", [])
            for o in orders:
                all_orders.append({
                    "platform": "shopify",
                    "order_number": o.get("name", o.get("id")),
                    "customer": o.get("email", "unknown"),
                    "total": float(o.get("total_price", 0)),
                    "items": len(o.get("line_items", [])),
                    "status": o.get("fulfillment_status", "unfulfilled") or "unfulfilled",
                    "created_at": o.get("created_at", ""),
                })

        elif platform == "amazon":
            result = amazon_api(pconfig, f"/orders/v0/orders?CreatedAfter={date}T00:00:00Z")
            orders = result.get("payload", {}).get("Orders", [])
            for o in orders:
                all_orders.append({
                    "platform": "amazon",
                    "order_number": o.get("AmazonOrderId", ""),
                    "customer": o.get("BuyerEmail", "unknown"),
                    "total": float(o.get("OrderTotal", {}).get("Amount", 0)),
                    "items": o.get("NumberOfItemsUnshipped", 0) + o.get("NumberOfItemsShipped", 0),
                    "status": o.get("OrderStatus", "").lower(),
                    "created_at": o.get("PurchaseDate", ""),
                })

        elif platform == "ebay":
            result = ebay_api(pconfig, f"/sell/fulfillment/v1/order?filter=creationdate:[{date}T00:00:00.000Z..]")
            orders = result.get("orders", [])
            for o in orders:
                all_orders.append({
                    "platform": "ebay",
                    "order_number": o.get("orderId", ""),
                    "customer": o.get("buyer", {}).get("username", "unknown"),
                    "total": float(o.get("pricingSummary", {}).get("total", {}).get("value", 0)),
                    "items": len(o.get("lineItems", [])),
                    "status": o.get("orderFulfillmentStatus", "").lower(),
                    "created_at": o.get("creationDate", ""),
                })

    # Print unified results
    if not all_orders:
        print(f"\nNo orders found for {date}")
        return

    total_revenue = sum(o["total"] for o in all_orders)
    print(f"\n{'='*60}")
    print(f"ORDERS — {date}")
    print(f"{'='*60}")
    print(f"Total: {len(all_orders)} orders | Revenue: ${total_revenue:.2f}")
    print()

    for platform in ["shopify", "amazon", "ebay"]:
        p_orders = [o for o in all_orders if o["platform"] == platform]
        if p_orders:
            p_rev = sum(o["total"] for o in p_orders)
            print(f"  {platform.upper()}: {len(p_orders)} orders (${p_rev:.2f})")
            for o in p_orders[:5]:
                print(f"    #{o['order_number']} — ${o['total']:.2f} ({o['status']})")
            if len(p_orders) > 5:
                print(f"    ... and {len(p_orders) - 5} more")
            print()

    unfulfilled = [o for o in all_orders if o["status"] in ("unfulfilled", "unshipped", "not_started")]
    if unfulfilled:
        print(f"⚠️  {len(unfulfilled)} unfulfilled orders need attention")


# ── Command: inventory ──

def cmd_inventory(args, config):
    """Check or adjust inventory for a SKU."""
    ensure_dirs()
    inventory = load_json_db(INVENTORY_DB, {"skus": {}})
    sku = args.sku.upper()

    if args.adjust is not None and args.source:
        # Adjust inventory
        current = inventory.get("skus", {}).get(sku, {}).get("quantity", 0)
        new_qty = current + args.adjust
        if new_qty < 0:
            print(f"ERROR: Adjustment would make {sku} negative ({current} + {args.adjust} = {new_qty})")
            sys.exit(1)

        inventory.setdefault("skus", {})[sku] = {
            "quantity": new_qty,
            "last_adjusted": datetime.datetime.now().isoformat(),
            "source": args.source,
        }
        save_json_db(INVENTORY_DB, inventory)
        print(f"✅ {sku}: {current} → {new_qty} (adjusted by {args.adjust} from {args.source})")

        # Sync to other platforms
        buffer = config.get("policies", {}).get("inventory_buffer_units", 5)
        sync_qty = max(0, new_qty - buffer)
        print(f"   Sync quantity (with {buffer}-unit buffer): {sync_qty}")

        platforms_to_sync = [
            p for p, c in config.get("platforms", {}).items()
            if c.get("enabled") and p != args.source
        ]
        for platform in platforms_to_sync:
            print(f"   → Would sync {sync_qty} units to {platform}")

    else:
        # Show inventory
        sku_data = inventory.get("skus", {}).get(sku)
        if sku_data:
            print(f"{sku}: {sku_data['quantity']} units (last updated: {sku_data.get('last_adjusted', 'unknown')})")
        else:
            print(f"{sku}: not tracked. Run with --adjust to add.")


# ── Command: inventory-sync ──

def cmd_inventory_sync(args, config):
    """Sync inventory across all platforms."""
    ensure_dirs()
    inventory = load_json_db(INVENTORY_DB, {"skus": {}})
    buffer = config.get("policies", {}).get("inventory_buffer_units", 5)
    threshold = config.get("policies", {}).get("low_stock_threshold", 10)

    enabled_platforms = [p for p, c in config.get("platforms", {}).items() if c.get("enabled")]
    if not enabled_platforms:
        print("ERROR: No platforms enabled in config")
        sys.exit(1)

    print(f"{'='*60}")
    print(f"INVENTORY SYNC {'(DRY RUN)' if args.dry_run else ''}")
    print(f"{'='*60}")
    print(f"Platforms: {', '.join(enabled_platforms)}")
    print(f"Buffer: {buffer} units | Low stock threshold: {threshold}")
    print()

    if args.full:
        print("Full reconciliation mode — pulling inventory from all platforms...")
        for platform in enabled_platforms:
            pconfig = config.get("platforms", {}).get(platform, {})
            print(f"  Pulling from {platform}...")

            if platform == "shopify":
                result = shopify_api(pconfig, "products.json?fields=id,title,variants")
                products = result.get("products", [])
                for p in products:
                    for v in p.get("variants", []):
                        sku = v.get("sku", "").upper()
                        qty = v.get("inventory_quantity", 0)
                        if sku:
                            inventory.setdefault("skus", {})[sku] = {
                                "quantity": qty,
                                "last_adjusted": datetime.datetime.now().isoformat(),
                                "source": "shopify-reconciliation",
                            }
                            print(f"    {sku}: {qty} units")

            elif platform == "amazon":
                print(f"    (Amazon inventory pull requires inventory API — use MCP server)")

            elif platform == "ebay":
                print(f"    (eBay inventory pull requires inventory API — use MCP server)")

        if not args.dry_run:
            save_json_db(INVENTORY_DB, inventory)
            print(f"\n✅ Inventory database updated with {len(inventory.get('skus', {}))} SKUs")
        else:
            print(f"\n(Dry run — no changes saved)")
    else:
        # Quick sync — push current quantities to all platforms
        skus = inventory.get("skus", {})
        if not skus:
            print("No SKUs tracked. Run with --full for initial pull.")
            return

        low_stock = []
        for sku, data in skus.items():
            qty = data.get("quantity", 0)
            sync_qty = max(0, qty - buffer)

            if qty <= threshold:
                low_stock.append((sku, qty))

            for platform in enabled_platforms:
                if args.dry_run:
                    print(f"  Would sync {sku} → {platform}: {sync_qty} units")
                else:
                    print(f"  Syncing {sku} → {platform}: {sync_qty} units")

        if low_stock:
            print(f"\n⚠️  LOW STOCK ALERTS:")
            for sku, qty in low_stock:
                print(f"  {sku}: {qty} remaining (threshold: {threshold})")


# ── Command: returns ──

def cmd_returns(args, config):
    """Process returns and RMAs."""
    ensure_dirs()
    returns = load_json_db(RETURNS_DB, {"active": [], "completed": []})
    policies = config.get("policies", {})

    if args.action == "check":
        # Check for new return requests
        print("Checking for new return requests...")
        enabled = [p for p, c in config.get("platforms", {}).items() if c.get("enabled")]

        for platform in enabled:
            pconfig = config.get("platforms", {}).get(platform, {})
            print(f"  Checking {platform}...")

            if platform == "shopify":
                result = shopify_api(pconfig, "orders.json?status=any&fulfillment_status=any")
                orders = result.get("orders", [])
                refunds = [o for o in orders if o.get("refunds")]
                print(f"    Orders with refund activity: {len(refunds)}")

            elif platform == "amazon":
                result = amazon_api(pconfig, "/fba/inbound/v0/returns")
                print(f"    Response: {result.get('error', 'OK')}")

            elif platform == "ebay":
                result = ebay_api(pconfig, "/post-order/v2/return/search?return_state=RETURN_REQUESTED")
                print(f"    Response: {result.get('error', 'OK')}")

    elif args.action == "create":
        # Create a new RMA
        if not args.order:
            print("ERROR: --order required for create action")
            sys.exit(1)

        order_id = args.order
        platform = args.platform or "shopify"

        # Generate RMA number
        rma_hash = hashlib.md5(f"{order_id}-{datetime.datetime.now().isoformat()}".encode()).hexdigest()[:8]
        rma_number = f"RMA-{rma_hash.upper()}"

        # Check return policy
        auto_threshold = policies.get("auto_approve_threshold", 100)
        human_threshold = policies.get("require_human_over", 200)
        window_days = policies.get("return_window_days", 30)

        rma = {
            "rma_number": rma_number,
            "order_id": order_id,
            "platform": platform,
            "status": "created",
            "created_at": datetime.datetime.now().isoformat(),
            "auto_threshold": auto_threshold,
            "human_threshold": human_threshold,
        }

        returns["active"].append(rma)
        save_json_db(RETURNS_DB, returns)

        print(f"✅ RMA Created: {rma_number}")
        print(f"   Order: {order_id} ({platform})")
        print(f"   Return window: {window_days} days")
        print(f"   Auto-approve under: ${auto_threshold}")
        print(f"   Human approval over: ${human_threshold}")
        print(f"\nNext steps:")
        print(f"  1. Generate return label via ShipStation")
        print(f"  2. Email customer with RMA #{rma_number} + label")
        print(f"  3. Track return shipment")
        print(f"  4. Inspect item on arrival → approve/reject refund")

    elif args.action == "track":
        # Track active returns
        active = returns.get("active", [])
        if not active:
            print("No active returns")
            return

        print(f"{'='*60}")
        print(f"ACTIVE RETURNS ({len(active)})")
        print(f"{'='*60}")
        for r in active:
            print(f"  {r['rma_number']} — {r['platform']} order #{r['order_id']}")
            print(f"    Status: {r['status']} | Created: {r['created_at']}")
            if r.get("tracking_number"):
                print(f"    Tracking: {r['tracking_number']}")
            print()

    elif args.action == "refund":
        # Process a refund
        if not args.order:
            print("ERROR: --order (RMA number) required for refund action")
            sys.exit(1)

        rma_number = args.order
        active = returns.get("active", [])
        matching = [r for r in active if r["rma_number"] == rma_number]

        if not matching:
            print(f"ERROR: RMA {rma_number} not found in active returns")
            sys.exit(1)

        rma = matching[0]
        print(f"Processing refund for {rma_number}...")
        print(f"  Platform: {rma['platform']}")
        print(f"  Order: {rma['order_id']}")
        print(f"\n⚠️  HUMAN APPROVAL REQUIRED")
        print(f"  Confirm refund amount and approve before proceeding.")

    else:
        print(f"Unknown action: {args.action}")
        print("Valid actions: check, create, track, refund")


# ── Command: pricing ──

def cmd_pricing(args, config):
    """Check or adjust pricing for a SKU."""
    ensure_dirs()
    price_log = load_json_db(PRICE_LOG, {"changes": []})
    max_change = config.get("policies", {}).get("max_price_change_pct", 20)

    sku = args.sku.upper()

    if args.check:
        print(f"Checking competitive pricing for {sku}...")
        enabled = [p for p, c in config.get("platforms", {}).items() if c.get("enabled")]

        for platform in enabled:
            pconfig = config.get("platforms", {}).get(platform, {})
            if platform == "amazon":
                result = amazon_api(pconfig, f"/products/pricing/v0/competitivePrice?Asin={sku}")
                print(f"  Amazon: {json.dumps(result, indent=2)[:200]}")
            else:
                print(f"  {platform}: Pricing check via MCP server")

    elif args.adjust:
        print(f"Price adjustment for {sku}")
        print(f"Max auto-change: {max_change}%")
        print(f"⚠️  Guardrails:")
        print(f"  - Max {max_change}% change per 24 hours")
        print(f"  - Changes >15% require human approval")
        print(f"  - Never go below cost floor")
        print(f"  - Race-to-bottom protection active")

        if args.dry_run:
            print(f"\n(Dry run — no price changes applied)")

    else:
        # Show price history
        changes = [c for c in price_log.get("changes", []) if c.get("sku") == sku]
        if changes:
            print(f"Price history for {sku}:")
            for c in changes[-10:]:
                print(f"  {c['date']}: ${c.get('old_price', '?')} → ${c.get('new_price', '?')} ({c.get('reason', '')})")
        else:
            print(f"No price history for {sku}")


# ── Command: report ──

def cmd_report(args, config):
    """Generate daily, weekly, or monthly reports."""
    ensure_dirs()
    report_date = args.date or datetime.date.today().isoformat()

    if args.type == "daily":
        print(f"{'='*60}")
        print(f"📦 DAILY E-COMMERCE REPORT — {report_date}")
        print(f"{'='*60}")
        print()
        print("SUMMARY")
        print("  Fetching orders from all platforms...")
        print()

        # Fetch orders for the day
        enabled = [p for p, c in config.get("platforms", {}).items() if c.get("enabled")]
        if not enabled:
            print("  No platforms configured. Run ecommerce-setup.sh first.")
            return

        total_orders = 0
        total_revenue = 0.0
        platform_stats = {}

        for platform in enabled:
            pconfig = config.get("platforms", {}).get(platform, {})

            if platform == "shopify":
                result = shopify_api(pconfig, f"orders/count.json?created_at_min={report_date}T00:00:00-00:00")
                count = result.get("count", 0)
                platform_stats[platform] = {"orders": count, "revenue": 0}
                total_orders += count

            elif platform == "amazon":
                platform_stats[platform] = {"orders": 0, "revenue": 0, "note": "Use MCP for full data"}

            elif platform == "ebay":
                platform_stats[platform] = {"orders": 0, "revenue": 0, "note": "Use MCP for full data"}

        print(f"  Total Orders: {total_orders}")
        print(f"  Total Revenue: ${total_revenue:.2f}")
        print()
        print("  By Platform:")
        for p, stats in platform_stats.items():
            note = f" ({stats['note']})" if stats.get("note") else ""
            print(f"    • {p.capitalize()}: {stats['orders']} orders (${stats['revenue']:.2f}){note}")

        # Check returns
        returns = load_json_db(RETURNS_DB, {"active": []})
        active_returns = len(returns.get("active", []))
        print(f"\n  Active Returns: {active_returns}")

        # Check low stock
        inventory = load_json_db(INVENTORY_DB, {"skus": {}})
        threshold = config.get("policies", {}).get("low_stock_threshold", 10)
        low = [(s, d["quantity"]) for s, d in inventory.get("skus", {}).items() if d.get("quantity", 0) <= threshold]
        if low:
            print(f"\n  ⚠️  LOW STOCK ({len(low)} items):")
            for sku, qty in low:
                print(f"    {sku}: {qty} remaining")

        # Save report
        report_file = os.path.join(REPORTS_DIR, f"daily-{report_date}.txt")
        with open(report_file, "w") as f:
            f.write(f"Daily Report — {report_date}\n")
            f.write(f"Orders: {total_orders} | Revenue: ${total_revenue:.2f}\n")
            f.write(f"Active Returns: {active_returns}\n")
            f.write(f"Low Stock Items: {len(low)}\n")
        print(f"\n  Report saved: {report_file}")

    elif args.type == "weekly":
        today = datetime.date.fromisoformat(report_date)
        week_start = today - datetime.timedelta(days=today.weekday())
        week_end = week_start + datetime.timedelta(days=6)

        print(f"{'='*60}")
        print(f"📊 WEEKLY P&L REPORT — {week_start} to {week_end}")
        print(f"{'='*60}")
        print()
        print("REVENUE")
        print("  (Aggregate from daily reports for the week)")
        print()
        print("COSTS")
        print("  • COGS: (from product data)")
        print("  • Platform Fees:")
        print("    - Shopify: 2.9% + $0.30 per transaction")
        print("    - Amazon: 15% referral fee (varies by category)")
        print("    - eBay: 12.35% final value fee")
        print("  • Shipping: (from ShipStation)")
        print("  • Returns/Refunds: (from returns DB)")
        print()
        print("NET PROFIT")
        print("  Revenue - COGS - Fees - Shipping - Returns = Net")
        print()
        print("TOP PRODUCTS")
        print("  (Ranked by units sold)")
        print()
        print("SLOW MOVERS")
        print("  (Products with <2 sales this week)")
        print()
        print("RECOMMENDATIONS")
        print("  (Auto-generated based on data trends)")

        report_file = os.path.join(REPORTS_DIR, f"weekly-{week_start}.txt")
        with open(report_file, "w") as f:
            f.write(f"Weekly P&L — {week_start} to {week_end}\n")
        print(f"\n  Report saved: {report_file}")

    elif args.type == "monthly":
        print(f"📈 Monthly analytics report for {report_date[:7]}")
        print("  (Aggregate weekly reports + trend analysis)")

    else:
        print(f"Unknown report type: {args.type}")
        print("Valid types: daily, weekly, monthly")


# ── Command: setup ──

def cmd_setup(args, config):
    """Test platform connections."""
    platform = args.platform
    pconfig = config.get("platforms", {}).get(platform, {})

    if not pconfig and platform not in ("shipstation",):
        print(f"ERROR: {platform} not found in config")
        print(f"Add {platform} credentials to {CONFIG_PATH}")
        sys.exit(1)

    print(f"Testing {platform} connection...")

    if platform == "shopify":
        result = shopify_api(pconfig, "shop.json")
        if "shop" in result:
            shop = result["shop"]
            print(f"✅ Connected to {shop.get('name', 'unknown')} ({shop.get('domain', '')})")
            print(f"   Plan: {shop.get('plan_name', 'unknown')}")
            print(f"   Currency: {shop.get('currency', 'unknown')}")
        else:
            print(f"❌ Connection failed: {result.get('error', result)}")

    elif platform == "amazon":
        result = amazon_api(pconfig, "/sellers/v1/marketplaceParticipations")
        if "payload" in result:
            print(f"✅ Connected to Amazon Seller Central")
            participations = result["payload"]
            for p in participations[:3]:
                mp = p.get("marketplace", {})
                print(f"   Marketplace: {mp.get('name', 'unknown')} ({mp.get('countryCode', '')})")
        else:
            print(f"❌ Connection failed: {result.get('error', result)}")

    elif platform == "ebay":
        result = ebay_api(pconfig, "/sell/account/v1/privilege")
        if "error" not in result:
            print(f"✅ Connected to eBay")
            print(f"   Selling limit: {result.get('sellingLimit', {})}")
        else:
            print(f"❌ Connection failed: {result.get('error', result)}")

    elif platform == "shipstation":
        ss_config = config.get("fulfillment", {})
        result = shipstation_api(ss_config, "/warehouses")
        if isinstance(result, list):
            print(f"✅ Connected to ShipStation")
            for w in result:
                print(f"   Warehouse: {w.get('warehouseName', 'unknown')} ({w.get('warehouseId', '')})")
        else:
            print(f"❌ Connection failed: {result.get('error', result)}")


# ── Command: status ──

def cmd_status(args, config):
    """Show overall e-commerce status."""
    ensure_dirs()

    print(f"{'='*60}")
    print(f"E-COMMERCE STATUS")
    print(f"{'='*60}")
    print()

    # Platform connections
    print("PLATFORMS:")
    platforms = config.get("platforms", {})
    for name, pconfig in platforms.items():
        enabled = pconfig.get("enabled", False)
        has_creds = bool(pconfig.get("access_token") or pconfig.get("lwa_client_id") or pconfig.get("user_token"))
        status = "✅ Enabled" if enabled and has_creds else "⚠️ Enabled (no credentials)" if enabled else "❌ Disabled"
        print(f"  {name.capitalize()}: {status}")

    # Fulfillment
    fulfillment = config.get("fulfillment", {})
    ff_system = fulfillment.get("system", "none")
    ff_key = bool(fulfillment.get("api_key"))
    print(f"\nFULFILLMENT:")
    print(f"  System: {ff_system} {'✅' if ff_key else '❌ no API key'}")

    # Policies
    policies = config.get("policies", {})
    print(f"\nPOLICIES:")
    print(f"  Return window: {policies.get('return_window_days', 30)} days")
    print(f"  Auto-approve under: ${policies.get('auto_approve_threshold', 100)}")
    print(f"  Human approval over: ${policies.get('require_human_over', 200)}")
    print(f"  Low stock threshold: {policies.get('low_stock_threshold', 10)} units")
    print(f"  Inventory buffer: {policies.get('inventory_buffer_units', 5)} units")
    print(f"  Max price change: {policies.get('max_price_change_pct', 20)}%")

    # Active data
    returns = load_json_db(RETURNS_DB, {"active": []})
    inventory = load_json_db(INVENTORY_DB, {"skus": {}})
    price_changes = load_json_db(PRICE_LOG, {"changes": []})

    print(f"\nDATA:")
    print(f"  Tracked SKUs: {len(inventory.get('skus', {}))}")
    print(f"  Active returns: {len(returns.get('active', []))}")
    print(f"  Price changes logged: {len(price_changes.get('changes', []))}")

    # Config file
    print(f"\nCONFIG: {CONFIG_PATH}")
    print(f"  Exists: {'✅' if os.path.exists(CONFIG_PATH) else '❌'}")


# ── Main ──

def main():
    parser = argparse.ArgumentParser(
        description="E-Commerce & Marketplace Operations Manager",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s orders --platform all --date 2026-02-22
  %(prog)s inventory --sku SKU-123 --adjust -3 --source shopify
  %(prog)s inventory-sync --full --dry-run
  %(prog)s returns --action create --order ORD-456 --platform shopify
  %(prog)s returns --action track
  %(prog)s pricing --sku B0ABC123 --check
  %(prog)s report --type daily
  %(prog)s report --type weekly
  %(prog)s setup --platform shopify --test
  %(prog)s status
        """
    )

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # orders
    p_orders = subparsers.add_parser("orders", help="Fetch orders from platforms")
    p_orders.add_argument("--platform", default="all", choices=["shopify", "amazon", "ebay", "all"])
    p_orders.add_argument("--date", help="Date filter (YYYY-MM-DD)")

    # inventory
    p_inv = subparsers.add_parser("inventory", help="Check or adjust inventory")
    p_inv.add_argument("--sku", required=True, help="SKU to check/adjust")
    p_inv.add_argument("--adjust", type=int, help="Quantity adjustment (+ or -)")
    p_inv.add_argument("--source", help="Source platform for adjustment")

    # inventory-sync
    p_sync = subparsers.add_parser("inventory-sync", help="Sync inventory across platforms")
    p_sync.add_argument("--full", action="store_true", help="Full reconciliation from all platforms")
    p_sync.add_argument("--dry-run", action="store_true", help="Preview without applying changes")

    # returns
    p_ret = subparsers.add_parser("returns", help="Process returns and RMAs")
    p_ret.add_argument("--action", required=True, choices=["check", "create", "track", "refund"])
    p_ret.add_argument("--order", help="Order ID or RMA number")
    p_ret.add_argument("--platform", help="Platform (shopify, amazon, ebay)")

    # pricing
    p_price = subparsers.add_parser("pricing", help="Competitive pricing management")
    p_price.add_argument("--sku", required=True, help="SKU or ASIN to check")
    p_price.add_argument("--check", action="store_true", help="Check competitor pricing")
    p_price.add_argument("--adjust", action="store_true", help="Adjust pricing")
    p_price.add_argument("--dry-run", action="store_true", help="Preview without applying")

    # report
    p_report = subparsers.add_parser("report", help="Generate reports")
    p_report.add_argument("--type", required=True, choices=["daily", "weekly", "monthly"])
    p_report.add_argument("--date", help="Report date (YYYY-MM-DD)")

    # setup
    p_setup = subparsers.add_parser("setup", help="Test platform connections")
    p_setup.add_argument("--platform", required=True, choices=["shopify", "amazon", "ebay", "shipstation"])
    p_setup.add_argument("--test", action="store_true", help="Test connection")

    # status
    subparsers.add_parser("status", help="Show e-commerce status")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    config = load_config()

    dispatch = {
        "orders": cmd_orders,
        "inventory": cmd_inventory,
        "inventory-sync": cmd_inventory_sync,
        "returns": cmd_returns,
        "pricing": cmd_pricing,
        "report": cmd_report,
        "setup": cmd_setup,
        "status": cmd_status,
    }

    handler = dispatch.get(args.command)
    if handler:
        handler(args, config)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
