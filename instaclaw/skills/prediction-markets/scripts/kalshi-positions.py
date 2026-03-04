#!/usr/bin/env python3
"""
kalshi-positions.py — Query positions, trade history, and P&L from Kalshi API.

Usage:
  python3 ~/scripts/kalshi-positions.py list [--json]
  python3 ~/scripts/kalshi-positions.py history [--limit 20] [--json]
  python3 ~/scripts/kalshi-positions.py pnl [--json]

Exit codes:
  0 = success (OK)
  1 = error (FAIL)
"""

import argparse
import json
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PREDICTION_DIR = Path.home() / ".openclaw" / "prediction-markets"
CREDS_FILE = PREDICTION_DIR / "kalshi-creds.json"
TRADE_LOG_FILE = PREDICTION_DIR / "kalshi-trade-log.json"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_json(path, default=None):
    if not path.exists():
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return default


def output(msg, json_mode=False, data=None):
    if json_mode and data is not None:
        print(json.dumps(data, indent=2))
    else:
        print(msg)


def _sign_request(api_key_id, private_key_pem, method, path):
    import base64, time
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    timestamp = str(int(time.time() * 1000))
    message = (timestamp + method.upper() + path).encode("utf-8")
    private_key = serialization.load_pem_private_key(
        private_key_pem.encode("utf-8") if isinstance(private_key_pem, str) else private_key_pem,
        password=None,
    )
    signature = private_key.sign(
        message,
        padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH),
        hashes.SHA256(),
    )
    return {
        "KALSHI-ACCESS-KEY": api_key_id,
        "KALSHI-ACCESS-TIMESTAMP": timestamp,
        "KALSHI-ACCESS-SIGNATURE": base64.b64encode(signature).decode("utf-8"),
    }


def kalshi_request(creds, method, endpoint):
    import urllib.request, urllib.error
    base = "https://trading-api.kalshi.com/trade-api/v2"
    path = f"/trade-api/v2{endpoint.split('?')[0]}"
    url = f"{base}{endpoint}"

    headers = _sign_request(creds["api_key_id"], creds["private_key_pem"], method, path)
    headers["Accept"] = "application/json"

    req = urllib.request.Request(url, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode()), None
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        return None, f"HTTP {e.code}: {body_text[:300]}"
    except Exception as e:
        return None, str(e)


def load_creds():
    c = load_json(CREDS_FILE)
    if not c or not c.get("api_key_id") or not c.get("private_key_pem"):
        return None
    return c


# ---------------------------------------------------------------------------
# list subcommand
# ---------------------------------------------------------------------------

def cmd_list(args):
    creds = load_creds()
    if not creds:
        output("FAIL — Kalshi not configured. Run: kalshi-setup.py setup", args.json,
               {"status": "FAIL", "error": "not_configured"})
        return 1

    resp, err = kalshi_request(creds, "GET", "/portfolio/positions?limit=200")
    if err:
        output(f"FAIL — {err}", args.json, {"status": "FAIL", "error": err})
        return 1

    market_positions = resp.get("market_positions", [])
    event_positions = resp.get("event_positions", [])

    if args.json:
        print(json.dumps({
            "status": "OK",
            "market_positions": market_positions,
            "event_positions": event_positions,
            "count": len(market_positions),
        }, indent=2))
    else:
        if not market_positions and not event_positions:
            print("OK — No open positions")
            return 0

        if market_positions:
            print(f"=== Positions ({len(market_positions)}) ===\n")
            for p in market_positions:
                ticker = p.get("ticker", "?")
                position = p.get("position", 0)
                exposure = p.get("market_exposure", 0)
                realized = p.get("realized_pnl", 0)
                fees = p.get("fees_paid", 0)
                total_traded = p.get("total_traded", 0)
                print(f"  {ticker}")
                print(f"    Position: {position} contracts")
                print(f"    Exposure: ${exposure / 100:.2f}")
                print(f"    Realized P&L: ${realized / 100:.2f}")
                print(f"    Fees: ${fees / 100:.2f}")
                print(f"    Total Traded: {total_traded}")
                print()

        if event_positions:
            print(f"=== Event Positions ({len(event_positions)}) ===\n")
            for ep in event_positions:
                ticker = ep.get("event_ticker", "?")
                exposure = ep.get("event_exposure", 0)
                realized = ep.get("realized_pnl", 0)
                print(f"  {ticker}  exposure=${exposure / 100:.2f}  realized=${realized / 100:.2f}")
    return 0


