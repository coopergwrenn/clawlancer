#!/usr/bin/env python3
"""
polymarket-trade.py — Execute real trades on Polymarket via CLOB API
with risk enforcement, daily spend tracking, and full trade logging.

Usage:
  python3 ~/scripts/polymarket-trade.py buy --market-id <id> --outcome YES --amount 10 [--price 0.65] [--order-type FOK] [--json]
  python3 ~/scripts/polymarket-trade.py sell --market-id <id> --outcome YES --shares 15 [--price 0.70] [--order-type FOK] [--json]
  python3 ~/scripts/polymarket-trade.py cancel --order-id <id> [--json]
  python3 ~/scripts/polymarket-trade.py cancel --all [--json]
  python3 ~/scripts/polymarket-trade.py orders [--json]
  python3 ~/scripts/polymarket-trade.py check-orders [--json]
  python3 ~/scripts/polymarket-trade.py cancel-all [--json]
  python3 ~/scripts/polymarket-trade.py price --market-id <id> [--json]
  python3 ~/scripts/polymarket-trade.py convert-to-market --order-id <id> [--json]
  python3 ~/scripts/polymarket-trade.py acknowledge-risk [--json]

Exit codes:
  0 = success (OK)
  1 = error (FAIL)
  2 = blocked by risk limits (BLOCK)
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone, date
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

POLYMARKET_DIR = Path.home() / ".openclaw" / "polymarket"
WALLET_FILE = POLYMARKET_DIR / "wallet.json"
RISK_CONFIG_FILE = POLYMARKET_DIR / "risk-config.json"
DAILY_SPEND_FILE = POLYMARKET_DIR / "daily-spend.json"
TRADE_LOG_FILE = POLYMARKET_DIR / "trade-log.json"
POSITIONS_FILE = POLYMARKET_DIR / "positions.json"
RISK_ACK_FILE = POLYMARKET_DIR / "polymarket-risk.json"

CLOB_HOST_DEFAULT = "https://clob.polymarket.com"
GAMMA_API = "https://gamma-api.polymarket.com"
CHAIN_ID = 137

# USDC contract addresses (Polygon mainnet)
USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"       # Bridged — Polymarket uses this
USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"   # Native — NOT usable on Polymarket

ENV_FILE = Path.home() / ".openclaw" / ".env"

RPC_FALLBACKS = [
    "https://api.zan.top/polygon-mainnet",
    "https://1rpc.io/matic",
    "https://polygon-rpc.com",
    "https://polygon-bor-rpc.publicnode.com",
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_json(path, default=None):
    """Load a JSON file, return default if missing or invalid."""
    if not path.exists():
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return default


def save_json(path, data):
    """Save data to a JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def load_wallet():
    """Load wallet from wallet.json."""
    return load_json(WALLET_FILE)


def load_risk_config():
    """Load risk config. Returns None if missing."""
    return load_json(RISK_CONFIG_FILE)


def load_daily_spend():
    """Load daily spend tracker. Resets if UTC date changed."""
    today = date.today().isoformat()
    spend = load_json(DAILY_SPEND_FILE, {
        "date": today,
        "total_spent_usdc": 0.0,
        "total_loss_usdc": 0.0,
        "trade_count": 0,
    })
    if spend.get("date") != today:
        spend = {
            "date": today,
            "total_spent_usdc": 0.0,
            "total_loss_usdc": 0.0,
            "trade_count": 0,
        }
        save_json(DAILY_SPEND_FILE, spend)
    return spend


def check_risk_limits(amount_usdc, config, daily_spend):
    """Check all risk limits. Returns (ok, reason) tuple."""
    if not config.get("enabled"):
        return False, "Trading is disabled in risk-config.json (enabled=false)"

    daily_cap = config.get("dailySpendCapUSDC", 50)
    max_position = config.get("maxPositionSizeUSDC", 100)
    daily_loss_limit = config.get("dailyLossLimitUSDC", 100)

    new_total = daily_spend.get("total_spent_usdc", 0) + amount_usdc
    if new_total > daily_cap:
        remaining = max(0, daily_cap - daily_spend.get("total_spent_usdc", 0))
        return False, f"Daily spend cap exceeded: ${new_total:.2f} > ${daily_cap:.2f} cap (${remaining:.2f} remaining)"

    if amount_usdc > max_position:
        return False, f"Position size ${amount_usdc:.2f} exceeds max ${max_position:.2f}"

    if daily_spend.get("total_loss_usdc", 0) >= daily_loss_limit:
        return False, f"Daily loss limit reached: ${daily_spend['total_loss_usdc']:.2f} >= ${daily_loss_limit:.2f}"

    return True, None


def fetch_market_info(market_id):
    """Fetch market info from Gamma API. Returns dict or None.
    Handles both numeric IDs (path lookup) and condition_ids (query param)."""
    # condition_ids start with "0x"
    if str(market_id).startswith("0x"):
        url = f"{GAMMA_API}/markets?condition_id={market_id}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "polymarket-trade/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode())
                markets = data if isinstance(data, list) else data.get("markets", data.get("data", []))
                return markets[0] if markets else None
        except Exception:
            return None
    else:
        url = f"{GAMMA_API}/markets/{market_id}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "polymarket-trade/1.0"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode())
        except Exception:
            return None


def get_token_id(market, outcome):
    """Extract the correct token ID for the given outcome."""
    outcomes = json.loads(market.get("outcomes", "[]"))
    token_ids = json.loads(market.get("clobTokenIds", "[]"))

    outcome_upper = outcome.upper()
    for i, o in enumerate(outcomes):
        if o.upper() == outcome_upper and i < len(token_ids):
            return token_ids[i]

    return None


def get_all_token_ids(market):
    """Get all token IDs with their outcome labels."""
    outcomes = json.loads(market.get("outcomes", "[]"))
    token_ids = json.loads(market.get("clobTokenIds", "[]"))
    result = []
    for i, o in enumerate(outcomes):
        if i < len(token_ids):
            result.append({"outcome": o, "token_id": token_ids[i]})
    return result


def get_current_price(market, outcome):
    """Get current price for the given outcome."""
    outcomes = json.loads(market.get("outcomes", "[]"))
    prices = json.loads(market.get("outcomePrices", "[]"))

    outcome_upper = outcome.upper()
    for i, o in enumerate(outcomes):
        if o.upper() == outcome_upper and i < len(prices):
            try:
                return float(prices[i])
            except (ValueError, TypeError):
                return None
    return None


def fetch_orderbook(token_id):
    """Fetch orderbook from CLOB API for a token. Returns dict or None."""
    host = get_clob_host()
    url = f"{host}/book?token_id={token_id}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "polymarket-trade/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def snap_size_for_clob(amount_usdc, price):
    """Calculate shares so that shares*price has at most 2 decimal places.
    The CLOB API requires maker_amount (USDC) to have max 2 decimal precision.
    Uses Decimal to avoid floating-point drift."""
    from decimal import Decimal, ROUND_DOWN
    d_amount = Decimal(str(amount_usdc))
    d_price = Decimal(str(price))

    # Raw shares floored to 2 decimals (CLOB requires size ≤ 2 decimals)
    raw_shares = d_amount / d_price
    shares = raw_shares.quantize(Decimal("0.01"), rounding=ROUND_DOWN)

    # Verify maker_amount = shares * price has ≤ 2 decimals; reduce if not
    maker = shares * d_price
    max_dec = Decimal("0.01")
    attempts = 0
    while maker != maker.quantize(max_dec) and attempts < 10 and shares > 0:
        shares -= Decimal("0.01")
        maker = shares * d_price
        attempts += 1

    return float(shares), float(maker.quantize(max_dec, rounding=ROUND_DOWN))


