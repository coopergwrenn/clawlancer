#!/usr/bin/env bash
set -euo pipefail

# AgentBook registration script for VM agents.
# Usage: bash agentbook-register.sh <WALLET_ADDRESS>
#
# 1. Validates the wallet address argument
# 2. Checks if already registered
# 3. Runs @worldcoin/agentkit-cli register --llms (outputs verification URL)
# 4. Polls on-chain every 10s for up to 5 minutes waiting for registration to confirm
# 5. Reports result back to InstaClaw API
#
# IMPORTANT: The CLI outputs a "HUMAN ACTION REQUIRED:" URL. The human must
# open that URL in World App and complete verification. This script waits
# until the on-chain state changes (nonce increments) before reporting success.

source ~/.nvm/nvm.sh 2>/dev/null || true

INSTACLAW_API="${INSTACLAW_API_URL:-https://instaclaw.io}"
WALLET="${1:-}"
AGENTBOOK_CONTRACT="0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4"
POLL_INTERVAL=10
POLL_TIMEOUT=300  # 5 minutes

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

# Step 3: Run the CLI — capture output to extract the verification URL
CLI_OUTPUT=$(npx @worldcoin/agentkit-cli@0.1.3 --llms register "$WALLET" --network base 2>&1) || true

echo "$CLI_OUTPUT"
echo ""

# Extract the verification URL from CLI output (World Bridge connector URI)
VERIFY_URL=$(echo "$CLI_OUTPUT" | grep -oE 'https://[^ ]+' | head -1 || true)

if [ -n "$VERIFY_URL" ]; then
    echo "==========================================="
    echo "HUMAN ACTION REQUIRED"
    echo "==========================================="
    echo ""
    echo "Open this link on your phone to verify with World App:"
    echo ""
    echo "  $VERIFY_URL"
    echo ""
    echo "==========================================="
    echo ""
    echo "Waiting for on-chain confirmation (polling every ${POLL_INTERVAL}s, timeout ${POLL_TIMEOUT}s)..."
else
    echo "WARNING: Could not extract verification URL from CLI output."
    echo "The CLI may have completed registration directly."
    echo "Checking on-chain status..."
fi

# Step 4: Poll on-chain until registered or timeout
ELAPSED=0
CONFIRMED=false

while [ $ELAPSED -lt $POLL_TIMEOUT ]; do
    sleep $POLL_INTERVAL
    ELAPSED=$((ELAPSED + POLL_INTERVAL))

    CHECK=$(python3 ~/scripts/agentbook-check.py --json status 2>/dev/null || echo '{"registered":false}')
    IS_REG=$(echo "$CHECK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('registered',False))" 2>/dev/null || echo "False")

    if [ "$IS_REG" = "True" ]; then
        CONFIRMED=true
        STATUS="$CHECK"
        break
    fi

    REMAINING=$((POLL_TIMEOUT - ELAPSED))
    echo "  [${ELAPSED}s] Not yet registered on-chain. ${REMAINING}s remaining..."
done

echo ""

if [ "$CONFIRMED" = "true" ]; then
    echo "REGISTRATION CONFIRMED ON-CHAIN!"
    echo "$STATUS"

    # Extract nullifier_hash from status JSON
    NULLIFIER=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('nullifier_hash',''))" 2>/dev/null || echo "")

    # Step 5: Report back to InstaClaw (Bearer gateway token auth)
    TOKEN=$(grep '^GATEWAY_TOKEN=' ~/.openclaw/.env | cut -d= -f2 || true)
    curl -s -X POST "${INSTACLAW_API}/api/agentbook/register" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKEN}" \
        -d "{\"walletAddress\":\"${WALLET}\",\"nullifierHash\":\"${NULLIFIER}\"}" \
        >/dev/null 2>&1 || true

    echo ""
    echo "Registration reported to InstaClaw."
else
    echo "REGISTRATION NOT CONFIRMED after ${POLL_TIMEOUT} seconds."
    echo ""
    echo "Possible reasons:"
    echo "  1. The human has not yet opened the verification URL in World App"
    echo "  2. The World App verification was not completed"
    echo "  3. The gasless relay failed to submit the transaction"
    echo ""
    echo "To retry: ask the human to open the URL above in World App,"
    echo "then run: python3 ~/scripts/agentbook-check.py --json status"
    exit 1
fi
