#!/usr/bin/env python3
"""Solana balance checking: SOL, tokens, prices via DexScreener."""

import argparse
import json
import os
import sys

try:
    import httpx
except ImportError:
    print(json.dumps({"error": "Missing httpx. Run: pip install httpx"}), file=sys.stderr)
    sys.exit(1)

DEXSCREENER_BASE = "https://api.dexscreener.com"

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
    lamports = resp.json().get("result", {}).get("value", 0)
    return lamports / 1e9

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
                "raw_amount": amount["amount"],
            })
    return tokens

def get_token_price(mint: str) -> dict | None:
    try:
        resp = httpx.get(f"{DEXSCREENER_BASE}/latest/dex/tokens/{mint}", timeout=10)
        if resp.status_code != 200:
            return None
        pairs = resp.json().get("pairs", [])
        # Filter for Solana pairs, pick highest liquidity
        sol_pairs = [p for p in pairs if p.get("chainId") == "solana"]
        if not sol_pairs:
            return None
        best = max(sol_pairs, key=lambda p: (p.get("liquidity", {}).get("usd") or 0))
        return {
            "price_usd": best.get("priceUsd"),
            "price_change_24h": best.get("priceChange", {}).get("h24"),
            "volume_24h": best.get("volume", {}).get("h24"),
            "liquidity_usd": best.get("liquidity", {}).get("usd"),
            "symbol": best.get("baseToken", {}).get("symbol", "???"),
            "name": best.get("baseToken", {}).get("name", "Unknown"),
        }
    except Exception:
        return None

def cmd_check(args):
    """Full balance check: SOL + tokens with prices."""
    env = load_env()
    if not env.get("SOLANA_WALLET_ADDRESS"):
        print(json.dumps({"error": "No wallet configured"}))
        sys.exit(1)

    rpc_url = env.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    address = env["SOLANA_WALLET_ADDRESS"]

    sol_balance = get_sol_balance(rpc_url, address)
    tokens = get_token_accounts(rpc_url, address)

    # Enrich tokens with price data (top 10 only to avoid rate limits)
    enriched = []
    for token in tokens[:10]:
        price_data = get_token_price(token["mint"])
        entry = {**token}
        if price_data:
            entry.update(price_data)
            if price_data.get("price_usd"):
                entry["value_usd"] = float(price_data["price_usd"]) * token["balance"]
        enriched.append(entry)

    # Sort by USD value
    enriched.sort(key=lambda t: t.get("value_usd", 0), reverse=True)

    result = {
        "address": address,
        "sol": round(sol_balance, 6),
        "tokens": enriched,
    }
    print(json.dumps(result))

def cmd_sol(args):
    """SOL balance only."""
    env = load_env()
    if not env.get("SOLANA_WALLET_ADDRESS"):
        print(json.dumps({"error": "No wallet configured"}))
        sys.exit(1)

    rpc_url = env.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    sol = get_sol_balance(rpc_url, env["SOLANA_WALLET_ADDRESS"])
    print(json.dumps({"sol": round(sol, 6), "address": env["SOLANA_WALLET_ADDRESS"]}))

def cmd_tokens(args):
    """Token balances only."""
    env = load_env()
    if not env.get("SOLANA_WALLET_ADDRESS"):
        print(json.dumps({"error": "No wallet configured"}))
        sys.exit(1)

    rpc_url = env.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    tokens = get_token_accounts(rpc_url, env["SOLANA_WALLET_ADDRESS"])
    print(json.dumps({"tokens": tokens}))

def cmd_price(args):
    """Get token price from DexScreener."""
    data = get_token_price(args.mint)
    if data:
        print(json.dumps(data))
    else:
        print(json.dumps({"error": f"No price data for {args.mint}"}))
        sys.exit(1)

def cmd_search(args):
    """Search for a token by name/symbol."""
    try:
        resp = httpx.get(f"{DEXSCREENER_BASE}/latest/dex/search", params={"q": args.query}, timeout=10)
        pairs = resp.json().get("pairs", [])
        sol_pairs = [p for p in pairs if p.get("chainId") == "solana"][:10]
        results = []
        for p in sol_pairs:
            results.append({
                "name": p.get("baseToken", {}).get("name"),
                "symbol": p.get("baseToken", {}).get("symbol"),
                "mint": p.get("baseToken", {}).get("address"),
                "price_usd": p.get("priceUsd"),
                "volume_24h": p.get("volume", {}).get("h24"),
                "liquidity_usd": p.get("liquidity", {}).get("usd"),
            })
        print(json.dumps({"results": results}))
    except Exception as e:
        print(json.dumps({"error": str(e)[:200]}))
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Solana balance & price checks")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("check").add_argument("--json", action="store_true")
    sub.add_parser("sol").add_argument("--json", action="store_true")
    sub.add_parser("tokens").add_argument("--json", action="store_true")

    p = sub.add_parser("price")
    p.add_argument("--mint", required=True)
    p.add_argument("--json", action="store_true")

    s = sub.add_parser("search")
    s.add_argument("--query", required=True)
    s.add_argument("--json", action="store_true")

    args = parser.parse_args()
    cmds = {"check": cmd_check, "sol": cmd_sol, "tokens": cmd_tokens, "price": cmd_price, "search": cmd_search}
    if args.command in cmds:
        cmds[args.command](args)
    else:
        parser.print_help()
        sys.exit(1)
