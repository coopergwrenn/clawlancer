#!/usr/bin/env python3
"""Portfolio tracking, P&L, and trade history for Solana DeFi."""

import argparse
import json
import os
import sys
from datetime import datetime

try:
    import httpx
except ImportError:
    print(json.dumps({"error": "Missing httpx. Run: pip install httpx"}), file=sys.stderr)
    sys.exit(1)

DEXSCREENER_BASE = "https://api.dexscreener.com"
TRADE_LOG = os.path.expanduser("~/.openclaw/solana-defi/trades.json")
LOSS_TRACKER = os.path.expanduser("~/.openclaw/solana-defi/daily-losses.json")

def load_env():
    env = {}
    env_path = os.path.expanduser("~/.openclaw/.env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, _, v = line.partition("=")
                    env[k.strip()] = v.strip()
    return env

def get_sol_balance(rpc_url: str, address: str) -> float:
    resp = httpx.post(rpc_url, json={
        "jsonrpc": "2.0", "id": 1,
        "method": "getBalance",
        "params": [address]
    }, timeout=10)
    return resp.json().get("result", {}).get("value", 0) / 1e9

def get_token_accounts(rpc_url: str, address: str) -> list:
    resp = httpx.post(rpc_url, json={
        "jsonrpc": "2.0", "id": 1,
        "method": "getTokenAccountsByOwner",
        "params": [
            address,
            {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
            {"encoding": "jsonParsed"}
        ]
    }, timeout=15)
    accounts = resp.json().get("result", {}).get("value", [])
    tokens = []
    for acct in accounts:
        info = acct["account"]["data"]["parsed"]["info"]
        amount = info["tokenAmount"]
        if float(amount.get("uiAmount") or 0) > 0:
            tokens.append({
                "mint": info["mint"],
                "balance": amount["uiAmount"],
                "decimals": amount["decimals"],
            })
    return tokens

def get_token_price(mint: str):
    try:
        resp = httpx.get(f"{DEXSCREENER_BASE}/latest/dex/tokens/{mint}", timeout=10)
        pairs = resp.json().get("pairs", [])
        sol_pairs = [p for p in pairs if p.get("chainId") == "solana"]
        if not sol_pairs:
            return None
        best = max(sol_pairs, key=lambda p: (p.get("liquidity", {}).get("usd") or 0))
        return {
            "price_usd": best.get("priceUsd"),
            "symbol": best.get("baseToken", {}).get("symbol", "???"),
            "name": best.get("baseToken", {}).get("name", "Unknown"),
            "change_24h": best.get("priceChange", {}).get("h24"),
        }
    except Exception:
        return None

def load_trades() -> list:
    try:
        with open(TRADE_LOG) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []

def cmd_summary(args):
    """Portfolio summary with current values."""
    env = load_env()
    if not env.get("SOLANA_WALLET_ADDRESS"):
        print(json.dumps({"error": "No wallet configured"}))
        sys.exit(1)

    rpc_url = env.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    address = env["SOLANA_WALLET_ADDRESS"]

    sol_balance = get_sol_balance(rpc_url, address)
    tokens = get_token_accounts(rpc_url, address)

    # Get SOL price
    sol_price_data = get_token_price("So11111111111111111111111111111111111111112")
    sol_price_usd = float(sol_price_data["price_usd"]) if sol_price_data and sol_price_data.get("price_usd") else 0

    total_usd = sol_balance * sol_price_usd
    positions = []

    for token in tokens[:10]:
        price_data = get_token_price(token["mint"])
        entry = {
            "mint": token["mint"],
            "balance": token["balance"],
        }
        if price_data:
            entry["symbol"] = price_data.get("symbol", "???")
            entry["name"] = price_data.get("name", "Unknown")
            entry["change_24h"] = price_data.get("change_24h")
            if price_data.get("price_usd"):
                value = float(price_data["price_usd"]) * token["balance"]
                entry["value_usd"] = round(value, 2)
                total_usd += value
        positions.append(entry)

    positions.sort(key=lambda p: p.get("value_usd", 0), reverse=True)

    result = {
        "address": address,
        "sol_balance": round(sol_balance, 6),
        "sol_value_usd": round(sol_balance * sol_price_usd, 2),
        "positions": positions,
        "total_value_usd": round(total_usd, 2),
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }
    print(json.dumps(result))

def cmd_detail(args):
    """Detailed info on a specific position."""
    env = load_env()
    if not env.get("SOLANA_WALLET_ADDRESS"):
        print(json.dumps({"error": "No wallet configured"}))
        sys.exit(1)

    rpc_url = env.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    address = env["SOLANA_WALLET_ADDRESS"]

    # Get token balance
    resp = httpx.post(rpc_url, json={
        "jsonrpc": "2.0", "id": 1,
        "method": "getTokenAccountsByOwner",
        "params": [address, {"mint": args.mint}, {"encoding": "jsonParsed"}]
    }, timeout=10)
    accounts = resp.json().get("result", {}).get("value", [])

    balance = 0
    if accounts:
        balance = accounts[0]["account"]["data"]["parsed"]["info"]["tokenAmount"]["uiAmount"]

    price_data = get_token_price(args.mint) or {}

    # Look up trade history for this mint
    trades = [t for t in load_trades() if t.get("mint") == args.mint]

    result = {
        "mint": args.mint,
        "balance": balance,
        **price_data,
        "trades": trades[-10:],  # last 10 trades
    }
    print(json.dumps(result))

def cmd_pnl(args):
    """Calculate P&L from trade history."""
    trades = load_trades()
    if not trades:
        print(json.dumps({"error": "No trade history found", "pnl_sol": 0}))
        return

    total_spent_sol = sum(t.get("sol_spent", 0) for t in trades if t.get("action") == "BUY")
    total_received_sol = sum(t.get("sol_received", 0) for t in trades if t.get("action") == "SELL")

    from datetime import date
    daily_losses = 0
    try:
        with open(LOSS_TRACKER) as f:
            data = json.load(f)
        if data.get("date") == str(date.today()):
            daily_losses = data.get("total_loss_sol", 0)
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    result = {
        "total_trades": len(trades),
        "total_buys": sum(1 for t in trades if t.get("action") == "BUY"),
        "total_sells": sum(1 for t in trades if t.get("action") == "SELL"),
        "total_spent_sol": round(total_spent_sol, 6),
        "total_received_sol": round(total_received_sol, 6),
        "realized_pnl_sol": round(total_received_sol - total_spent_sol, 6),
        "daily_losses_sol": round(daily_losses, 6),
    }
    print(json.dumps(result))

def cmd_history(args):
    """Show trade history."""
    trades = load_trades()
    limit = args.limit or 20
    recent = trades[-limit:]
    print(json.dumps({"trades": recent, "total": len(trades)}))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Solana portfolio & positions")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("summary").add_argument("--json", action="store_true")

    d = sub.add_parser("detail")
    d.add_argument("--mint", required=True)
    d.add_argument("--json", action="store_true")

    sub.add_parser("pnl").add_argument("--json", action="store_true")

    h = sub.add_parser("history")
    h.add_argument("--limit", type=int, default=20)
    h.add_argument("--json", action="store_true")

    args = parser.parse_args()
    cmds = {"summary": cmd_summary, "detail": cmd_detail, "pnl": cmd_pnl, "history": cmd_history}
    if args.command in cmds:
        cmds[args.command](args)
    else:
        parser.print_help()
        sys.exit(1)