# ---------------------------------------------------------------------------
# history subcommand
# ---------------------------------------------------------------------------

def cmd_history(args):
    creds = load_creds()
    if not creds:
        output("FAIL — Kalshi not configured", args.json, {"status": "FAIL", "error": "not_configured"})
        return 1

    resp, err = kalshi_request(creds, "GET", f"/portfolio/orders?status=closed&limit={args.limit}")
    if err:
        output(f"FAIL — {err}", args.json, {"status": "FAIL", "error": err})
        return 1

    orders = resp.get("orders", [])
    if args.json:
        print(json.dumps({"status": "OK", "trades": orders, "count": len(orders)}, indent=2))
    else:
        if not orders:
            print("OK — No trade history")
            return 0
        print(f"OK — {len(orders)} recent trade(s):\n")
        for o in orders:
            oid = o.get("order_id", "?")[:12]
            ticker = o.get("ticker", "?")
            action = o.get("action", "?")
            side = o.get("side", "?")
            count = o.get("count", "?")
            price = o.get("yes_price", o.get("no_price", "?"))
            status = o.get("status", "?")
            created = o.get("created_time", "")
            print(f"  [{created[:19]}] {action} {side} {ticker}  {count} @ {price}c  {status}  id={oid}...")
    return 0


# ---------------------------------------------------------------------------
# pnl subcommand
# ---------------------------------------------------------------------------

def cmd_pnl(args):
    creds = load_creds()
    if not creds:
        output("FAIL — Kalshi not configured", args.json, {"status": "FAIL", "error": "not_configured"})
        return 1

    # Get balance
    bal_resp, bal_err = kalshi_request(creds, "GET", "/portfolio/balance")
    balance_usd = 0.0
    portfolio_usd = 0.0
    if not bal_err:
        balance_usd = bal_resp.get("balance", 0) / 100
        portfolio_usd = bal_resp.get("portfolio_value", 0) / 100

    # Get positions for realized P&L
    pos_resp, pos_err = kalshi_request(creds, "GET", "/portfolio/positions?limit=200")
    realized_pnl = 0.0
    total_fees = 0.0
    open_positions = 0
    if not pos_err:
        for p in pos_resp.get("market_positions", []):
            realized_pnl += p.get("realized_pnl", 0) / 100
            total_fees += p.get("fees_paid", 0) / 100
            if p.get("position", 0) != 0:
                open_positions += 1

    # Get trade count from local log
    trade_log = load_json(TRADE_LOG_FILE, [])

    result = {
        "status": "OK",
        "balance_usd": balance_usd,
        "portfolio_value_usd": portfolio_usd,
        "realized_pnl": round(realized_pnl, 2),
        "total_fees": round(total_fees, 2),
        "open_positions": open_positions,
        "total_trades": len(trade_log),
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("=== Kalshi P&L ===\n")
        print(f"  Balance:        ${balance_usd:.2f}")
        print(f"  Portfolio:      ${portfolio_usd:.2f}")
        print(f"  Realized P&L:   ${realized_pnl:+.2f}")
        print(f"  Total Fees:     ${total_fees:.2f}")
        print(f"  Open Positions: {open_positions}")
        print(f"  Total Trades:   {len(trade_log)}")
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Kalshi position tracking and P&L",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    sp_list = subparsers.add_parser("list", help="Show current positions")
    sp_list.add_argument("--json", action="store_true")

    sp_hist = subparsers.add_parser("history", help="Show trade history")
    sp_hist.add_argument("--limit", type=int, default=20)
    sp_hist.add_argument("--json", action="store_true")

    sp_pnl = subparsers.add_parser("pnl", help="Portfolio P&L summary")
    sp_pnl.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        return 1

    cmd_map = {"list": cmd_list, "history": cmd_history, "pnl": cmd_pnl}
    return cmd_map[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
