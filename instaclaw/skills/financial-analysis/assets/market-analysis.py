#!/usr/bin/env python3
"""
market-analysis.py — Technical analysis engine for AI agents

Usage:
    market-analysis.py analyze    --symbol <sym>                     — Full technical analysis
    market-analysis.py chart      --symbol <sym> [--output path.png] — Generate price chart
    market-analysis.py watchlist  --symbols SYM1,SYM2,...            — Multi-ticker scan
    market-analysis.py rate-status                                    — Show API usage stats

Reads from:
    ~/.openclaw/.env  — ALPHAVANTAGE_API_KEY

Output: Formatted analysis text or JSON (--json flag)
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ENV_FILE = Path.home() / ".openclaw" / ".env"
CACHE_DIR = Path.home() / ".openclaw" / "cache" / "alphavantage"
RATE_FILE = CACHE_DIR / ".rate-log"
BASE_URL = "https://www.alphavantage.co/query"
DAILY_BUDGET = 500


def load_api_key() -> str:
    """Load Alpha Vantage API key from environment or .env file."""
    key = os.environ.get("ALPHAVANTAGE_API_KEY", "")
    if not key and ENV_FILE.exists():
        try:
            for line in ENV_FILE.read_text().splitlines():
                if line.startswith("ALPHAVANTAGE_API_KEY="):
                    key = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        except IOError:
            pass
    return key


def api_call(params: dict, api_key: str) -> dict:
    """Make an Alpha Vantage API call."""
    import requests
    params["apikey"] = api_key
    try:
        resp = requests.get(BASE_URL, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if "Error Message" in data:
            print(f"API Error: {data['Error Message']}", file=sys.stderr)
            return {}
        if "Note" in data:
            print(f"API Note: {data['Note']}", file=sys.stderr)
            return {}
        # Log request
        log_request()
        return data
    except Exception as e:
        print(f"API call failed: {e}", file=sys.stderr)
        return {}


def log_request():
    """Log an API request for rate tracking."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    now = datetime.now(timezone.utc).strftime("%H:%M:%S")
    with open(RATE_FILE, "a") as f:
        f.write(f"{today} {now}\n")


def get_daily_count() -> int:
    """Get today's API request count."""
    if not RATE_FILE.exists():
        return 0
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        return sum(1 for line in RATE_FILE.read_text().splitlines() if line.startswith(today))
    except IOError:
        return 0


def check_rate_limit():
    """Check if we're within budget."""
    count = get_daily_count()
    if count >= DAILY_BUDGET:
        print(f"ERROR: Daily API budget exhausted ({count}/{DAILY_BUDGET})", file=sys.stderr)
        sys.exit(2)
    if count >= 400:
        print(f"WARNING: Approaching daily budget ({count}/{DAILY_BUDGET})", file=sys.stderr)


def get_quote(symbol: str, api_key: str) -> dict:
    """Get real-time quote."""
    data = api_call({"function": "GLOBAL_QUOTE", "symbol": symbol}, api_key)
    quote = data.get("Global Quote", {})
    if not quote:
        return {}
    return {
        "symbol": quote.get("01. symbol", symbol),
        "price": float(quote.get("05. price", 0)),
        "change": float(quote.get("09. change", 0)),
        "change_pct": quote.get("10. change percent", "0%"),
        "volume": int(quote.get("06. volume", 0)),
        "prev_close": float(quote.get("08. previous close", 0)),
        "timestamp": quote.get("07. latest trading day", ""),
    }


def get_indicator(symbol: str, function: str, api_key: str,
                  interval: str = "daily", time_period: int = 14) -> list:
    """Get a technical indicator's recent values."""
    params = {
        "function": function,
        "symbol": symbol,
        "interval": interval,
        "time_period": time_period,
        "series_type": "close",
    }
    data = api_call(params, api_key)
    # Alpha Vantage returns data under "Technical Analysis: <FUNCTION>" key
    ta_key = f"Technical Analysis: {function}"
    ta_data = data.get(ta_key, {})
    if not ta_data:
        # Try other possible key formats
        for key in data:
            if "Technical Analysis" in key:
                ta_data = data[key]
                break
    if not ta_data:
        return []
    # Convert to sorted list of (date, values)
    result = []
    for date_str, values in sorted(ta_data.items(), reverse=True)[:50]:
        entry = {"date": date_str}
        for k, v in values.items():
            entry[k.lower().replace(" ", "_")] = float(v)
        result.append(entry)
    return result


