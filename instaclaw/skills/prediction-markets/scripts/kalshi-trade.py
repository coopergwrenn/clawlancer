#!/usr/bin/env python3
"""
kalshi-trade.py — Execute trades on Kalshi with risk enforcement and trade logging.

Usage:
  python3 ~/scripts/kalshi-trade.py buy --ticker <TICKER> --side yes|no --amount <USD> [--limit-price <CENTS>] [--json]
  python3 ~/scripts/kalshi-trade.py sell --ticker <TICKER> --side yes|no --contracts <N> [--limit-price <CENTS>] [--json]
  python3 ~/scripts/kalshi-trade.py cancel --order-id <ID> [--json]
  python3 ~/scripts/kalshi-trade.py orders [--status open] [--json]

Exit codes:
  0 = success (OK)
  1 = error (FAIL)
  2 = blocked by risk limits (BLOCK)
"""

import argparse
import json
import sys
from datetime import datetime, timezone, date
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PREDICTION_DIR = Path.home() / ".openclaw" / "prediction-markets"
CREDS_FILE = PREDICTION_DIR / "kalshi-creds.json"
RISK_CONFIG_FILE = PREDICTION_DIR / "kalshi-risk-config.json"
DAILY_SPEND_FILE = PREDICTION_DIR / "kalshi-daily-spend.json"
TRADE_LOG_FILE = PREDICTION_DIR / "kalshi-trade-log.json"

# ---------------------------------------------------------------------------
# Helpers (reuse kalshi_request from kalshi-setup)
# ---------------------------------------------------------------------------

def load_json(path, default=None):
    if not path.exists():
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


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


def kalshi_request(creds, method, endpoint, body=None):
    import urllib.request, urllib.error
    base = "https://trading-api.kalshi.com/trade-api/v2"
    path = f"/trade-api/v2{endpoint.split('?')[0]}"
    url = f"{base}{endpoint}"

    headers = _sign_request(creds["api_key_id"], creds["private_key_pem"], method, path)
    headers["Content-Type"] = "application/json"
    headers["Accept"] = "application/json"

    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
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


def load_risk_config():
    config = load_json(RISK_CONFIG_FILE)
    if config is None:
        # Auto-create with conservative defaults
        config = {
            "enabled": False,
            "daily_spend_cap": 50.00,
            "max_position_size": 100.00,
            "daily_loss_limit": 100.00,
            "confirmation_threshold": 25.00,
        }
        RISK_CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        save_json(RISK_CONFIG_FILE, config)
    return config


def load_daily_spend():
    today = date.today().isoformat()
    spend = load_json(DAILY_SPEND_FILE, {"date": today, "total_spent_usd": 0.0, "total_loss_usd": 0.0, "trade_count": 0})
    if spend.get("date") != today:
        spend = {"date": today, "total_spent_usd": 0.0, "total_loss_usd": 0.0, "trade_count": 0}
        save_json(DAILY_SPEND_FILE, spend)
    return spend


def check_risk_limits(amount_usd, config, daily_spend):
    if not config.get("enabled"):
        return False, "Trading disabled in kalshi-risk-config.json (enabled=false)"
    daily_cap = config.get("dailySpendCapUSD", config.get("daily_spend_cap", 50))
    max_pos = config.get("maxPositionSizeUSD", config.get("max_position_size", 100))
    daily_loss = config.get("dailyLossLimitUSD", config.get("daily_loss_limit", 100))
    new_total = daily_spend.get("total_spent_usd", 0) + amount_usd
    if new_total > daily_cap:
        remaining = max(0, daily_cap - daily_spend.get("total_spent_usd", 0))
        return False, f"Daily spend cap exceeded: ${new_total:.2f} > ${daily_cap:.2f} (${remaining:.2f} remaining)"
    if amount_usd > max_pos:
        return False, f"Position size ${amount_usd:.2f} exceeds max ${max_pos:.2f}"
    if daily_spend.get("total_loss_usd", 0) >= daily_loss:
        return False, f"Daily loss limit reached: ${daily_spend['total_loss_usd']:.2f} >= ${daily_loss:.2f}"
    return True, None


