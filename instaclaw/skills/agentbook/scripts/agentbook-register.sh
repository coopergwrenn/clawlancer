#!/usr/bin/env bash
set -euo pipefail

# AgentBook registration script for VM agents.
# Usage: bash agentbook-register.sh <WALLET_ADDRESS>
#
# Flow:
# 1. Validates wallet, checks if already registered
# 2. Runs agentkit-cli register (blocks up to 5 min waiting for World App scan)
# 3. CLI outputs "HUMAN ACTION REQUIRED: ... https://world.org/verify?..." URL
# 4. Script extracts and prints the URL clearly for the agent to send to the user
# 5. CLI polls internally — when human completes scan, CLI submits to gasless relay
# 6. On success (exit 0): verifies on-chain, reports to InstaClaw
# 7. On failure (exit non-0): reports timeout/failure

source ~/.nvm/nvm.sh 2>/dev/null || true

INSTACLAW_API="${INSTACLAW_API_URL:-https://instaclaw.io}"
WALLET="${1:-}"
OUTPUT_FILE="/tmp/agentbook-cli-output.txt"

echo "=== AgentBook Registration ==="
echo ""

# Step 1: Validate wallet address
if [ -z "$WALLET" ]; then
    echo "ERROR: Wallet address required as first argument."
    echo "Usage: bash agentbook-register.sh 0x..."
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

# Step 3: Launch CLI in background with tee to capture output
rm -f "$OUTPUT_FILE"
npx @worldcoin/agentkit-cli@0.1.3 register "$WALLET" --network base 2>&1 | tee "$OUTPUT_FILE" &
CLI_PID=$!

# Step 4: Poll output file every 2s until the verification URL appears (max 30s)
VERIFY_URL=""
for i in $(seq 1 15); do
    sleep 2
    if [ -f "$OUTPUT_FILE" ]; then
        VERIFY_URL=$(grep -oE 'https://world\.org/verify[^ ]+' "$OUTPUT_FILE" 2>/dev/null || true)
        if [ -n "$VERIFY_URL" ]; then
            break
        fi
    fi
done

echo ""
if [ -n "$VERIFY_URL" ]; then
    echo "==========================================="
    echo "HUMAN ACTION REQUIRED"
    echo "==========================================="
    echo ""
    echo "Open this link on your phone in World App:"
    echo ""
    echo "$VERIFY_URL"
    echo ""
    echo "==========================================="
    echo ""
    echo "Waiting for human to complete verification in World App..."
    echo "(The CLI is polling — this can take up to 5 minutes)"
else
    echo "WARNING: Could not extract verification URL from CLI output."
    echo "Raw output:"
    cat "$OUTPUT_FILE" 2>/dev/null || echo "(empty)"
    echo ""
    echo "Waiting for CLI to complete..."
fi

# Step 5: Wait for CLI process to finish (it polls internally for up to 5 min)
wait $CLI_PID
CLI_EXIT=$?

echo ""

if [ $CLI_EXIT -ne 0 ]; then
    echo "REGISTRATION FAILED (CLI exit code: $CLI_EXIT)"
    echo ""
    echo "Possible reasons:"
    echo "  1. Human did not open the verification URL in World App within 5 minutes"
    echo "  2. World App verification was cancelled or failed"
    echo "  3. Gasless relay failed to submit the transaction"
    echo ""
    echo "To retry: run this script again. A new verification URL will be generated."
    rm -f "$OUTPUT_FILE"
    exit $CLI_EXIT
fi

# Step 6: CLI exited 0 — verify on-chain
echo "CLI completed successfully. Verifying on-chain..."
sleep 5  # Brief wait for tx confirmation

STATUS=$(python3 ~/scripts/agentbook-check.py --json status 2>/dev/null || echo '{"registered":false}')
REGISTERED=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('registered',False))" 2>/dev/null || echo "False")

if [ "$REGISTERED" = "True" ]; then
    echo ""
    echo "REGISTRATION CONFIRMED ON-CHAIN!"
    echo "$STATUS"

    # Extract nullifier_hash
    NULLIFIER=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('nullifier_hash',''))" 2>/dev/null || echo "")

    # Report to InstaClaw
    TOKEN=$(grep '^GATEWAY_TOKEN=' ~/.openclaw/.env | cut -d= -f2 || true)
    RESPONSE=$(curl -s -w '\n%{http_code}' -X POST "${INSTACLAW_API}/api/agentbook/register" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKEN}" \
        -d "{\"walletAddress\":\"${WALLET}\",\"nullifierHash\":\"${NULLIFIER}\"}" 2>/dev/null || echo -e "\n000")
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    echo "Reported to InstaClaw (HTTP $HTTP_CODE)"
else
    echo ""
    echo "WARNING: CLI reported success but on-chain status is still unregistered."
    echo "The transaction may still be confirming. Check again in 30 seconds:"
    echo "  python3 ~/scripts/agentbook-check.py --json status"
fi

rm -f "$OUTPUT_FILE"