def analyze_symbol(symbol: str, api_key: str, as_json: bool = False):
    """Run full technical analysis on a symbol."""
    check_rate_limit()

    now = datetime.now(timezone.utc)
    timestamp = now.strftime("%b %d, %Y %H:%M UTC")

    # Get quote
    quote = get_quote(symbol, api_key)
    if not quote:
        print(f"Error: Could not fetch data for {symbol}", file=sys.stderr)
        return

    # Get indicators (each is a separate API call)
    rsi_data = get_indicator(symbol, "RSI", api_key, time_period=14)
    macd_data = get_indicator(symbol, "MACD", api_key)
    bbands_data = get_indicator(symbol, "BBANDS", api_key, time_period=20)
    sma50_data = get_indicator(symbol, "SMA", api_key, time_period=50)
    sma200_data = get_indicator(symbol, "SMA", api_key, time_period=200)
    adx_data = get_indicator(symbol, "ADX", api_key, time_period=14)
    stoch_data = get_indicator(symbol, "STOCH", api_key, time_period=14)

    # Extract latest values
    rsi = rsi_data[0].get("rsi", 0) if rsi_data else None
    sma50 = sma50_data[0].get("sma", 0) if sma50_data else None
    sma200 = sma200_data[0].get("sma", 0) if sma200_data else None
    adx = adx_data[0].get("adx", 0) if adx_data else None

    macd_val = macd_data[0].get("macd", 0) if macd_data else None
    macd_signal = macd_data[0].get("macd_signal", 0) if macd_data else None
    macd_hist = macd_data[0].get("macd_hist", 0) if macd_data else None

    bb_upper = bbands_data[0].get("real_upper_band", 0) if bbands_data else None
    bb_middle = bbands_data[0].get("real_middle_band", 0) if bbands_data else None
    bb_lower = bbands_data[0].get("real_lower_band", 0) if bbands_data else None

    stoch_k = stoch_data[0].get("slowk", 0) if stoch_data else None
    stoch_d = stoch_data[0].get("slowd", 0) if stoch_data else None

    price = quote["price"]

    # Score indicators
    signals = []

    # SMA trend
    if sma50 and sma200:
        if price > sma50 > sma200:
            signals.append(("SMA 50/200", "BULLISH", f"Price ${price:.2f} > SMA50 ${sma50:.2f} > SMA200 ${sma200:.2f}"))
        elif price < sma50 < sma200:
            signals.append(("SMA 50/200", "BEARISH", f"Price ${price:.2f} < SMA50 ${sma50:.2f} < SMA200 ${sma200:.2f}"))
        elif price > sma50:
            signals.append(("SMA 50/200", "BULLISH", f"Price above SMA50 ${sma50:.2f}"))
        else:
            signals.append(("SMA 50/200", "BEARISH", f"Price below SMA50 ${sma50:.2f}"))

    # RSI
    if rsi is not None:
        if rsi > 70:
            signals.append(("RSI", "BEARISH", f"RSI {rsi:.1f} — overbought"))
        elif rsi < 30:
            signals.append(("RSI", "BULLISH", f"RSI {rsi:.1f} — oversold"))
        elif rsi > 50:
            signals.append(("RSI", "BULLISH", f"RSI {rsi:.1f} — above midline"))
        else:
            signals.append(("RSI", "BEARISH", f"RSI {rsi:.1f} — below midline"))

    # MACD
    if macd_val is not None and macd_signal is not None:
        if macd_val > macd_signal:
            signals.append(("MACD", "BULLISH", f"MACD {macd_val:.4f} > Signal {macd_signal:.4f}"))
        else:
            signals.append(("MACD", "BEARISH", f"MACD {macd_val:.4f} < Signal {macd_signal:.4f}"))

    # ADX
    if adx is not None:
        if adx > 25:
            signals.append(("ADX", "TRENDING", f"ADX {adx:.1f} — strong trend"))
        else:
            signals.append(("ADX", "RANGING", f"ADX {adx:.1f} — weak/no trend"))

    # Stochastic
    if stoch_k is not None:
        if stoch_k > 80:
            signals.append(("Stochastic", "BEARISH", f"SlowK {stoch_k:.1f} — overbought"))
        elif stoch_k < 20:
            signals.append(("Stochastic", "BULLISH", f"SlowK {stoch_k:.1f} — oversold"))
        elif stoch_k > 50:
            signals.append(("Stochastic", "BULLISH", f"SlowK {stoch_k:.1f} — above midline"))
        else:
            signals.append(("Stochastic", "BEARISH", f"SlowK {stoch_k:.1f} — below midline"))

    # Bollinger Bands
    if bb_upper and bb_lower:
        bb_width = bb_upper - bb_lower
        if price > bb_upper:
            signals.append(("Bollinger", "BEARISH", f"Price above upper band ${bb_upper:.2f}"))
        elif price < bb_lower:
            signals.append(("Bollinger", "BULLISH", f"Price below lower band ${bb_lower:.2f}"))
        else:
            pct = (price - bb_lower) / bb_width if bb_width > 0 else 0.5
            if pct > 0.5:
                signals.append(("Bollinger", "BULLISH", f"Upper half of bands ({pct:.0%})"))
            else:
                signals.append(("Bollinger", "BEARISH", f"Lower half of bands ({pct:.0%})"))

    # Tally
    bullish = sum(1 for _, d, _ in signals if d == "BULLISH")
    bearish = sum(1 for _, d, _ in signals if d == "BEARISH")
    total_directional = bullish + bearish

    if total_directional > 0:
        if bullish > bearish:
            trend = "BULLISH"
            confidence = f"{bullish}/{total_directional} indicators bullish"
        elif bearish > bullish:
            trend = "BEARISH"
            confidence = f"{bearish}/{total_directional} indicators bearish"
        else:
            trend = "NEUTRAL"
            confidence = f"Mixed: {bullish} bullish, {bearish} bearish"
    else:
        trend = "UNKNOWN"
        confidence = "Insufficient data"

    if as_json:
        print(json.dumps({
            "symbol": symbol,
            "timestamp": timestamp,
            "quote": quote,
            "trend": trend,
            "confidence": confidence,
            "signals": [{"indicator": i, "direction": d, "detail": det} for i, d, det in signals],
            "indicators": {
                "rsi": rsi,
                "macd": macd_val,
                "macd_signal": macd_signal,
                "macd_hist": macd_hist,
                "sma50": sma50,
                "sma200": sma200,
                "adx": adx,
                "stoch_k": stoch_k,
                "stoch_d": stoch_d,
                "bb_upper": bb_upper,
                "bb_middle": bb_middle,
                "bb_lower": bb_lower,
            },
            "levels": {
                "support": [s for s in [sma50, bb_lower] if s],
                "resistance": [r for r in [sma200, bb_upper] if r],
            },
        }, indent=2))
        return

    # Format as text
    lines = [
        f"Technical Analysis: {symbol} — {timestamp}",
        "",
        f"PRICE: ${price:.2f} ({quote['change_pct']}) | Volume: {quote['volume']:,}",
        "",
        f"TREND: {trend} ({confidence})",
    ]

    for indicator, direction, detail in signals:
        icon = "+" if direction == "BULLISH" else "-" if direction == "BEARISH" else "~"
        lines.append(f"  [{icon}] {indicator}: {detail}")

    lines.append("")
    lines.append("KEY LEVELS:")
    if sma50:
        above_below = "above" if price > sma50 else "below"
        lines.append(f"  SMA 50: ${sma50:.2f} (price {above_below})")
    if sma200:
        above_below = "above" if price > sma200 else "below"
        lines.append(f"  SMA 200: ${sma200:.2f} (price {above_below})")
    if bb_upper and bb_lower:
        lines.append(f"  Bollinger: ${bb_lower:.2f} — ${bb_middle:.2f} — ${bb_upper:.2f}")

    lines.append("")
    lines.append("This is data analysis, not financial advice. All trading decisions are yours.")

    print("\n".join(lines))


