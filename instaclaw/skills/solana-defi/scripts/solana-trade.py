#!/usr/bin/env python3
"""Solana token trading via Jupiter V6 API with safety rails."""

import argparse
import json
import os
import sys
import time

try:
    import httpx
    import base58
    from solders.keypair import Keypair
    from solders.transaction import VersionedTransaction
except ImportError:
    print(json.dumps({"error": "Missing deps. Run: pip install httpx solders base58"}), file=sys.stderr)
    sys.exit(1)

JUPITER_BASE = "https://quote-api.jup.ag/v6"
SOL_MINT = "So11111111111111111111111111111111111111112"
LOSS_TRACKER = os.path.expanduser("~/.openclaw/solana-defi/daily-losses.json")
CONFIG_PATH = os.path.expanduser("~/.openclaw/solana-defi/config.json")

MAX_RETRIES = 3
BACKOFF = [5, 15, 45]

TRANSIENT_ERRORS = ["rate limit", "429", "timeout", "blockhash not found", "blockhash expired", "connection refused"]
PERMANENT_ERRORS = ["insufficient funds", "insufficient balance", "invalid mint", "account not found", "signature verification", "program failed"]

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

def load_config():
    defaults = {"max_trade_sol": 0.1, "daily_loss_limit_sol": 0.5, "auto_trade": False}
    try:
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
        defaults.update(cfg)
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return defaults

def get_daily_losses():
    from datetime import date
    try:
        with open(LOSS_TRACKER) as f:
            data = json.load(f)
        if data.get("date") != str(date.today()):
            return 0.0
        return data.get("total_loss_sol", 0.0)
    except (FileNotFoundError, json.JSONDecodeError):
        return 0.0

def classify_error(msg):
    lower = msg.lower()
    for p in PERMANENT_ERRORS:
        if p in lower:
            return "permanent"
    for p in TRANSIENT_ERRORS:
        if p in lower:
            return "transient"
    return "unknown"

def cmd_quote(args):
    """Get a swap quote from Jupiter."""
    env = load_env()
    input_mint = SOL_MINT if args.input.upper() == "SOL" else args.input
    output_mint = SOL_MINT if args.output.upper() == "SOL" else args.output
    amount_lamports = int(float(args.amount) * 1e9) if input_mint == SOL_MINT else int(float(args.amount) * 1e6)
    slippage = args.slippage or 100  # 1% default

    resp = httpx.get(f"{JUPITER_BASE}/quote", params={
        "inputMint": input_mint,
        "outputMint": output_mint,
        "amount": str(amount_lamports),
        "slippageBps": slippage,
    }, timeout=15)

    if resp.status_code != 200:
        print(json.dumps({"error": f"Quote failed: {resp.text[:200]}"}))
        sys.exit(1)

    quote = resp.json()
    out_amount = int(quote.get("outAmount", 0))
    price_impact = quote.get("priceImpactPct", "0")

    result = {
        "input_mint": input_mint,
        "output_mint": output_mint,
        "input_amount": args.amount,
        "output_amount": out_amount / 1e9 if output_mint == SOL_MINT else out_amount / 1e6,
        "slippage_bps": slippage,
        "price_impact_pct": price_impact,
    }
    print(json.dumps(result))