def get_best_ask(orderbook):
    """Get best (lowest) ask price from orderbook."""
    asks = orderbook.get("asks", [])
    if not asks:
        return None
    try:
        return min(round(float(a.get("price", 0)), 4) for a in asks if float(a.get("price", 0)) > 0)
    except (ValueError, TypeError):
        return None


def get_best_bid(orderbook):
    """Get best (highest) bid price from orderbook."""
    bids = orderbook.get("bids", [])
    if not bids:
        return None
    try:
        return max(round(float(b.get("price", 0)), 4) for b in bids if float(b.get("price", 0)) > 0)
    except (ValueError, TypeError):
        return None


def _patch_clob_rounding():
    """Patch py_clob_client ROUNDING_CONFIG so maker/taker amounts use max 2 decimals.
    The CLOB API now enforces 'maker amount max 2 decimals' but the SDK's default
    config allows up to 5-6, causing PolyApiException 400 on FOK/GTC orders."""
    try:
        from py_clob_client.order_builder.builder import ROUNDING_CONFIG, RoundConfig
        for key in ROUNDING_CONFIG:
            old = ROUNDING_CONFIG[key]
            ROUNDING_CONFIG[key] = RoundConfig(price=old.price, size=old.size, amount=2)
    except Exception:
        pass  # Non-fatal — if SDK changes, we just skip the patch


def init_clob_client(wallet):
    """Initialize and authenticate CLOB client."""
    try:
        from py_clob_client.client import ClobClient
    except ImportError:
        return None, "py-clob-client not installed. Run: pip3 install py-clob-client"

    _patch_clob_rounding()

    host = get_clob_host()
    try:
        client = ClobClient(host, key=wallet["private_key"], chain_id=CHAIN_ID)
        api_creds = client.create_or_derive_api_creds()
        client.set_api_creds(api_creds)
        return client, None
    except (ConnectionRefusedError, ConnectionResetError, OSError) as e:
        if host != CLOB_HOST_DEFAULT:
            return None, f"CLOB proxy unreachable at {host}. The proxy server may be down or misconfigured. Try again in a few minutes or contact support."
        return None, f"CLOB client init failed: {e}"
    except Exception as e:
        err_str = str(e).lower()
        if host != CLOB_HOST_DEFAULT and ("connection" in err_str or "refused" in err_str or "unreachable" in err_str or "timeout" in err_str):
            return None, f"CLOB proxy unreachable at {host}. The proxy server may be down or misconfigured. Try again in a few minutes or contact support."
        return None, f"CLOB client init failed: {e}"


def log_trade(entry):
    """Append a trade entry to trade-log.json."""
    log = load_json(TRADE_LOG_FILE, [])
    log.append(entry)
    save_json(TRADE_LOG_FILE, log)


def update_trade_log_entry(order_id, updates):
    """Update an existing trade log entry by order_id."""
    log = load_json(TRADE_LOG_FILE, [])
    for entry in reversed(log):
        if entry.get("order_id") == order_id:
            entry.update(updates)
            break
    save_json(TRADE_LOG_FILE, log)


