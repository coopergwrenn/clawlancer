#!/usr/bin/env python3
"""PumpPortal sniping: buy/sell on pump.fun, watch for new launches."""

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

PUMPPORTAL_BASE = "https://pumpportal.fun"
PUMPPORTAL_WS = "wss://pumpportal.fun/api/data"
CONFIG_PATH = os.path.expanduser("~/.openclaw/solana-defi/config.json")
LOSS_TRACKER = os.path.expanduser("~/.openclaw/solana-defi/daily-losses.json")

MAX_RETRIES = 3
BACKOFF = [5, 15, 45]

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
            defaults.update(json.load(f))
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
    permanent = ["insufficient funds", "invalid mint", "graduated", "account not found"]
    for p in permanent:
        if p in lower:
            return "permanent"
    return "transient"

def send_and_confirm(rpc_url, keypair, tx_bytes):
    """Sign a transaction and send it."""
    import base64 as b64
    tx = VersionedTransaction.from_bytes(tx_bytes)
    signed = VersionedTransaction(tx.message, [keypair])
    encoded = b64.b64encode(bytes(signed)).decode("utf-8")

    send_resp = httpx.post(rpc_url, json={
        "jsonrpc": "2.0", "id": 1,
        "method": "sendTransaction",
        "params": [encoded, {"encoding": "base64", "skipPreflight": False, "maxRetries": 3}]
    }, timeout=30)
    result = send_resp.json()
    if "error" in result:
        raise Exception(f"Send failed: {json.dumps(result['error'])[:200]}")

    signature = result["result"]

    # Confirm
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
                raise Exception(f"On-chain error: {statuses[0]['err']}")
            return signature
    return signature  # return anyway, might confirm later

def cmd_buy(args):
    """Buy a token on pump.fun via PumpPortal."""
    env = load_env()
    config = load_config()

    if not env.get("SOLANA_PRIVATE_KEY"):
        print(json.dumps({"error": "No wallet configured"}))
        sys.exit(1)

    amount_sol = float(args.amount)
    if amount_sol > config["max_trade_sol"]:
        print(json.dumps({"error": f"Amount {amount_sol} exceeds max trade {config['max_trade_sol']} SOL"}))
        sys.exit(1)

    daily = get_daily_losses()
    if daily + amount_sol > config["daily_loss_limit_sol"]:
        print(json.dumps({"error": f"Daily loss limit reached ({daily}/{config['daily_loss_limit_sol']} SOL)"}))
        sys.exit(1)

    rpc_url = env.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    wallet = env["SOLANA_WALLET_ADDRESS"]
    privkey = base58.b58decode(env["SOLANA_PRIVATE_KEY"])
    keypair = Keypair.from_bytes(privkey)
    slippage = args.slippage or 2500  # 25% default for pump.fun

    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.post(f"{PUMPPORTAL_BASE}/api/trade-local", json={
                "publicKey": wallet,
                "action": "buy",
                "mint": args.mint,
                "denominatedInSol": "true",
                "amount": amount_sol,
                "slippage": slippage / 100,  # PumpPortal uses percentage
                "priorityFee": 0.0005,
                "pool": "pump",
            }, timeout=15)

            if resp.status_code != 200:
                error_text = resp.text[:200]
                if "graduated" in error_text.lower():
                    print(json.dumps({"error": "Token has graduated from pump.fun. Use solana-trade.py (Jupiter) instead.", "error_class": "permanent"}))
                    sys.exit(1)
                raise Exception(f"PumpPortal error: {error_text}")

            import base64
            tx_bytes = base64.b64decode(resp.content)
            signature = send_and_confirm(rpc_url, keypair, tx_bytes)

            print(json.dumps({
                "status": "success",
                "action": "BUY",
                "platform": "pump.fun",
                "mint": args.mint,
                "amount_sol": amount_sol,
                "signature": signature,
            }))
            return

        except Exception as e:
            err_class = classify_error(str(e))
            if err_class == "permanent" or attempt == MAX_RETRIES - 1:
                print(json.dumps({"error": str(e)[:200], "attempt": attempt + 1, "error_class": err_class}))
                sys.exit(1)
            time.sleep(BACKOFF[attempt])

