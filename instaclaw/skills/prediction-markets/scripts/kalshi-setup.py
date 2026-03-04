#!/usr/bin/env python3
"""
kalshi-setup.py — Store and validate Kalshi API credentials, check balance.

Usage:
  python3 ~/scripts/kalshi-setup.py setup --api-key-id <KEY_ID> --private-key-file <PEM_PATH> [--json]
  python3 ~/scripts/kalshi-setup.py setup --api-key-id <KEY_ID> --private-key-pem <PEM_STRING> [--json]
  python3 ~/scripts/kalshi-setup.py setup-interactive --api-key-id <KEY_ID> [--json]
      (reads PEM from stdin — Telegram-friendly)
  python3 ~/scripts/kalshi-setup.py status [--json]
  python3 ~/scripts/kalshi-setup.py balance [--json]

Exit codes:
  0 = success (OK)
  1 = error (FAIL)
"""

import argparse
import base64
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PREDICTION_DIR = Path.home() / ".openclaw" / "prediction-markets"
CREDS_FILE = PREDICTION_DIR / "kalshi-creds.json"
PEM_FILE = PREDICTION_DIR / "kalshi-private-key.pem"

KALSHI_BASE_URL = "https://trading-api.kalshi.com/trade-api/v2"

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


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    path.chmod(0o600)


def output(msg, json_mode=False, data=None):
    if json_mode and data is not None:
        print(json.dumps(data, indent=2))
    else:
        print(msg)


def sign_request(api_key_id, private_key_pem, method, path):
    """Sign a Kalshi API request using RSA-PSS with SHA256."""
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
    except ImportError:
        return None, "cryptography package not installed. Run: pip3 install cryptography"

    timestamp = str(int(time.time() * 1000))
    message = (timestamp + method.upper() + path).encode("utf-8")

    try:
        private_key = serialization.load_pem_private_key(
            private_key_pem.encode("utf-8") if isinstance(private_key_pem, str) else private_key_pem,
            password=None,
        )
        signature = private_key.sign(
            message,
            padding.PSS(
                mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH,
            ),
            hashes.SHA256(),
        )
        sig_b64 = base64.b64encode(signature).decode("utf-8")
        return {
            "KALSHI-ACCESS-KEY": api_key_id,
            "KALSHI-ACCESS-TIMESTAMP": timestamp,
            "KALSHI-ACCESS-SIGNATURE": sig_b64,
        }, None
    except Exception as e:
        return None, f"Signing failed: {e}"


def kalshi_request(api_key_id, private_key_pem, method, endpoint, body=None):
    """Make an authenticated request to the Kalshi API."""
    path = f"/trade-api/v2{endpoint.split('?')[0]}"
    url = f"{KALSHI_BASE_URL}{endpoint}"

    headers, err = sign_request(api_key_id, private_key_pem, method, path)
    if err:
        return None, err

    headers["Content-Type"] = "application/json"
    headers["Accept"] = "application/json"

    data = json.dumps(body).encode("utf-8") if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode()), None
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else ""
        return None, f"HTTP {e.code}: {body_text[:200]}"
    except Exception as e:
        return None, f"Request failed: {e}"


def load_creds():
    """Load stored Kalshi credentials."""
    return load_json(CREDS_FILE)


# ---------------------------------------------------------------------------
# setup subcommand
# ---------------------------------------------------------------------------

def cmd_setup(args):
    """Store and validate Kalshi API credentials."""
    try:
        from cryptography.hazmat.primitives import serialization
    except ImportError:
        output("FAIL — cryptography not installed. Run: pip3 install cryptography", args.json)
        return 1

    api_key_id = args.api_key_id
    if not api_key_id:
        output("FAIL — --api-key-id is required", args.json,
               {"status": "FAIL", "error": "missing_api_key_id"})
        return 1

    # Get private key PEM
    private_key_pem = None
    if args.private_key_file:
        try:
            with open(args.private_key_file) as f:
                private_key_pem = f.read()
        except Exception as e:
            output(f"FAIL — Could not read private key file: {e}", args.json,
                   {"status": "FAIL", "error": "read_key_failed"})
            return 1
    elif args.private_key_pem:
        private_key_pem = args.private_key_pem
    else:
        output("FAIL — Provide --private-key-file or --private-key-pem", args.json,
               {"status": "FAIL", "error": "missing_private_key"})
        return 1

    # Validate PEM format
    try:
        serialization.load_pem_private_key(
            private_key_pem.encode("utf-8") if isinstance(private_key_pem, str) else private_key_pem,
            password=None,
        )
    except Exception as e:
        output(f"FAIL — Invalid private key: {e}", args.json,
               {"status": "FAIL", "error": "invalid_private_key"})
        return 1

    # Test connection by fetching balance
    result, err = kalshi_request(api_key_id, private_key_pem, "GET", "/portfolio/balance")
    if err:
        output(f"FAIL — Could not verify credentials: {err}", args.json,
               {"status": "FAIL", "error": "verify_failed", "detail": err})
        return 1

    balance_cents = result.get("balance", 0)
    portfolio_cents = result.get("portfolio_value", 0)

    # Store credentials
    creds = {
        "platform": "kalshi",
        "api_key_id": api_key_id,
        "private_key_pem": private_key_pem,
        "verified": True,
        "verified_at": datetime.now(timezone.utc).isoformat(),
    }
    save_json(CREDS_FILE, creds)

    output(
        f"OK — Kalshi API credentials stored and verified\n"
        f"  Balance:         ${balance_cents / 100:.2f}\n"
        f"  Portfolio Value: ${portfolio_cents / 100:.2f}",
        args.json,
        {
            "status": "OK",
            "verified": True,
            "balance_usd": balance_cents / 100,
            "portfolio_value_usd": portfolio_cents / 100,
        },
    )
    return 0