def update_positions(market_id, market_question, outcome, token_id, shares, avg_price, side):
    """Update positions.json after a trade."""
    positions = load_json(POSITIONS_FILE, [])

    existing = None
    for p in positions:
        if p.get("token_id") == token_id:
            existing = p
            break

    if side == "BUY":
        if existing:
            old_shares = existing.get("shares", 0)
            old_cost = existing.get("avg_price", 0) * old_shares
            new_cost = avg_price * shares
            total_shares = old_shares + shares
            existing["shares"] = total_shares
            existing["avg_price"] = (old_cost + new_cost) / total_shares if total_shares > 0 else 0
            existing["updated_at"] = datetime.now(timezone.utc).isoformat()
        else:
            positions.append({
                "market_id": market_id,
                "question": market_question,
                "outcome": outcome,
                "token_id": token_id,
                "shares": shares,
                "avg_price": avg_price,
                "opened_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
    elif side == "SELL":
        if existing:
            existing["shares"] = max(0, existing.get("shares", 0) - shares)
            existing["updated_at"] = datetime.now(timezone.utc).isoformat()
            if existing["shares"] <= 0:
                positions.remove(existing)

    save_json(POSITIONS_FILE, positions)


def get_rpc_url():
    """Read POLYGON_RPC_URL from env file, or find a working fallback."""
    if ENV_FILE.exists():
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line.startswith("POLYGON_RPC_URL="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val
    for rpc in RPC_FALLBACKS:
        try:
            payload = json.dumps({"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}).encode()
            req = urllib.request.Request(rpc, data=payload, headers={"Content-Type": "application/json"})
            resp = urllib.request.urlopen(req, timeout=5)
            data = json.loads(resp.read().decode())
            if "result" in data:
                return rpc
        except Exception:
            continue
    return RPC_FALLBACKS[0]


def get_clob_host():
    """Read CLOB host from env. US VMs use proxy; non-US connect direct."""
    if ENV_FILE.exists():
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if line.startswith("CLOB_PROXY_URL="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        return val
    return CLOB_HOST_DEFAULT


def check_usdc_balance(wallet_address):
    """Check USDC.e and native USDC balances. Returns (usdc_e, usdc_native) or (None, None)."""
    rpc_url = get_rpc_url()
    addr_padded = wallet_address[2:].lower().zfill(64)
    call_data = "0x70a08231" + addr_padded  # balanceOf(address)

    balances = {}
    for label, token_addr in [("usdc_e", USDC_E), ("usdc_native", USDC_NATIVE)]:
        try:
            payload = json.dumps({
                "jsonrpc": "2.0",
                "method": "eth_call",
                "params": [{"to": token_addr, "data": call_data}, "latest"],
                "id": 1,
            }).encode()
            req = urllib.request.Request(rpc_url, data=payload, headers={"Content-Type": "application/json"})
            resp = urllib.request.urlopen(req, timeout=10)
            data = json.loads(resp.read().decode())
            raw = data.get("result", "0x0")
            balances[label] = int(raw, 16) / 1e6 if raw and raw != "0x" else 0.0
        except Exception:
            balances[label] = None
    return balances.get("usdc_e"), balances.get("usdc_native")


def output_result(msg, json_mode=False, data=None):
    """Print result in appropriate format."""
    if json_mode and data is not None:
        print(json.dumps(data, indent=2))
    else:
        print(msg)


def _check_us_region_proxy():
    """Detect misconfigured US VM missing proxy. Returns (ok, error_data)."""
    agent_region = ""
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith("AGENT_REGION="):
                agent_region = line.split("=", 1)[1].strip().strip('"').strip("'")
    if agent_region.startswith("us") and get_clob_host() == CLOB_HOST_DEFAULT:
        return False, {
            "status": "FAIL",
            "error": "us_region_no_proxy",
            "detail": "This VM is in the US and Polymarket blocks trading from US IPs. The CLOB proxy has not been configured for this VM.",
            "suggestion": "Contact support to configure the proxy, or use Kalshi instead: python3 ~/scripts/kalshi-setup.py status",
        }
    return True, None


def check_proxy_risk_ack():
    """Check if risk acknowledgment is needed when using proxy. Returns (ok, reason)."""
    host = get_clob_host()
    if host == CLOB_HOST_DEFAULT:
        return True, None  # Direct connection, no ack needed
    # Using proxy — check acknowledgment file
    ack = load_json(RISK_ACK_FILE)
    if ack and ack.get("acknowledged") is True:
        return True, None
    return False, "BLOCK — Polymarket international markets require risk acknowledgment.\nRun: python3 ~/scripts/polymarket-trade.py acknowledge-risk"


def check_order_status(client, order_id, wait_seconds=3):
    """Check order status after placement. Returns status dict."""
    if wait_seconds > 0:
        time.sleep(wait_seconds)
    try:
        order = client.get_order(order_id)
        if isinstance(order, dict):
            status = order.get("status", "UNKNOWN")
            return {
                "order_id": order_id,
                "status": status,
                "size_matched": order.get("size_matched", "0"),
                "price": order.get("price", ""),
                "side": order.get("side", ""),
                "original_size": order.get("original_size", order.get("size", "")),
                "associate_trades": order.get("associate_trades", []),
            }
        return {"order_id": order_id, "status": "UNKNOWN"}
    except Exception:
        return {"order_id": order_id, "status": "UNKNOWN"}


def determine_fill_status(order_status_dict, order_type):
    """Determine fill status from order status check. Returns (fill_status, details)."""
    status = order_status_dict.get("status", "UNKNOWN").upper()
    size_matched = order_status_dict.get("size_matched", "0")

    try:
        matched_float = float(size_matched)
    except (ValueError, TypeError):
        matched_float = 0.0

    if status == "MATCHED" or matched_float > 0:
        return "MATCHED", {
            "shares_filled": matched_float,
            "trades": order_status_dict.get("associate_trades", []),
        }
    elif status == "LIVE":
        return "PENDING", {"message": "Order is live in the orderbook, waiting for a match"}
    elif status == "CANCELLED":
        return "CANCELLED", {"message": "Order was cancelled"}
    else:
        if order_type == "FOK":
            return "FAIL", {"message": f"FOK order not matched (status: {status})"}
        return "PENDING", {"message": f"Order status: {status}"}


def cmd_acknowledge_risk(args):
    """Write risk acknowledgment file for proxy-based trading."""
    save_json(RISK_ACK_FILE, {
        "acknowledged": True,
        "mode": "international",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "warning_shown": "Polymarket international markets not officially available in US. Funds could be restricted or frozen by Polymarket at any time. Use at your own risk.",
    })
    output_result(
        "OK — Risk acknowledgment saved. You can now trade via proxy.",
        getattr(args, 'json', False),
        {"status": "OK", "acknowledged": True},
    )
    return 0


# ---------------------------------------------------------------------------
# buy subcommand
# ---------------------------------------------------------------------------

def cmd_buy(args):
    """Execute a buy order."""
    from decimal import Decimal

    # 0a. Check US region proxy misconfiguration
    proxy_ok, proxy_err = _check_us_region_proxy()
    if not proxy_ok:
        output_result(proxy_err["detail"], args.json, proxy_err)
        return 1

    # 0. Check proxy risk acknowledgment
    ack_ok, ack_reason = check_proxy_risk_ack()
    if not ack_ok:
        output_result(
            ack_reason,
            args.json,
            {"status": "BLOCK", "error": "risk_ack_required"},
        )
        return 2

    # 1. Load and check risk config
    config = load_risk_config()
    if not config:
        output_result(
            "BLOCK — Risk config not found at ~/.openclaw/polymarket/risk-config.json",
            args.json,
            {"status": "BLOCK", "error": "risk_config_missing"},
        )
        return 2

    # 2. Load daily spend
    daily_spend = load_daily_spend()

    # FIX 2: Precision rounding on amount
    amount = round(float(args.amount), 2)

    # 3. Check risk limits
    ok, reason = check_risk_limits(amount, config, daily_spend)
    if not ok:
        output_result(
            f"BLOCK — {reason}",
            args.json,
            {"status": "BLOCK", "error": "risk_limit", "detail": reason},
        )
        return 2

    # 4. Load wallet
    wallet = load_wallet()
    if not wallet:
        output_result(
            "FAIL — No wallet found. Run: bash ~/scripts/setup-polymarket-wallet.sh",
            args.json,
            {"status": "FAIL", "error": "wallet_not_found"},
        )
        return 1

    # 5. Pre-trade balance check — detect wrong USDC type
    usdc_e_bal, usdc_native_bal = check_usdc_balance(wallet["address"])
    if usdc_e_bal is not None and usdc_native_bal is not None:
        if usdc_e_bal < amount and usdc_native_bal > 0:
            output_result(
                f"FAIL — Wrong USDC type. You have ${usdc_native_bal:.2f} native USDC but "
                f"Polymarket requires USDC.e (bridged). Your USDC.e balance is ${usdc_e_bal:.2f}.\n"
                f"  To fix: deposit through https://polymarket.com (auto-converts),\n"
                f"  or swap native USDC to USDC.e on a Polygon DEX (Uniswap, QuickSwap).\n"
                f"  USDC.e contract: 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174\n"
                f"  Native USDC contract: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
                args.json,
                {
                    "status": "FAIL",
                    "error": "wrong_usdc_type",
                    "usdc_e_balance": usdc_e_bal,
                    "usdc_native_balance": usdc_native_bal,
                    "fix": "Deposit through polymarket.com to auto-convert, or swap native USDC to USDC.e on a Polygon DEX",
                },
            )
            return 1
        if usdc_e_bal < amount and usdc_native_bal == 0:
            output_result(
                f"FAIL — Insufficient USDC.e balance: ${usdc_e_bal:.2f} < ${amount:.2f} needed.\n"
                f"  Fund wallet: {wallet['address']}",
                args.json,
                {"status": "FAIL", "error": "insufficient_balance", "usdc_e_balance": usdc_e_bal, "address": wallet["address"]},
            )
            return 1

    # 6. Fetch market info
    market = fetch_market_info(args.market_id)
    if not market:
        output_result(
            f"FAIL — Market {args.market_id} not found on Gamma API",
            args.json,
            {"status": "FAIL", "error": "market_not_found", "market_id": args.market_id},
        )
        return 1

    # 7. Get token ID
    token_id = get_token_id(market, args.outcome)
    if not token_id:
        outcomes = json.loads(market.get("outcomes", "[]"))
        output_result(
            f"FAIL — Outcome '{args.outcome}' not found. Available: {outcomes}",
            args.json,
            {"status": "FAIL", "error": "outcome_not_found", "available": outcomes},
        )
        return 1

    # 8. Determine order type and price
    order_type_str = args.order_type  # default FOK

    if order_type_str == "FOK" and not args.price:
        # FIX 1: For FOK orders, fetch orderbook to get best ask
        orderbook = fetch_orderbook(token_id)
        if not orderbook:
            output_result(
                "FAIL — Could not fetch orderbook for FOK pricing. Try --order-type GTC with --price.",
                args.json,
                {"status": "FAIL", "error": "orderbook_unavailable"},
            )
            return 1
        price = get_best_ask(orderbook)
        if not price or price <= 0:
            output_result(
                "FAIL — No asks in orderbook (no liquidity). Cannot place FOK buy.",
                args.json,
                {"status": "FAIL", "error": "no_liquidity", "detail": "No asks available in orderbook"},
            )
            return 1
    elif args.price:
        price = round(float(args.price), 4)
    else:
        price = get_current_price(market, args.outcome)
        if not price or price <= 0:
            output_result(
                "FAIL — Could not determine market price. Use --price to set manually.",
                args.json,
                {"status": "FAIL", "error": "price_unavailable"},
            )
            return 1

    # FIX 2: Precision rounding on price
    price = round(float(price), 4)

    # 9. Calculate shares
    if price <= 0 or price >= 1:
        output_result(
            f"FAIL — Invalid price {price}. Must be between 0 and 1.",
            args.json,
            {"status": "FAIL", "error": "invalid_price"},
        )
        return 1

    # FIX 3: Snap shares so maker_amount (shares*price) has ≤ 2 decimals
    # The CLOB API rejects orders where maker_amount exceeds 2 decimal precision.
    shares, _ = snap_size_for_clob(amount, price)
    if shares <= 0:
        output_result(
            f"FAIL — Amount ${amount:.2f} too small for price {price:.4f}.",
            args.json,
            {"status": "FAIL", "error": "amount_too_small"},
        )
        return 1

    # 10. Init CLOB client
    client, err = init_clob_client(wallet)
    if not client:
        output_result(
            f"FAIL — {err}",
            args.json,
            {"status": "FAIL", "error": "clob_init_failed", "detail": err},
        )
        return 1

    # 11. Build and post order
    try:
        from py_clob_client.clob_types import OrderArgs, OrderType
        from py_clob_client.order_builder.constants import BUY

        order_type_map = {"GTC": OrderType.GTC, "FOK": OrderType.FOK}
        order_type = order_type_map.get(order_type_str, OrderType.FOK)

        order_args = OrderArgs(
            price=price,
            size=shares,
            side=BUY,
            token_id=token_id,
        )

        signed_order = client.create_order(order_args)
        resp = client.post_order(signed_order, order_type)
    except Exception as e:
        err_str = str(e)
        if "insufficient" in err_str.lower() or "balance" in err_str.lower():
            output_result(
                f"FAIL — Insufficient balance. Fund wallet: {wallet['address']}",
                args.json,
                {"status": "FAIL", "error": "insufficient_balance", "address": wallet["address"]},
            )
            return 1
        if "approval" in err_str.lower() or "allowance" in err_str.lower():
            output_result(
                "FAIL — Token approvals needed. Run: python3 ~/scripts/polymarket-setup-creds.py approve",
                args.json,
                {"status": "FAIL", "error": "approval_needed"},
            )
            return 1
        output_result(
            f"FAIL — Order failed: {e}",
            args.json,
            {"status": "FAIL", "error": "order_failed", "detail": err_str},
        )
        return 1

    # 12. Parse response
    if isinstance(resp, dict):
        order_id = resp.get("orderID", resp.get("order_id", ""))
        status = resp.get("status", "unknown")
        tx_hashes = resp.get("transactionsHashes", resp.get("transactionHashes", []))
        taking = resp.get("takingAmount", "")
        making = resp.get("makingAmount", "")
    else:
        order_id = str(resp)
        status = "unknown"
        tx_hashes = []
        taking = ""
        making = ""

    # FIX 3: Check order status after placement
    fill_status = "UNKNOWN"
    fill_details = {}
    if order_id:
        order_status = check_order_status(client, order_id, wait_seconds=3)
        fill_status, fill_details = determine_fill_status(order_status, order_type_str)

        # For FOK: if not MATCHED, report FAIL
        if order_type_str == "FOK" and fill_status != "MATCHED":
            market_question = market.get("question", "Unknown")
            log_entry = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "action": "BUY",
                "market_id": args.market_id,
                "condition_id": args.market_id,
                "market_question": market_question,
                "outcome": args.outcome,
                "token_id": token_id,
                "amount_usdc": amount,
                "price": price,
                "shares": shares,
                "order_type": order_type_str,
                "order_id": order_id,
                "status": status,
                "fill_status": fill_status,
                "tx_hashes": tx_hashes,
            }
            log_trade(log_entry)
            output_result(
                f"FAIL — FOK order not filled. Status: {fill_status}. No shares acquired.\n"
                f"  Market: {market_question}\n"
                f"  The order was not matched — likely insufficient liquidity at price ${price:.4f}.\n"
                f"  Try: --order-type GTC for a limit order, or check liquidity with: price --market-id {args.market_id}",
                args.json,
                {
                    "status": "FAIL",
                    "error": "fok_not_filled",
                    "fill_status": fill_status,
                    "order_id": order_id,
                    "price_attempted": price,
                    "detail": fill_details.get("message", ""),
                },
            )
            return 1

    # 13. Update daily spend (only if order was placed successfully)
    daily_spend["total_spent_usdc"] = daily_spend.get("total_spent_usdc", 0) + amount
    daily_spend["trade_count"] = daily_spend.get("trade_count", 0) + 1
    save_json(DAILY_SPEND_FILE, daily_spend)

    # 14. Log trade — FIX 9: Enhanced trade log
    market_question = market.get("question", "Unknown")
    log_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": "BUY",
        "market_id": args.market_id,
        "condition_id": args.market_id,
        "market_question": market_question,
        "outcome": args.outcome,
        "token_id": token_id,
        "amount_usdc": amount,
        "price": price,
        "shares": shares,
        "order_type": order_type_str,
        "order_id": order_id,
        "status": status,
        "fill_status": fill_status,
        "tx_hashes": tx_hashes,
    }
    log_trade(log_entry)

    # 15. Update positions (only if actually filled)
    if fill_status == "MATCHED":
        filled_shares = fill_details.get("shares_filled", shares)
        update_positions(args.market_id, market_question, args.outcome, token_id, filled_shares, price, "BUY")
    elif fill_status == "UNKNOWN" and status != "CANCELLED":
        # Legacy fallback: update positions if we can't determine fill status
        update_positions(args.market_id, market_question, args.outcome, token_id, shares, price, "BUY")

    # 16. Output
    result = {
        "status": "OK",
        "action": "BUY",
        "market_question": market_question,
        "outcome": args.outcome,
        "amount_usdc": amount,
        "price": price,
        "shares": shares,
        "order_id": order_id,
        "order_type": order_type_str,
        "order_status": status,
        "fill_status": fill_status,
        "tx_hashes": tx_hashes,
    }
    if fill_details:
        result["fill_details"] = fill_details

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"OK — BUY order placed ({order_type_str})")
        print(f"  Market: {market_question}")
        print(f"  Outcome: {args.outcome}")
        print(f"  Amount: ${amount:.2f} USDC")
        print(f"  Price: ${price:.4f} ({price*100:.1f}% implied)")
        print(f"  Shares: {shares:.2f}")
        print(f"  Order ID: {order_id}")
        print(f"  Fill Status: {fill_status}")
        if fill_status == "MATCHED":
            filled = fill_details.get("shares_filled", shares)
            print(f"  Shares Filled: {filled:.2f}")
        elif fill_status == "PENDING":
            print(f"  ⚠ Order is PENDING in orderbook — not yet filled")
            print(f"  Check: python3 ~/scripts/polymarket-trade.py check-orders")
        if tx_hashes:
            for tx in tx_hashes:
                print(f"  Tx: https://polygonscan.com/tx/{tx}")

    return 0


# ---------------------------------------------------------------------------
# sell subcommand
# ---------------------------------------------------------------------------

def cmd_sell(args):
    """Execute a sell order."""

    # 0a. Check US region proxy misconfiguration
    proxy_ok, proxy_err = _check_us_region_proxy()
    if not proxy_ok:
        output_result(proxy_err["detail"], args.json, proxy_err)
        return 1

    # 0. Check proxy risk acknowledgment
    ack_ok, ack_reason = check_proxy_risk_ack()
    if not ack_ok:
        output_result(
            ack_reason,
            args.json,
            {"status": "BLOCK", "error": "risk_ack_required"},
        )
        return 2

    # 1. Load risk config
    config = load_risk_config()
    if not config:
        output_result(
            "BLOCK — Risk config not found",
            args.json,
            {"status": "BLOCK", "error": "risk_config_missing"},
        )
        return 2

    if not config.get("enabled"):
        output_result(
            "BLOCK — Trading is disabled in risk-config.json",
            args.json,
            {"status": "BLOCK", "error": "trading_disabled"},
        )
        return 2

    # 2. Load wallet
    wallet = load_wallet()
    if not wallet:
        output_result(
            "FAIL — No wallet found. Run: bash ~/scripts/setup-polymarket-wallet.sh",
            args.json,
            {"status": "FAIL", "error": "wallet_not_found"},
        )
        return 1

    # 3. Fetch market info
    market = fetch_market_info(args.market_id)
    if not market:
        output_result(
            f"FAIL — Market {args.market_id} not found",
            args.json,
            {"status": "FAIL", "error": "market_not_found"},
        )
        return 1

    # 4. Get token ID
    token_id = get_token_id(market, args.outcome)
    if not token_id:
        outcomes = json.loads(market.get("outcomes", "[]"))
        output_result(
            f"FAIL — Outcome '{args.outcome}' not found. Available: {outcomes}",
            args.json,
            {"status": "FAIL", "error": "outcome_not_found", "available": outcomes},
        )
        return 1

    # Precision rounding on shares (2 decimals max for CLOB)
    sell_shares = round(float(args.shares), 2)

    # 5. Determine order type and price
    order_type_str = args.order_type  # default FOK

    if order_type_str == "FOK" and not args.price:
        # FIX 1: For FOK sell orders, fetch orderbook to get best bid
        orderbook = fetch_orderbook(token_id)
        if not orderbook:
            output_result(
                "FAIL — Could not fetch orderbook for FOK pricing. Try --order-type GTC with --price.",
                args.json,
                {"status": "FAIL", "error": "orderbook_unavailable"},
            )
            return 1
        price = get_best_bid(orderbook)
        if not price or price <= 0:
            output_result(
                "FAIL — No bids in orderbook (no liquidity). Cannot place FOK sell.",
                args.json,
                {"status": "FAIL", "error": "no_liquidity", "detail": "No bids available in orderbook"},
            )
            return 1
    elif args.price:
        price = round(float(args.price), 4)
    else:
        price = get_current_price(market, args.outcome)
        if not price or price <= 0:
            output_result(
                "FAIL — Could not determine market price. Use --price to set manually.",
                args.json,
                {"status": "FAIL", "error": "price_unavailable"},
            )
            return 1

    # FIX 3: Precision — snap sell_shares so taker_amount (shares*price) ≤ 2 decimals
    price = round(float(price), 4)
    snapped, _ = snap_size_for_clob(sell_shares * price, price)
    if snapped < sell_shares:
        sell_shares = snapped

    # 6. Init CLOB client
    client, err = init_clob_client(wallet)
    if not client:
        output_result(
            f"FAIL — {err}",
            args.json,
            {"status": "FAIL", "error": "clob_init_failed", "detail": err},
        )
        return 1

    # 7. Build and post sell order
    try:
        from py_clob_client.clob_types import OrderArgs, OrderType
        from py_clob_client.order_builder.constants import SELL

        order_type_map = {"GTC": OrderType.GTC, "FOK": OrderType.FOK}
        order_type = order_type_map.get(order_type_str, OrderType.FOK)

        order_args = OrderArgs(
            price=price,
            size=sell_shares,
            side=SELL,
            token_id=token_id,
        )

        signed_order = client.create_order(order_args)
        resp = client.post_order(signed_order, order_type)
    except Exception as e:
        output_result(
            f"FAIL — Sell order failed: {e}",
            args.json,
            {"status": "FAIL", "error": "order_failed", "detail": str(e)},
        )
        return 1

    # 8. Parse response
    if isinstance(resp, dict):
        order_id = resp.get("orderID", resp.get("order_id", ""))
        status = resp.get("status", "unknown")
        tx_hashes = resp.get("transactionsHashes", resp.get("transactionHashes", []))
    else:
        order_id = str(resp)
        status = "unknown"
        tx_hashes = []

    # FIX 3: Check order status after placement
    fill_status = "UNKNOWN"
    fill_details = {}
    if order_id:
        order_status = check_order_status(client, order_id, wait_seconds=3)
        fill_status, fill_details = determine_fill_status(order_status, order_type_str)

        # For FOK: if not MATCHED, report FAIL
        if order_type_str == "FOK" and fill_status != "MATCHED":
            market_question = market.get("question", "Unknown")
            log_entry = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "action": "SELL",
                "market_id": args.market_id,
                "condition_id": args.market_id,
                "market_question": market_question,
                "outcome": args.outcome,
                "token_id": token_id,
                "shares": sell_shares,
                "price": price,
                "value_usdc": round(price * sell_shares, 2),
                "order_type": order_type_str,
                "order_id": order_id,
                "status": status,
                "fill_status": fill_status,
                "tx_hashes": tx_hashes,
            }
            log_trade(log_entry)
            output_result(
                f"FAIL — FOK sell order not filled. Status: {fill_status}. No shares sold.\n"
                f"  Market: {market_question}\n"
                f"  Try: --order-type GTC for a limit order, or check liquidity with: price --market-id {args.market_id}",
                args.json,
                {
                    "status": "FAIL",
                    "error": "fok_not_filled",
                    "fill_status": fill_status,
                    "order_id": order_id,
                    "price_attempted": price,
                    "detail": fill_details.get("message", ""),
                },
            )
            return 1

    # 9. Log trade — FIX 9: Enhanced trade log
    market_question = market.get("question", "Unknown")
    sale_value = round(price * sell_shares, 2)
    log_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": "SELL",
        "market_id": args.market_id,
        "condition_id": args.market_id,
        "market_question": market_question,
        "outcome": args.outcome,
        "token_id": token_id,
        "shares": sell_shares,
        "price": price,
        "value_usdc": sale_value,
        "order_type": order_type_str,
        "order_id": order_id,
        "status": status,
        "fill_status": fill_status,
        "tx_hashes": tx_hashes,
    }
    log_trade(log_entry)

    # 10. Update positions (only if actually filled)
    if fill_status == "MATCHED":
        filled_shares = fill_details.get("shares_filled", sell_shares)
        update_positions(args.market_id, market_question, args.outcome, token_id, filled_shares, price, "SELL")
    elif fill_status == "UNKNOWN" and status != "CANCELLED":
        update_positions(args.market_id, market_question, args.outcome, token_id, sell_shares, price, "SELL")

    # 11. Output
    result = {
        "status": "OK",
        "action": "SELL",
        "market_question": market_question,
        "outcome": args.outcome,
        "shares": sell_shares,
        "price": price,
        "value_usdc": sale_value,
        "order_id": order_id,
        "order_type": order_type_str,
        "order_status": status,
        "fill_status": fill_status,
        "tx_hashes": tx_hashes,
    }
    if fill_details:
        result["fill_details"] = fill_details

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"OK — SELL order placed ({order_type_str})")
        print(f"  Market: {market_question}")
        print(f"  Outcome: {args.outcome}")
        print(f"  Shares: {sell_shares:.2f}")
        print(f"  Price: ${price:.4f} ({price*100:.1f}% implied)")
        print(f"  Value: ${sale_value:.2f} USDC")
        print(f"  Order ID: {order_id}")
        print(f"  Fill Status: {fill_status}")
        if fill_status == "MATCHED":
            filled = fill_details.get("shares_filled", sell_shares)
            print(f"  Shares Filled: {filled:.2f}")
        elif fill_status == "PENDING":
            print(f"  ⚠ Order is PENDING in orderbook — not yet filled")
            print(f"  Check: python3 ~/scripts/polymarket-trade.py check-orders")
        if tx_hashes:
            for tx in tx_hashes:
                print(f"  Tx: https://polygonscan.com/tx/{tx}")

    return 0