def chart_symbol(symbol: str, api_key: str, output: str):
    """Generate a simple price chart with indicators."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import matplotlib.dates as mdates
    except ImportError:
        print("Error: matplotlib not available. Install with: pip3 install matplotlib", file=sys.stderr)
        sys.exit(1)

    check_rate_limit()

    # Get daily prices
    data = api_call({
        "function": "TIME_SERIES_DAILY",
        "symbol": symbol,
        "outputsize": "compact",
    }, api_key)

    ts_key = "Time Series (Daily)"
    if ts_key not in data:
        print(f"Error: No daily data for {symbol}", file=sys.stderr)
        return

    dates = []
    closes = []
    for date_str in sorted(data[ts_key].keys()):
        dates.append(datetime.strptime(date_str, "%Y-%m-%d"))
        closes.append(float(data[ts_key][date_str]["4. close"]))

    # Get SMA 50
    sma50_data = get_indicator(symbol, "SMA", api_key, time_period=50)
    sma50_dates = []
    sma50_vals = []
    for entry in reversed(sma50_data):
        try:
            sma50_dates.append(datetime.strptime(entry["date"], "%Y-%m-%d"))
            sma50_vals.append(entry["sma"])
        except (KeyError, ValueError):
            pass

    # Get Bollinger Bands
    bb_data = get_indicator(symbol, "BBANDS", api_key, time_period=20)
    bb_dates = []
    bb_upper = []
    bb_lower = []
    for entry in reversed(bb_data):
        try:
            bb_dates.append(datetime.strptime(entry["date"], "%Y-%m-%d"))
            bb_upper.append(entry["real_upper_band"])
            bb_lower.append(entry["real_lower_band"])
        except (KeyError, ValueError):
            pass

    fig, ax = plt.subplots(figsize=(12, 6))
    ax.plot(dates, closes, label=f"{symbol} Close", color="white", linewidth=1.5)

    if sma50_dates:
        ax.plot(sma50_dates, sma50_vals, label="SMA 50", color="#FFD700", linewidth=1, linestyle="--")
    if bb_dates:
        ax.fill_between(bb_dates, bb_lower, bb_upper, alpha=0.15, color="#4A90D9", label="Bollinger Bands")

    ax.set_facecolor("#1a1a2e")
    fig.patch.set_facecolor("#1a1a2e")
    ax.tick_params(colors="white")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
    ax.xaxis.set_major_locator(mdates.WeekdayLocator(interval=2))
    plt.xticks(rotation=45)
    ax.set_title(f"{symbol} — Daily Chart", color="white", fontsize=14)
    ax.set_ylabel("Price ($)", color="white")
    ax.legend(facecolor="#1a1a2e", edgecolor="white", labelcolor="white")
    ax.grid(alpha=0.2, color="white")

    for spine in ax.spines.values():
        spine.set_color("white")

    plt.tight_layout()
    plt.savefig(output, dpi=150, facecolor=fig.get_facecolor())
    plt.close()
    print(f"Chart saved to {output}")


def watchlist_scan(symbols: list, api_key: str, as_json: bool = False):
    """Quick scan of multiple symbols."""
    check_rate_limit()

    results = []
    for sym in symbols:
        quote = get_quote(sym.strip(), api_key)
        if not quote:
            results.append({"symbol": sym, "error": "No data"})
            continue

        # Get RSI (one API call per symbol)
        rsi_data = get_indicator(sym.strip(), "RSI", api_key, time_period=14)
        rsi = rsi_data[0].get("rsi", None) if rsi_data else None

        entry = {
            "symbol": quote["symbol"],
            "price": quote["price"],
            "change_pct": quote["change_pct"],
            "volume": quote["volume"],
            "rsi": rsi,
        }

        # Quick signal
        if rsi is not None:
            if rsi > 70:
                entry["signal"] = "OVERBOUGHT"
            elif rsi < 30:
                entry["signal"] = "OVERSOLD"
            else:
                entry["signal"] = "NEUTRAL"

        results.append(entry)

    if as_json:
        print(json.dumps(results, indent=2))
        return

    timestamp = datetime.now(timezone.utc).strftime("%b %d, %Y %H:%M UTC")
    print(f"Watchlist Scan — {timestamp}")
    print()
    for r in results:
        if "error" in r:
            print(f"  {r['symbol']}: ERROR — {r['error']}")
            continue
        rsi_str = f"RSI {r['rsi']:.0f}" if r.get("rsi") else "RSI N/A"
        signal = r.get("signal", "")
        icon = "!" if signal in ("OVERBOUGHT", "OVERSOLD") else " "
        print(f" {icon} {r['symbol']}: ${r['price']:.2f} ({r['change_pct']}) | {rsi_str} {signal}")

    print()
    print("This is data analysis, not financial advice.")


def rate_status():
    """Show API rate limit status."""
    count = get_daily_count()
    remaining = DAILY_BUDGET - count
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    status = "WARNING — approaching limit" if count >= 400 else "BUDGET EXHAUSTED" if count >= DAILY_BUDGET else "OK"

    print(f"Alpha Vantage API Usage")
    print(f"  Date:      {today}")
    print(f"  Requests:  {count} / {DAILY_BUDGET}")
    print(f"  Remaining: {remaining}")
    print(f"  Status:    {status}")


def main():
    parser = argparse.ArgumentParser(description="Market analysis engine")
    subparsers = parser.add_subparsers(dest="command")

    # analyze
    p_analyze = subparsers.add_parser("analyze")
    p_analyze.add_argument("--symbol", required=True)
    p_analyze.add_argument("--json", action="store_true")

    # chart
    p_chart = subparsers.add_parser("chart")
    p_chart.add_argument("--symbol", required=True)
    p_chart.add_argument("--output", default="/tmp/chart.png")

    # watchlist
    p_watch = subparsers.add_parser("watchlist")
    p_watch.add_argument("--symbols", required=True, help="Comma-separated symbols")
    p_watch.add_argument("--json", action="store_true")

    # rate-status
    subparsers.add_parser("rate-status")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    api_key = load_api_key()
    if args.command != "rate-status" and not api_key:
        print("Error: ALPHAVANTAGE_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    if args.command == "analyze":
        analyze_symbol(args.symbol, api_key, as_json=args.json)
    elif args.command == "chart":
        chart_symbol(args.symbol, api_key, args.output)
    elif args.command == "watchlist":
        symbols = [s.strip() for s in args.symbols.split(",")]
        watchlist_scan(symbols, api_key, as_json=args.json)
    elif args.command == "rate-status":
        rate_status()


if __name__ == "__main__":
    main()