def cmd_buy(args):
    """Buy a token with SOL via Jupiter."""
    env = load_env()
    config = load_config()

    if not env.get("SOLANA_PRIVATE_KEY"):
        print(json.dumps({"error": "No wallet configured. Run setup-solana-wallet.py generate"}))
        sys.exit(1)

    amount_sol = float(args.amount)

    # Safety checks
    if amount_sol > config["max_trade_sol"]:
        print(json.dumps({"error": f"Amount {amount_sol} SOL exceeds max trade size {config['max_trade_sol']} SOL"}))
        sys.exit(1)

    daily_losses = get_daily_losses()
    if daily_losses + amount_sol > config["daily_loss_limit_sol"]:
        print(json.dumps({"error": f"Would exceed daily loss limit. Current losses: {daily_losses} SOL, limit: {config['daily_loss_limit_sol']} SOL"}))
        sys.exit(1)

    rpc_url = env.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    wallet_address = env["SOLANA_WALLET_ADDRESS"]
    privkey_bytes = base58.b58decode(env["SOLANA_PRIVATE_KEY"])
    keypair = Keypair.from_bytes(privkey_bytes)

    amount_lamports = int(amount_sol * 1e9)
    slippage = args.slippage or 100

    # Check balance first
    bal_resp = httpx.post(rpc_url, json={
        "jsonrpc": "2.0", "id": 1,
        "method": "getBalance",
        "params": [wallet_address]
    }, timeout=10)
    balance_lamports = bal_resp.json().get("result", {}).get("value", 0)
    if balance_lamports < amount_lamports + 10_000_000:  # reserve 0.01 SOL for fees
        print(json.dumps({"error": f"Insufficient balance: {balance_lamports / 1e9:.4f} SOL (need {amount_sol + 0.01} SOL)"}))
        sys.exit(1)

    for attempt in range(MAX_RETRIES):
        try:
            # Get quote
            quote_resp = httpx.get(f"{JUPITER_BASE}/quote", params={
                "inputMint": SOL_MINT,
                "outputMint": args.mint,
                "amount": str(amount_lamports),
                "slippageBps": slippage,
            }, timeout=15)
            if quote_resp.status_code != 200:
                raise Exception(f"Quote failed: {quote_resp.text[:200]}")
            quote = quote_resp.json()

            # Build swap tx
            swap_resp = httpx.post(f"{JUPITER_BASE}/swap", json={
                "quoteResponse": quote,
                "userPublicKey": wallet_address,
                "wrapAndUnwrapSol": True,
                "dynamicComputeUnitLimit": True,
                "prioritizationFeeLamports": "auto",
            }, timeout=15)
            if swap_resp.status_code != 200:
                raise Exception(f"Swap build failed: {swap_resp.text[:200]}")
            swap_data = swap_resp.json()

            # Sign and send
            import base64
            tx_bytes = base64.b64decode(swap_data["swapTransaction"])
            tx = VersionedTransaction.from_bytes(tx_bytes)
            signed_tx = VersionedTransaction(tx.message, [keypair])
            signed_bytes = base64.b64encode(bytes(signed_tx)).decode("utf-8")

            send_resp = httpx.post(rpc_url, json={
                "jsonrpc": "2.0", "id": 1,
                "method": "sendTransaction",
                "params": [signed_bytes, {"encoding": "base64", "skipPreflight": False, "maxRetries": 3}]
            }, timeout=30)

            send_result = send_resp.json()
            if "error" in send_result:
                raise Exception(f"Send failed: {json.dumps(send_result['error'])[:200]}")

            signature = send_result["result"]

            # Wait for confirmation
            confirmed = False
            for _ in range(15):
                time.sleep(2)
                status_resp = httpx.post(rpc_url, json={
                    "jsonrpc": "2.0", "id": 1,
                    "method": "getSignatureStatuses",
                    "params": [[signature], {"searchTransactionHistory": True}]
                }, timeout=10)
                statuses = status_resp.json().get("result", {}).get("value", [None])
                if statuses[0] and statuses[0].get("confirmationStatus") in ("confirmed", "finalized"):
                    if statuses[0].get("err"):
                        raise Exception(f"Transaction failed on-chain: {statuses[0]['err']}")
                    confirmed = True
                    break

            out_amount = int(quote.get("outAmount", 0))
            print(json.dumps({
                "status": "success",
                "action": "BUY",
                "input_sol": amount_sol,
                "output_amount": out_amount,
                "output_mint": args.mint,
                "signature": signature,
                "confirmed": confirmed,
            }))
            return

        except Exception as e:
            err_class = classify_error(str(e))
            if err_class == "permanent" or attempt == MAX_RETRIES - 1:
                print(json.dumps({
                    "error": str(e)[:200],
                    "attempt": attempt + 1,
                    "max_retries": MAX_RETRIES,
                    "error_class": err_class,
                }))
                sys.exit(1)
            time.sleep(BACKOFF[attempt])

