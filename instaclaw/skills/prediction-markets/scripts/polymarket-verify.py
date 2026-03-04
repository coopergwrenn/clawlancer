#!/usr/bin/env python3
"""
polymarket-verify.py — Verify orders and trades with real transaction hashes
from the Polymarket CLOB API.

Usage:
  python3 ~/scripts/polymarket-verify.py order --order-id <id> [--wait] [--timeout 60] [--json]
  python3 ~/scripts/polymarket-verify.py trade --trade-id <id> [--json]
  python3 ~/scripts/polymarket-verify.py recent [--limit 10] [--json]

Exit codes:
  0 = success (OK)
  1 = error (FAIL)
"""

import argparse
import json
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

POLYMARKET_DIR = Path.home() / ".openclaw" / "polymarket"
WALLET_FILE = POLYMARKET_DIR / "wallet.json"

CLOB_HOST_DEFAULT = "https://clob.polymarket.com"
CHAIN_ID = 137

ENV_FILE = Path.home() / ".openclaw" / ".env"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_wallet():
    if not WALLET_FILE.exists():
        return None
    with open(WALLET_FILE) as f:
        return json.load(f)


def get_clob_host():
    """Read CLOB host from env. US VMs use proxy; non-US connect direct."""
    if ENV_FILE.exists():
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line.startswith("CLOB_PROXY_URL="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val
    return CLOB_HOST_DEFAULT


def init_clob_client(wallet):
    """Initialize CLOB client."""
    try:
        from py_clob_client.client import ClobClient
    except ImportError:
        return None, "py-clob-client not installed. Run: pip3 install py-clob-client"

    try:
        host = get_clob_host()
        client = ClobClient(host, key=wallet["private_key"], chain_id=CHAIN_ID)
        api_creds = client.create_or_derive_api_creds()
        client.set_api_creds(api_creds)
        return client, None
    except Exception as e:
        return None, str(e)


# ---------------------------------------------------------------------------
# order subcommand
# ---------------------------------------------------------------------------

def cmd_order(args):
    """Query order status, fills, and transaction hashes."""
    wallet = load_wallet()
    if not wallet:
        print("FAIL — No wallet found. Run: bash ~/scripts/setup-polymarket-wallet.sh")
        return 1

    client, err = init_clob_client(wallet)
    if not client:
        print(f"FAIL — {err}")
        return 1

    deadline = time.time() + args.timeout if args.wait else 0

    while True:
        try:
            order = client.get_order(args.order_id)
        except Exception as e:
            print(f"FAIL — Could not fetch order {args.order_id}: {e}")
            return 1

        if not order:
            print(f"FAIL — Order {args.order_id} not found")
            return 1

        # Normalize order data
        if isinstance(order, dict):
            status = order.get("status", "unknown")
            size_matched = order.get("size_matched", "0")
            original_size = order.get("original_size", order.get("size", "0"))

            is_terminal = status in ("matched", "cancelled", "expired")

            if args.wait and not is_terminal and time.time() < deadline:
                if not args.json:
                    print(f"  Waiting... status={status}, matched={size_matched}/{original_size}")
                time.sleep(5)
                continue

            # Fetch associated trades for tx hashes
            tx_hashes = []
            try:
                trades = client.get_trades()
                if trades:
                    for t in trades:
                        if t.get("order_id") == args.order_id or t.get("orderID") == args.order_id:
                            tx = t.get("transaction_hash", t.get("transactionHash", ""))
                            if tx:
                                tx_hashes.append(tx)
            except Exception:
                pass

            result = {
                "status": "OK",
                "order_id": args.order_id,
                "order_status": status,
                "side": order.get("side", ""),
                "price": order.get("price", ""),
                "original_size": original_size,
                "size_matched": size_matched,
                "tx_hashes": tx_hashes,
            }

            if args.json:
                print(json.dumps(result, indent=2))
            else:
                print(f"OK — Order {args.order_id}")
                print(f"  Status: {status}")
                print(f"  Side: {order.get('side', '?')}")
                print(f"  Price: ${order.get('price', '?')}")
                print(f"  Size: {size_matched}/{original_size} matched")
                if tx_hashes:
                    for tx in tx_hashes:
                        print(f"  Tx: https://polygonscan.com/tx/{tx}")
                else:
                    print("  Tx: none yet")

            return 0
        else:
            print(f"FAIL — Unexpected response type: {type(order)}")
            return 1


# ---------------------------------------------------------------------------
# trade subcommand
# ---------------------------------------------------------------------------

def cmd_trade(args):
    """Query a specific trade for its transaction hash."""
    wallet = load_wallet()
    if not wallet:
        print("FAIL — No wallet found")
        return 1

    client, err = init_clob_client(wallet)
    if not client:
        print(f"FAIL — {err}")
        return 1

    try:
        trades = client.get_trades()
    except Exception as e:
        print(f"FAIL — Could not fetch trades: {e}")
        return 1

    if not trades:
        print(f"FAIL — No trades found")
        return 1

    target = None
    for t in trades:
        trade_id = t.get("id", t.get("trade_id", ""))
        if str(trade_id) == str(args.trade_id):
            target = t
            break

    if not target:
        print(f"FAIL — Trade {args.trade_id} not found")
        return 1

    tx_hash = target.get("transaction_hash", target.get("transactionHash", ""))

    result = {
        "status": "OK",
        "trade_id": args.trade_id,
        "transaction_hash": tx_hash,
        "side": target.get("side", ""),
        "price": target.get("price", ""),
        "size": target.get("size", ""),
        "order_id": target.get("order_id", target.get("orderID", "")),
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"OK — Trade {args.trade_id}")
        print(f"  Side: {target.get('side', '?')}")
        print(f"  Price: ${target.get('price', '?')}")
        print(f"  Size: {target.get('size', '?')}")
        if tx_hash:
            print(f"  Tx: https://polygonscan.com/tx/{tx_hash}")
        else:
            print("  Tx: not available")

    return 0


# ---------------------------------------------------------------------------
# recent subcommand
# ---------------------------------------------------------------------------

def cmd_recent(args):
    """Show recent trades with transaction hashes."""
    wallet = load_wallet()
    if not wallet:
        print("FAIL — No wallet found")
        return 1

    client, err = init_clob_client(wallet)
    if not client:
        print(f"FAIL — {err}")
        return 1

    try:
        trades = client.get_trades()
    except Exception as e:
        print(f"FAIL — Could not fetch trades: {e}")
        return 1

    if not trades:
        if args.json:
            print(json.dumps({"status": "OK", "trades": [], "count": 0}))
        else:
            print("OK — No recent trades")
        return 0

    # Limit results
    trades = trades[:args.limit]

    if args.json:
        simplified = []
        for t in trades:
            simplified.append({
                "trade_id": t.get("id", t.get("trade_id", "")),
                "side": t.get("side", ""),
                "price": t.get("price", ""),
                "size": t.get("size", ""),
                "transaction_hash": t.get("transaction_hash", t.get("transactionHash", "")),
                "order_id": t.get("order_id", t.get("orderID", "")),
                "timestamp": t.get("created_at", t.get("timestamp", "")),
            })
        print(json.dumps({"status": "OK", "trades": simplified, "count": len(simplified)}, indent=2))
    else:
        print(f"OK — {len(trades)} recent trade(s):\n")
        for t in trades:
            tid = t.get("id", t.get("trade_id", "?"))
            side = t.get("side", "?")
            price = t.get("price", "?")
            size = t.get("size", "?")
            tx = t.get("transaction_hash", t.get("transactionHash", ""))
            ts = t.get("created_at", t.get("timestamp", ""))

            print(f"  [{ts}] {side} {size} @ ${price}")
            print(f"    Trade ID: {tid}")
            if tx:
                print(f"    Tx: https://polygonscan.com/tx/{tx}")
            print()

    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Verify Polymarket orders and trades with real transaction hashes",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    # order
    sp_order = subparsers.add_parser("order", help="Query order status and tx hashes")
    sp_order.add_argument("--order-id", required=True, help="Order ID to verify")
    sp_order.add_argument("--wait", action="store_true", help="Poll until filled or timeout")
    sp_order.add_argument("--timeout", type=int, default=60, help="Max wait time in seconds (default: 60)")
    sp_order.add_argument("--json", action="store_true", help="Output as JSON")

    # trade
    sp_trade = subparsers.add_parser("trade", help="Query a specific trade")
    sp_trade.add_argument("--trade-id", required=True, help="Trade ID to look up")
    sp_trade.add_argument("--json", action="store_true", help="Output as JSON")

    # recent
    sp_recent = subparsers.add_parser("recent", help="Show recent trades")
    sp_recent.add_argument("--limit", type=int, default=10, help="Number of trades to show (default: 10)")
    sp_recent.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        return 1

    cmd_map = {
        "order": cmd_order,
        "trade": cmd_trade,
        "recent": cmd_recent,
    }

    return cmd_map[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