# ---------------------------------------------------------------------------
# cancel subcommand
# ---------------------------------------------------------------------------

def cmd_cancel(args):
    """Cancel an order or all orders."""
    wallet = load_wallet()
    if not wallet:
        output_result("FAIL — No wallet found", args.json, {"status": "FAIL", "error": "wallet_not_found"})
        return 1

    client, err = init_clob_client(wallet)
    if not client:
        output_result(f"FAIL — {err}", args.json, {"status": "FAIL", "error": "clob_init_failed"})
        return 1

    try:
        if args.all:
            resp = client.cancel_all()
            output_result(
                "OK — All open orders cancelled",
                args.json,
                {"status": "OK", "action": "cancel_all", "response": str(resp)},
            )
        elif args.order_id:
            resp = client.cancel(order_id=args.order_id)
            output_result(
                f"OK — Order {args.order_id} cancelled",
                args.json,
                {"status": "OK", "action": "cancel", "order_id": args.order_id, "response": str(resp)},
            )
        else:
            output_result(
                "FAIL — Provide --order-id or --all",
                args.json,
                {"status": "FAIL", "error": "missing_argument"},
            )
            return 1
    except Exception as e:
        output_result(
            f"FAIL — Cancel failed: {e}",
            args.json,
            {"status": "FAIL", "error": "cancel_failed", "detail": str(e)},
        )
        return 1

    return 0


