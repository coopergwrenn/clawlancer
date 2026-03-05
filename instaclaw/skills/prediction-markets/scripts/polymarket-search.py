#!/usr/bin/env python3
"""
polymarket-search.py — Search and browse Polymarket markets via Gamma API.

Usage:
  python3 ~/scripts/polymarket-search.py search --query "bitcoin" [--limit 10] [--json]
  python3 ~/scripts/polymarket-search.py trending [--limit 10] [--json]
  python3 ~/scripts/polymarket-search.py detail --market-id <condition_id> [--json]

Exit codes:
  0 = success (OK)
  1 = error (FAIL)
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GAMMA_BASE = "https://gamma-api.polymarket.com"
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".openclaw", "polymarket")
CACHE_FILE = os.path.join(CACHE_DIR, "search-cache.json")
CACHE_TTL = 300  # 5 minutes
MAX_RETRIES = 3
RETRY_BACKOFF = 2  # seconds
REQUEST_TIMEOUT = 15
MAX_PAGES = 5
MAX_PAGES_DEEP = 20
PAGE_SIZE = 100

# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

def _load_cache():
    try:
        with open(CACHE_FILE) as f:
            return json.load(f)
    except (IOError, json.JSONDecodeError):
        return {}


def _save_cache(cache):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(CACHE_FILE, "w") as f:
            json.dump(cache, f)
    except IOError:
        pass


def _cache_get(url):
    cache = _load_cache()
    entry = cache.get(url)
    if entry and time.time() - entry.get("ts", 0) < CACHE_TTL:
        return entry.get("data")
    return None


def _cache_set(url, data):
    cache = _load_cache()
    # Prune expired entries
    now = time.time()
    cache = {k: v for k, v in cache.items() if now - v.get("ts", 0) < CACHE_TTL}
    cache[url] = {"ts": now, "data": data}
    _save_cache(cache)

# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def gamma_get(endpoint):
    """GET from Gamma API with retries and caching."""
    url = f"{GAMMA_BASE}{endpoint}"

    cached = _cache_get(url)
    if cached is not None:
        return cached, None

    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers={
                "Accept": "application/json",
                "User-Agent": "openclaw-polymarket-search/1.0",
            })
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                data = json.loads(resp.read().decode())
                _cache_set(url, data)
                return data, None
        except urllib.error.HTTPError as e:
            body = e.read().decode() if e.fp else ""
            last_err = f"HTTP {e.code}: {body[:300]}"
        except Exception as e:
            last_err = str(e)
        if attempt < MAX_RETRIES - 1:
            time.sleep(RETRY_BACKOFF)

    return None, last_err

# ---------------------------------------------------------------------------
# Format helpers
# ---------------------------------------------------------------------------

def _fmt_price(val):
    """Format price as percentage (0.65 → 65%)."""
    if val is None:
        return "?"
    try:
        return f"{float(val) * 100:.1f}%"
    except (ValueError, TypeError):
        return str(val)


def _fmt_volume(val):
    """Format volume with K/M suffixes."""
    if val is None:
        return "?"
    try:
        v = float(val)
        if v >= 1_000_000:
            return f"${v / 1_000_000:.1f}M"
        if v >= 1_000:
            return f"${v / 1_000:.1f}K"
        return f"${v:.0f}"
    except (ValueError, TypeError):
        return str(val)


def _market_summary(m):
    """Extract display fields from a Gamma market object."""
    return {
        "question": m.get("question", "?"),
        "condition_id": m.get("condition_id", m.get("conditionId", "?")),
        "yes_price": m.get("outcomePrices", m.get("outcome_prices", "[]")),
        "volume_24h": m.get("volume24hr", m.get("volume_num", 0)),
        "liquidity": m.get("liquidityNum", m.get("liquidity_num", 0)),
        "end_date": (m.get("endDate", m.get("end_date_iso", "")) or "")[:10],
        "active": m.get("active", True),
    }


def _parse_prices(m):
    """Parse YES/NO prices from outcome_prices JSON string or list."""
    raw = m.get("outcomePrices", m.get("outcome_prices", "[]"))
    if isinstance(raw, str):
        try:
            prices = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            prices = []
    elif isinstance(raw, list):
        prices = raw
    else:
        prices = []
    yes = float(prices[0]) if len(prices) > 0 else None
    no = float(prices[1]) if len(prices) > 1 else None
    return yes, no

# ---------------------------------------------------------------------------
# search subcommand
# ---------------------------------------------------------------------------

def _extract_markets_from_events(events_data):
    """Extract individual market objects from events response groups."""
    markets = []
    items = events_data if isinstance(events_data, list) else events_data.get("data", events_data.get("events", []))
    for event in items:
        event_markets = event.get("markets", [])
        if event_markets:
            for m in event_markets:
                markets.append(m)
        elif event.get("condition_id") or event.get("conditionId"):
            # Single-market event — treat as market directly
            markets.append(event)
    return markets


def _search_via_events(query, limit):
    """Try the /events endpoint with server-side title search. Returns (markets, error)."""
    encoded_query = urllib.request.quote(query)
    data, err = gamma_get(f"/events?closed=false&slug_size=gt0&title={encoded_query}&limit={limit}")
    if err:
        return [], err
    if not data:
        return [], None
    markets = _extract_markets_from_events(data)
    return markets[:limit], None


def _search_via_markets_pagination(query, limit, max_pages):
    """Fallback: paginate /markets with client-side keyword filtering."""
    query_lower = query.lower()
    keywords = query_lower.split()
    all_matches = []

    for page in range(max_pages):
        offset = page * PAGE_SIZE
        data, err = gamma_get(f"/markets?closed=false&limit={PAGE_SIZE}&offset={offset}")
        if err:
            if page == 0:
                return [], err
            break
        if not data:
            break

        markets = data if isinstance(data, list) else data.get("markets", data.get("data", []))
        if not markets:
            break

        for m in markets:
            searchable = " ".join([
                m.get("question", ""),
                m.get("description", ""),
                m.get("groupItemTitle", ""),
            ]).lower()
            if any(kw in searchable for kw in keywords):
                all_matches.append(m)

        if len(all_matches) >= limit:
            break

    return all_matches[:limit], None


def cmd_search(args):
    deep = getattr(args, "deep", False)
    max_pages = MAX_PAGES_DEEP if deep else MAX_PAGES

    # 1. Try events endpoint (server-side title search)
    matches, events_err = _search_via_events(args.query, args.limit)

    # 2. If events returned nothing, fall back to paginated /markets
    if not matches:
        matches, markets_err = _search_via_markets_pagination(args.query, args.limit, max_pages)
        if not matches and markets_err and not events_err:
            _fail(f"Gamma API error: {markets_err}", args.json)
            return 1

    search_method = "events" if matches and not events_err else "markets"
    matches = matches[:args.limit]

    if args.json:
        results = []
        for m in matches:
            yes, no = _parse_prices(m)
            results.append({
                "question": m.get("question", "?"),
                "condition_id": m.get("condition_id", m.get("conditionId", "?")),
                "yes_price": yes,
                "no_price": no,
                "volume_24h": m.get("volume24hr", m.get("volume_num", 0)),
                "liquidity": m.get("liquidityNum", m.get("liquidity_num", 0)),
                "end_date": (m.get("endDate", m.get("end_date_iso", "")) or "")[:10],
            })
        print(json.dumps({"status": "OK", "query": args.query, "count": len(results),
                          "search_method": search_method, "deep": deep, "markets": results}, indent=2))
    else:
        if not matches:
            print(f"OK — No markets found matching '{args.query}'")
            return 0
        mode_label = f" [deep scan: {max_pages * PAGE_SIZE} markets]" if deep else ""
        print(f"=== Polymarket: '{args.query}' ({len(matches)} results{mode_label}) ===\n")
        for m in matches:
            yes, no = _parse_prices(m)
            question = m.get("question", "?")
            vol = _fmt_volume(m.get("volume24hr", m.get("volume_num", 0)))
            liq = _fmt_volume(m.get("liquidityNum", m.get("liquidity_num", 0)))
            end = (m.get("endDate", m.get("end_date_iso", "")) or "")[:10]
            cid = m.get("condition_id", m.get("conditionId", "?"))
            print(f"  {question}")
            print(f"    YES: {_fmt_price(yes)}  NO: {_fmt_price(no)}  Vol(24h): {vol}  Liq: {liq}  Ends: {end}")
            print(f"    condition_id: {cid}")
            print()
    return 0

# ---------------------------------------------------------------------------
# trending subcommand
# ---------------------------------------------------------------------------

def cmd_trending(args):
    data, err = gamma_get(f"/markets?closed=false&order=volume24hr&ascending=false&limit={args.limit}")
    if err:
        _fail(f"Gamma API error: {err}", args.json)
        return 1

    markets = data if isinstance(data, list) else data.get("markets", data.get("data", []))
    if not markets:
        markets = []

    top = markets[:args.limit]

    if args.json:
        results = []
        for m in top:
            yes, no = _parse_prices(m)
            results.append({
                "question": m.get("question", "?"),
                "condition_id": m.get("condition_id", m.get("conditionId", "?")),
                "yes_price": yes,
                "no_price": no,
                "volume_24h": m.get("volume24hr", m.get("volume_num", 0)),
                "liquidity": m.get("liquidityNum", m.get("liquidity_num", 0)),
                "end_date": (m.get("endDate", m.get("end_date_iso", "")) or "")[:10],
            })
        print(json.dumps({"status": "OK", "count": len(results), "markets": results}, indent=2))
    else:
        if not top:
            print("OK — No open markets found")
            return 0
        print(f"=== Polymarket Trending Markets (Top {len(top)}) ===\n")
        for i, m in enumerate(top, 1):
            yes, no = _parse_prices(m)
            question = m.get("question", "?")
            vol = _fmt_volume(m.get("volume24hr", m.get("volume_num", 0)))
            liq = _fmt_volume(m.get("liquidityNum", m.get("liquidity_num", 0)))
            end = (m.get("endDate", m.get("end_date_iso", "")) or "")[:10]
            cid = m.get("condition_id", m.get("conditionId", "?"))
            print(f"  {i}. {question}")
            print(f"     YES: {_fmt_price(yes)}  NO: {_fmt_price(no)}  Vol(24h): {vol}  Liq: {liq}  Ends: {end}")
            print(f"     condition_id: {cid}")
            print()
    return 0

# ---------------------------------------------------------------------------
# events subcommand
# ---------------------------------------------------------------------------

def cmd_events(args):
    """Browse event groups (each event contains one or more markets)."""
    data, err = gamma_get(f"/events?closed=false&limit={args.limit}")
    if err:
        _fail(f"Gamma API error: {err}", args.json)
        return 1

    items = data if isinstance(data, list) else data.get("data", data.get("events", []))
    if not items:
        items = []
    events = items[:args.limit]

    if args.json:
        results = []
        for ev in events:
            markets = ev.get("markets", [])
            results.append({
                "title": ev.get("title", ev.get("name", "?")),
                "slug": ev.get("slug", ""),
                "market_count": len(markets),
                "volume": ev.get("volume", ev.get("competitionVolume", 0)),
                "markets": [
                    {
                        "question": m.get("question", "?"),
                        "condition_id": m.get("condition_id", m.get("conditionId", "?")),
                    }
                    for m in markets[:5]  # Cap to avoid huge output
                ],
            })
        print(json.dumps({"status": "OK", "count": len(results), "events": results}, indent=2))
    else:
        if not events:
            print("OK — No open events found")
            return 0
        print(f"=== Polymarket Events (Top {len(events)}) ===\n")
        for i, ev in enumerate(events, 1):
            title = ev.get("title", ev.get("name", "?"))
            markets = ev.get("markets", [])
            vol = _fmt_volume(ev.get("volume", ev.get("competitionVolume", 0)))
            print(f"  {i}. {title}")
            print(f"     Markets: {len(markets)}  Volume: {vol}")
            for m in markets[:3]:
                q = m.get("question", "?")
                cid = m.get("condition_id", m.get("conditionId", "?"))
                print(f"       - {q} ({cid})")
            if len(markets) > 3:
                print(f"       ... and {len(markets) - 3} more")
            print()
    return 0

# ---------------------------------------------------------------------------
# detail subcommand
# ---------------------------------------------------------------------------

def cmd_detail(args):
    data, err = gamma_get(f"/markets?condition_id={args.market_id}")
    if err:
        _fail(f"Gamma API error: {err}", args.json)
        return 1

    markets = data if isinstance(data, list) else data.get("markets", data.get("data", []))
    if not markets:
        _fail(f"No market found with condition_id: {args.market_id}", args.json)
        return 1

    m = markets[0]
    yes, no = _parse_prices(m)

    if args.json:
        print(json.dumps({
            "status": "OK",
            "market": {
                "question": m.get("question", "?"),
                "description": m.get("description", ""),
                "condition_id": m.get("condition_id", m.get("conditionId", "?")),
                "yes_price": yes,
                "no_price": no,
                "spread": round(abs((yes or 0) - (1 - (no or 1))), 4) if yes and no else None,
                "volume_24h": m.get("volume24hr", m.get("volume_num", 0)),
                "liquidity": m.get("liquidityNum", m.get("liquidity_num", 0)),
                "end_date": m.get("endDate", m.get("end_date_iso", "")),
                "resolution_source": m.get("resolutionSource", m.get("resolution_source", "")),
                "active": m.get("active", True),
            }
        }, indent=2))
    else:
        question = m.get("question", "?")
        desc = m.get("description", "")
        cid = m.get("condition_id", m.get("conditionId", "?"))
        vol = _fmt_volume(m.get("volume24hr", m.get("volume_num", 0)))
        liq = _fmt_volume(m.get("liquidityNum", m.get("liquidity_num", 0)))
        end = m.get("endDate", m.get("end_date_iso", ""))
        res_source = m.get("resolutionSource", m.get("resolution_source", ""))
        spread = round(abs((yes or 0) - (1 - (no or 1))), 4) if yes and no else "?"

        print(f"=== {question} ===\n")
        print(f"  Condition ID:   {cid}")
        print(f"  YES:            {_fmt_price(yes)}")
        print(f"  NO:             {_fmt_price(no)}")
        print(f"  Spread:         {_fmt_price(spread) if isinstance(spread, float) else spread}")
        print(f"  Volume (24h):   {vol}")
        print(f"  Liquidity:      {liq}")
        if end:
            print(f"  End Date:       {end[:19]}")
        if res_source:
            print(f"  Resolution:     {res_source}")
        if desc:
            print(f"\n  Description: {desc[:500]}")
    return 0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fail(msg, json_mode):
    if json_mode:
        print(json.dumps({"status": "FAIL", "error": msg}, indent=2))
    else:
        print(f"FAIL — {msg}")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Search and browse Polymarket markets",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    sp_search = subparsers.add_parser("search", help="Search markets by keyword")
    sp_search.add_argument("--query", required=True, help="Search query")
    sp_search.add_argument("--limit", type=int, default=10, help="Max results")
    sp_search.add_argument("--deep", action="store_true", help="Deep scan: search up to 2000 markets instead of 500")
    sp_search.add_argument("--json", action="store_true")

    sp_trending = subparsers.add_parser("trending", help="Show trending markets by volume")
    sp_trending.add_argument("--limit", type=int, default=10, help="Number of markets")
    sp_trending.add_argument("--json", action="store_true")

    sp_detail = subparsers.add_parser("detail", help="Show market details")
    sp_detail.add_argument("--market-id", required=True, help="Market condition_id")
    sp_detail.add_argument("--json", action="store_true")

    sp_events = subparsers.add_parser("events", help="Browse event groups")
    sp_events.add_argument("--limit", type=int, default=10, help="Number of events")
    sp_events.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        return 1

    cmd_map = {"search": cmd_search, "trending": cmd_trending, "detail": cmd_detail, "events": cmd_events}
    return cmd_map[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
