#!/usr/bin/env python3
"""
kalshi-browse.py — Browse and search Kalshi markets.

Usage:
  python3 ~/scripts/kalshi-browse.py search --query "bitcoin" [--limit 20] [--json]
  python3 ~/scripts/kalshi-browse.py trending [--limit 10] [--json]
  python3 ~/scripts/kalshi-browse.py detail --ticker KXBTC-26MAR14-B90000 [--json]
  python3 ~/scripts/kalshi-browse.py categories [--json]

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


def output(msg, json_mode=False, data=None):
    if json_mode and data is not None:
        print(json.dumps(data, indent=2))
    else:
        print(msg)


# ---------------------------------------------------------------------------
# search subcommand
# ---------------------------------------------------------------------------

def cmd_search(args):
    creds = load_creds()
    if not creds:
        output("FAIL — Kalshi not configured. Run: python3 ~/scripts/kalshi-setup.py setup", args.json,
               {"status": "FAIL", "error": "not_configured"})
        return 1

    resp, err = kalshi_request(creds, "GET", f"/markets?status=open&limit=200")
    if err:
        output(f"FAIL — {err}", args.json, {"status": "FAIL", "error": err})
        return 1

    markets = resp.get("markets", [])
    query_lower = args.query.lower()
    keywords = query_lower.split()
    matches = [m for m in markets if any(kw in m.get("title", "").lower() for kw in keywords)]
    matches = matches[:args.limit]

    if args.json:
        print(json.dumps({"status": "OK", "query": args.query, "markets": matches, "count": len(matches)}, indent=2))
    else:
        if not matches:
            print(f"OK — No markets found matching '{args.query}'")
            return 0
        print(f"=== Kalshi Markets: '{args.query}' ({len(matches)} results) ===\n")
        for m in matches:
            ticker = m.get("ticker", "?")
            title = m.get("title", "?")
            yes_ask = m.get("yes_ask", "?")
            no_ask = m.get("no_ask", "?")
            volume = m.get("volume", 0)
            close_time = m.get("close_time", m.get("expiration_time", ""))[:10]
            print(f"  {title}")
            print(f"    Ticker: {ticker}  YES: {yes_ask}c  NO: {no_ask}c  Vol: {volume}  Closes: {close_time}")
            print()
    return 0


# ---------------------------------------------------------------------------
# trending subcommand
# ---------------------------------------------------------------------------

def cmd_trending(args):
    creds = load_creds()
    if not creds:
        output("FAIL — Kalshi not configured", args.json, {"status": "FAIL", "error": "not_configured"})
        return 1

    resp, err = kalshi_request(creds, "GET", f"/markets?status=open&limit=200")
    if err:
        output(f"FAIL — {err}", args.json, {"status": "FAIL", "error": err})
        return 1

    markets = resp.get("markets", [])
    # Sort by volume descending
    markets.sort(key=lambda m: m.get("volume", 0), reverse=True)
    top = markets[:args.limit]

    if args.json:
        print(json.dumps({"status": "OK", "markets": top, "count": len(top)}, indent=2))
    else:
        if not top:
            print("OK — No open markets found")
            return 0
        print(f"=== Kalshi Trending Markets (Top {len(top)}) ===\n")
        for i, m in enumerate(top, 1):
            ticker = m.get("ticker", "?")
            title = m.get("title", "?")
            yes_ask = m.get("yes_ask", "?")
            volume = m.get("volume", 0)
            open_interest = m.get("open_interest", 0)
            print(f"  {i}. {title}")
            print(f"     Ticker: {ticker}  YES: {yes_ask}c  Vol: {volume}  OI: {open_interest}")
            print()
    return 0


# ---------------------------------------------------------------------------
# detail subcommand
# ---------------------------------------------------------------------------

def cmd_detail(args):
    creds = load_creds()
    if not creds:
        output("FAIL — Kalshi not configured", args.json, {"status": "FAIL", "error": "not_configured"})
        return 1

    resp, err = kalshi_request(creds, "GET", f"/markets/{args.ticker}")
    if err:
        output(f"FAIL — {err}", args.json, {"status": "FAIL", "error": err})
        return 1

    market = resp.get("market", resp)

    if args.json:
        print(json.dumps({"status": "OK", "market": market}, indent=2))
    else:
        title = market.get("title", "?")
        ticker = market.get("ticker", "?")
        category = market.get("category", "?")
        status = market.get("status", "?")
        yes_ask = market.get("yes_ask", "?")
        yes_bid = market.get("yes_bid", "?")
        no_ask = market.get("no_ask", "?")
        no_bid = market.get("no_bid", "?")
        last_price = market.get("last_price", "?")
        volume = market.get("volume", 0)
        open_interest = market.get("open_interest", 0)
        close_time = market.get("close_time", market.get("expiration_time", ""))
        rules = market.get("rules_primary", market.get("rules", ""))
        settlement = market.get("settlement_source_url", "")

        print(f"=== {title} ===\n")
        print(f"  Ticker:         {ticker}")
        print(f"  Category:       {category}")
        print(f"  Status:         {status}")
        print(f"  YES:            bid {yes_bid}c / ask {yes_ask}c")
        print(f"  NO:             bid {no_bid}c / ask {no_ask}c")
        print(f"  Last Price:     {last_price}c")
        print(f"  Volume:         {volume}")
        print(f"  Open Interest:  {open_interest}")
        if close_time:
            print(f"  Closes:         {close_time[:19]}")
        if rules:
            print(f"\n  Rules: {rules[:300]}")
        if settlement:
            print(f"  Settlement:     {settlement}")
    return 0


# ---------------------------------------------------------------------------
# categories subcommand
# ---------------------------------------------------------------------------

def cmd_categories(args):
    creds = load_creds()
    if not creds:
        output("FAIL — Kalshi not configured", args.json, {"status": "FAIL", "error": "not_configured"})
        return 1

    resp, err = kalshi_request(creds, "GET", "/events?status=open&limit=200")
    if err:
        output(f"FAIL — {err}", args.json, {"status": "FAIL", "error": err})
        return 1

    events = resp.get("events", [])
    cats = {}
    for e in events:
        cat = e.get("category", "uncategorized")
        cats[cat] = cats.get(cat, 0) + 1

    sorted_cats = sorted(cats.items(), key=lambda x: x[1], reverse=True)

    if args.json:
        print(json.dumps({"status": "OK", "categories": dict(sorted_cats), "total_events": len(events)}, indent=2))
    else:
        print(f"=== Kalshi Event Categories ({len(events)} open events) ===\n")
        for cat, count in sorted_cats:
            print(f"  {cat}: {count} events")
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Browse and search Kalshi markets",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    sp_search = subparsers.add_parser("search", help="Search markets by keyword")
    sp_search.add_argument("--query", required=True, help="Search query")
    sp_search.add_argument("--limit", type=int, default=20, help="Max results")
    sp_search.add_argument("--json", action="store_true")

    sp_trending = subparsers.add_parser("trending", help="Show trending markets by volume")
    sp_trending.add_argument("--limit", type=int, default=10, help="Number of markets")
    sp_trending.add_argument("--json", action="store_true")

    sp_detail = subparsers.add_parser("detail", help="Show market details")
    sp_detail.add_argument("--ticker", required=True, help="Market ticker")
    sp_detail.add_argument("--json", action="store_true")

    sp_cats = subparsers.add_parser("categories", help="List event categories")
    sp_cats.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        return 1

    cmd_map = {"search": cmd_search, "trending": cmd_trending, "detail": cmd_detail, "categories": cmd_categories}
    return cmd_map[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
