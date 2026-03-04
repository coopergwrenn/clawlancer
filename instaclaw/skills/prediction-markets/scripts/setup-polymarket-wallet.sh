#!/bin/bash
#
# setup-polymarket-wallet.sh — Generate a Polygon EOA wallet for Polymarket trading
#
# Usage:
#   bash ~/scripts/setup-polymarket-wallet.sh           — Generate new wallet
#   bash ~/scripts/setup-polymarket-wallet.sh status     — Check if wallet exists
#   bash ~/scripts/setup-polymarket-wallet.sh address    — Show wallet address
#
# Wallet stored at: ~/.openclaw/polymarket/wallet.json (0o600 permissions)
# Also creates default risk-config.json and empty watchlist if they don't exist.
#

set -euo pipefail

WALLET_DIR="$HOME/.openclaw/polymarket"
WALLET_FILE="$WALLET_DIR/wallet.json"
RISK_CONFIG="$WALLET_DIR/risk-config.json"
WATCHLIST="$HOME/memory/polymarket-watchlist.json"

CMD="${1:-generate}"

check_eth_account() {
  if ! python3 -c "import eth_account" 2>/dev/null; then
    echo "ERROR: eth_account Python module not found."
    echo ""
    echo "Install it with:"
    echo "  pip3 install eth-account"
    echo ""
    echo "(It's also installed as a dependency of py-clob-client)"
    exit 1
  fi
}

create_risk_config() {
  if [ ! -f "$RISK_CONFIG" ]; then
    cat > "$RISK_CONFIG" <<'RISKEOF'
{
  "enabled": false,
  "dailySpendCapUSDC": 50,
  "confirmationThresholdUSDC": 25,
  "dailyLossLimitUSDC": 100,
  "maxPositionSizeUSDC": 100,
  "updatedAt": ""
}
RISKEOF
    chmod 600 "$RISK_CONFIG"
    echo "Created default risk config at $RISK_CONFIG (trading DISABLED)"
  fi
}

create_watchlist() {
  if [ ! -f "$WATCHLIST" ]; then
    mkdir -p "$(dirname "$WATCHLIST")"
    cat > "$WATCHLIST" <<'WLEOF'
{
  "version": 1,
  "markets": [],
  "lastFullSync": null
}
WLEOF
    echo "Created empty watchlist at $WATCHLIST"
  fi
}

case "$CMD" in
  generate)
    # Refuse to overwrite existing wallet
    if [ -f "$WALLET_FILE" ]; then
      echo "ERROR: Wallet already exists at $WALLET_FILE"
      echo ""
      echo "To check wallet status: bash $0 status"
      echo "To show address:        bash $0 address"
      echo ""
      echo "If you need a new wallet, manually remove the existing one first."
      exit 1
    fi

    check_eth_account
    mkdir -p "$WALLET_DIR"

    # Generate wallet using eth_account
    python3 -c "
import json
from datetime import datetime, timezone
from eth_account import Account

acct = Account.create()
wallet = {
    'address': acct.address,
    'private_key': '0x' + acct.key.hex(),
    'chain_id': 137,
    'chain_name': 'polygon',
    'created_at': datetime.now(timezone.utc).isoformat(),
    'purpose': 'polymarket-trading'
}
with open('$WALLET_FILE', 'w') as f:
    json.dump(wallet, f, indent=2)
print(f'Wallet created: {acct.address}')
"

    chmod 600 "$WALLET_FILE"
    echo "Wallet saved to $WALLET_FILE (permissions: 0600)"
    echo ""
    echo "Next steps:"
    echo "  1. Fund with MATIC (gas) — send to the address above on Polygon (chain 137)"
    echo "  2. Fund with USDC.e (trading) — bridged USDC on Polygon"
    echo "  3. Enable trading in your dashboard risk settings"

    # Create supporting files
    create_risk_config
    create_watchlist
    ;;

  status)
    if [ -f "$WALLET_FILE" ]; then
      ADDRESS=$(python3 -c "import json; print(json.load(open('$WALLET_FILE'))['address'])" 2>/dev/null || echo "error reading")
      PERMS=$(stat -c '%a' "$WALLET_FILE" 2>/dev/null || stat -f '%Lp' "$WALLET_FILE" 2>/dev/null || echo "unknown")
      echo "Wallet: EXISTS"
      echo "Address: $ADDRESS"
      echo "File: $WALLET_FILE"
      echo "Permissions: $PERMS"
      if [ -f "$RISK_CONFIG" ]; then
        ENABLED=$(python3 -c "import json; print(json.load(open('$RISK_CONFIG')).get('enabled', False))" 2>/dev/null || echo "unknown")
        echo "Trading enabled: $ENABLED"
      else
        echo "Risk config: NOT FOUND"
      fi
    else
      echo "Wallet: NOT CONFIGURED"
      echo "Run: bash $0"
    fi
    ;;

  address)
    if [ ! -f "$WALLET_FILE" ]; then
      echo "ERROR: No wallet found. Run: bash $0"
      exit 1
    fi
    python3 -c "import json; print(json.load(open('$WALLET_FILE'))['address'])"
    ;;

  *)
    echo "Usage: $0 [generate|status|address]"
    echo ""
    echo "  generate  — Create new Polygon wallet (default)"
    echo "  status    — Check wallet status"
    echo "  address   — Print wallet address"
    exit 1
    ;;
esac
