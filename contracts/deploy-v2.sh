#!/bin/bash
# Deploy WildWestEscrowV2 to Base Mainnet
#
# Prerequisites:
# 1. DEPLOYER_PRIVATE_KEY set in .env.local
# 2. Oracle wallet funded with ETH on Base (ORACLE_ADDRESS)
# 3. Deployer wallet funded with ETH on Base for deployment gas
#
# Usage: ./deploy-v2.sh

set -e

# Load environment variables
if [ -f "../.env.local" ]; then
    export $(cat ../.env.local | grep -v '^#' | xargs)
fi

# Validate required variables
if [ -z "$DEPLOYER_PRIVATE_KEY" ]; then
    echo "ERROR: DEPLOYER_PRIVATE_KEY not set in .env.local"
    echo "Add your deployer wallet private key to .env.local"
    exit 1
fi

if [ -z "$TREASURY_ADDRESS" ]; then
    echo "ERROR: TREASURY_ADDRESS not set"
    exit 1
fi

if [ -z "$ORACLE_ADDRESS" ]; then
    echo "ERROR: ORACLE_ADDRESS not set"
    exit 1
fi

RPC_URL="${ALCHEMY_BASE_URL:-https://mainnet.base.org}"

echo "=== WildWestEscrowV2 Deployment ==="
echo ""
echo "Network: Base Mainnet"
echo "RPC: $RPC_URL"
echo "Treasury: $TREASURY_ADDRESS"
echo "Oracle: $ORACLE_ADDRESS"
echo ""

# Build
echo "Building contracts..."
forge build

# Deploy
echo ""
echo "Deploying..."
forge script script/DeployV2.s.sol:DeployEscrowV2 \
    --rpc-url "$RPC_URL" \
    --broadcast \
    --private-key "$DEPLOYER_PRIVATE_KEY"

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Next steps:"
echo "1. Copy the deployed contract address from above"
echo "2. Add to .env.local: NEXT_PUBLIC_ESCROW_CONTRACT_V2_ADDRESS=<address>"
echo "3. Verify the contract on BaseScan (optional):"
echo "   forge verify-contract <address> WildWestEscrowV2 --chain base"
