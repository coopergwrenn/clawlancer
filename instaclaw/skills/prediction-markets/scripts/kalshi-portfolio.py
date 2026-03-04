#!/usr/bin/env python3
"""
kalshi-portfolio.py — Unified portfolio view for Kalshi account.

Usage:
  python3 ~/scripts/kalshi-portfolio.py summary [--json]
  python3 ~/scripts/kalshi-portfolio.py detail [--json]

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
    path = f"/trade-api/v2{endpoint}"
    url = f"{base}{endpoint}"

    headers = _sign_request(creds["api_key_id"], creds["private_key_pem"], method, path)
    headers["Accept"] = "application/json"

    req = urllib.request.Request(url, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode()), None
    except Exception as e:
        return None, str(e)


def load_creds():
    c = load_json(CREDS_FILE)
    if not c or not c.get("api_key_id") or not c.get("private_key_pem"):
        return None
    return c


# ---------------------------------------------------------------------------
# summary subcommand
# ---------------------------------------------------------------------------

def cmd_summary(args):
    creds = load_creds()
    if not creds:
        if args.json:
            print(json.dumps({"status": "FAIL", "error": "not_configured"}))
        else:
            print("FAIL — Kalshi not configured. Run: python3 ~/scripts/kalshi-setup.py setup")
        return 1

    # Balance
    bal, bal_err = kalshi_request(creds, "GET", "/portfolio/balance")
    balance_usd = bal.get("balance", 0) / 100 if bal else 0
    portfolio_usd = bal.get("portfolio_value", 0) / 100 if bal else 0

    # Positions
    pos, pos_err = kalshi_request(creds, "GET", "/portfolio/positions?limit=200")
    positions = pos.get("market_positions", []) if pos else []
    open_positions = [p for p in positions if p.get("position", 0) != 0]
    realized_pnl = sum(p.get("realized_pnl", 0) for p in positions) / 100
    total_fees = sum(p.get("fees_paid", 0) for p in positions) / 100

    # Trade count from local log
    trade_log = load_json(TRADE_LOG_FILE, [])
    wins = sum(1 for t in trade_log if t.get("status") in ("matched", "filled"))
    total = len(trade_log)
    win_rate = (wins / total * 100) if total > 0 else 0

    result = {
        "status": "OK",
        "platform": "kalshi",
        "balance_usd": balance_usd,
        "portfolio_value_usd": portfolio_usd,
        "total_value_usd": balance_usd + portfolio_usd,
        "open_positions": len(open_positions),
        "realized_pnl": round(realized_pnl, 2),
        "total_fees": round(total_fees, 2),
        "total_trades": total,
        "win_rate": round(win_rate, 1),
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("=== Kalshi Portfolio Summary ===\n")
        print(f"  Cash Balance:   ${balance_usd:.2f}")
        print(f"  Portfolio Value: ${portfolio_usd:.2f}")
        print(f"  Total Value:     ${balance_usd + portfolio_usd:.2f}")
        print(f"  Open Positions:  {len(open_positions)}")
        print(f"  Realized P&L:    ${realized_pnl:+.2f}")
        print(f"  Total Fees:      ${total_fees:.2f}")
        print(f"  Total Trades:    {total}")
        if total > 0:
            print(f"  Win Rate:        {win_rate:.0f}%")
        if bal_err:
            print(f"\n  WARN: Balance fetch error: {bal_err}")
        if pos_err:
            print(f"  WARN: Positions fetch error: {pos_err}")
    return 0


# ---------------------------------------------------------------------------
# detail subcommand
# ---------------------------------------------------------------------------

def cmd_detail(args):
    creds = load_creds()
    if not creds:
        if args.json:
            print(json.dumps({"status": "FAIL", "error": "not_configured"}))
        else:
            print("FAIL — Kalshi not configured")
        return 1

    # Balance
    bal, _ = kalshi_request(creds, "GET", "/portfolio/balance")
    balance_usd = bal.get("balance", 0) / 100 if bal else 0

    # Positions
    pos, pos_err = kalshi_request(creds, "GET", "/portfolio/positions?limit=200")
    positions = pos.get("market_positions", []) if pos else []
    open_positions = [p for p in positions if p.get("position", 0) != 0]

    # Enrich positions with market data
    enriched = []
    for p in open_positions:
        ticker = p.get("ticker", "")
        entry = dict(p)
        # Fetch market details
        market_data, _ = kalshi_request(creds, "GET", f"/markets/{ticker}")
        if market_data:
            market = market_data.get("market", market_data)
            entry["market_title"] = market.get("title", market.get("subtitle", ticker))
            entry["yes_ask"] = market.get("yes_ask_dollars") or market.get("yes_ask")
            entry["no_ask"] = market.get("no_ask_dollars") or market.get("no_ask")
            entry["status"] = market.get("status", "unknown")
            entry["expiration"] = market.get("expiration_time", market.get("close_time", ""))
        enriched.append(entry)

    if args.json:
        print(json.dumps({
            "status": "OK",
            "balance_usd": balance_usd,
            "positions": enriched,
            "count": len(enriched),
        }, indent=2))
    else:
        print("=== Kalshi Portfolio Detail ===\n")
        print(f"  Cash: ${balance_usd:.2f}\n")
        if not enriched:
            print("  No open positions.")
            return 0
        for p in enriched:
            ticker = p.get("ticker", "?")
            title = p.get("market_title", ticker)
            position = p.get("position", 0)
            exposure = p.get("market_exposure", 0) / 100
            realized = p.get("realized_pnl", 0) / 100
            fees = p.get("fees_paid", 0) / 100
            exp = p.get("expiration", "")
            yes_ask = p.get("yes_ask", "?")
            print(f"  {title}")
            print(f"    Ticker: {ticker}")
            print(f"    Position: {position} contracts")
            print(f"    Exposure: ${exposure:.2f}")
            print(f"    Current YES: {yes_ask}")
            print(f"    Realized P&L: ${realized:+.2f}  Fees: ${fees:.2f}")
            if exp:
                print(f"    Expires: {exp[:19]}")
            print()
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Kalshi portfolio dashboard",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    sp_sum = subparsers.add_parser("summary", help="Portfolio summary")
    sp_sum.add_argument("--json", action="store_true")

    sp_det = subparsers.add_parser("detail", help="Detailed position breakdown")
    sp_det.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        return 1

    cmd_map = {"summary": cmd_summary, "detail": cmd_detail}
    return cmd_map[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