# ---------------------------------------------------------------------------
# setup-interactive subcommand (reads PEM from stdin — Telegram-friendly)
# ---------------------------------------------------------------------------

def cmd_setup_interactive(args):
    """Read PEM from stdin, save to file, then run normal setup flow."""
    try:
        from cryptography.hazmat.primitives import serialization
    except ImportError:
        output("FAIL — cryptography not installed. Run: pip3 install cryptography", args.json,
               {"status": "FAIL", "error": "missing_cryptography"})
        return 1

    api_key_id = args.api_key_id
    if not api_key_id:
        output("FAIL — --api-key-id is required", args.json,
               {"status": "FAIL", "error": "missing_api_key_id"})
        return 1

    # Read PEM from stdin
    pem_text = sys.stdin.read().strip()
    if not pem_text:
        output("FAIL — No PEM data received on stdin. Pipe the PEM content to this command.", args.json,
               {"status": "FAIL", "error": "empty_stdin"})
        return 1

    # Validate PEM format
    try:
        serialization.load_pem_private_key(
            pem_text.encode("utf-8"),
            password=None,
        )
    except Exception as e:
        output(f"FAIL — Invalid private key: {e}\nMake sure you copied the FULL PEM including -----BEGIN and -----END lines.", args.json,
               {"status": "FAIL", "error": "invalid_private_key"})
        return 1

    # Save PEM to file
    PEM_FILE.parent.mkdir(parents=True, exist_ok=True)
    PEM_FILE.write_text(pem_text)
    PEM_FILE.chmod(0o600)

    # Test connection by fetching balance
    result, err = kalshi_request(api_key_id, pem_text, "GET", "/portfolio/balance")
    if err:
        # Clean up on failure
        PEM_FILE.unlink(missing_ok=True)
        output(f"FAIL — Could not verify credentials: {err}\nDouble-check you copied the full PEM and the correct API Key ID.", args.json,
               {"status": "FAIL", "error": "verify_failed", "detail": err})
        return 1

    balance_cents = result.get("balance", 0)
    portfolio_cents = result.get("portfolio_value", 0)

    # Store credentials
    creds = {
        "platform": "kalshi",
        "api_key_id": api_key_id,
        "private_key_pem": pem_text,
        "verified": True,
        "verified_at": datetime.now(timezone.utc).isoformat(),
    }
    save_json(CREDS_FILE, creds)

    output(
        f"OK — Kalshi API credentials stored and verified\n"
        f"  Balance:         ${balance_cents / 100:.2f}\n"
        f"  Portfolio Value: ${portfolio_cents / 100:.2f}",
        args.json,
        {
            "status": "OK",
            "verified": True,
            "balance_usd": balance_cents / 100,
            "portfolio_value_usd": portfolio_cents / 100,
        },
    )
    return 0


# ---------------------------------------------------------------------------
# status subcommand
# ---------------------------------------------------------------------------