def cmd_sell(args):
    """Sell a token for SOL via Jupiter."""
    env = load_env()
    config = load_config()

    if not env.get("SOLANA_PRIVATE_KEY"):
        print(json.dumps({"error": "No wallet configured"}))
        sys.exit(1)

    rpc_url = env.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    wallet_address = env["SOLANA_WALLET_ADDRESS"]
    privkey_bytes = base58.b58decode(env["SOLANA_PRIVATE_KEY"])
    keypair = Keypair.from_bytes(privkey_bytes)
    slippage = args.slippage or 100

    # Get token balance
    token_resp = httpx.post(rpc_url, json={
        "jsonrpc": "2.0", "id": 1,
        "method": "getTokenAccountsByOwner",
        "params": [
            wallet_address,
            {"mint": args.mint},
            {"encoding": "jsonParsed"}
        ]
    }, timeout=10)
    accounts = token_resp.json().get("result", {}).get("value", [])
    if not accounts:
        print(json.dumps({"error": f"No token account found for mint {args.mint}"}))
        sys.exit(1)

    token_info = accounts[0]["account"]["data"]["parsed"]["info"]
    token_amount = int(token_info["tokenAmount"]["amount"])

    if args.amount.upper() == "ALL":
        sell_amount = token_amount
    else:
        decimals = token_info["tokenAmount"]["decimals"]
        sell_amount = int(float(args.amount) * (10 ** decimals))
        if sell_amount > token_amount:
            print(json.dumps({"error": f"Insufficient token balance. Have: {token_amount}, want to sell: {sell_amount}"}))
            sys.exit(1)

    for attempt in range(MAX_RETRIES):
        try:
            quote_resp = httpx.get(f"{JUPITER_BASE}/quote", params={
                "inputMint": args.mint,
                "outputMint": SOL_MINT,
                "amount": str(sell_amount),
                "slippageBps": slippage,
            }, timeout=15)
            if quote_resp.status_code != 200:
                raise Exception(f"Quote failed: {quote_resp.text[:200]}")
            quote = quote_resp.json()

            swap_resp = httpx.post(f"{JUPITER_BASE}/swap", json={
                "quoteResponse": quote,
                "userPublicKey": wallet_address,
                "wrapAndUnwrapSol": True,
                "dynamicComputeUnitLimit": True,
                "prioritizationFeeLamports": "auto",
            }, timeout=15)
            if swap_resp.status_code != 200:
                raise Exception(f"Swap build failed: {swap_resp.text[:200]}")
            swap_data = swap_resp.json()

            import base64
            tx_bytes = base64.b64decode(swap_data["swapTransaction"])
            tx = VersionedTransaction.from_bytes(tx_bytes)
            signed_tx = VersionedTransaction(tx.message, [keypair])
            signed_bytes = base64.b64encode(bytes(signed_tx)).decode("utf-8")

            send_resp = httpx.post(rpc_url, json={
                "jsonrpc": "2.0", "id": 1,
                "method": "sendTransaction",
                "params": [signed_bytes, {"encoding": "base64", "skipPreflight": False, "maxRetries": 3}]
            }, timeout=30)
            send_result = send_resp.json()
            if "error" in send_result:
                raise Exception(f"Send failed: {json.dumps(send_result['error'])[:200]}")

            signature = send_result["result"]
            out_amount = int(quote.get("outAmount", 0))

            print(json.dumps({
                "status": "success",
                "action": "SELL",
                "input_amount": sell_amount,
                "input_mint": args.mint,
                "output_sol": out_amount / 1e9,
                "signature": signature,
            }))
            return

        except Exception as e:
            err_class = classify_error(str(e))
            if err_class == "permanent" or attempt == MAX_RETRIES - 1:
                print(json.dumps({"error": str(e)[:200], "attempt": attempt + 1, "error_class": err_class}))
                sys.exit(1)
            time.sleep(BACKOFF[attempt])

def cmd_limits(args):
    """Show current trading limits."""
    config = load_config()
    print(json.dumps(config))

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Solana trading via Jupiter V6")
    sub = parser.add_subparsers(dest="command")

    q = sub.add_parser("quote")
    q.add_argument("--input", required=True)
    q.add_argument("--output", required=True)
    q.add_argument("--amount", required=True)
    q.add_argument("--slippage", type=int)
    q.add_argument("--json", action="store_true")

    b = sub.add_parser("buy")
    b.add_argument("--mint", required=True)
    b.add_argument("--amount", required=True)
    b.add_argument("--slippage", type=int)
    b.add_argument("--json", action="store_true")

    s = sub.add_parser("sell")
    s.add_argument("--mint", required=True)
    s.add_argument("--amount", required=True)
    s.add_argument("--slippage", type=int)
    s.add_argument("--json", action="store_true")

    l = sub.add_parser("limits")
    l.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.command == "quote":
        cmd_quote(args)
    elif args.command == "buy":
        cmd_buy(args)
    elif args.command == "sell":
        cmd_sell(args)
    elif args.command == "limits":
        cmd_limits(args)
    else:
        parser.print_help()
        sys.exit(1)