def log_trade(entry):
    log = load_json(TRADE_LOG_FILE, [])
    log.append(entry)
    save_json(TRADE_LOG_FILE, log)


# ---------------------------------------------------------------------------
# buy subcommand
# ---------------------------------------------------------------------------

def cmd_buy(args):
    config = load_risk_config()

    daily_spend = load_daily_spend()
    ok, reason = check_risk_limits(args.amount, config, daily_spend)
    if not ok:
        output(f"BLOCK — {reason}", args.json, {"status": "BLOCK", "error": "risk_limit", "detail": reason})
        return 2

    creds = load_creds()
    if not creds:
        output("FAIL — Kalshi not configured. Run: python3 ~/scripts/kalshi-setup.py setup", args.json,
               {"status": "FAIL", "error": "not_configured"})
        return 1

    # Pre-trade balance check
    bal_resp, bal_err = kalshi_request(creds, "GET", "/portfolio/balance")
    if bal_resp:
        available_cents = bal_resp.get("balance", 0)
        available_usd = available_cents / 100
        if available_usd < args.amount:
            output(f"FAIL — Insufficient balance: ${available_usd:.2f} available, need ${args.amount:.2f}. Deposit more at kalshi.com.",
                   args.json, {"status": "FAIL", "error": "insufficient_balance",
                               "available_usd": available_usd, "needed_usd": args.amount,
                               "suggestion": "Deposit more funds at kalshi.com"})
            return 1

    # Determine price and contracts
    if args.limit_price:
        price_cents = args.limit_price
    else:
        # Fetch current market price
        market_data, err = kalshi_request(creds, "GET", f"/markets/{args.ticker}")
        if err:
            output(f"FAIL — Could not fetch market: {err}", args.json,
                   {"status": "FAIL", "error": "market_fetch_failed", "detail": err})
            return 1
        market = market_data.get("market", market_data)
        if args.side == "yes":
            price_str = market.get("yes_ask_dollars") or market.get("yes_ask")
        else:
            price_str = market.get("no_ask_dollars") or market.get("no_ask")
        if not price_str:
            output("FAIL — Could not determine market price. Use --limit-price.", args.json,
                   {"status": "FAIL", "error": "price_unavailable"})
            return 1
        try:
            price_cents = int(float(str(price_str)) * 100)
        except (ValueError, TypeError):
            output(f"FAIL — Invalid price from API: {price_str}", args.json,
                   {"status": "FAIL", "error": "invalid_price"})
            return 1

    if price_cents <= 0 or price_cents >= 100:
        output(f"FAIL — Price {price_cents}c out of range (1-99)", args.json,
               {"status": "FAIL", "error": "invalid_price"})
        return 1

    contracts = int(args.amount * 100 / price_cents)
    if contracts < 1:
        output(f"FAIL — Amount ${args.amount:.2f} too small for price {price_cents}c (need at least 1 contract)",
               args.json, {"status": "FAIL", "error": "amount_too_small"})
        return 1

    # Place order
    order_body = {
        "ticker": args.ticker,
        "action": "buy",
        "side": args.side,
        "type": "limit",
        "count": contracts,
    }
    if args.side == "yes":
        order_body["yes_price"] = price_cents
    else:
        order_body["no_price"] = price_cents

    resp, err = kalshi_request(creds, "POST", "/portfolio/orders", order_body)
    if err:
        output(f"FAIL — Order failed: {err}", args.json, {"status": "FAIL", "error": "order_failed", "detail": err})
        return 1

    order = resp.get("order", resp)
    order_id = order.get("order_id", "")
    status = order.get("status", "unknown")
    cost_cents = price_cents * contracts

    # Update daily spend
    daily_spend["total_spent_usd"] = daily_spend.get("total_spent_usd", 0) + cost_cents / 100
    daily_spend["trade_count"] = daily_spend.get("trade_count", 0) + 1
    save_json(DAILY_SPEND_FILE, daily_spend)

    # Log trade
    log_trade({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": "BUY",
        "ticker": args.ticker,
        "side": args.side,
        "contracts": contracts,
        "price_cents": price_cents,
        "cost_usd": cost_cents / 100,
        "order_id": order_id,
        "status": status,
    })

    result = {
        "status": "OK",
        "action": "BUY",
        "ticker": args.ticker,
        "side": args.side,
        "contracts": contracts,
        "price_cents": price_cents,
        "cost_usd": cost_cents / 100,
        "order_id": order_id,
        "order_status": status,
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"OK — BUY order placed on Kalshi")
        print(f"  Ticker: {args.ticker}")
        print(f"  Side: {args.side.upper()}")
        print(f"  Contracts: {contracts}")
        print(f"  Price: {price_cents}c (${price_cents/100:.2f})")
        print(f"  Cost: ${cost_cents/100:.2f}")
        print(f"  Order ID: {order_id}")
        print(f"  Status: {status}")
    return 0


