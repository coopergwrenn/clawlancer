#!/usr/bin/env python3
"""Solana wallet management: generate, status, address, import."""

import argparse
import json
import os
import sys
import stat

ENV_PATH = os.path.expanduser("~/.openclaw/.env")
WALLET_DIR = os.path.expanduser("~/.openclaw/solana-defi")

def read_env() -> dict:
    """Read key=value pairs from .env file."""
    env = {}
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    key, _, val = line.partition("=")
                    env[key.strip()] = val.strip()
    return env

def write_env_key(key: str, value: str):
    """Add or update a key in .env file."""
    lines = []
    found = False
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH) as f:
            lines = f.readlines()
    new_lines = []
    for line in lines:
        if line.strip().startswith(f"{key}="):
            new_lines.append(f"{key}={value}\n")
            found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f"{key}={value}\n")
    with open(ENV_PATH, "w") as f:
        f.writelines(new_lines)
    os.chmod(ENV_PATH, stat.S_IRUSR | stat.S_IWUSR)  # 0600

def cmd_generate(args):
    """Generate a new Solana keypair. Idempotent — skips if wallet exists."""
    env = read_env()
    if env.get("SOLANA_PRIVATE_KEY") and not args.force:
        addr = env.get("SOLANA_WALLET_ADDRESS", "unknown")
        if args.json:
            print(json.dumps({"status": "exists", "address": addr}))
        else:
            print(f"Wallet already exists: {addr}")
        return

    try:
        from solders.keypair import Keypair
        import base58
    except ImportError:
        print(json.dumps({"error": "Missing deps. Run: pip install solders base58"}), file=sys.stderr)
        sys.exit(1)

    kp = Keypair()
    privkey = base58.b58encode(bytes(kp)).decode("utf-8")
    pubkey = str(kp.pubkey())

    write_env_key("SOLANA_PRIVATE_KEY", privkey)
    write_env_key("SOLANA_WALLET_ADDRESS", pubkey)
    if not env.get("SOLANA_RPC_URL"):
        write_env_key("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")

    os.makedirs(WALLET_DIR, exist_ok=True)

    if args.json:
        print(json.dumps({"status": "created", "address": pubkey}))
    else:
        print(pubkey)

def cmd_status(args):
    """Check wallet status."""
    env = read_env()
    has_key = bool(env.get("SOLANA_PRIVATE_KEY"))
    address = env.get("SOLANA_WALLET_ADDRESS", "")
    rpc_url = env.get("SOLANA_RPC_URL", "")
    result = {
        "configured": has_key,
        "address": address if has_key else None,
        "rpc_url": rpc_url or "https://api.mainnet-beta.solana.com",
    }
    if args.json:
        print(json.dumps(result))
    else:
        if has_key:
            print(f"Wallet: {address}")
            print(f"RPC: {rpc_url or 'default (mainnet-beta)'}")
        else:
            print("No wallet configured")

def cmd_address(args):
    """Print wallet address."""
    env = read_env()
    addr = env.get("SOLANA_WALLET_ADDRESS", "")
    if addr:
        print(addr)
    else:
        print("No wallet configured", file=sys.stderr)
        sys.exit(1)

def cmd_import(args):
    """Import an existing wallet from base58 private key via stdin."""
    try:
        import base58
        from solders.keypair import Keypair
    except ImportError:
        print(json.dumps({"error": "Missing deps. Run: pip install solders base58"}), file=sys.stderr)
        sys.exit(1)

    # Read private key from stdin (never as CLI arg)
    privkey_b58 = sys.stdin.read().strip()
    if not privkey_b58:
        print(json.dumps({"error": "No private key provided on stdin"}), file=sys.stderr)
        sys.exit(1)

    try:
        privkey_bytes = base58.b58decode(privkey_b58)
        if len(privkey_bytes) != 64:
            raise ValueError(f"Expected 64 bytes, got {len(privkey_bytes)}")
        kp = Keypair.from_bytes(privkey_bytes)
        pubkey = str(kp.pubkey())
    except Exception as e:
        print(json.dumps({"error": f"Invalid private key: {e}"}), file=sys.stderr)
        sys.exit(1)

    write_env_key("SOLANA_PRIVATE_KEY", privkey_b58)
    write_env_key("SOLANA_WALLET_ADDRESS", pubkey)

    if args.json:
        print(json.dumps({"status": "imported", "address": pubkey}))
    else:
        print(f"Imported wallet: {pubkey}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Solana wallet management")
    parser.add_argument("--json", action="store_true", help="JSON output")
    sub = parser.add_subparsers(dest="command")

    gen = sub.add_parser("generate", help="Generate new keypair")
    gen.add_argument("--force", action="store_true", help="Overwrite existing wallet")
    gen.add_argument("--json", action="store_true")

    st = sub.add_parser("status", help="Check wallet status")
    st.add_argument("--json", action="store_true")

    addr = sub.add_parser("address", help="Print wallet address")

    imp = sub.add_parser("import", help="Import wallet from stdin")
    imp.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.command == "generate":
        cmd_generate(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "address":
        cmd_address(args)
    elif args.command == "import":
        cmd_import(args)
    else:
        parser.print_help()
        sys.exit(1)