# ---------------------------------------------------------------------------
# orders subcommand
# ---------------------------------------------------------------------------

def cmd_orders(args):
    """List open orders."""
    wallet = load_wallet()
    if not wallet:
        output_result("FAIL — No wallet found", args.json, {"status": "FAIL", "error": "wallet_not_found"})
        return 1

    client, err = init_clob_client(wallet)
    if not client:
        output_result(f"FAIL — {err}", args.json, {"status": "FAIL", "error": "clob_init_failed"})
        return 1

    try:
        orders = client.get_orders()
    except Exception as e:
        output_result(
            f"FAIL — Could not fetch orders: {e}",
            args.json,
            {"status": "FAIL", "error": "fetch_failed", "detail": str(e)},
        )
        return 1

    if args.json:
        print(json.dumps({"status": "OK", "orders": orders}, indent=2))
    else:
        if not orders:
            print("OK — No open orders")
        else:
            print(f"OK — {len(orders)} open order(s):\n")
            for o in orders:
                oid = o.get("id", o.get("order_id", "?"))
                side = o.get("side", "?")
                price = o.get("price", "?")
                size = o.get("original_size", o.get("size", "?"))
                matched = o.get("size_matched", "0")
                status = o.get("status", "?")
                print(f"  {oid}  {side} {size} @ ${price}  matched={matched}  status={status}")

    return 0


