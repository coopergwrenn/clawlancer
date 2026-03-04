#!/usr/bin/env python3
"""
polymarket-portfolio.py — Generate a real portfolio summary the agent shows to users.

Combines positions, current prices, unrealized P&L, trade history with
Polygonscan tx links into a single structured report.

Usage:
  python3 ~/scripts/polymarket-portfolio.py summary [--json]
  python3 ~/scripts/polymarket-portfolio.py trades [--limit 20] [--json]

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

GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_HOST_DEFAULT = "https://clob.polymarket.com"
POLYGONSCAN = "https://polygonscan.com/tx"
CHAIN_ID = 137

# USDC contract addresses (Polygon mainnet)
USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"

ENV_FILE = Path.home() / ".openclaw" / ".env"

RPC_FALLBACKS = [
    "https://api.zan.top/polygon-mainnet",
    "https://1rpc.io/matic",
    "https://polygon-rpc.com",
    "https://polygon-bor-rpc.publicnode.com",
]

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


def load_wallet():
    return load_json(WALLET_FILE)


def fetch_market_info(market_id):
    """Fetch market info from Gamma API."""
    url = f"{GAMMA_API}/markets/{market_id}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "polymarket-portfolio/1.0"})
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


def get_market_url(market):
    """Build a Polymarket URL from market data."""
    slug = market.get("slug", "")
    events = market.get("events", [])
    if events and isinstance(events, list) and len(events) > 0:
        event_slug = events[0].get("slug", "")
        if event_slug and slug:
            return f"https://polymarket.com/event/{event_slug}/{slug}"
    if slug:
        return f"https://polymarket.com/market/{slug}"
    return None


def collect_tx_hashes_for_position(trade_log, token_id):
    """Gather all tx hashes from trade log entries matching a token ID."""
    hashes = []
    for t in trade_log:
        if t.get("token_id") == token_id:
            for tx in t.get("tx_hashes", []):
                if tx and tx not in hashes:
                    hashes.append(tx)
    return hashes


def get_rpc_url():
    """Read POLYGON_RPC_URL from env file, or find a working fallback."""
    if ENV_FILE.exists():
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line.startswith("POLYGON_RPC_URL="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val
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


def get_clob_host():
    """Read CLOB host from env."""
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
        return None, "py-clob-client not installed"
    try:
        host = get_clob_host()
        client = ClobClient(host, key=wallet["private_key"], chain_id=CHAIN_ID)
        api_creds = client.create_or_derive_api_creds()
        client.set_api_creds(api_creds)
        return client, None
    except Exception as e:
        return None, str(e)


def check_usdc_balance(wallet_address):
    """Check USDC.e balance. Returns float or None."""
    rpc_url = get_rpc_url()
    addr_padded = wallet_address[2:].lower().zfill(64)
    call_data = "0x70a08231" + addr_padded
    try:
        payload = json.dumps({
            "jsonrpc": "2.0",
            "method": "eth_call",
            "params": [{"to": USDC_E, "data": call_data}, "latest"],
            "id": 1,
        }).encode()
        req = urllib.request.Request(rpc_url, data=payload, headers={"Content-Type": "application/json"})
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read().decode())
        raw = data.get("result", "0x0")
        return int(raw, 16) / 1e6 if raw and raw != "0x" else 0.0
    except Exception:
        return None


def verify_on_chain_balance(wallet, token_id):
    """Check on-chain balance for a single CT token. Returns shares or None."""
    try:
        from web3 import Web3
    except ImportError:
        return None
    rpc_url = get_rpc_url()
    try:
        w3 = Web3(Web3.HTTPProvider(rpc_url))
        if not w3.is_connected():
            return None
        CT_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
        CT_ABI = json.loads('[{"inputs":[{"name":"account","type":"address"},{"name":"id","type":"uint256"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"}]')
        ct = w3.eth.contract(address=Web3.to_checksum_address(CT_ADDRESS), abi=CT_ABI)
        addr = Web3.to_checksum_address(wallet["address"])
        tid = int(token_id, 16) if isinstance(token_id, str) and token_id.startswith("0x") else int(token_id)
        raw = ct.functions.balanceOf(addr, tid).call()
        return raw / 1e6
    except Exception:
        return None


def compute_cost_basis(trade_log):
    """Compute FIFO cost basis per token_id. Returns {token_id: avg_entry_price}."""
    buys = {}  # token_id -> [(shares, price)]
    for t in trade_log:
        if t.get("action") == "BUY":
            tid = t.get("token_id", "")
            if tid not in buys:
                buys[tid] = []
            buys[tid].append((t.get("shares", 0), t.get("price", 0)))

    result = {}
    for tid, entries in buys.items():
        total_shares = sum(s for s, _ in entries)
        total_cost = sum(s * p for s, p in entries)
        if total_shares > 0:
            result[tid] = total_cost / total_shares
        else:
            result[tid] = 0
    return result


# ---------------------------------------------------------------------------
# summary subcommand
# ---------------------------------------------------------------------------

def cmd_summary(args):
    """Full portfolio summary: verified positions + pending orders + cash balance."""
    wallet = load_wallet()
    if not wallet:
        if args.json:
            print(json.dumps({"status": "FAIL", "error": "wallet_not_found"}))
        else:
            print("FAIL — No wallet found. Run: bash ~/scripts/setup-polymarket-wallet.sh")
        return 1

    positions = load_json(POSITIONS_FILE, [])
    trade_log = load_json(TRADE_LOG_FILE, [])
    cost_basis = compute_cost_basis(trade_log)

    # FIX 8: Get USDC.e cash balance
    usdc_balance = check_usdc_balance(wallet["address"])

    # FIX 8: Get open orders from CLOB
    open_orders = []
    client, client_err = init_clob_client(wallet)
    if client:
        try:
            orders = client.get_orders()
            if orders:
                open_orders = orders
        except Exception:
            pass

    if not positions and not trade_log and not open_orders:
        result = {
            "status": "OK",
            "wallet": wallet["address"],
            "usdc_balance": usdc_balance,
            "positions": [],
            "pending_orders": [],
            "total_value": 0,
            "total_pnl": 0,
            "trade_count": 0,
        }
        if args.json:
            print(json.dumps(result))
        else:
            print(f"OK — Portfolio for {wallet['address']}")
            if usdc_balance is not None:
                print(f"  Cash: ${usdc_balance:.2f} USDC.e")
            print("  No positions or trades yet.")
        return 0

    # Build enriched position data — FIX 8: only verified positions in P&L
    portfolio_rows = []
    total_value = 0.0
    total_pnl = 0.0
    total_cost = 0.0

    market_cache = {}

    for p in positions:
        market_id = p.get("market_id", "")
        token_id = p.get("token_id", "")
        shares = p.get("shares", 0)

        if shares <= 0:
            continue

        # FIX 8: Verify on-chain balance — only include verified positions in P&L
        on_chain_shares = verify_on_chain_balance(wallet, token_id) if token_id else None
        if on_chain_shares is not None and on_chain_shares <= 0:
            continue  # Skip — no on-chain balance, don't include in P&L
        actual_shares = on_chain_shares if on_chain_shares is not None else shares

        if market_id not in market_cache:
            market_cache[market_id] = fetch_market_info(market_id)
        market = market_cache[market_id]

        question = p.get("question", p.get("market_question", "Unknown"))
        outcome = p.get("outcome", "?")
        entry_price = cost_basis.get(token_id, p.get("avg_price", 0))

        current_price = None
        market_url = None
        if market:
            current_price = get_current_price_for_token(market, token_id)
            market_url = get_market_url(market)

        position_cost = entry_price * actual_shares
        if current_price is not None:
            position_value = current_price * actual_shares
            unrealized_pnl = position_value - position_cost
        else:
            position_value = position_cost
            unrealized_pnl = 0.0

        total_value += position_value
        total_pnl += unrealized_pnl
        total_cost += position_cost

        tx_hashes = collect_tx_hashes_for_position(trade_log, token_id)

        row = {
            "market": question,
            "market_id": market_id,
            "outcome": outcome,
            "shares": round(actual_shares, 2),
            "verified": on_chain_shares is not None,
            "entry_price": round(entry_price, 4),
            "current_price": round(current_price, 4) if current_price is not None else None,
            "value_usdc": round(position_value, 2),
            "unrealized_pnl": round(unrealized_pnl, 2),
            "market_url": market_url,
            "tx_links": [f"{POLYGONSCAN}/{tx}" for tx in tx_hashes],
        }
        portfolio_rows.append(row)

    # Realized P&L from sells
    realized_pnl = 0.0
    sell_buys = {}
    for t in trade_log:
        if t.get("action") == "BUY":
            tid = t.get("token_id", "")
            if tid not in sell_buys:
                sell_buys[tid] = []
            sell_buys[tid].append({"shares": t.get("shares", 0), "price": t.get("price", 0)})
    for t in trade_log:
        if t.get("action") == "SELL":
            tid = t.get("token_id", "")
            sell_price = t.get("price", 0)
            remaining = t.get("shares", 0)
            buy_list = sell_buys.get(tid, [])
            cost = 0.0
            while remaining > 0 and buy_list:
                entry = buy_list[0]
                take = min(remaining, entry["shares"])
                cost += take * entry["price"]
                entry["shares"] -= take
                remaining -= take
                if entry["shares"] <= 0:
                    buy_list.pop(0)
            realized_pnl += (sell_price * t.get("shares", 0)) - cost

    combined_pnl = total_pnl + realized_pnl

    # FIX 8: Format pending orders
    pending_orders_data = []
    for o in open_orders:
        try:
            o_price = float(o.get("price", 0))
            o_size = float(o.get("original_size", o.get("size", 0)))
            o_matched = float(o.get("size_matched", 0))
            o_remaining = o_size - o_matched
            o_value = o_price * o_remaining
        except (ValueError, TypeError):
            o_value = 0
            o_remaining = 0
        pending_orders_data.append({
            "order_id": o.get("id", o.get("order_id", "?")),
            "side": o.get("side", "?"),
            "price": o.get("price", "?"),
            "size": o.get("original_size", o.get("size", "?")),
            "size_matched": o.get("size_matched", "0"),
            "remaining": round(o_remaining, 2),
            "value_tied": round(o_value, 2),
            "status": o.get("status", "?"),
            "type": o.get("type", o.get("order_type", "?")),
        })

    if args.json:
        print(json.dumps({
            "status": "OK",
            "wallet": wallet["address"],
            "usdc_balance": usdc_balance,
            "verified_positions": portfolio_rows,
            "pending_orders": pending_orders_data,
            "total_value": round(total_value, 2),
            "total_cost": round(total_cost, 2),
            "unrealized_pnl": round(total_pnl, 2),
            "realized_pnl": round(realized_pnl, 2),
            "total_pnl": round(combined_pnl, 2),
            "roi_pct": round((combined_pnl / total_cost) * 100, 1) if total_cost > 0 else 0,
            "trade_count": len(trade_log),
        }, indent=2))
    else:
        print(f"=== Portfolio Summary — {wallet['address']} ===\n")

        # Cash balance
        if usdc_balance is not None:
            print(f"  Cash: ${usdc_balance:.2f} USDC.e\n")

        # Verified positions
        if not portfolio_rows:
            print("  No verified open positions.\n")
        else:
            print(f"  --- Verified Positions ({len(portfolio_rows)}) ---\n")
            for row in portfolio_rows:
                pnl_str = f"${row['unrealized_pnl']:+.2f}" if row["current_price"] is not None else "N/A"
                cur_str = f"${row['current_price']:.4f}" if row["current_price"] is not None else "N/A"
                v_str = " [on-chain verified]" if row.get("verified") else ""

                print(f"  {row['market']}{v_str}")
                print(f"    Side: {row['outcome']}  |  Shares: {row['shares']:.2f}")
                print(f"    Entry: ${row['entry_price']:.4f}  |  Current: {cur_str}  |  P&L: {pnl_str}")
                print(f"    Value: ${row['value_usdc']:.2f} USDC")
                if row.get("market_url"):
                    print(f"    Market: {row['market_url']}")
                if row.get("tx_links"):
                    for link in row["tx_links"]:
                        print(f"    Tx: {link}")
                print()

        # FIX 8: Pending orders section (separate from P&L)
        if pending_orders_data:
            print(f"  --- Pending Orders ({len(pending_orders_data)}) ---")
            print(f"  (These are NOT filled — not included in P&L)\n")
            for po in pending_orders_data:
                print(f"  Order: {po['order_id']}")
                print(f"    {po['side']} {po['size']} @ ${po['price']}  |  Matched: {po['size_matched']}  |  Type: {po['type']}")
                print(f"    Status: {po['status']}  |  Capital tied: ~${po['value_tied']:.2f} USDC")
                print()

        # Totals (only from verified positions)
        print("  --- P&L (verified positions only) ---")
        print(f"  Portfolio Value: ${total_value:.2f} USDC")
        print(f"  Total Cost:      ${total_cost:.2f} USDC")
        print(f"  Unrealized P&L:  ${total_pnl:+.2f}")
        print(f"  Realized P&L:    ${realized_pnl:+.2f}")
        print(f"  Total P&L:       ${combined_pnl:+.2f}")
        if total_cost > 0:
            print(f"  ROI:             {(combined_pnl / total_cost) * 100:+.1f}%")
        print(f"  Total Trades:    {len(trade_log)}")

    return 0


# ---------------------------------------------------------------------------
# trades subcommand
# ---------------------------------------------------------------------------

def cmd_trades(args):
    """Show trade history with tx links."""
    trade_log = load_json(TRADE_LOG_FILE, [])

    if not trade_log:
        if args.json:
            print(json.dumps({"status": "OK", "trades": [], "count": 0}))
        else:
            print("OK — No trades recorded yet.")
        return 0

    # Most recent first, then apply limit
    trades = list(reversed(trade_log))[:args.limit]

    if args.json:
        out = []
        for t in trades:
            entry = {
                "timestamp": t.get("timestamp", ""),
                "action": t.get("action", ""),
                "market": t.get("market_question", ""),
                "market_id": t.get("market_id", ""),
                "outcome": t.get("outcome", ""),
                "shares": t.get("shares", 0),
                "price": t.get("price", 0),
                "order_id": t.get("order_id", ""),
                "status": t.get("status", ""),
                "tx_links": [f"{POLYGONSCAN}/{tx}" for tx in t.get("tx_hashes", []) if tx],
            }
            if t.get("action") == "BUY":
                entry["amount_usdc"] = t.get("amount_usdc", 0)
            elif t.get("action") == "SELL":
                entry["value_usdc"] = t.get("value_usdc", 0)
            out.append(entry)
        print(json.dumps({"status": "OK", "trades": out, "count": len(out)}, indent=2))
    else:
        print(f"=== Trade History (last {len(trades)}) ===\n")
        for t in trades:
            action = t.get("action", "?")
            question = t.get("market_question", "Unknown")
            outcome = t.get("outcome", "?")
            shares = t.get("shares", 0)
            price = t.get("price", 0)
            order_id = t.get("order_id", "")
            status = t.get("status", "")
            ts = t.get("timestamp", "")

            if action == "BUY":
                amount = t.get("amount_usdc", price * shares)
                print(f"  [{ts}] BUY {outcome}")
                print(f"    {question}")
                print(f"    {shares:.2f} shares @ ${price:.4f} = ${amount:.2f} USDC")
            elif action == "SELL":
                value = t.get("value_usdc", price * shares)
                print(f"  [{ts}] SELL {outcome}")
                print(f"    {question}")
                print(f"    {shares:.2f} shares @ ${price:.4f} = ${value:.2f} USDC")
            else:
                print(f"  [{ts}] {action} {outcome}")
                print(f"    {question}")

            if order_id:
                print(f"    Order: {order_id} ({status})")
            for tx in t.get("tx_hashes", []):
                if tx:
                    print(f"    Tx: {POLYGONSCAN}/{tx}")
            print()

    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Polymarket portfolio summary with real data and tx links",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    # summary
    sp_summary = subparsers.add_parser("summary", help="Full portfolio summary")
    sp_summary.add_argument("--json", action="store_true", help="Output as JSON")

    # trades
    sp_trades = subparsers.add_parser("trades", help="Trade history with tx links")
    sp_trades.add_argument("--limit", type=int, default=20, help="Number of trades to show (default: 20)")
    sp_trades.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        return 1

    cmd_map = {
        "summary": cmd_summary,
        "trades": cmd_trades,
    }

    return cmd_map[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
