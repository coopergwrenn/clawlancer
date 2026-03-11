#!/usr/bin/env bash
set -euo pipefail

# AgentBook registration script for VM agents.
# Usage: bash agentbook-register.sh <WALLET_ADDRESS>
#
# 1. Validates the wallet address argument
# 2. Checks if already registered
# 3. Runs @worldcoin/agentkit-cli register (interactive — requires human QR scan)
# 4. Reports result back to InstaClaw API

source ~/.nvm/nvm.sh 2>/dev/null || true

INSTACLAW_API="${INSTACLAW_API_URL:-https://instaclaw.io}"
WALLET="${1:-}"

echo "=== AgentBook Registration ==="
echo ""

# Step 1: Validate wallet address
if [ -z "$WALLET" ]; then
    echo "ERROR: Wallet address required as first argument."
    echo "Usage: bash agentbook-register.sh 0x..."
    echo ""
    echo "Get your wallet from InstaClaw:"
    echo '  TOKEN=$(grep "^GATEWAY_TOKEN=" ~/.openclaw/.env | cut -d= -f2)'
    echo '  curl -s -H "Authorization: Bearer $TOKEN" https://instaclaw.io/api/vm/identity'
    exit 1
fi

if [[ ! "$WALLET" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "ERROR: Invalid wallet address format: $WALLET"
    exit 1
fi

echo "Wallet: $WALLET"
echo ""

# Step 2: Check if already registered
echo "Checking AgentBook status..."
STATUS=$(python3 ~/scripts/agentbook-check.py --json status 2>/dev/null || echo '{"registered":false}')
REGISTERED=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('registered',False))" 2>/dev/null || echo "False")

if [ "$REGISTERED" = "True" ]; then
    echo "Already registered in AgentBook. No action needed."
    echo "$STATUS"
    exit 0
fi

echo "Not yet registered. Starting registration..."
echo ""

# Step 3: Run the CLI (interactive — will show QR/link for human to scan)
echo "A QR code or link will appear below."
echo "The human operator must scan it with World App to complete verification."
echo ""

npx @worldcoin/agentkit-cli@0.1.3 register "$WALLET" --network base

CLI_EXIT=$?

if [ $CLI_EXIT -ne 0 ]; then
    echo ""
    echo "ERROR: Registration CLI exited with code $CLI_EXIT"
    exit $CLI_EXIT
fi

echo ""
echo "Registration submitted. Verifying on-chain..."

# Step 4: Verify registration
sleep 5  # Wait for tx confirmation
STATUS=$(python3 ~/scripts/agentbook-check.py --json status 2>/dev/null || echo '{"registered":false}')
REGISTERED=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('registered',False))" 2>/dev/null || echo "False")

if [ "$REGISTERED" = "True" ]; then
    echo "Registration confirmed on-chain!"
    echo "$STATUS"

    # Step 5: Report back to InstaClaw
    TOKEN=$(grep '^GATEWAY_TOKEN=' ~/.openclaw/.env | cut -d= -f2 || true)
    curl -s -X POST "${INSTACLAW_API}/api/agentbook/register" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKEN}" \
        -d "{\"walletAddress\":\"${WALLET}\"}" \
        >/dev/null 2>&1 || true
else
    echo "WARNING: Registration submitted but not yet confirmed on-chain."
    echo "This may take a few more seconds. Run 'python3 ~/scripts/agentbook-check.py status' to check."
fi