# ---------------------------------------------------------------------------
# sell subcommand
# ---------------------------------------------------------------------------

def cmd_sell(args):
    config = load_risk_config()
    if not config or not config.get("enabled"):
        output("BLOCK — Trading disabled or risk config missing", args.json,
               {"status": "BLOCK", "error": "trading_disabled"})
        return 2

    creds = load_creds()
    if not creds:
        output("FAIL — Kalshi not configured", args.json, {"status": "FAIL", "error": "not_configured"})
        return 1

    if args.limit_price:
        price_cents = args.limit_price
    else:
        market_data, err = kalshi_request(creds, "GET", f"/markets/{args.ticker}")
        if err:
            output(f"FAIL — {err}", args.json, {"status": "FAIL", "error": "market_fetch_failed"})
            return 1
        market = market_data.get("market", market_data)
        if args.side == "yes":
            price_str = market.get("yes_bid_dollars") or market.get("yes_bid")
        else:
            price_str = market.get("no_bid_dollars") or market.get("no_bid")
        if not price_str:
            output("FAIL — Could not determine price. Use --limit-price.", args.json,
                   {"status": "FAIL", "error": "price_unavailable"})
            return 1
        try:
            price_cents = int(float(str(price_str)) * 100)
        except (ValueError, TypeError):
            output(f"FAIL — Invalid price: {price_str}", args.json, {"status": "FAIL", "error": "invalid_price"})
            return 1

    order_body = {
        "ticker": args.ticker,
        "action": "sell",
        "side": args.side,
        "type": "limit",
        "count": args.contracts,
    }
    if args.side == "yes":
        order_body["yes_price"] = price_cents
    else:
        order_body["no_price"] = price_cents

    resp, err = kalshi_request(creds, "POST", "/portfolio/orders", order_body)
    if err:
        output(f"FAIL — Sell failed: {err}", args.json, {"status": "FAIL", "error": "order_failed", "detail": err})
        return 1

    order = resp.get("order", resp)
    order_id = order.get("order_id", "")
    status = order.get("status", "unknown")
    value_cents = price_cents * args.contracts

    log_trade({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": "SELL",
        "ticker": args.ticker,
        "side": args.side,
        "contracts": args.contracts,
        "price_cents": price_cents,
        "value_usd": value_cents / 100,
        "order_id": order_id,
        "status": status,
    })

    result = {
        "status": "OK",
        "action": "SELL",
        "ticker": args.ticker,
        "side": args.side,
        "contracts": args.contracts,
        "price_cents": price_cents,
        "value_usd": value_cents / 100,
        "order_id": order_id,
        "order_status": status,
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"OK — SELL order placed on Kalshi")
        print(f"  Ticker: {args.ticker}")
        print(f"  Side: {args.side.upper()}")
        print(f"  Contracts: {args.contracts}")
        print(f"  Price: {price_cents}c")
        print(f"  Value: ${value_cents/100:.2f}")
        print(f"  Order ID: {order_id}")
        print(f"  Status: {status}")
    return 0


