#!/usr/bin/env python3
"""
polymarket-positions.py — On-chain position verification and P&L tracking
for Polymarket trades.

Usage:
  python3 ~/scripts/polymarket-positions.py list [--json]
  python3 ~/scripts/polymarket-positions.py sync [--json]
  python3 ~/scripts/polymarket-positions.py pnl [--json]

Exit codes:
  0 = success (OK)
  1 = error (FAIL)
"""

import argparse
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

POLYMARKET_DIR = Path.home() / ".openclaw" / "polymarket"
WALLET_FILE = POLYMARKET_DIR / "wallet.json"
POSITIONS_FILE = POLYMARKET_DIR / "positions.json"
TRADE_LOG_FILE = POLYMARKET_DIR / "trade-log.json"

CLOB_HOST = "https://clob.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"
CHAIN_ID = 137

# Conditional Tokens contract (Polygon)
CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"

# Minimal ABI for balanceOf(address, uint256)
CT_BALANCE_ABI = json.loads('[{"inputs":[{"name":"account","type":"address"},{"name":"id","type":"uint256"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"}]')

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_json(path, default=None):
    """Load a JSON file, return default if missing."""
    if not path.exists():
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return default


def save_json(path, data):
    """Save data to a JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def load_wallet():
    return load_json(WALLET_FILE)


def fetch_market_info(market_id):
    """Fetch market info from Gamma API."""
    url = f"{GAMMA_API}/markets/{market_id}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "polymarket-positions/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def get_current_price_for_token(market, token_id):
    """Get current price for a token ID from market data."""
    token_ids = json.loads(market.get("clobTokenIds", "[]"))
    prices = json.loads(market.get("outcomePrices", "[]"))
    for i, tid in enumerate(token_ids):
        if tid == token_id and i < len(prices):
            try:
                return float(prices[i])
            except (ValueError, TypeError):
                return None
    return None


RPC_FALLBACKS = [
    "https://api.zan.top/polygon-mainnet",
    "https://1rpc.io/matic",
    "https://polygon-rpc.com",
    "https://polygon-bor-rpc.publicnode.com",
]


def get_rpc_url():
    """Read POLYGON_RPC_URL from env file, or find a working fallback."""
    env_file = Path.home() / ".openclaw" / ".env"
    if env_file.exists():
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line.startswith("POLYGON_RPC_URL="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val
    import urllib.request
    for rpc in RPC_FALLBACKS:
        try:
            payload = json.dumps({"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}).encode()
            req = urllib.request.Request(rpc, data=payload, headers={"Content-Type": "application/json"})
            resp = urllib.request.urlopen(req, timeout=5)
            data = json.loads(resp.read().decode())
            if "result" in data:
                return rpc
        except Exception:
            continue
    return RPC_FALLBACKS[0]


def init_clob_client(wallet):
    """Initialize CLOB client."""
    try:
        from py_clob_client.client import ClobClient
    except ImportError:
        return None, "py-clob-client not installed"

    try:
        client = ClobClient(CLOB_HOST, key=wallet["private_key"], chain_id=CHAIN_ID)
        api_creds = client.create_or_derive_api_creds()
        client.set_api_creds(api_creds)
        return client, None
    except Exception as e:
        return None, str(e)


# ---------------------------------------------------------------------------
# list subcommand
# ---------------------------------------------------------------------------

def cmd_list(args):
    """Show positions from local file + open orders from CLOB API."""
    positions = load_json(POSITIONS_FILE, [])

    wallet = load_wallet()

    # Try to fetch current prices for each position
    enriched = []
    for p in positions:
        entry = dict(p)
        market = fetch_market_info(p.get("market_id", ""))
        if market:
            current_price = get_current_price_for_token(market, p.get("token_id", ""))
            if current_price is not None:
                entry["current_price"] = current_price
                entry["current_value"] = round(current_price * p.get("shares", 0), 2)
                entry["unrealized_pnl"] = round((current_price - p.get("avg_price", 0)) * p.get("shares", 0), 2)
        enriched.append(entry)

    # Open orders from CLOB
    open_orders = []
    if wallet:
        client, err = init_clob_client(wallet)
        if client:
            try:
                orders = client.get_orders()
                if orders:
                    open_orders = orders
            except Exception:
                pass

    if args.json:
        print(json.dumps({
            "status": "OK",
            "positions": enriched,
            "open_orders": len(open_orders),
        }, indent=2))
    else:
        if not enriched and not open_orders:
            print("OK — No positions or open orders")
            return 0

        if enriched:
            print(f"=== Positions ({len(enriched)}) ===\n")
            for p in enriched:
                question = p.get("question", p.get("market_question", "Unknown"))
                outcome = p.get("outcome", "?")
                shares = p.get("shares", 0)
                avg = p.get("avg_price", 0)
                cur = p.get("current_price")
                pnl = p.get("unrealized_pnl")

                print(f"  {question}")
                print(f"    {outcome}: {shares:.2f} shares @ ${avg:.4f} avg")
                if cur is not None:
                    print(f"    Current: ${cur:.4f}  Value: ${p.get('current_value', 0):.2f}  P&L: ${pnl:+.2f}")
                print()

        if open_orders:
            print(f"=== Open Orders ({len(open_orders)}) ===\n")
            for o in open_orders:
                oid = o.get("id", "?")
                side = o.get("side", "?")
                price = o.get("price", "?")
                size = o.get("original_size", o.get("size", "?"))
                print(f"  {oid}  {side} {size} @ ${price}")
            print()

    return 0


# ---------------------------------------------------------------------------
# sync subcommand
# ---------------------------------------------------------------------------

def cmd_sync(args):
    """Verify positions on-chain via Conditional Tokens balanceOf()."""
    try:
        from web3 import Web3
    except ImportError:
        print("FAIL — web3 not installed. Run: pip3 install web3")
        return 1

    wallet = load_wallet()
    if not wallet:
        print("FAIL — No wallet found. Run: bash ~/scripts/setup-polymarket-wallet.sh")
        return 1

    positions = load_json(POSITIONS_FILE, [])
    if not positions:
        if args.json:
            print(json.dumps({"status": "OK", "message": "no_positions", "positions": []}))
        else:
            print("OK — No positions to sync")
        return 0

    rpc_url = get_rpc_url()
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    if not w3.is_connected():
        print(f"FAIL — Cannot connect to Polygon RPC: {rpc_url}")
        return 1

    ct_contract = w3.eth.contract(
        address=Web3.to_checksum_address(CONDITIONAL_TOKENS),
        abi=CT_BALANCE_ABI,
    )
    address_cs = Web3.to_checksum_address(wallet["address"])

    results = []
    updated = False

    for p in positions:
        token_id = p.get("token_id", "")
        local_shares = p.get("shares", 0)

        try:
            # Token IDs in Polymarket are large hex strings — convert to int
            if isinstance(token_id, str):
                if token_id.startswith("0x"):
                    token_id_int = int(token_id, 16)
                else:
                    token_id_int = int(token_id)
            else:
                token_id_int = int(token_id)

            on_chain_raw = ct_contract.functions.balanceOf(address_cs, token_id_int).call()
            # CT shares have 6 decimal places (like USDC)
            on_chain_shares = on_chain_raw / 1e6

            discrepancy = abs(on_chain_shares - local_shares) > 0.01
            if discrepancy:
                results.append({
                    "token_id": str(token_id),
                    "question": p.get("question", ""),
                    "outcome": p.get("outcome", ""),
                    "local_shares": local_shares,
                    "on_chain_shares": on_chain_shares,
                    "discrepancy": True,
                })
                p["shares"] = on_chain_shares
                p["updated_at"] = datetime.now(timezone.utc).isoformat()
                p["last_sync"] = "on_chain"
                updated = True
            else:
                results.append({
                    "token_id": str(token_id),
                    "question": p.get("question", ""),
                    "outcome": p.get("outcome", ""),
                    "local_shares": local_shares,
                    "on_chain_shares": on_chain_shares,
                    "discrepancy": False,
                })
        except Exception as e:
            results.append({
                "token_id": str(token_id),
                "question": p.get("question", ""),
                "error": str(e),
            })

    # Remove positions with 0 shares
    positions = [p for p in positions if p.get("shares", 0) > 0]

    if updated:
        save_json(POSITIONS_FILE, positions)

    if args.json:
        print(json.dumps({
            "status": "OK",
            "synced": len(results),
            "discrepancies": sum(1 for r in results if r.get("discrepancy")),
            "results": results,
        }, indent=2))
    else:
        disc_count = sum(1 for r in results if r.get("discrepancy"))
        err_count = sum(1 for r in results if "error" in r)
        ok_count = len(results) - disc_count - err_count

        print(f"OK — Synced {len(results)} position(s): {ok_count} match, {disc_count} updated, {err_count} errors")
        for r in results:
            if r.get("discrepancy"):
                print(f"  WARN — {r.get('question', '?')} ({r.get('outcome', '?')}): "
                      f"local={r['local_shares']:.2f} → on-chain={r['on_chain_shares']:.2f} (UPDATED)")
            elif "error" in r:
                print(f"  FAIL — token {r['token_id']}: {r['error']}")

    return 0


# ---------------------------------------------------------------------------
# pnl subcommand
# ---------------------------------------------------------------------------

def cmd_pnl(args):
    """Calculate P&L from positions and trade log."""
    positions = load_json(POSITIONS_FILE, [])
    trade_log = load_json(TRADE_LOG_FILE, [])

    # Calculate realized P&L from sells in trade log
    realized_pnl = 0.0
    total_invested = 0.0

    buys_by_token = {}  # token_id -> list of (shares, price)
    for t in trade_log:
        token_id = t.get("token_id", "")
        if t.get("action") == "BUY":
            shares = t.get("shares", 0)
            price = t.get("price", 0)
            amount = t.get("amount_usdc", price * shares)
            total_invested += amount
            if token_id not in buys_by_token:
                buys_by_token[token_id] = []
            buys_by_token[token_id].append({"shares": shares, "price": price})
        elif t.get("action") == "SELL":
            shares_sold = t.get("shares", 0)
            sell_price = t.get("price", 0)
            # FIFO cost basis
            buy_list = buys_by_token.get(token_id, [])
            remaining = shares_sold
            cost_basis = 0.0
            while remaining > 0 and buy_list:
                entry = buy_list[0]
                take = min(remaining, entry["shares"])
                cost_basis += take * entry["price"]
                entry["shares"] -= take
                remaining -= take
                if entry["shares"] <= 0:
                    buy_list.pop(0)
            realized_pnl += (sell_price * shares_sold) - cost_basis

    # Calculate unrealized P&L from current positions
    unrealized_pnl = 0.0
    portfolio_value = 0.0

    for p in positions:
        market = fetch_market_info(p.get("market_id", ""))
        current_price = None
        if market:
            current_price = get_current_price_for_token(market, p.get("token_id", ""))

        shares = p.get("shares", 0)
        avg_price = p.get("avg_price", 0)

        if current_price is not None:
            position_value = current_price * shares
            position_cost = avg_price * shares
            unrealized_pnl += position_value - position_cost
            portfolio_value += position_value
        else:
            # Use avg_price as fallback value
            portfolio_value += avg_price * shares

    total_pnl = realized_pnl + unrealized_pnl

    result = {
        "status": "OK",
        "realized_pnl": round(realized_pnl, 2),
        "unrealized_pnl": round(unrealized_pnl, 2),
        "total_pnl": round(total_pnl, 2),
        "portfolio_value": round(portfolio_value, 2),
        "total_invested": round(total_invested, 2),
        "open_positions": len(positions),
        "total_trades": len(trade_log),
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("=== Polymarket P&L ===\n")
        print(f"  Realized P&L:   ${realized_pnl:+.2f}")
        print(f"  Unrealized P&L: ${unrealized_pnl:+.2f}")
        print(f"  Total P&L:      ${total_pnl:+.2f}")
        print(f"  Portfolio Value: ${portfolio_value:.2f}")
        print(f"  Total Invested:  ${total_invested:.2f}")
        print(f"  Open Positions:  {len(positions)}")
        print(f"  Total Trades:    {len(trade_log)}")

        if total_invested > 0:
            roi = (total_pnl / total_invested) * 100
            print(f"  ROI:             {roi:+.1f}%")

    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Polymarket position tracking and P&L",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    # list
    sp_list = subparsers.add_parser("list", help="Show current positions")
    sp_list.add_argument("--json", action="store_true", help="Output as JSON")

    # sync
    sp_sync = subparsers.add_parser("sync", help="Verify positions on-chain")
    sp_sync.add_argument("--json", action="store_true", help="Output as JSON")

    # pnl
    sp_pnl = subparsers.add_parser("pnl", help="Calculate P&L")
    sp_pnl.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        return 1

    cmd_map = {
        "list": cmd_list,
        "sync": cmd_sync,
        "pnl": cmd_pnl,
    }

    return cmd_map[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
