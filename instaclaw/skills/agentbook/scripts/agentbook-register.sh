#!/usr/bin/env bash
set -euo pipefail

# AgentBook registration script for VM agents.
# 1. Retrieves wallet address via MCP
# 2. Checks if already registered
# 3. Runs @worldcoin/agentkit-cli register
# 4. Reports result back to InstaClaw API

INSTACLAW_API="${INSTACLAW_API_URL:-https://instaclaw.io}"

echo "=== AgentBook Registration ==="
echo ""

# Step 1: Get wallet address via MCP
echo "Retrieving wallet address..."
PROFILE=$(mcporter call clawlancer.get_my_profile 2>/dev/null || echo '{}')
WALLET=$(echo "$PROFILE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('wallet_address',''))" 2>/dev/null || echo "")

if [ -z "$WALLET" ]; then
    echo "ERROR: No wallet address found."
    echo "Register on Clawlancer first: mcporter call clawlancer.register_agent"
    exit 1
fi

echo "Wallet: $WALLET"
echo ""

# Step 2: Check if already registered
echo "Checking AgentBook status..."
STATUS=$(python3 ~/scripts/agentbook-check.py status --json 2>/dev/null || echo '{"registered":false}')
REGISTERED=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('registered',False))" 2>/dev/null || echo "False")

if [ "$REGISTERED" = "True" ]; then
    echo "Already registered in AgentBook. No action needed."
    echo "$STATUS"
    exit 0
fi

echo "Not yet registered. Starting registration..."
echo ""

# Step 3: Run the CLI with --agent flag for machine-readable output
# The CLI will display a QR code / link for the human to scan with World App.
# --agent flag produces: HUMAN ACTION REQUIRED: Scan or click this link...
echo "A QR code or link will appear below."
echo "The human operator must scan it with World App to complete verification."
echo ""

npx @worldcoin/agentkit-cli@0.1.3 register \
    --agent \
    --wallet "$WALLET" \
    --network base

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
STATUS=$(python3 ~/scripts/agentbook-check.py status --json 2>/dev/null || echo '{"registered":false}')
REGISTERED=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('registered',False))" 2>/dev/null || echo "False")

if [ "$REGISTERED" = "True" ]; then
    echo "Registration confirmed on-chain!"
    echo "$STATUS"

    # Step 5: Report back to InstaClaw (fire and forget)
    # Uses the session cookie from the user's auth
    curl -s -X POST "${INSTACLAW_API}/api/agentbook/register" \
        -H "Content-Type: application/json" \
        -d "{\"walletAddress\":\"${WALLET}\"}" \
        >/dev/null 2>&1 || true
else
    echo "WARNING: Registration submitted but not yet confirmed on-chain."
    echo "This may take a few more seconds. Run 'python3 ~/scripts/agentbook-check.py status' to check."
fi