# ---------------------------------------------------------------------------
# cancel subcommand
# ---------------------------------------------------------------------------

def cmd_cancel(args):
    creds = load_creds()
    if not creds:
        output("FAIL — Kalshi not configured", args.json, {"status": "FAIL", "error": "not_configured"})
        return 1

    resp, err = kalshi_request(creds, "DELETE", f"/portfolio/orders/{args.order_id}")
    if err:
        output(f"FAIL — Cancel failed: {err}", args.json, {"status": "FAIL", "error": "cancel_failed", "detail": err})
        return 1

    output(f"OK — Order {args.order_id} cancelled", args.json,
           {"status": "OK", "order_id": args.order_id, "cancelled": True})
    return 0


# ---------------------------------------------------------------------------
# orders subcommand
# ---------------------------------------------------------------------------

def cmd_orders(args):
    creds = load_creds()
    if not creds:
        output("FAIL — Kalshi not configured", args.json, {"status": "FAIL", "error": "not_configured"})
        return 1

    params = f"?status={args.status}" if args.status else ""
    resp, err = kalshi_request(creds, "GET", f"/portfolio/orders{params}")
    if err:
        output(f"FAIL — {err}", args.json, {"status": "FAIL", "error": err})
        return 1

    orders = resp.get("orders", [])
    if args.json:
        print(json.dumps({"status": "OK", "orders": orders, "count": len(orders)}, indent=2))
    else:
        if not orders:
            print("OK — No orders found")
        else:
            print(f"OK — {len(orders)} order(s):\n")
            for o in orders:
                oid = o.get("order_id", "?")
                ticker = o.get("ticker", "?")
                side = o.get("side", "?")
                action = o.get("action", "?")
                count = o.get("remaining_count", o.get("count", "?"))
                price = o.get("yes_price", o.get("no_price", "?"))
                status = o.get("status", "?")
                print(f"  {oid}  {action} {side} {ticker}  {count} @ {price}c  status={status}")
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Kalshi trade execution with risk enforcement",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    sp_buy = subparsers.add_parser("buy", help="Buy contracts")
    sp_buy.add_argument("--ticker", required=True, help="Kalshi market ticker")
    sp_buy.add_argument("--side", required=True, choices=["yes", "no"], help="Side to buy")
    sp_buy.add_argument("--amount", required=True, type=float, help="USD amount to spend")
    sp_buy.add_argument("--limit-price", type=int, help="Limit price in cents (1-99)")
    sp_buy.add_argument("--json", action="store_true")

    sp_sell = subparsers.add_parser("sell", help="Sell contracts")
    sp_sell.add_argument("--ticker", required=True, help="Kalshi market ticker")
    sp_sell.add_argument("--side", required=True, choices=["yes", "no"], help="Side to sell")
    sp_sell.add_argument("--contracts", required=True, type=int, help="Number of contracts")
    sp_sell.add_argument("--limit-price", type=int, help="Limit price in cents (1-99)")
    sp_sell.add_argument("--json", action="store_true")

    sp_cancel = subparsers.add_parser("cancel", help="Cancel an order")
    sp_cancel.add_argument("--order-id", required=True, help="Order ID to cancel")
    sp_cancel.add_argument("--json", action="store_true")

    sp_orders = subparsers.add_parser("orders", help="List orders")
    sp_orders.add_argument("--status", choices=["open", "closed"], help="Filter by status")
    sp_orders.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        return 1

    cmd_map = {"buy": cmd_buy, "sell": cmd_sell, "cancel": cmd_cancel, "orders": cmd_orders}
    return cmd_map[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