# ---------------------------------------------------------------------------
# FIX 4: check-orders subcommand
# ---------------------------------------------------------------------------

def cmd_check_orders(args):
    """List all open/pending orders with enriched detail."""
    wallet = load_wallet()
    if not wallet:
        output_result("FAIL — No wallet found", args.json, {"status": "FAIL", "error": "wallet_not_found"})
        return 1

    client, err = init_clob_client(wallet)
    if not client:
        output_result(f"FAIL — {err}", args.json, {"status": "FAIL", "error": "clob_init_failed"})
        return 1

    try:
        orders = client.get_orders()
    except Exception as e:
        output_result(
            f"FAIL — Could not fetch orders: {e}",
            args.json,
            {"status": "FAIL", "error": "fetch_failed", "detail": str(e)},
        )
        return 1

    if not orders:
        output_result("OK — No open orders", args.json, {"status": "OK", "orders": [], "count": 0})
        return 0

    # Enrich with trade log data for market question
    trade_log = load_json(TRADE_LOG_FILE, [])
    order_id_to_question = {}
    for t in trade_log:
        oid = t.get("order_id", "")
        if oid:
            order_id_to_question[oid] = t.get("market_question", "")

    enriched = []
    now = datetime.now(timezone.utc)
    for o in orders:
        oid = o.get("id", o.get("order_id", "?"))
        side = o.get("side", "?")
        price = o.get("price", "?")
        size = o.get("original_size", o.get("size", "?"))
        matched = o.get("size_matched", "0")
        status = o.get("status", "?")
        order_type = o.get("type", o.get("order_type", "?"))
        created = o.get("created_at", o.get("timestamp", ""))

        question = order_id_to_question.get(oid, "")

        wait_duration = ""
        if created:
            try:
                created_dt = datetime.fromisoformat(created.replace("Z", "+00:00"))
                delta = now - created_dt
                minutes = int(delta.total_seconds() // 60)
                if minutes < 60:
                    wait_duration = f"{minutes}m"
                else:
                    wait_duration = f"{minutes // 60}h {minutes % 60}m"
            except Exception:
                pass

        entry = {
            "order_id": oid,
            "market_question": question,
            "side": side,
            "price": price,
            "size": size,
            "size_matched": matched,
            "status": status,
            "order_type": order_type,
            "created_at": created,
            "wait_duration": wait_duration,
        }
        enriched.append(entry)

    if args.json:
        print(json.dumps({"status": "OK", "orders": enriched, "count": len(enriched)}, indent=2))
    else:
        print(f"=== Open Orders ({len(enriched)}) ===\n")
        for e in enriched:
            print(f"  Order: {e['order_id']}")
            if e["market_question"]:
                print(f"    Market: {e['market_question']}")
            print(f"    Side: {e['side']}  |  Price: ${e['price']}  |  Size: {e['size']}  |  Matched: {e['size_matched']}")
            print(f"    Type: {e['order_type']}  |  Status: {e['status']}  |  Waiting: {e['wait_duration'] or 'N/A'}")
            print()

    return 0


# ---------------------------------------------------------------------------
# FIX 4: cancel-all subcommand
# ---------------------------------------------------------------------------

def cmd_cancel_all(args):
    """Cancel all open GTC orders and report capital freed."""
    wallet = load_wallet()
    if not wallet:
        output_result("FAIL — No wallet found", args.json, {"status": "FAIL", "error": "wallet_not_found"})
        return 1

    client, err = init_clob_client(wallet)
    if not client:
        output_result(f"FAIL — {err}", args.json, {"status": "FAIL", "error": "clob_init_failed"})
        return 1

    # First, count open orders
    try:
        orders = client.get_orders()
    except Exception as e:
        output_result(
            f"FAIL — Could not fetch orders: {e}",
            args.json,
            {"status": "FAIL", "error": "fetch_failed"},
        )
        return 1

    if not orders:
        output_result("OK — No open orders to cancel", args.json, {"status": "OK", "cancelled": 0, "capital_freed": 0})
        return 0

    # Estimate capital tied up
    capital_freed = 0.0
    for o in orders:
        try:
            price = float(o.get("price", 0))
            size = float(o.get("original_size", o.get("size", 0)))
            matched = float(o.get("size_matched", 0))
            remaining = size - matched
            if remaining > 0:
                capital_freed += price * remaining
        except (ValueError, TypeError):
            pass

    # Cancel all
    try:
        resp = client.cancel_all()
    except Exception as e:
        output_result(
            f"FAIL — Cancel all failed: {e}",
            args.json,
            {"status": "FAIL", "error": "cancel_failed", "detail": str(e)},
        )
        return 1

    result = {
        "status": "OK",
        "action": "cancel_all",
        "cancelled": len(orders),
        "capital_freed_estimate": round(capital_freed, 2),
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"OK — Cancelled {len(orders)} open order(s)")
        print(f"  Estimated capital freed: ~${capital_freed:.2f} USDC")

    return 0


# ---------------------------------------------------------------------------
# FIX 5: price subcommand
# ---------------------------------------------------------------------------

def cmd_price(args):
    """Show orderbook pricing and liquidity for a market."""
    market = fetch_market_info(args.market_id)
    if not market:
        output_result(
            f"FAIL — Market {args.market_id} not found on Gamma API",
            args.json,
            {"status": "FAIL", "error": "market_not_found"},
        )
        return 1

    question = market.get("question", "Unknown")
    volume_24h = market.get("volume24hr", 0)
    tokens = get_all_token_ids(market)

    results = []
    for tok in tokens:
        outcome = tok["outcome"]
        token_id = tok["token_id"]

        orderbook = fetch_orderbook(token_id)
        if not orderbook:
            results.append({
                "outcome": outcome,
                "token_id": token_id,
                "error": "Could not fetch orderbook",
            })
            continue

        best_bid = get_best_bid(orderbook)
        best_ask = get_best_ask(orderbook)
        mid_price = None
        spread = None
        if best_bid is not None and best_ask is not None:
            mid_price = round((best_bid + best_ask) / 2, 4)
            spread = round(best_ask - best_bid, 4)

        results.append({
            "outcome": outcome,
            "token_id": token_id,
            "best_bid": best_bid,
            "best_ask": best_ask,
            "mid_price": mid_price,
            "spread": spread,
            "bid_count": len(orderbook.get("bids", [])),
            "ask_count": len(orderbook.get("asks", [])),
        })

    output = {
        "status": "OK",
        "market_question": question,
        "market_id": args.market_id,
        "volume_24h": volume_24h,
        "outcomes": results,
    }

    if args.json:
        print(json.dumps(output, indent=2))
    else:
        print(f"=== Market Price: {question} ===\n")
        try:
            vol_str = f"${float(volume_24h):,.0f}"
        except (ValueError, TypeError):
            vol_str = str(volume_24h)
        print(f"  24h Volume: {vol_str}")
        if float(volume_24h or 0) < 10000:
            print(f"  ⚠ LOW LIQUIDITY WARNING: 24h volume < $10,000")
        print()

        for r in results:
            if "error" in r:
                print(f"  {r['outcome']}: {r['error']}")
                continue
            bid_str = f"${r['best_bid']:.4f}" if r['best_bid'] is not None else "N/A"
            ask_str = f"${r['best_ask']:.4f}" if r['best_ask'] is not None else "N/A"
            mid_str = f"${r['mid_price']:.4f}" if r['mid_price'] is not None else "N/A"
            spread_str = f"${r['spread']:.4f}" if r['spread'] is not None else "N/A"
            print(f"  {r['outcome']}:")
            print(f"    Best Bid: {bid_str}  |  Best Ask: {ask_str}")
            print(f"    Mid Price: {mid_str}  |  Spread: {spread_str}")
            print(f"    Orderbook: {r['bid_count']} bids, {r['ask_count']} asks")
            print()

    return 0


# ---------------------------------------------------------------------------
# FIX 6: convert-to-market subcommand
# ---------------------------------------------------------------------------

def cmd_convert_to_market(args):
    """Cancel a GTC order and replace with FOK at current best price."""
    wallet = load_wallet()
    if not wallet:
        output_result("FAIL — No wallet found", args.json, {"status": "FAIL", "error": "wallet_not_found"})
        return 1

    client, err = init_clob_client(wallet)
    if not client:
        output_result(f"FAIL — {err}", args.json, {"status": "FAIL", "error": "clob_init_failed"})
        return 1

    # 1. Get order details before cancelling
    try:
        order_info = client.get_order(args.order_id)
    except Exception as e:
        output_result(
            f"FAIL — Could not fetch order {args.order_id}: {e}",
            args.json,
            {"status": "FAIL", "error": "order_not_found", "detail": str(e)},
        )
        return 1

    if not isinstance(order_info, dict):
        output_result(
            f"FAIL — Invalid order data for {args.order_id}",
            args.json,
            {"status": "FAIL", "error": "invalid_order"},
        )
        return 1

    side = order_info.get("side", "").upper()
    token_id = order_info.get("asset_id", order_info.get("token_id", ""))
    original_size = float(order_info.get("original_size", order_info.get("size", 0)))
    size_matched = float(order_info.get("size_matched", 0))
    remaining_size = round(original_size - size_matched, 2)

    if remaining_size <= 0:
        output_result(
            "FAIL — Order is already fully filled, nothing to convert",
            args.json,
            {"status": "FAIL", "error": "already_filled"},
        )
        return 1

    # 2. Cancel the GTC order
    try:
        client.cancel(order_id=args.order_id)
    except Exception as e:
        output_result(
            f"FAIL — Could not cancel order {args.order_id}: {e}",
            args.json,
            {"status": "FAIL", "error": "cancel_failed", "detail": str(e)},
        )
        return 1

    # 3. Get current best price from orderbook
    orderbook = fetch_orderbook(token_id)
    if not orderbook:
        output_result(
            f"FAIL — Cancelled order {args.order_id} but could not fetch orderbook for FOK replacement. "
            f"Remaining {remaining_size} shares are now unordered.",
            args.json,
            {"status": "FAIL", "error": "orderbook_unavailable", "cancelled_order_id": args.order_id},
        )
        return 1

    if side == "BUY" or side == "B":
        fok_price = get_best_ask(orderbook)
        if not fok_price:
            output_result(
                f"FAIL — Cancelled order but no asks in orderbook. Remaining {remaining_size} shares unordered.",
                args.json,
                {"status": "FAIL", "error": "no_liquidity", "cancelled_order_id": args.order_id},
            )
            return 1
    else:
        fok_price = get_best_bid(orderbook)
        if not fok_price:
            output_result(
                f"FAIL — Cancelled order but no bids in orderbook. Remaining {remaining_size} shares unordered.",
                args.json,
                {"status": "FAIL", "error": "no_liquidity", "cancelled_order_id": args.order_id},
            )
            return 1

    fok_price = round(float(fok_price), 4)

    # FIX 3: Snap remaining_size for CLOB precision
    if side == "BUY" or side == "B":
        remaining_size, _ = snap_size_for_clob(remaining_size * fok_price, fok_price)
    else:
        snapped, _ = snap_size_for_clob(remaining_size * fok_price, fok_price)
        if snapped < remaining_size:
            remaining_size = snapped

    # 4. Place FOK order
    try:
        from py_clob_client.clob_types import OrderArgs, OrderType
        from py_clob_client.order_builder.constants import BUY as BUY_SIDE, SELL as SELL_SIDE

        order_side = BUY_SIDE if (side == "BUY" or side == "B") else SELL_SIDE

        order_args = OrderArgs(
            price=fok_price,
            size=remaining_size,
            side=order_side,
            token_id=token_id,
        )
        signed_order = client.create_order(order_args)
        resp = client.post_order(signed_order, OrderType.FOK)
    except Exception as e:
        output_result(
            f"FAIL — Cancelled old order but FOK replacement failed: {e}\n"
            f"  Remaining {remaining_size} shares are unordered.",
            args.json,
            {"status": "FAIL", "error": "fok_failed", "cancelled_order_id": args.order_id, "detail": str(e)},
        )
        return 1

    # 5. Parse response and check status
    if isinstance(resp, dict):
        new_order_id = resp.get("orderID", resp.get("order_id", ""))
        new_status = resp.get("status", "unknown")
    else:
        new_order_id = str(resp)
        new_status = "unknown"

    fill_status = "UNKNOWN"
    fill_details = {}
    if new_order_id:
        order_status = check_order_status(client, new_order_id, wait_seconds=3)
        fill_status, fill_details = determine_fill_status(order_status, "FOK")

    result = {
        "status": "OK" if fill_status == "MATCHED" else "FAIL",
        "action": "convert_to_market",
        "cancelled_order_id": args.order_id,
        "new_order_id": new_order_id,
        "side": side,
        "size": remaining_size,
        "fok_price": fok_price,
        "fill_status": fill_status,
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        if fill_status == "MATCHED":
            print(f"OK — Converted to market order (FOK)")
            print(f"  Cancelled: {args.order_id}")
            print(f"  New Order: {new_order_id}")
            print(f"  Side: {side}  |  Size: {remaining_size:.2f}  |  Price: ${fok_price:.4f}")
            print(f"  Fill Status: MATCHED")
        else:
            print(f"FAIL — Cancelled GTC order but FOK replacement did not fill")
            print(f"  Cancelled: {args.order_id}")
            print(f"  FOK Status: {fill_status}")
            print(f"  Remaining {remaining_size} shares are unordered")

    return 0 if fill_status == "MATCHED" else 1


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Polymarket trade execution with risk enforcement",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    # buy
    sp_buy = subparsers.add_parser("buy", help="Buy shares in a market outcome")
    sp_buy.add_argument("--market-id", required=True, help="Gamma API market ID (condition_id)")
    sp_buy.add_argument("--outcome", required=True, help="Outcome to buy (e.g. YES, NO)")
    sp_buy.add_argument("--amount", required=True, type=float, help="USDC amount to spend")
    sp_buy.add_argument("--price", type=float, help="Limit price (0-1). For GTC orders or to override FOK auto-pricing.")
    sp_buy.add_argument("--order-type", default="FOK", choices=["GTC", "FOK"], help="Order type (default: FOK — fill-or-kill for immediate execution)")
    sp_buy.add_argument("--json", action="store_true", help="Output as JSON")

    # sell
    sp_sell = subparsers.add_parser("sell", help="Sell shares in a market outcome")
    sp_sell.add_argument("--market-id", required=True, help="Gamma API market ID (condition_id)")
    sp_sell.add_argument("--outcome", required=True, help="Outcome to sell (e.g. YES, NO)")
    sp_sell.add_argument("--shares", required=True, type=float, help="Number of shares to sell")
    sp_sell.add_argument("--price", type=float, help="Limit price (0-1). For GTC orders or to override FOK auto-pricing.")
    sp_sell.add_argument("--order-type", default="FOK", choices=["GTC", "FOK"], help="Order type (default: FOK — fill-or-kill for immediate execution)")
    sp_sell.add_argument("--json", action="store_true", help="Output as JSON")

    # cancel
    sp_cancel = subparsers.add_parser("cancel", help="Cancel an order")
    sp_cancel.add_argument("--order-id", help="Order ID to cancel")
    sp_cancel.add_argument("--all", action="store_true", help="Cancel all open orders")
    sp_cancel.add_argument("--json", action="store_true", help="Output as JSON")

    # orders
    sp_orders = subparsers.add_parser("orders", help="List open orders (basic)")
    sp_orders.add_argument("--json", action="store_true", help="Output as JSON")

    # check-orders (FIX 4)
    sp_check = subparsers.add_parser("check-orders", help="List open orders with enriched detail (market, wait time)")
    sp_check.add_argument("--json", action="store_true", help="Output as JSON")

    # cancel-all (FIX 4)
    sp_cancel_all = subparsers.add_parser("cancel-all", help="Cancel all open GTC orders, report capital freed")
    sp_cancel_all.add_argument("--json", action="store_true", help="Output as JSON")

    # price (FIX 5)
    sp_price = subparsers.add_parser("price", help="Show orderbook pricing and liquidity for a market")
    sp_price.add_argument("--market-id", required=True, help="Gamma API market ID (condition_id)")
    sp_price.add_argument("--json", action="store_true", help="Output as JSON")

    # convert-to-market (FIX 6)
    sp_convert = subparsers.add_parser("convert-to-market", help="Cancel a GTC order and replace with FOK at best price")
    sp_convert.add_argument("--order-id", required=True, help="Order ID of GTC order to convert")
    sp_convert.add_argument("--json", action="store_true", help="Output as JSON")

    # acknowledge-risk
    sp_ack = subparsers.add_parser("acknowledge-risk", help="Acknowledge proxy trading risks")
    sp_ack.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        return 1

    cmd_map = {
        "buy": cmd_buy,
        "sell": cmd_sell,
        "cancel": cmd_cancel,
        "orders": cmd_orders,
        "check-orders": cmd_check_orders,
        "cancel-all": cmd_cancel_all,
        "price": cmd_price,
        "convert-to-market": cmd_convert_to_market,
        "acknowledge-risk": cmd_acknowledge_risk,
    }

    return cmd_map[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
