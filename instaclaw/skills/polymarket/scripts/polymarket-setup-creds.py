#!/usr/bin/env python3
"""
polymarket-setup-creds.py — Derive CLOB API credentials and send ERC-20 approvals
for Polymarket trading on Polygon.

Usage:
  python3 ~/scripts/polymarket-setup-creds.py setup [--json]
  python3 ~/scripts/polymarket-setup-creds.py approve [--json] [--dry-run]
  python3 ~/scripts/polymarket-setup-creds.py status [--json]

Exit codes:
  0 = success (OK)
  1 = error (FAIL)
  2 = blocked (BLOCK)
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

POLYMARKET_DIR = Path.home() / ".openclaw" / "polymarket"
WALLET_FILE = POLYMARKET_DIR / "wallet.json"
CREDS_STATE_FILE = POLYMARKET_DIR / "creds-state.json"
ENV_FILE = Path.home() / ".openclaw" / ".env"

CLOB_HOST_DEFAULT = "https://clob.polymarket.com"
CHAIN_ID = 137  # Polygon mainnet

RPC_FALLBACKS = [
    "https://1rpc.io/matic",
    "https://polygon-bor-rpc.publicnode.com",
    "https://api.zan.top/polygon-mainnet",
    "https://polygon-rpc.com",
]

# Contract addresses (Polygon mainnet)
USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"      # Bridged USDC (Polymarket collateral)
USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"  # Native USDC (Circle-issued)
CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"
NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a"
NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"
CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"

MAX_UINT256 = 2**256 - 1

# Minimal ABIs
ERC20_ABI = json.loads('[{"inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],"name":"approve","outputs":[{"name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],"name":"allowance","outputs":[{"name":"","type":"uint256"}],"stateMutability":"view","type":"function"}]')

ERC1155_ABI = json.loads('[{"inputs":[{"name":"operator","type":"address"},{"name":"approved","type":"bool"}],"name":"setApprovalForAll","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"name":"account","type":"address"},{"name":"operator","type":"address"}],"name":"isApprovedForAll","outputs":[{"name":"","type":"bool"}],"stateMutability":"view","type":"function"}]')

# Approval pairs: (description, token_contract, spender, type)
APPROVAL_PAIRS = [
    ("USDC.e -> CTF Exchange", USDC_E, CTF_EXCHANGE, "erc20"),
    ("USDC.e -> Neg Risk CTF Exchange", USDC_E, NEG_RISK_CTF_EXCHANGE, "erc20"),
    ("Conditional Tokens -> CTF Exchange", CONDITIONAL_TOKENS, CTF_EXCHANGE, "erc1155"),
    ("Conditional Tokens -> Neg Risk CTF Exchange", CONDITIONAL_TOKENS, NEG_RISK_CTF_EXCHANGE, "erc1155"),
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_wallet():
    """Load wallet from wallet.json. Returns dict or exits with FAIL."""
    if not WALLET_FILE.exists():
        return None
    with open(WALLET_FILE) as f:
        return json.load(f)


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
    # Try fallbacks until one works
    import urllib.request
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


def save_creds_state(derived, verified):
    """Save credential state to creds-state.json."""
    POLYMARKET_DIR.mkdir(parents=True, exist_ok=True)
    state = {
        "derived": derived,
        "verified": verified,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    with open(CREDS_STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def load_creds_state():
    """Load credential state if it exists."""
    if not CREDS_STATE_FILE.exists():
        return None
    with open(CREDS_STATE_FILE) as f:
        return json.load(f)


def output(msg, json_mode=False, data=None):
    """Print output in the appropriate format."""
    if json_mode and data is not None:
        print(json.dumps(data, indent=2))
    else:
        print(msg)


# ---------------------------------------------------------------------------
# setup subcommand
# ---------------------------------------------------------------------------

def cmd_setup(args):
    """Derive CLOB API credentials from wallet and verify with get_ok()."""
    try:
        from py_clob_client.client import ClobClient
    except ImportError:
        output("FAIL — py-clob-client not installed. Run: pip3 install py-clob-client", args.json)
        return 1

    wallet = load_wallet()
    if not wallet:
        output(
            "FAIL — No wallet found at ~/.openclaw/polymarket/wallet.json\n"
            "Run: bash ~/scripts/setup-polymarket-wallet.sh",
            args.json,
            {"status": "FAIL", "error": "wallet_not_found"},
        )
        return 1

    try:
        client = ClobClient(get_clob_host(), key=wallet["private_key"], chain_id=CHAIN_ID)
        api_creds = client.create_or_derive_api_creds()
        client.set_api_creds(api_creds)
    except Exception as e:
        output(
            f"FAIL — Could not derive API credentials: {e}",
            args.json,
            {"status": "FAIL", "error": "derive_failed", "detail": str(e)},
        )
        return 1

    # Verify
    try:
        ok = client.get_ok()
        verified = ok == "OK" or ok is True
    except Exception as e:
        output(
            f"WARN — Credentials derived but verification failed: {e}",
            args.json,
            {"status": "WARN", "derived": True, "verified": False, "detail": str(e)},
        )
        save_creds_state(derived=True, verified=False)
        return 0

    save_creds_state(derived=True, verified=verified)

    if verified:
        output(
            f"OK — CLOB API credentials derived and verified for {wallet['address']}",
            args.json,
            {"status": "OK", "derived": True, "verified": True, "address": wallet["address"]},
        )
    else:
        output(
            f"WARN — Credentials derived but get_ok() returned: {ok}",
            args.json,
            {"status": "WARN", "derived": True, "verified": False, "ok_response": str(ok)},
        )
    return 0


# ---------------------------------------------------------------------------
# approve subcommand
# ---------------------------------------------------------------------------

def cmd_approve(args):
    """Send ERC-20 / ERC-1155 approvals for Polymarket contracts."""
    try:
        from web3 import Web3
        from eth_account import Account
    except ImportError:
        output(
            "FAIL — web3 or eth-account not installed. Run: pip3 install web3 eth-account",
            args.json,
        )
        return 1

    wallet = load_wallet()
    if not wallet:
        output(
            "FAIL — No wallet found. Run: bash ~/scripts/setup-polymarket-wallet.sh",
            args.json,
            {"status": "FAIL", "error": "wallet_not_found"},
        )
        return 1

    rpc_url = get_rpc_url()
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    if not w3.is_connected():
        output(
            f"FAIL — Cannot connect to Polygon RPC: {rpc_url}",
            args.json,
            {"status": "FAIL", "error": "rpc_connection_failed"},
        )
        return 1

    address = wallet["address"]
    private_key = wallet["private_key"]
    results = []

    for desc, token_addr, spender, approval_type in APPROVAL_PAIRS:
        token_addr_cs = Web3.to_checksum_address(token_addr)
        spender_cs = Web3.to_checksum_address(spender)
        address_cs = Web3.to_checksum_address(address)

        if approval_type == "erc20":
            contract = w3.eth.contract(address=token_addr_cs, abi=ERC20_ABI)
            current = contract.functions.allowance(address_cs, spender_cs).call()
            already_approved = current >= MAX_UINT256 // 2
        else:
            contract = w3.eth.contract(address=token_addr_cs, abi=ERC1155_ABI)
            already_approved = contract.functions.isApprovedForAll(address_cs, spender_cs).call()

        if already_approved:
            results.append({"pair": desc, "status": "already_approved"})
            if not args.json:
                print(f"  OK — {desc}: already approved")
            continue

        if args.dry_run:
            results.append({"pair": desc, "status": "needs_approval", "dry_run": True})
            if not args.json:
                print(f"  DRY-RUN — {desc}: needs approval (would send tx)")
            continue

        # Build and send approval tx
        try:
            nonce = w3.eth.get_transaction_count(address_cs)

            if approval_type == "erc20":
                tx = contract.functions.approve(spender_cs, MAX_UINT256).build_transaction({
                    "from": address_cs,
                    "nonce": nonce,
                    "gas": 100000,
                    "gasPrice": w3.eth.gas_price,
                    "chainId": CHAIN_ID,
                })
            else:
                tx = contract.functions.setApprovalForAll(spender_cs, True).build_transaction({
                    "from": address_cs,
                    "nonce": nonce,
                    "gas": 100000,
                    "gasPrice": w3.eth.gas_price,
                    "chainId": CHAIN_ID,
                })

            signed = w3.eth.account.sign_transaction(tx, private_key)
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

            tx_hash_hex = receipt.transactionHash.hex()
            if receipt.status == 1:
                results.append({"pair": desc, "status": "approved", "tx_hash": tx_hash_hex})
                if not args.json:
                    print(f"  OK — {desc}: approved (tx: {tx_hash_hex})")
            else:
                results.append({"pair": desc, "status": "tx_failed", "tx_hash": tx_hash_hex})
                if not args.json:
                    print(f"  FAIL — {desc}: tx reverted ({tx_hash_hex})")
        except Exception as e:
            results.append({"pair": desc, "status": "error", "detail": str(e)})
            if not args.json:
                print(f"  FAIL — {desc}: {e}")

    all_ok = all(r["status"] in ("approved", "already_approved") for r in results)
    dry_run_only = args.dry_run

    if args.json:
        print(json.dumps({
            "status": "OK" if (all_ok and not dry_run_only) else ("DRY-RUN" if dry_run_only else "PARTIAL"),
            "approvals": results,
        }, indent=2))
    else:
        if all_ok and not dry_run_only:
            print(f"\nOK — All {len(APPROVAL_PAIRS)} approvals confirmed")
        elif dry_run_only:
            print(f"\nDRY-RUN — {len(results)} approval(s) checked, no transactions sent")
        else:
            print(f"\nWARN — Some approvals failed, check output above")

    return 0


# ---------------------------------------------------------------------------
# status subcommand
# ---------------------------------------------------------------------------

def cmd_status(args):
    """Check wallet, credentials, approvals, and dependencies."""
    checks = {}

    # 1. Wallet
    wallet = load_wallet()
    if wallet:
        checks["wallet"] = {"exists": True, "address": wallet["address"]}
    else:
        checks["wallet"] = {"exists": False}

    # 2. Credentials
    creds_state = load_creds_state()
    if creds_state:
        checks["credentials"] = creds_state
    else:
        checks["credentials"] = {"derived": False, "verified": False}

    # 3. Dependencies
    deps = {}
    for pkg in ["py_clob_client", "web3", "eth_account"]:
        try:
            __import__(pkg)
            deps[pkg] = True
        except ImportError:
            deps[pkg] = False
    checks["dependencies"] = deps

    # 4. Approvals (only if wallet + web3 available)
    if wallet and deps.get("web3"):
        try:
            from web3 import Web3
            rpc_url = get_rpc_url()
            w3 = Web3(Web3.HTTPProvider(rpc_url))
            if w3.is_connected():
                address_cs = Web3.to_checksum_address(wallet["address"])
                approval_status = []
                for desc, token_addr, spender, approval_type in APPROVAL_PAIRS:
                    token_addr_cs = Web3.to_checksum_address(token_addr)
                    spender_cs = Web3.to_checksum_address(spender)
                    if approval_type == "erc20":
                        contract = w3.eth.contract(address=token_addr_cs, abi=ERC20_ABI)
                        current = contract.functions.allowance(address_cs, spender_cs).call()
                        approved = current >= MAX_UINT256 // 2
                    else:
                        contract = w3.eth.contract(address=token_addr_cs, abi=ERC1155_ABI)
                        approved = contract.functions.isApprovedForAll(address_cs, spender_cs).call()
                    approval_status.append({"pair": desc, "approved": approved})
                checks["approvals"] = approval_status
            else:
                checks["approvals"] = {"error": "rpc_not_connected"}
        except Exception as e:
            checks["approvals"] = {"error": str(e)}
    else:
        checks["approvals"] = {"skipped": True, "reason": "wallet or web3 missing"}

    # 5. Balance check (only if wallet + web3 available)
    if wallet and deps.get("web3"):
        try:
            from web3 import Web3
            rpc_url = get_rpc_url()
            w3 = Web3(Web3.HTTPProvider(rpc_url))
            if w3.is_connected():
                address_cs = Web3.to_checksum_address(wallet["address"])
                balances = {}
                for label, token_addr in [("usdc_e", USDC_E), ("usdc_native", USDC_NATIVE)]:
                    contract = w3.eth.contract(
                        address=Web3.to_checksum_address(token_addr), abi=ERC20_ABI
                    )
                    try:
                        raw = contract.functions.allowance(address_cs, address_cs).call()
                        # Actually use balanceOf — need to add to ABI. Use raw eth_call instead.
                    except Exception:
                        pass
                # Raw eth_call for balanceOf (0x70a08231)
                addr_padded = wallet["address"][2:].lower().zfill(64)
                call_data = "0x70a08231" + addr_padded
                for label, token_addr in [("usdc_e", USDC_E), ("usdc_native", USDC_NATIVE)]:
                    try:
                        result = w3.eth.call({"to": Web3.to_checksum_address(token_addr), "data": call_data})
                        balances[label] = int(result.hex(), 16) / 1e6
                    except Exception:
                        balances[label] = None
                try:
                    matic_wei = w3.eth.get_balance(address_cs)
                    balances["pol_matic"] = matic_wei / 1e18
                except Exception:
                    balances["pol_matic"] = None
                checks["balances"] = balances
            else:
                checks["balances"] = {"error": "rpc_not_connected"}
        except Exception as e:
            checks["balances"] = {"error": str(e)}
    else:
        checks["balances"] = {"skipped": True}

    # 6. Live API check (only if credentials derived + py-clob-client available)
    if wallet and creds_state and creds_state.get("derived") and deps.get("py_clob_client"):
        try:
            from py_clob_client.client import ClobClient
            client = ClobClient(get_clob_host(), key=wallet["private_key"], chain_id=CHAIN_ID)
            api_creds = client.create_or_derive_api_creds()
            client.set_api_creds(api_creds)
            ok = client.get_ok()
            checks["api_live"] = {"ok": ok == "OK" or ok is True, "response": str(ok)}
        except Exception as e:
            checks["api_live"] = {"ok": False, "error": str(e)}
    else:
        checks["api_live"] = {"skipped": True}

    # Output
    if args.json:
        print(json.dumps({"status": "OK", "checks": checks}, indent=2))
    else:
        print("=== Polymarket Setup Status ===\n")
        # Wallet
        if checks["wallet"]["exists"]:
            print(f"  Wallet: OK ({checks['wallet']['address']})")
        else:
            print("  Wallet: NOT CONFIGURED — run: bash ~/scripts/setup-polymarket-wallet.sh")
        # Credentials
        creds = checks["credentials"]
        if creds.get("verified"):
            print(f"  API Credentials: VERIFIED (derived {creds.get('timestamp', 'unknown')})")
        elif creds.get("derived"):
            print("  API Credentials: DERIVED but not verified")
        else:
            print("  API Credentials: NOT SETUP — run: python3 ~/scripts/polymarket-setup-creds.py setup")
        # Dependencies
        missing = [k for k, v in deps.items() if not v]
        if missing:
            print(f"  Dependencies: MISSING — {', '.join(missing)}")
            print("    Install: pip3 install py-clob-client eth-account web3")
        else:
            print("  Dependencies: OK")
        # Approvals
        approvals = checks.get("approvals", {})
        if isinstance(approvals, list):
            approved_count = sum(1 for a in approvals if a.get("approved"))
            total = len(approvals)
            if approved_count == total:
                print(f"  Approvals: OK ({approved_count}/{total})")
            else:
                print(f"  Approvals: {approved_count}/{total} — run: python3 ~/scripts/polymarket-setup-creds.py approve")
                for a in approvals:
                    status = "OK" if a["approved"] else "NEEDED"
                    print(f"    {a['pair']}: {status}")
        elif approvals.get("skipped"):
            print(f"  Approvals: SKIPPED ({approvals.get('reason', '')})")
        else:
            print(f"  Approvals: ERROR ({approvals.get('error', 'unknown')})")
        # Balances
        bals = checks.get("balances", {})
        if isinstance(bals, dict) and not bals.get("error") and not bals.get("skipped"):
            usdc_e = bals.get("usdc_e")
            usdc_n = bals.get("usdc_native")
            pol = bals.get("pol_matic")
            usdc_e_str = f"${usdc_e:.2f}" if usdc_e is not None else "?"
            usdc_n_str = f"${usdc_n:.2f}" if usdc_n is not None else "?"
            pol_str = f"{pol:.4f}" if pol is not None else "?"
            print(f"  USDC.e (Polymarket collateral): {usdc_e_str}")
            print(f"  USDC (native):                  {usdc_n_str}")
            print(f"  POL/MATIC (gas):                {pol_str}")
            if usdc_n and usdc_n > 0 and (not usdc_e or usdc_e == 0):
                print("  NOTE: You have native USDC but Polymarket uses USDC.e.")
                print("        Deposit via https://polymarket.com to auto-convert,")
                print("        or swap on a DEX (e.g. Uniswap on Polygon).")
            if pol is not None and pol < 0.01:
                print("  WARN: Very low POL/MATIC — need gas to send approval txs.")
        elif bals.get("skipped"):
            print("  Balances: SKIPPED")
        else:
            print(f"  Balances: ERROR ({bals.get('error', 'unknown')})")
        # Live API
        api = checks.get("api_live", {})
        if api.get("ok"):
            print("  Live API: OK")
        elif api.get("skipped"):
            print("  Live API: SKIPPED")
        else:
            print(f"  Live API: FAIL ({api.get('error', 'unknown')})")

    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Polymarket CLOB API credential setup and ERC-20 approvals",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    # setup
    sp_setup = subparsers.add_parser("setup", help="Derive CLOB API credentials from wallet")
    sp_setup.add_argument("--json", action="store_true", help="Output as JSON")

    # approve
    sp_approve = subparsers.add_parser("approve", help="Send ERC-20/ERC-1155 approvals")
    sp_approve.add_argument("--json", action="store_true", help="Output as JSON")
    sp_approve.add_argument("--dry-run", action="store_true", help="Check approvals without sending transactions")

    # status
    sp_status = subparsers.add_parser("status", help="Check setup status")
    sp_status.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        return 1

    if args.command == "setup":
        return cmd_setup(args)
    elif args.command == "approve":
        return cmd_approve(args)
    elif args.command == "status":
        return cmd_status(args)

    return 1


if __name__ == "__main__":
    sys.exit(main())
