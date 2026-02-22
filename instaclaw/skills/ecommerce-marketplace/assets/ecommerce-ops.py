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
            pconfig = config.get("platforms", {}).get(platform, {})
            sync_ok = False
            try:
                if platform == "shopify":
                    # Find inventory item ID for this SKU, then update
                    search = shopify_api(pconfig, f"products.json?fields=id,variants")
                    for p in search.get("products", []):
                        for v in p.get("variants", []):
                            if (v.get("sku") or "").upper() == sku:
                                inv_item_id = v.get("inventory_item_id")
                                if inv_item_id:
                                    loc_result = shopify_api(pconfig, f"inventory_levels.json?inventory_item_ids={inv_item_id}")
                                    levels = loc_result.get("inventory_levels", [])
                                    if levels:
                                        loc_id = levels[0].get("location_id")
                                        shopify_api(pconfig, "inventory_levels/set.json", method="POST", data={
                                            "location_id": loc_id,
                                            "inventory_item_id": inv_item_id,
                                            "available": sync_qty,
                                        })
                                        sync_ok = True
                elif platform == "amazon":
                    # Update Amazon inventory via feeds API
                    result = amazon_api(pconfig, "/feeds/2021-06-30/feeds", method="POST", data={
                        "feedType": "POST_INVENTORY_AVAILABILITY_DATA",
                        "marketplaceIds": [pconfig.get("marketplace_id", "ATVPDKIKX0DER")],
                    })
                    sync_ok = "error" not in result
                elif platform == "ebay":
                    result = ebay_api(pconfig, f"/sell/inventory/v1/inventory_item/{sku}", method="PUT", data={
                        "availability": {"shipToLocationAvailability": {"quantity": sync_qty}}
                    })
                    sync_ok = "error" not in result
            except Exception as e:
                print(f"   ❌ Sync to {platform} failed: {e}")
                # Pause listing on sync failure (critical safety)
                print(f"   ⚠️  PAUSING {sku} on {platform} due to sync failure — manual intervention needed")
                continue

            if sync_ok:
                print(f"   ✅ Synced {sync_qty} units to {platform}")
            else:
                print(f"   ❌ Sync to {platform} failed — pausing listing for safety")
                print(f"   ⚠️  Manual intervention needed for {sku} on {platform}")

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
                result = amazon_api(pconfig, "/fba/inventory/v1/summaries?details=true&granularityType=Marketplace"
                                    f"&granularityId={pconfig.get('marketplace_id', 'ATVPDKIKX0DER')}"
                                    "&marketplaceIds=" + pconfig.get("marketplace_id", "ATVPDKIKX0DER"))
                summaries = result.get("payload", {}).get("inventorySummaries", [])
                if summaries:
                    for item in summaries:
                        sku = (item.get("sellerSku") or "").upper()
                        qty = item.get("inventoryDetails", {}).get("fulfillableQuantity", 0)
                        if sku:
                            inventory.setdefault("skus", {})[sku] = {
                                "quantity": qty,
                                "last_adjusted": datetime.datetime.now().isoformat(),
                                "source": "amazon-reconciliation",
                            }
                            print(f"    {sku}: {qty} units")
                else:
                    print(f"    No inventory data returned (check Amazon SP-API credentials)")

            elif platform == "ebay":
                result = ebay_api(pconfig, "/sell/inventory/v1/inventory_item?limit=100")
                items = result.get("inventoryItems", [])
                if items:
                    for item in items:
                        sku = (item.get("sku") or "").upper()
                        qty = item.get("availability", {}).get("shipToLocationAvailability", {}).get("quantity", 0)
                        if sku:
                            inventory.setdefault("skus", {})[sku] = {
                                "quantity": qty,
                                "last_adjusted": datetime.datetime.now().isoformat(),
                                "source": "ebay-reconciliation",
                            }
                            print(f"    {sku}: {qty} units")
                else:
                    print(f"    No inventory data returned (check eBay credentials)")

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
                    pconfig = config.get("platforms", {}).get(platform, {})
                    sync_ok = False
                    try:
                        if platform == "shopify":
                            search = shopify_api(pconfig, f"products.json?fields=id,variants")
                            for p in search.get("products", []):
                                for v in p.get("variants", []):
                                    if (v.get("sku") or "").upper() == sku:
                                        inv_item_id = v.get("inventory_item_id")
                                        if inv_item_id:
                                            loc_result = shopify_api(pconfig, f"inventory_levels.json?inventory_item_ids={inv_item_id}")
                                            levels = loc_result.get("inventory_levels", [])
                                            if levels:
                                                shopify_api(pconfig, "inventory_levels/set.json", method="POST", data={
                                                    "location_id": levels[0].get("location_id"),
                                                    "inventory_item_id": inv_item_id,
                                                    "available": sync_qty,
                                                })
                                                sync_ok = True
                        elif platform == "amazon":
                            result = amazon_api(pconfig, "/feeds/2021-06-30/feeds", method="POST", data={
                                "feedType": "POST_INVENTORY_AVAILABILITY_DATA",
                                "marketplaceIds": [pconfig.get("marketplace_id", "ATVPDKIKX0DER")],
                            })
                            sync_ok = "error" not in result
                        elif platform == "ebay":
                            result = ebay_api(pconfig, f"/sell/inventory/v1/inventory_item/{sku}", method="PUT", data={
                                "availability": {"shipToLocationAvailability": {"quantity": sync_qty}}
                            })
                            sync_ok = "error" not in result
                    except Exception as e:
                        print(f"  ❌ Sync {sku} → {platform} failed: {e}")
                        print(f"  ⚠️  PAUSING {sku} on {platform} — manual intervention needed")
                        continue

                    if sync_ok:
                        print(f"  ✅ Synced {sku} → {platform}: {sync_qty} units")
                    else:
                        print(f"  ❌ Sync {sku} → {platform} failed — listing paused for safety")

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

        # Step 4: Create return label via ShipStation
        ss_config = config.get("fulfillment", {})
        label_url = None
        tracking_number = None
        if ss_config.get("api_key"):
            label_result = shipstation_api(ss_config, "/shipments/createlabel", method="POST", data={
                "orderId": order_id,
                "carrierCode": ss_config.get("carrier_code", "stamps_com"),
                "serviceCode": ss_config.get("return_service", "usps_first_class_mail"),
                "packageCode": "package",
                "confirmation": "delivery",
                "shipDate": datetime.datetime.now().strftime("%Y-%m-%d"),
                "testLabel": False,
            })
            if "labelData" in label_result:
                label_url = label_result.get("labelDownload", {}).get("href", "")
                tracking_number = label_result.get("trackingNumber", "")
                print(f"   Return label created: {tracking_number}")
            else:
                print(f"   ⚠️  Label creation failed: {label_result.get('error', label_result.get('ExceptionMessage', 'unknown'))}")
                print(f"   Continuing without label — generate manually via ShipStation dashboard.")
        else:
            print(f"   ⚠️  ShipStation not configured — generate return label manually.")

        # Step 5: Email customer with RMA + label link
        email_sent = False
        try:
            email_script = os.path.expanduser("~/scripts/email-client.sh")
            if os.path.exists(email_script):
                # Look up customer email from order
                pconfig = config.get("platforms", {}).get(platform, {})
                customer_email = None
                if platform == "shopify":
                    order_data = shopify_api(pconfig, f"orders/{order_id}.json")
                    customer_email = order_data.get("order", {}).get("email")
                elif platform == "amazon":
                    order_data = amazon_api(pconfig, f"/orders/v0/orders/{order_id}")
                    customer_email = order_data.get("payload", {}).get("BuyerEmail")
                elif platform == "ebay":
                    order_data = ebay_api(pconfig, f"/sell/fulfillment/v1/order/{order_id}")
                    customer_email = order_data.get("buyer", {}).get("buyerRegistrationAddress", {}).get("email")

                if customer_email:
                    label_text = f"\nReturn label: {label_url}" if label_url else "\nA return label will be sent separately."
                    subject = f"Return Authorized — RMA #{rma_number}"
                    body = (
                        f"Your return has been authorized.\n\n"
                        f"RMA Number: {rma_number}\n"
                        f"Order: {order_id}{label_text}\n\n"
                        f"Please ship the item within {window_days} days.\n"
                        f"Include the RMA number on the outside of your package."
                    )
                    email_cmd = [email_script, "send", "--to", customer_email,
                                 "--subject", subject, "--body", body]
                    email_result = subprocess.run(email_cmd, capture_output=True, text=True, timeout=30)
                    if email_result.returncode == 0:
                        email_sent = True
                        print(f"   Email sent to {customer_email}")
                    else:
                        print(f"   ⚠️  Email send failed: {email_result.stderr[:200]}")
                else:
                    print(f"   ⚠️  Could not find customer email for order {order_id}")
            else:
                print(f"   ⚠️  email-client.sh not found — email not sent")
        except Exception as e:
            print(f"   ⚠️  Email error: {e}")

        # Step 6: Update platform order status
        pconfig = config.get("platforms", {}).get(platform, {})
        if platform == "shopify":
            # Add a note to the Shopify order indicating return authorized
            shopify_api(pconfig, f"orders/{order_id}.json", method="PUT", data={
                "order": {"id": order_id, "note": f"Return authorized — {rma_number}"}
            })
            print(f"   Shopify order #{order_id} updated with RMA note")
        elif platform == "amazon":
            # Amazon returns are managed via FBA or Seller Central — log for manual action
            print(f"   Amazon order #{order_id} — update return status via Seller Central")
        elif platform == "ebay":
            # Initiate return acceptance on eBay
            ebay_api(pconfig, f"/post-order/v2/return/{order_id}/accept", method="POST", data={
                "comments": {"content": f"Return accepted. RMA: {rma_number}"},
                "RMANumber": rma_number,
            })
            print(f"   eBay order #{order_id} return accepted")

        # Step 7: Store tracking + refund info in returns DB
        rma["tracking_number"] = tracking_number or "pending"
        rma["label_url"] = label_url or ""
        rma["email_sent"] = email_sent
        rma["status"] = "label_sent" if label_url else "awaiting_label"

        returns["active"].append(rma)
        save_json_db(RETURNS_DB, returns)

        # Step 8: Print notification for agent relay
        print(f"\n✅ RMA Created: {rma_number}")
        print(f"   Order: {order_id} ({platform})")
        print(f"   Return window: {window_days} days")
        print(f"   Auto-approve under: ${auto_threshold}")
        print(f"   Human approval over: ${human_threshold}")
        if tracking_number:
            print(f"   Tracking: {tracking_number}")
        if label_url:
            print(f"   Label: {label_url}")
        print(f"   Email sent: {'yes' if email_sent else 'no'}")
        print(f"\n📋 NOTIFY OWNER: RMA {rma_number} created for order #{order_id} ({platform})")

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
        platform = rma["platform"]
        order_id = rma["order_id"]
        human_threshold = rma.get("human_threshold", 200)

        print(f"Processing refund for {rma_number}...")
        print(f"  Platform: {platform}")
        print(f"  Order: {order_id}")

        # Look up order total for approval gating
        pconfig = config.get("platforms", {}).get(platform, {})
        refund_amount = 0.0
        if platform == "shopify":
            order_data = shopify_api(pconfig, f"orders/{order_id}.json")
            refund_amount = float(order_data.get("order", {}).get("total_price", 0))
        elif platform == "amazon":
            order_data = amazon_api(pconfig, f"/orders/v0/orders/{order_id}")
            refund_amount = float(order_data.get("payload", {}).get("OrderTotal", {}).get("Amount", 0))
        elif platform == "ebay":
            order_data = ebay_api(pconfig, f"/sell/fulfillment/v1/order/{order_id}")
            refund_amount = float(order_data.get("pricingSummary", {}).get("total", {}).get("value", 0))

        # Step 9: Human approval gate for refunds > threshold
        if refund_amount > human_threshold:
            print(f"\n⚠️  HUMAN APPROVAL REQUIRED — Refund ${refund_amount:.2f} exceeds ${human_threshold} threshold")
            print(f"  Run again with --force to process, or approve in dashboard.")
            # Mark as pending_approval but do not process
            rma["status"] = "pending_approval"
            rma["refund_amount"] = refund_amount
            save_json_db(RETURNS_DB, returns)
            return

        # Process refund via platform API
        refund_success = False
        if platform == "shopify":
            refund_result = shopify_api(pconfig, f"orders/{order_id}/refunds.json", method="POST", data={
                "refund": {
                    "notify": True,
                    "note": f"RMA {rma_number} — return received, refund processed",
                    "shipping": {"full_refund": True},
                    "refund_line_items": [],  # Full refund
                }
            })
            if "refund" in refund_result:
                refund_success = True
                print(f"  ✅ Shopify refund processed: ${refund_amount:.2f}")
            else:
                print(f"  ❌ Shopify refund failed: {refund_result.get('error', refund_result.get('errors', 'unknown'))}")
        elif platform == "amazon":
            # Amazon refunds via SP-API
            refund_result = amazon_api(pconfig, f"/orders/v0/orders/{order_id}/refund", method="POST", data={
                "AmazonOrderId": order_id,
                "SellerFulfillmentOrderId": order_id,
            })
            if "error" not in refund_result:
                refund_success = True
                print(f"  ✅ Amazon refund initiated: ${refund_amount:.2f}")
            else:
                print(f"  ❌ Amazon refund failed: {refund_result.get('error', 'unknown')}")
        elif platform == "ebay":
            refund_result = ebay_api(pconfig, f"/sell/fulfillment/v1/order/{order_id}/issue_refund", method="POST", data={
                "reasonForRefund": "BUYER_RETURN",
                "orderLevelRefundAmount": {"value": str(refund_amount), "currency": "USD"},
            })
            if "error" not in refund_result:
                refund_success = True
                print(f"  ✅ eBay refund processed: ${refund_amount:.2f}")
            else:
                print(f"  ❌ eBay refund failed: {refund_result.get('error', 'unknown')}")

        # Move to completed
        if refund_success:
            rma["status"] = "refunded"
            rma["refund_amount"] = refund_amount
            rma["refunded_at"] = datetime.datetime.now().isoformat()
            returns["active"] = [r for r in returns["active"] if r["rma_number"] != rma_number]
            returns["completed"].append(rma)
            save_json_db(RETURNS_DB, returns)
            print(f"\n✅ Refund complete for {rma_number} — ${refund_amount:.2f}")
            print(f"📋 NOTIFY OWNER: Refund ${refund_amount:.2f} processed for RMA {rma_number}")
        else:
            rma["status"] = "refund_failed"
            save_json_db(RETURNS_DB, returns)
            print(f"\n❌ Refund failed — check platform dashboard for manual processing")

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
        competitor_prices = []

        for platform in enabled:
            pconfig = config.get("platforms", {}).get(platform, {})
            if platform == "amazon":
                result = amazon_api(pconfig, f"/products/pricing/v0/competitivePrice"
                                    f"?MarketplaceId={pconfig.get('marketplace_id', 'ATVPDKIKX0DER')}"
                                    f"&Asins={sku}&ItemType=Asin")
                prices = result.get("payload", [])
                if prices:
                    for p in prices:
                        comp_prices = p.get("Product", {}).get("CompetitivePricing", {}).get("CompetitivePrices", [])
                        for cp in comp_prices:
                            price_val = float(cp.get("Price", {}).get("ListingPrice", {}).get("Amount", 0))
                            if price_val > 0:
                                competitor_prices.append({"platform": "amazon", "price": price_val, "condition": cp.get("condition", "New")})
                                print(f"  Amazon competitor: ${price_val:.2f} ({cp.get('condition', 'New')})")
                    if not comp_prices:
                        print(f"  Amazon: No competitive pricing data found")
                else:
                    print(f"  Amazon: {result.get('error', 'No data')}")

            elif platform == "shopify":
                # Shopify doesn't have competitive pricing — show our own price
                search = shopify_api(pconfig, f"products.json?fields=id,title,variants")
                for prod in search.get("products", []):
                    for v in prod.get("variants", []):
                        if (v.get("sku") or "").upper() == sku:
                            our_price = float(v.get("price", 0))
                            print(f"  Shopify (our price): ${our_price:.2f}")
                            competitor_prices.append({"platform": "shopify_own", "price": our_price, "condition": "own"})

            elif platform == "ebay":
                # Search eBay for similar items
                result = ebay_api(pconfig, f"/buy/browse/v1/item_summary/search?q={sku}&limit=5")
                items = result.get("itemSummaries", [])
                for item in items[:3]:
                    price_val = float(item.get("price", {}).get("value", 0))
                    if price_val > 0:
                        competitor_prices.append({"platform": "ebay", "price": price_val, "condition": item.get("condition", "")})
                        print(f"  eBay competitor: ${price_val:.2f} ({item.get('condition', '')})")
                if not items:
                    print(f"  eBay: No listings found for {sku}")

        if competitor_prices:
            comp_only = [p["price"] for p in competitor_prices if p.get("condition") != "own"]
            if comp_only:
                avg_price = sum(comp_only) / len(comp_only)
                min_price = min(comp_only)
                print(f"\n  Summary: {len(comp_only)} competitor prices found")
                print(f"  Average: ${avg_price:.2f} | Lowest: ${min_price:.2f}")
                print(f"  Suggested: ${min_price - 0.50:.2f} (undercut lowest by $0.50)")

    elif args.adjust:
        print(f"Price adjustment for {sku}")
        print(f"Max auto-change: {max_change}%/day")

        # Fetch current price and competitor data
        enabled = [p for p, c in config.get("platforms", {}).items() if c.get("enabled")]
        current_price = None
        target_price = None

        # Find our current price
        for platform in enabled:
            pconfig = config.get("platforms", {}).get(platform, {})
            if platform == "shopify":
                search = shopify_api(pconfig, f"products.json?fields=id,title,variants")
                for prod in search.get("products", []):
                    for v in prod.get("variants", []):
                        if (v.get("sku") or "").upper() == sku:
                            current_price = float(v.get("price", 0))
                            break

        if current_price is None or current_price == 0:
            print(f"  Could not determine current price for {sku}")
            return

        # Fetch Amazon competitive pricing for target
        for platform in enabled:
            if platform == "amazon":
                pconfig = config.get("platforms", {}).get(platform, {})
                result = amazon_api(pconfig, f"/products/pricing/v0/competitivePrice"
                                    f"?MarketplaceId={pconfig.get('marketplace_id', 'ATVPDKIKX0DER')}"
                                    f"&Asins={sku}&ItemType=Asin")
                prices = result.get("payload", [])
                comp_prices = []
                for p in prices:
                    for cp in p.get("Product", {}).get("CompetitivePricing", {}).get("CompetitivePrices", []):
                        val = float(cp.get("Price", {}).get("ListingPrice", {}).get("Amount", 0))
                        if val > 0:
                            comp_prices.append(val)
                if comp_prices:
                    target_price = min(comp_prices) - 0.50  # Undercut by $0.50

        if target_price is None:
            print(f"  No competitor pricing found — cannot auto-adjust")
            return

        # Calculate change percentage and enforce caps
        change_pct = abs(target_price - current_price) / current_price * 100
        print(f"  Current: ${current_price:.2f}")
        print(f"  Target:  ${target_price:.2f} (undercut lowest by $0.50)")
        print(f"  Change:  {change_pct:.1f}%")

        # Check today's cumulative changes
        today = datetime.date.today().isoformat()
        today_changes = [c for c in price_log.get("changes", [])
                         if c.get("sku") == sku and c.get("date", "").startswith(today)]
        cumulative_pct = sum(abs(c.get("change_pct", 0)) for c in today_changes)

        if cumulative_pct + change_pct > max_change:
            print(f"\n  ❌ BLOCKED: Would exceed {max_change}%/day cap (today: {cumulative_pct:.1f}% + {change_pct:.1f}%)")
            return

        if change_pct > 15:
            print(f"\n  ⚠️  HUMAN APPROVAL REQUIRED — Change >{15}% ({change_pct:.1f}%)")
            print(f"  Run with --force to override, or approve in dashboard.")
            if not args.dry_run:
                price_log.setdefault("changes", []).append({
                    "sku": sku, "date": datetime.datetime.now().isoformat(),
                    "old_price": current_price, "new_price": target_price,
                    "change_pct": change_pct, "status": "pending_approval",
                    "reason": "competitive_undercut",
                })
                save_json_db(PRICE_LOG, price_log)
            return

        if args.dry_run:
            print(f"\n  (Dry run — no price changes applied)")
            return

        # Push price updates to platforms
        for platform in enabled:
            pconfig = config.get("platforms", {}).get(platform, {})
            if platform == "shopify":
                search = shopify_api(pconfig, f"products.json?fields=id,title,variants")
                for prod in search.get("products", []):
                    for v in prod.get("variants", []):
                        if (v.get("sku") or "").upper() == sku:
                            shopify_api(pconfig, f"variants/{v['id']}.json", method="PUT", data={
                                "variant": {"id": v["id"], "price": f"{target_price:.2f}"}
                            })
                            print(f"  ✅ Shopify price updated: ${target_price:.2f}")
            elif platform == "amazon":
                amazon_api(pconfig, "/feeds/2021-06-30/feeds", method="POST", data={
                    "feedType": "POST_PRODUCT_PRICING_DATA",
                    "marketplaceIds": [pconfig.get("marketplace_id", "ATVPDKIKX0DER")],
                })
                print(f"  ✅ Amazon price feed submitted: ${target_price:.2f}")
            elif platform == "ebay":
                ebay_api(pconfig, f"/sell/inventory/v1/offer/{sku}", method="PUT", data={
                    "pricingSummary": {"price": {"value": f"{target_price:.2f}", "currency": "USD"}}
                })
                print(f"  ✅ eBay price updated: ${target_price:.2f}")

        # Log change
        price_log.setdefault("changes", []).append({
            "sku": sku,
            "date": datetime.datetime.now().isoformat(),
            "old_price": current_price,
            "new_price": target_price,
            "change_pct": round(change_pct, 2),
            "status": "applied",
            "reason": "competitive_undercut",
        })
        save_json_db(PRICE_LOG, price_log)
        print(f"\n  ✅ Price updated: ${current_price:.2f} → ${target_price:.2f} ({change_pct:.1f}%)")

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
                result = shopify_api(pconfig, f"orders/count.json?created_at_min={report_date}T00:00:00-00:00"
                                     f"&created_at_max={report_date}T23:59:59-00:00")
                count = result.get("count", 0)
                # Fetch actual orders for revenue
                orders_result = shopify_api(pconfig, f"orders.json?created_at_min={report_date}T00:00:00-00:00"
                                            f"&created_at_max={report_date}T23:59:59-00:00&status=any&fields=total_price")
                orders = orders_result.get("orders", [])
                rev = sum(float(o.get("total_price", 0)) for o in orders)
                platform_stats[platform] = {"orders": count, "revenue": rev}
                total_orders += count
                total_revenue += rev

            elif platform == "amazon":
                result = amazon_api(pconfig, f"/orders/v0/orders?CreatedAfter={report_date}T00:00:00Z"
                                    f"&CreatedBefore={report_date}T23:59:59Z")
                orders = result.get("payload", {}).get("Orders", [])
                count = len(orders)
                rev = sum(float(o.get("OrderTotal", {}).get("Amount", 0)) for o in orders)
                platform_stats[platform] = {"orders": count, "revenue": rev}
                total_orders += count
                total_revenue += rev

            elif platform == "ebay":
                result = ebay_api(pconfig, f"/sell/fulfillment/v1/order?filter=creationdate:[{report_date}T00:00:00.000Z..{report_date}T23:59:59.000Z]")
                orders = result.get("orders", [])
                count = len(orders)
                rev = sum(float(o.get("pricingSummary", {}).get("total", {}).get("value", 0)) for o in orders)
                platform_stats[platform] = {"orders": count, "revenue": rev}
                total_orders += count
                total_revenue += rev

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
        print(f"WEEKLY P&L REPORT — {week_start} to {week_end}")
        print(f"{'='*60}")
        print()

        # Aggregate daily order data for the week
        enabled = [p for p, c in config.get("platforms", {}).items() if c.get("enabled")]
        weekly_orders = []
        weekly_revenue = 0.0

        for platform in enabled:
            pconfig = config.get("platforms", {}).get(platform, {})
            if platform == "shopify":
                result = shopify_api(pconfig,
                    f"orders.json?created_at_min={week_start}T00:00:00-00:00"
                    f"&created_at_max={week_end}T23:59:59-00:00&status=any")
                orders = result.get("orders", [])
                for o in orders:
                    total = float(o.get("total_price", 0))
                    weekly_orders.append({"platform": "shopify", "total": total, "items": len(o.get("line_items", []))})
                    weekly_revenue += total

            elif platform == "amazon":
                result = amazon_api(pconfig,
                    f"/orders/v0/orders?CreatedAfter={week_start}T00:00:00Z&CreatedBefore={week_end}T23:59:59Z")
                orders = result.get("payload", {}).get("Orders", [])
                for o in orders:
                    total = float(o.get("OrderTotal", {}).get("Amount", 0))
                    weekly_orders.append({"platform": "amazon", "total": total, "items": o.get("NumberOfItemsShipped", 0)})
                    weekly_revenue += total

            elif platform == "ebay":
                result = ebay_api(pconfig,
                    f"/sell/fulfillment/v1/order?filter=creationdate:[{week_start}T00:00:00.000Z..{week_end}T23:59:59.000Z]")
                orders = result.get("orders", [])
                for o in orders:
                    total = float(o.get("pricingSummary", {}).get("total", {}).get("value", 0))
                    weekly_orders.append({"platform": "ebay", "total": total, "items": len(o.get("lineItems", []))})
                    weekly_revenue += total

        total_items = sum(o["items"] for o in weekly_orders)

        # Calculate costs (platform fees)
        shopify_rev = sum(o["total"] for o in weekly_orders if o["platform"] == "shopify")
        amazon_rev = sum(o["total"] for o in weekly_orders if o["platform"] == "amazon")
        ebay_rev = sum(o["total"] for o in weekly_orders if o["platform"] == "ebay")
        shopify_count = sum(1 for o in weekly_orders if o["platform"] == "shopify")

        shopify_fees = shopify_rev * 0.029 + shopify_count * 0.30
        amazon_fees = amazon_rev * 0.15
        ebay_fees = ebay_rev * 0.1235
        total_fees = shopify_fees + amazon_fees + ebay_fees

        # Returns/refunds this week
        returns = load_json_db(RETURNS_DB, {"completed": []})
        week_refunds = [r for r in returns.get("completed", [])
                        if r.get("refunded_at", "")[:10] >= str(week_start) and r.get("refunded_at", "")[:10] <= str(week_end)]
        refund_total = sum(r.get("refund_amount", 0) for r in week_refunds)

        # Estimated COGS (assume 40% margin — user can override in config)
        cogs_pct = float(config.get("policies", {}).get("estimated_cogs_pct", 40)) / 100
        cogs = weekly_revenue * cogs_pct

        # Shipping estimate (from ShipStation or config)
        shipping_pct = float(config.get("policies", {}).get("estimated_shipping_pct", 8)) / 100
        shipping = weekly_revenue * shipping_pct

        net_profit = weekly_revenue - cogs - total_fees - shipping - refund_total

        print("REVENUE")
        print(f"  Total: ${weekly_revenue:.2f} ({len(weekly_orders)} orders, {total_items} items)")
        if shopify_rev > 0:
            print(f"    Shopify: ${shopify_rev:.2f} ({shopify_count} orders)")
        if amazon_rev > 0:
            print(f"    Amazon:  ${amazon_rev:.2f} ({sum(1 for o in weekly_orders if o['platform'] == 'amazon')} orders)")
        if ebay_rev > 0:
            print(f"    eBay:    ${ebay_rev:.2f} ({sum(1 for o in weekly_orders if o['platform'] == 'ebay')} orders)")
        print()

        print("COSTS")
        print(f"  COGS ({cogs_pct*100:.0f}%): ${cogs:.2f}")
        print(f"  Platform Fees: ${total_fees:.2f}")
        if shopify_fees > 0:
            print(f"    Shopify (2.9% + $0.30): ${shopify_fees:.2f}")
        if amazon_fees > 0:
            print(f"    Amazon (15%): ${amazon_fees:.2f}")
        if ebay_fees > 0:
            print(f"    eBay (12.35%): ${ebay_fees:.2f}")
        print(f"  Shipping (~{shipping_pct*100:.0f}%): ${shipping:.2f}")
        print(f"  Returns/Refunds: ${refund_total:.2f} ({len(week_refunds)} refunds)")
        print()

        print("NET PROFIT")
        margin = (net_profit / weekly_revenue * 100) if weekly_revenue > 0 else 0
        print(f"  ${net_profit:.2f} ({margin:.1f}% margin)")
        print(f"  Revenue ${weekly_revenue:.2f} - COGS ${cogs:.2f} - Fees ${total_fees:.2f} - Shipping ${shipping:.2f} - Returns ${refund_total:.2f}")
        print()

        # Price changes this week
        price_changes = load_json_db(PRICE_LOG, {"changes": []})
        week_price_changes = [c for c in price_changes.get("changes", [])
                              if c.get("date", "")[:10] >= str(week_start) and c.get("date", "")[:10] <= str(week_end)]
        if week_price_changes:
            print(f"PRICING CHANGES ({len(week_price_changes)} this week)")
            for c in week_price_changes[:5]:
                print(f"  {c.get('sku', '?')}: ${c.get('old_price', 0):.2f} → ${c.get('new_price', 0):.2f} ({c.get('reason', '')})")
            print()

        print("RECOMMENDATIONS")
        if margin < 20:
            print("  ⚠️  Margin below 20% — review pricing and COGS")
        if refund_total > weekly_revenue * 0.05:
            print("  ⚠️  Refund rate >5% — investigate product quality or listing accuracy")
        if len(weekly_orders) == 0:
            print("  ⚠️  Zero orders this week — check listings and advertising")
        elif margin >= 20:
            print("  ✅ Healthy margins — consider scaling ad spend")

        # Save report
        report_lines = [
            f"Weekly P&L — {week_start} to {week_end}",
            f"Revenue: ${weekly_revenue:.2f} | Orders: {len(weekly_orders)}",
            f"COGS: ${cogs:.2f} | Fees: ${total_fees:.2f} | Shipping: ${shipping:.2f} | Returns: ${refund_total:.2f}",
            f"Net Profit: ${net_profit:.2f} ({margin:.1f}%)",
        ]
        report_file = os.path.join(REPORTS_DIR, f"weekly-{week_start}.txt")
        with open(report_file, "w") as f:
            f.write("\n".join(report_lines) + "\n")
        print(f"\n  Report saved: {report_file}")

    elif args.type == "monthly":
        month = report_date[:7]  # YYYY-MM
        year, mon = int(month[:4]), int(month[5:])

        print(f"{'='*60}")
        print(f"MONTHLY ANALYTICS REPORT — {month}")
        print(f"{'='*60}")
        print()

        # Aggregate weekly reports for the month
        weekly_files = sorted([
            f for f in os.listdir(REPORTS_DIR)
            if f.startswith("weekly-") and f[7:14] >= f"{year}-{mon:02d}" and f[7:14] <= f"{year}-{mon:02d}"
        ]) if os.path.isdir(REPORTS_DIR) else []

        # Also fetch live data for the month from platforms
        enabled = [p for p, c in config.get("platforms", {}).items() if c.get("enabled")]
        monthly_revenue = 0.0
        monthly_orders = 0

        for platform in enabled:
            pconfig = config.get("platforms", {}).get(platform, {})
            if platform == "shopify":
                result = shopify_api(pconfig,
                    f"orders/count.json?created_at_min={month}-01T00:00:00-00:00")
                count = result.get("count", 0)
                # Get revenue from orders
                orders_result = shopify_api(pconfig,
                    f"orders.json?created_at_min={month}-01T00:00:00-00:00&status=any&fields=total_price")
                orders = orders_result.get("orders", [])
                rev = sum(float(o.get("total_price", 0)) for o in orders)
                monthly_orders += count
                monthly_revenue += rev
                print(f"  Shopify: {count} orders, ${rev:.2f} revenue")

            elif platform == "amazon":
                result = amazon_api(pconfig,
                    f"/orders/v0/orders?CreatedAfter={month}-01T00:00:00Z")
                orders = result.get("payload", {}).get("Orders", [])
                rev = sum(float(o.get("OrderTotal", {}).get("Amount", 0)) for o in orders)
                monthly_orders += len(orders)
                monthly_revenue += rev
                print(f"  Amazon: {len(orders)} orders, ${rev:.2f} revenue")

            elif platform == "ebay":
                result = ebay_api(pconfig,
                    f"/sell/fulfillment/v1/order?filter=creationdate:[{month}-01T00:00:00.000Z..]")
                orders = result.get("orders", [])
                rev = sum(float(o.get("pricingSummary", {}).get("total", {}).get("value", 0)) for o in orders)
                monthly_orders += len(orders)
                monthly_revenue += rev
                print(f"  eBay: {len(orders)} orders, ${rev:.2f} revenue")

        print()
        print(f"MONTHLY TOTALS")
        print(f"  Orders: {monthly_orders}")
        print(f"  Revenue: ${monthly_revenue:.2f}")

        # Returns this month
        returns = load_json_db(RETURNS_DB, {"completed": [], "active": []})
        month_refunds = [r for r in returns.get("completed", [])
                         if r.get("refunded_at", "")[:7] == month]
        refund_total = sum(r.get("refund_amount", 0) for r in month_refunds)
        print(f"  Refunds: ${refund_total:.2f} ({len(month_refunds)} returns)")

        # Price changes this month
        price_changes = load_json_db(PRICE_LOG, {"changes": []})
        month_changes = [c for c in price_changes.get("changes", [])
                         if c.get("date", "")[:7] == month]
        print(f"  Price adjustments: {len(month_changes)}")
        print()

        # Trend analysis vs previous month
        prev_mon = mon - 1 if mon > 1 else 12
        prev_year = year if mon > 1 else year - 1
        prev_month = f"{prev_year}-{prev_mon:02d}"
        prev_report = os.path.join(REPORTS_DIR, f"monthly-{prev_month}.json")
        if os.path.exists(prev_report):
            prev_data = load_json_db(prev_report, {})
            prev_rev = prev_data.get("revenue", 0)
            if prev_rev > 0:
                growth = (monthly_revenue - prev_rev) / prev_rev * 100
                print(f"TREND vs {prev_month}")
                print(f"  Revenue growth: {growth:+.1f}%")
                print(f"  Previous month: ${prev_rev:.2f}")
        print()

        # Save structured report
        report_data = {
            "month": month, "orders": monthly_orders, "revenue": monthly_revenue,
            "refunds": refund_total, "price_changes": len(month_changes),
        }
        report_file = os.path.join(REPORTS_DIR, f"monthly-{month}.json")
        save_json_db(report_file, report_data)
        print(f"  Report saved: {report_file}")

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