def cmd_sell(args):
    """Sell a token on pump.fun via PumpPortal."""
    env = load_env()
    if not env.get("SOLANA_PRIVATE_KEY"):
        print(json.dumps({"error": "No wallet configured"}))
        sys.exit(1)

    rpc_url = env.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
    wallet = env["SOLANA_WALLET_ADDRESS"]
    privkey = base58.b58decode(env["SOLANA_PRIVATE_KEY"])
    keypair = Keypair.from_bytes(privkey)
    slippage = args.slippage or 2500

    # Get token balance if selling ALL
    amount = args.amount
    if amount.upper() == "ALL":
        token_resp = httpx.post(rpc_url, json={
            "jsonrpc": "2.0", "id": 1,
            "method": "getTokenAccountsByOwner",
            "params": [wallet, {"mint": args.mint}, {"encoding": "jsonParsed"}]
        }, timeout=10)
        accounts = token_resp.json().get("result", {}).get("value", [])
        if not accounts:
            print(json.dumps({"error": "No tokens to sell"}))
            sys.exit(1)
        token_amount = accounts[0]["account"]["data"]["parsed"]["info"]["tokenAmount"]["uiAmount"]
        amount = str(token_amount)

    for attempt in range(MAX_RETRIES):
        try:
            resp = httpx.post(f"{PUMPPORTAL_BASE}/api/trade-local", json={
                "publicKey": wallet,
                "action": "sell",
                "mint": args.mint,
                "denominatedInSol": "false",
                "amount": float(amount),
                "slippage": slippage / 100,
                "priorityFee": 0.0005,
                "pool": "pump",
            }, timeout=15)

            if resp.status_code != 200:
                raise Exception(f"PumpPortal error: {resp.text[:200]}")

            import base64
            tx_bytes = base64.b64decode(resp.content)
            signature = send_and_confirm(rpc_url, keypair, tx_bytes)

            print(json.dumps({
                "status": "success",
                "action": "SELL",
                "platform": "pump.fun",
                "mint": args.mint,
                "amount": amount,
                "signature": signature,
            }))
            return

        except Exception as e:
            err_class = classify_error(str(e))
            if err_class == "permanent" or attempt == MAX_RETRIES - 1:
                print(json.dumps({"error": str(e)[:200], "attempt": attempt + 1, "error_class": err_class}))
                sys.exit(1)
            time.sleep(BACKOFF[attempt])

def cmd_watch(args):
    """Watch for new pump.fun launches via PumpPortal WebSocket.

    Outputs events as JSONL to stdout. Runs for --duration seconds (default 300).
    """
    try:
        import websockets
        import asyncio
    except ImportError:
        print(json.dumps({"error": "Missing websockets. Run: pip install websockets"}))
        sys.exit(1)

    min_sol = args.min_sol or 0
    max_age = args.max_age or 60  # seconds
    duration = args.duration or 300

    async def _watch():
        import websockets
        async with websockets.connect(PUMPPORTAL_WS) as ws:
            await ws.send(json.dumps({"method": "subscribeNewToken"}))
            start = time.time()
            seen = 0
            matched = 0

            while time.time() - start < duration:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=10)
                    data = json.loads(msg)
                    seen += 1

                    market_cap = data.get("marketCapSol", 0)
                    if market_cap >= min_sol:
                        matched += 1
                        event = {
                            "type": "new_token",
                            "mint": data.get("mint"),
                            "name": data.get("name"),
                            "symbol": data.get("symbol"),
                            "creator": data.get("traderPublicKey"),
                            "initial_buy_sol": data.get("initialBuy"),
                            "market_cap_sol": market_cap,
                        }
                        print(json.dumps(event), flush=True)
                except asyncio.TimeoutError:
                    continue
                except Exception as e:
                    print(json.dumps({"error": str(e)[:100]}), flush=True)
                    break

            print(json.dumps({"type": "summary", "seen": seen, "matched": matched, "duration_s": int(time.time() - start)}))

    asyncio.run(_watch())

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PumpPortal sniping")
    sub = parser.add_subparsers(dest="command")

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

    w = sub.add_parser("watch")
    w.add_argument("--min-sol", type=float)
    w.add_argument("--max-age", type=int)
    w.add_argument("--duration", type=int, default=300)
    w.add_argument("--json", action="store_true")

    args = parser.parse_args()
    cmds = {"buy": cmd_buy, "sell": cmd_sell, "watch": cmd_watch}
    if args.command in cmds:
        cmds[args.command](args)
    else:
        parser.print_help()
        sys.exit(1)