def cmd_status(args):
    """Check Kalshi credential status, connection, balance, and dependencies."""
    checks = {}

    # 1. Credentials
    creds = load_creds()
    if creds and creds.get("api_key_id"):
        checks["credentials"] = {
            "stored": True,
            "api_key_id": creds["api_key_id"][:8] + "...",
            "verified": creds.get("verified", False),
            "verified_at": creds.get("verified_at"),
        }
    else:
        checks["credentials"] = {"stored": False}

    # 2. Dependencies
    deps = {}
    for pkg in ["cryptography", "requests"]:
        try:
            __import__(pkg)
            deps[pkg] = True
        except ImportError:
            deps[pkg] = False
    checks["dependencies"] = deps

    # 3. Live API check + balance
    if creds and creds.get("api_key_id") and creds.get("private_key_pem"):
        result, err = kalshi_request(
            creds["api_key_id"], creds["private_key_pem"], "GET", "/portfolio/balance"
        )
        if err:
            checks["api_live"] = {"ok": False, "error": err}
            checks["balance"] = {"error": err}
        else:
            checks["api_live"] = {"ok": True}
            checks["balance"] = {
                "usd": result.get("balance", 0) / 100,
                "portfolio_value": result.get("portfolio_value", 0) / 100,
            }
    else:
        checks["api_live"] = {"skipped": True}
        checks["balance"] = {"skipped": True}

    if args.json:
        print(json.dumps({"status": "OK", "checks": checks}, indent=2))
    else:
        print("=== Kalshi Setup Status ===\n")
        c = checks["credentials"]
        if c.get("stored"):
            print(f"  Credentials: STORED (key: {c['api_key_id']})")
            if c.get("verified"):
                print(f"  Verified: {c.get('verified_at', 'unknown')}")
            else:
                print("  Verified: NO — run: kalshi-setup.py setup")
        else:
            print("  Credentials: NOT CONFIGURED")
            print("  Run: python3 ~/scripts/kalshi-setup.py setup --api-key-id <KEY> --private-key-file <PEM>")

        missing = [k for k, v in checks["dependencies"].items() if not v]
        if missing:
            print(f"  Dependencies: MISSING — {', '.join(missing)}")
        else:
            print("  Dependencies: OK")

        api = checks.get("api_live", {})
        if api.get("ok"):
            print("  Live API: OK")
        elif api.get("skipped"):
            print("  Live API: SKIPPED (no credentials)")
        else:
            print(f"  Live API: FAIL ({api.get('error', 'unknown')})")

        bal = checks.get("balance", {})
        if isinstance(bal, dict) and "usd" in bal:
            print(f"  Balance: ${bal['usd']:.2f}")
            print(f"  Portfolio: ${bal['portfolio_value']:.2f}")
        elif bal.get("skipped"):
            print("  Balance: SKIPPED")
        else:
            print(f"  Balance: ERROR ({bal.get('error', 'unknown')})")

    return 0


# ---------------------------------------------------------------------------
# balance subcommand
# ---------------------------------------------------------------------------

def cmd_balance(args):
    """Show Kalshi USD balance."""
    creds = load_creds()
    if not creds or not creds.get("api_key_id"):
        output("FAIL — Kalshi not configured. Run: kalshi-setup.py setup", args.json,
               {"status": "FAIL", "error": "not_configured"})
        return 1

    result, err = kalshi_request(
        creds["api_key_id"], creds["private_key_pem"], "GET", "/portfolio/balance"
    )
    if err:
        output(f"FAIL — {err}", args.json, {"status": "FAIL", "error": err})
        return 1

    balance = result.get("balance", 0) / 100
    portfolio = result.get("portfolio_value", 0) / 100

    output(
        f"OK — Kalshi Balance: ${balance:.2f}  |  Portfolio: ${portfolio:.2f}",
        args.json,
        {"status": "OK", "balance_usd": balance, "portfolio_value_usd": portfolio},
    )
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Kalshi API credential setup and validation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    sp_setup = subparsers.add_parser("setup", help="Store and validate Kalshi API credentials")
    sp_setup.add_argument("--api-key-id", required=True, help="Kalshi API Key ID")
    sp_setup.add_argument("--private-key-file", help="Path to RSA private key PEM file")
    sp_setup.add_argument("--private-key-pem", help="RSA private key PEM as string")
    sp_setup.add_argument("--json", action="store_true", help="Output as JSON")

    sp_interactive = subparsers.add_parser("setup-interactive", help="Setup from stdin PEM (Telegram-friendly)")
    sp_interactive.add_argument("--api-key-id", required=True, help="Kalshi API Key ID")
    sp_interactive.add_argument("--json", action="store_true", help="Output as JSON")

    sp_status = subparsers.add_parser("status", help="Check Kalshi setup status")
    sp_status.add_argument("--json", action="store_true", help="Output as JSON")

    sp_balance = subparsers.add_parser("balance", help="Show Kalshi USD balance")
    sp_balance.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        return 1

    cmd_map = {"setup": cmd_setup, "setup-interactive": cmd_setup_interactive, "status": cmd_status, "balance": cmd_balance}
    return cmd_map[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
