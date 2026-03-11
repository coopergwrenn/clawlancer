#!/usr/bin/env python3
"""
AgentBook status checker — queries the AgentBook contract on Base
to check whether an agent wallet is registered (backed by World ID human).

Usage:
  python3 agentbook-check.py status [--json]
  python3 agentbook-check.py lookup --address 0x... [--json]

Status mode:
  1. Retrieves wallet address from InstaClaw identity API (GATEWAY_TOKEN auth)
  2. Queries AgentBook contract lookupHuman(address) on Base
  3. Reports registration status

Lookup mode:
  Checks any address against AgentBook.
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.request

from web3 import Web3

AGENTBOOK_ADDRESS = "0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4"

AGENTBOOK_ABI = [
    {
        "name": "lookupHuman",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "agent", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "getNextNonce",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "agent", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
]

# Base mainnet RPC endpoints (fallback chain)
RPC_ENDPOINTS = [
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
    "https://base.drpc.org",
]


def get_web3():
    """Try RPC endpoints in order until one works."""
    for rpc in RPC_ENDPOINTS:
        try:
            w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 10}))
            if w3.is_connected():
                return w3
        except Exception:
            continue
    print("ERROR: Could not connect to any Base RPC endpoint", file=sys.stderr)
    sys.exit(1)


def lookup_human(w3, address):
    """Query AgentBook.lookupHuman(address). Returns nullifier hash or 0."""
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(AGENTBOOK_ADDRESS),
        abi=AGENTBOOK_ABI,
    )
    return contract.functions.lookupHuman(
        Web3.to_checksum_address(address)
    ).call()


def get_wallet_from_identity_api():
    """Retrieve wallet address from InstaClaw's identity API using GATEWAY_TOKEN."""
    try:
        # Read GATEWAY_TOKEN from .env
        env_path = os.path.expanduser("~/.openclaw/.env")
        token = None
        if os.path.exists(env_path):
            with open(env_path) as f:
                for line in f:
                    if line.startswith("GATEWAY_TOKEN="):
                        token = line.strip().split("=", 1)[1]
                        break
        if not token:
            return None

        url = "https://instaclaw.io/api/vm/identity"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            return data.get("wallet_address")
    except Exception:
        return None


def cmd_status(args):
    wallet = get_wallet_from_identity_api()
    if not wallet:
        result = {
            "wallet_address": None,
            "registered": False,
            "nullifier_hash": None,
            "error": "No wallet address set. Use PUT /api/vm/identity to set it.",
        }
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print("ERROR: No wallet address found.")
            print("Set your wallet via: curl -X PUT -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{\"wallet_address\":\"0x...\"}' https://instaclaw.io/api/vm/identity")
        return

    w3 = get_web3()
    nullifier = lookup_human(w3, wallet)
    registered = nullifier != 0

    result = {
        "wallet_address": wallet,
        "registered": registered,
        "nullifier_hash": str(nullifier) if registered else None,
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Wallet:     {wallet}")
        print(f"Registered: {'Yes' if registered else 'No'}")
        if registered:
            print(f"Human ID:   {nullifier}")


def cmd_lookup(args):
    if not args.address:
        print("ERROR: --address required", file=sys.stderr)
        sys.exit(1)

    w3 = get_web3()
    nullifier = lookup_human(w3, args.address)
    registered = nullifier != 0

    result = {
        "address": args.address,
        "registered": registered,
        "nullifier_hash": str(nullifier) if registered else None,
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Address:    {args.address}")
        print(f"Registered: {'Yes' if registered else 'No'}")
        if registered:
            print(f"Human ID:   {nullifier}")


def main():
    parser = argparse.ArgumentParser(description="AgentBook status checker")
    parser.add_argument("--json", action="store_true", help="JSON output")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("status", help="Check this agent's AgentBook status")

    lookup = sub.add_parser("lookup", help="Look up any address")
    lookup.add_argument("--address", required=True, help="Wallet address to check")

    args = parser.parse_args()

    if args.command == "status":
        cmd_status(args)
    elif args.command == "lookup":
        cmd_lookup(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
