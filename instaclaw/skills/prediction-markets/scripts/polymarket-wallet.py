#!/usr/bin/env python3
"""
polymarket-wallet.py — ERC-20 transfer, balance check, and USDC<->USDC.e swap
for Polygon wallets used with Polymarket.

Usage:
  python3 ~/scripts/polymarket-wallet.py transfer --token usdc --to 0x... --amount 6.70 [--json]
  python3 ~/scripts/polymarket-wallet.py balance [--json]
  python3 ~/scripts/polymarket-wallet.py swap --from usdc --to usdc.e --amount 6.70 [--slippage 0.5] [--json]

Exit codes:
  0 = success (OK)
  1 = error (FAIL)
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

POLYMARKET_DIR = Path.home() / ".openclaw" / "polymarket"
WALLET_FILE = POLYMARKET_DIR / "wallet.json"
ENV_FILE = Path.home() / ".openclaw" / ".env"

CHAIN_ID = 137  # Polygon mainnet

RPC_FALLBACKS = [
    "https://api.zan.top/polygon-mainnet",
    "https://1rpc.io/matic",
    "https://polygon-rpc.com",
    "https://polygon-bor-rpc.publicnode.com",
]

# Contract addresses (Polygon mainnet)
USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"       # Bridged USDC (Polymarket collateral)
USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"   # Native USDC (Circle-issued)

# Uniswap V3 SwapRouter on Polygon
UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564"

# Fee tiers to try for stablecoin pairs (lowest first)
SWAP_FEE_TIERS = [100, 500]  # 0.01%, then 0.05%

# Confirmation threshold (USD) — require --confirm for transfers above this
CONFIRM_THRESHOLD = 50.0

# Token map
TOKEN_MAP = {
    "usdc": USDC_NATIVE,
    "usdc.e": USDC_E,
}

# Minimal ERC-20 ABI (transfer + balanceOf + approve + allowance + decimals)
ERC20_ABI = json.loads("""[
  {"inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}],
   "name":"transfer","outputs":[{"name":"","type":"bool"}],
   "stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"name":"account","type":"address"}],
   "name":"balanceOf","outputs":[{"name":"","type":"uint256"}],
   "stateMutability":"view","type":"function"},
  {"inputs":[{"name":"spender","type":"address"},{"name":"amount","type":"uint256"}],
   "name":"approve","outputs":[{"name":"","type":"bool"}],
   "stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"name":"owner","type":"address"},{"name":"spender","type":"address"}],
   "name":"allowance","outputs":[{"name":"","type":"uint256"}],
   "stateMutability":"view","type":"function"},
  {"inputs":[],"name":"decimals","outputs":[{"name":"","type":"uint8"}],
   "stateMutability":"view","type":"function"}
]""")

# Uniswap V3 SwapRouter — exactInputSingle ABI
SWAP_ROUTER_ABI = json.loads("""[
  {"inputs":[{"components":[
    {"name":"tokenIn","type":"address"},
    {"name":"tokenOut","type":"address"},
    {"name":"fee","type":"uint24"},
    {"name":"recipient","type":"address"},
    {"name":"deadline","type":"uint256"},
    {"name":"amountIn","type":"uint256"},
    {"name":"amountOutMinimum","type":"uint256"},
    {"name":"sqrtPriceLimitX96","type":"uint160"}
  ],"name":"params","type":"tuple"}],
  "name":"exactInputSingle",
  "outputs":[{"name":"amountOut","type":"uint256"}],
  "stateMutability":"payable","type":"function"}
]""")


# ---------------------------------------------------------------------------
# Helpers (same patterns as polymarket-setup-creds.py)
# ---------------------------------------------------------------------------

def load_wallet():
    """Load wallet from wallet.json. Returns dict or None."""
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


def output(msg, json_mode=False, data=None):
    """Print output in the appropriate format."""
    if json_mode and data is not None:
        print(json.dumps(data, indent=2))
    else:
        print(msg)


def get_token_balance(w3, token_addr, wallet_addr):
    """Get ERC-20 token balance in human-readable units (6 decimals for USDC)."""
    contract = w3.eth.contract(address=w3.to_checksum_address(token_addr), abi=ERC20_ABI)
    raw = contract.functions.balanceOf(w3.to_checksum_address(wallet_addr)).call()
    return raw / 1e6


# ---------------------------------------------------------------------------
# transfer subcommand
# ---------------------------------------------------------------------------

def cmd_transfer(args):
    """Send ERC-20 tokens (USDC, USDC.e) or native POL to an address."""
    try:
        from web3 import Web3
    except ImportError:
        output("FAIL — web3 not installed. Run: pip3 install web3 eth-account", args.json)
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

    # Validate recipient address
    to_addr = args.to
    if not Web3.is_address(to_addr):
        output(
            f"FAIL — Invalid recipient address: {to_addr}",
            args.json,
            {"status": "FAIL", "error": "invalid_address", "to": to_addr},
        )
        return 1
    to_cs = Web3.to_checksum_address(to_addr)

    amount = args.amount
    if amount <= 0:
        output("FAIL — Amount must be positive", args.json, {"status": "FAIL", "error": "invalid_amount"})
        return 1

    # Safety: require --confirm for large transfers
    if amount > CONFIRM_THRESHOLD and not args.confirm:
        output(
            f"FAIL — Transfer of ${amount:.2f} exceeds ${CONFIRM_THRESHOLD:.0f} safety threshold.\n"
            f"Add --confirm to proceed.",
            args.json,
            {"status": "FAIL", "error": "confirmation_required", "amount": amount, "threshold": CONFIRM_THRESHOLD},
        )
        return 1

    rpc_url = get_rpc_url()
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    if not w3.is_connected():
        output(f"FAIL — Cannot connect to Polygon RPC: {rpc_url}", args.json,
               {"status": "FAIL", "error": "rpc_connection_failed"})
        return 1

    address_cs = Web3.to_checksum_address(wallet["address"])
    private_key = wallet["private_key"]
    nonce = w3.eth.get_transaction_count(address_cs)

    token_name = args.token.lower()

    if token_name == "pol":
        # Native POL/MATIC transfer
        value_wei = w3.to_wei(amount, "ether")
        bal_wei = w3.eth.get_balance(address_cs)
        if bal_wei < value_wei:
            bal_human = bal_wei / 1e18
            output(
                f"FAIL — Insufficient POL balance: {bal_human:.6f} POL (need {amount})",
                args.json,
                {"status": "FAIL", "error": "insufficient_balance", "balance": bal_human, "needed": amount},
            )
            return 1

        tx = {
            "from": address_cs,
            "to": to_cs,
            "value": value_wei,
            "nonce": nonce,
            "gas": 21000,
            "gasPrice": w3.eth.gas_price,
            "chainId": CHAIN_ID,
        }
        unit = "POL"
    else:
        # ERC-20 transfer
        if token_name not in TOKEN_MAP:
            output(
                f"FAIL — Unknown token: {token_name}. Use: usdc, usdc.e, or pol",
                args.json,
                {"status": "FAIL", "error": "unknown_token", "token": token_name},
            )
            return 1

        token_addr = TOKEN_MAP[token_name]
        token_addr_cs = Web3.to_checksum_address(token_addr)

        # Check balance first
        balance = get_token_balance(w3, token_addr, wallet["address"])
        if balance < amount:
            output(
                f"FAIL — Insufficient {token_name.upper()} balance: ${balance:.2f} (need ${amount:.2f})",
                args.json,
                {"status": "FAIL", "error": "insufficient_balance", "balance": balance, "needed": amount},
            )
            return 1

        amount_raw = int(amount * 1e6)  # 6 decimals for USDC
        contract = w3.eth.contract(address=token_addr_cs, abi=ERC20_ABI)
        tx = contract.functions.transfer(to_cs, amount_raw).build_transaction({
            "from": address_cs,
            "nonce": nonce,
            "gas": 100000,
            "gasPrice": w3.eth.gas_price,
            "chainId": CHAIN_ID,
        })
        unit = token_name.upper()

    # Sign and send
    try:
        signed = w3.eth.account.sign_transaction(tx, private_key)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    except Exception as e:
        output(
            f"FAIL — Transaction failed: {e}",
            args.json,
            {"status": "FAIL", "error": "tx_failed", "detail": str(e)},
        )
        return 1

    tx_hash_hex = receipt.transactionHash.hex()
    polygonscan = f"https://polygonscan.com/tx/0x{tx_hash_hex}"

    if receipt.status == 1:
        if token_name == "pol":
            display_amount = f"{amount} {unit}"
        else:
            display_amount = f"{amount:.2f} {unit}"
        output(
            f"OK — Sent {display_amount} to {to_cs}\n"
            f"  Tx: 0x{tx_hash_hex}\n"
            f"  Polygonscan: {polygonscan}",
            args.json,
            {
                "status": "OK",
                "action": "transfer",
                "token": token_name,
                "amount": amount,
                "to": to_cs,
                "tx_hash": f"0x{tx_hash_hex}",
                "polygonscan": polygonscan,
            },
        )
        return 0
    else:
        output(
            f"FAIL — Transaction reverted\n"
            f"  Tx: 0x{tx_hash_hex}\n"
            f"  Polygonscan: {polygonscan}",
            args.json,
            {
                "status": "FAIL",
                "error": "tx_reverted",
                "tx_hash": f"0x{tx_hash_hex}",
                "polygonscan": polygonscan,
            },
        )
        return 1


# ---------------------------------------------------------------------------
# balance subcommand
# ---------------------------------------------------------------------------

def cmd_balance(args):
    """Delegate to polymarket-setup-creds.py status for balance info."""
    cmd = ["python3", str(Path.home() / "scripts" / "polymarket-setup-creds.py"), "status"]
    if args.json:
        cmd.append("--json")
    result = subprocess.run(cmd)
    return result.returncode


# ---------------------------------------------------------------------------
# swap subcommand
# ---------------------------------------------------------------------------

def cmd_swap(args):
    """Swap between USDC and USDC.e via Uniswap V3 on Polygon."""
    try:
        from web3 import Web3
    except ImportError:
        output("FAIL — web3 not installed. Run: pip3 install web3 eth-account", args.json)
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

    token_from = getattr(args, "from").lower()
    token_to = args.to.lower()

    if token_from not in TOKEN_MAP:
        output(f"FAIL — Unknown source token: {token_from}. Use: usdc or usdc.e", args.json,
               {"status": "FAIL", "error": "unknown_token", "token": token_from})
        return 1
    if token_to not in TOKEN_MAP:
        output(f"FAIL — Unknown destination token: {token_to}. Use: usdc or usdc.e", args.json,
               {"status": "FAIL", "error": "unknown_token", "token": token_to})
        return 1
    if token_from == token_to:
        output("FAIL — Source and destination tokens must be different", args.json,
               {"status": "FAIL", "error": "same_token"})
        return 1

    amount = args.amount
    if amount <= 0:
        output("FAIL — Amount must be positive", args.json, {"status": "FAIL", "error": "invalid_amount"})
        return 1

    slippage = args.slippage
    if slippage < 0 or slippage > 50:
        output("FAIL — Slippage must be between 0 and 50%", args.json,
               {"status": "FAIL", "error": "invalid_slippage"})
        return 1

    # Safety: require --confirm for large swaps
    if amount > CONFIRM_THRESHOLD and not args.confirm:
        output(
            f"FAIL — Swap of ${amount:.2f} exceeds ${CONFIRM_THRESHOLD:.0f} safety threshold.\n"
            f"Add --confirm to proceed.",
            args.json,
            {"status": "FAIL", "error": "confirmation_required", "amount": amount, "threshold": CONFIRM_THRESHOLD},
        )
        return 1

    rpc_url = get_rpc_url()
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    if not w3.is_connected():
        output(f"FAIL — Cannot connect to Polygon RPC: {rpc_url}", args.json,
               {"status": "FAIL", "error": "rpc_connection_failed"})
        return 1

    address_cs = Web3.to_checksum_address(wallet["address"])
    private_key = wallet["private_key"]

    token_in_addr = Web3.to_checksum_address(TOKEN_MAP[token_from])
    token_out_addr = Web3.to_checksum_address(TOKEN_MAP[token_to])
    router_addr = Web3.to_checksum_address(UNISWAP_V3_ROUTER)

    # Check source token balance
    balance = get_token_balance(w3, TOKEN_MAP[token_from], wallet["address"])
    if balance < amount:
        output(
            f"FAIL — Insufficient {token_from.upper()} balance: ${balance:.2f} (need ${amount:.2f})",
            args.json,
            {"status": "FAIL", "error": "insufficient_balance", "balance": balance, "needed": amount},
        )
        return 1

    amount_in = int(amount * 1e6)
    min_out = int(amount * (1 - slippage / 100) * 1e6)

    # Step 1: Check and set allowance for router
    token_in_contract = w3.eth.contract(address=token_in_addr, abi=ERC20_ABI)
    current_allowance = token_in_contract.functions.allowance(address_cs, router_addr).call()

    if current_allowance < amount_in:
        if not args.json:
            print(f"  Approving Uniswap V3 Router to spend {token_from.upper()}...")
        try:
            nonce = w3.eth.get_transaction_count(address_cs)
            approve_tx = token_in_contract.functions.approve(
                router_addr, 2**256 - 1
            ).build_transaction({
                "from": address_cs,
                "nonce": nonce,
                "gas": 100000,
                "gasPrice": w3.eth.gas_price,
                "chainId": CHAIN_ID,
            })
            signed = w3.eth.account.sign_transaction(approve_tx, private_key)
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            if receipt.status != 1:
                output("FAIL — Approval transaction reverted", args.json,
                       {"status": "FAIL", "error": "approval_reverted",
                        "tx_hash": f"0x{receipt.transactionHash.hex()}"})
                return 1
            if not args.json:
                print(f"  Approval confirmed: 0x{receipt.transactionHash.hex()}")
        except Exception as e:
            output(f"FAIL — Approval failed: {e}", args.json,
                   {"status": "FAIL", "error": "approval_failed", "detail": str(e)})
            return 1

    # Step 2: Execute swap — try fee tiers in order
    router = w3.eth.contract(address=router_addr, abi=SWAP_ROUTER_ABI)
    deadline = int(time.time()) + 300  # 5 minutes

    swap_receipt = None
    used_fee_tier = None

    for fee_tier in SWAP_FEE_TIERS:
        try:
            nonce = w3.eth.get_transaction_count(address_cs)
            swap_params = (
                token_in_addr,    # tokenIn
                token_out_addr,   # tokenOut
                fee_tier,         # fee
                address_cs,       # recipient
                deadline,         # deadline
                amount_in,        # amountIn
                min_out,          # amountOutMinimum
                0,                # sqrtPriceLimitX96 (0 = no limit)
            )
            swap_tx = router.functions.exactInputSingle(swap_params).build_transaction({
                "from": address_cs,
                "nonce": nonce,
                "gas": 300000,
                "gasPrice": w3.eth.gas_price,
                "chainId": CHAIN_ID,
            })
            signed = w3.eth.account.sign_transaction(swap_tx, private_key)
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)

            if receipt.status == 1:
                swap_receipt = receipt
                used_fee_tier = fee_tier
                break
            else:
                if not args.json:
                    print(f"  Swap with fee tier {fee_tier} reverted, trying next...")
        except Exception as e:
            if not args.json:
                print(f"  Swap with fee tier {fee_tier} failed: {e}")
            continue

    if swap_receipt is None:
        output(
            f"FAIL — Swap failed on all fee tiers. The pool may lack liquidity for {token_from.upper()} -> {token_to.upper()}.",
            args.json,
            {"status": "FAIL", "error": "swap_failed", "tried_fee_tiers": SWAP_FEE_TIERS},
        )
        return 1

    tx_hash_hex = swap_receipt.transactionHash.hex()
    polygonscan = f"https://polygonscan.com/tx/0x{tx_hash_hex}"

    # Try to read amountOut from logs (Transfer event on output token)
    amount_out_human = None
    try:
        # Look for Transfer events from the output token contract
        transfer_topic = w3.keccak(text="Transfer(address,address,uint256)").hex()
        for log in swap_receipt.logs:
            if (log.address.lower() == token_out_addr.lower()
                    and len(log.topics) >= 3
                    and log.topics[0].hex() == transfer_topic):
                # Check if recipient matches our wallet
                log_to = "0x" + log.topics[2].hex()[-40:]
                if log_to.lower() == address_cs.lower():
                    amount_out_raw = int(log.data.hex(), 16)
                    amount_out_human = amount_out_raw / 1e6
                    break
    except Exception:
        pass  # Non-critical — just report success without exact amount out

    out_str = f" (received ${amount_out_human:.2f} {token_to.upper()})" if amount_out_human else ""
    output(
        f"OK — Swapped {amount:.2f} {token_from.upper()} -> {token_to.upper()}{out_str}\n"
        f"  Fee tier: {used_fee_tier / 10000:.2f}%\n"
        f"  Tx: 0x{tx_hash_hex}\n"
        f"  Polygonscan: {polygonscan}",
        args.json,
        {
            "status": "OK",
            "action": "swap",
            "token_from": token_from,
            "token_to": token_to,
            "amount_in": amount,
            "amount_out": amount_out_human,
            "fee_tier": used_fee_tier,
            "slippage_pct": slippage,
            "tx_hash": f"0x{tx_hash_hex}",
            "polygonscan": polygonscan,
        },
    )
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Polygon wallet operations: transfer, balance, swap",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    # transfer
    sp_transfer = subparsers.add_parser("transfer", help="Send ERC-20 tokens or native POL")
    sp_transfer.add_argument("--token", required=True, choices=["usdc", "usdc.e", "pol"],
                             help="Token to send: usdc, usdc.e, or pol")
    sp_transfer.add_argument("--to", required=True, help="Recipient address (0x...)")
    sp_transfer.add_argument("--amount", required=True, type=float, help="Amount to send")
    sp_transfer.add_argument("--confirm", action="store_true",
                             help=f"Confirm transfers above ${CONFIRM_THRESHOLD:.0f}")
    sp_transfer.add_argument("--json", action="store_true", help="Output as JSON")

    # balance
    sp_balance = subparsers.add_parser("balance", help="Check wallet balances (delegates to setup-creds status)")
    sp_balance.add_argument("--json", action="store_true", help="Output as JSON")

    # swap
    sp_swap = subparsers.add_parser("swap", help="Swap between USDC and USDC.e via Uniswap V3")
    sp_swap.add_argument("--from", required=True, choices=["usdc", "usdc.e"],
                         help="Source token", dest="from")
    sp_swap.add_argument("--to", required=True, choices=["usdc", "usdc.e"],
                         help="Destination token")
    sp_swap.add_argument("--amount", required=True, type=float, help="Amount to swap")
    sp_swap.add_argument("--slippage", type=float, default=0.5,
                         help="Max slippage percentage (default: 0.5)")
    sp_swap.add_argument("--confirm", action="store_true",
                         help=f"Confirm swaps above ${CONFIRM_THRESHOLD:.0f}")
    sp_swap.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        return 1

    if args.command == "transfer":
        return cmd_transfer(args)
    elif args.command == "balance":
        return cmd_balance(args)
    elif args.command == "swap":
        return cmd_swap(args)

    return 1


if __name__ == "__main__":
    sys.exit(main())
