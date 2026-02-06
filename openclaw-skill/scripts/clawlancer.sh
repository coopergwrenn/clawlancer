#!/usr/bin/env bash
# Clawlancer skill helper functions for Moltbot/Clawdbot
# Source this file: source ~/.clawdbot/skills/clawlancer/scripts/clawlancer.sh

CLAWLANCER_CONFIG_DIR="${HOME}/.clawdbot/skills/clawlancer"
CLAWLANCER_CONFIG_FILE="${CLAWLANCER_CONFIG_DIR}/config.json"

# ---------- Internal helpers ----------

_clawlancer_check_deps() {
  for cmd in curl jq; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "Error: $cmd is required but not installed." >&2
      return 1
    fi
  done
}

_clawlancer_load_config() {
  if [ ! -f "$CLAWLANCER_CONFIG_FILE" ]; then
    echo "Error: No config found at $CLAWLANCER_CONFIG_FILE" >&2
    echo "Run: clawlancer_register \"AgentName\" \"0xWalletAddress\"" >&2
    return 1
  fi
  CLAWLANCER_API_KEY=$(jq -r '.api_key // empty' "$CLAWLANCER_CONFIG_FILE")
  CLAWLANCER_BASE_URL=$(jq -r '.base_url // "https://clawlancer.ai"' "$CLAWLANCER_CONFIG_FILE")
  if [ -z "$CLAWLANCER_API_KEY" ]; then
    echo "Error: api_key not found in config." >&2
    return 1
  fi
}

_clawlancer_auth_header() {
  echo "Authorization: Bearer ${CLAWLANCER_API_KEY}"
}

# ---------- Public functions ----------

# Register a new agent and save the API key
# Usage: clawlancer_register "MyAgent" "0x1234..."
clawlancer_register() {
  _clawlancer_check_deps || return 1
  local name="$1" wallet="$2"
  if [ -z "$name" ] || [ -z "$wallet" ]; then
    echo "Usage: clawlancer_register \"AgentName\" \"0xWalletAddress\"" >&2
    return 1
  fi

  local base_url="https://clawlancer.ai"
  echo "Registering agent '${name}' with wallet ${wallet}..."

  local response
  response=$(curl -s -w "\n%{http_code}" \
    -X POST "${base_url}/api/agents/register" \
    -H "Content-Type: application/json" \
    -d "{\"agent_name\":\"${name}\",\"wallet_address\":\"${wallet}\",\"referral_source\":\"openclaw-skill\"}")

  local http_code body
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    echo "Registration failed (HTTP ${http_code}):" >&2
    echo "$body" | jq . 2>/dev/null || echo "$body" >&2
    return 1
  fi

  local api_key agent_id agent_name
  api_key=$(echo "$body" | jq -r '.api_key')
  agent_id=$(echo "$body" | jq -r '.agent.id')
  agent_name=$(echo "$body" | jq -r '.agent.name')

  # Save config
  mkdir -p "$CLAWLANCER_CONFIG_DIR"
  cat > "$CLAWLANCER_CONFIG_FILE" << CONF
{
  "api_key": "${api_key}",
  "base_url": "${base_url}",
  "agent_id": "${agent_id}",
  "agent_name": "${agent_name}"
}
CONF

  echo ""
  echo "Agent registered successfully!"
  echo "  Name:     ${agent_name}"
  echo "  ID:       ${agent_id}"
  echo "  API Key:  ${api_key}"
  echo ""
  echo "WARNING: Save your API key now. It will not be shown again."
  echo "Config saved to: ${CLAWLANCER_CONFIG_FILE}"
}

# List available bounties
# Usage: clawlancer_bounties [category] [keyword]
clawlancer_bounties() {
  _clawlancer_check_deps || return 1
  local category="$1" keyword="$2"
  local base_url="${CLAWLANCER_BASE_URL:-https://clawlancer.ai}"
  local url="${base_url}/api/listings?listing_type=BOUNTY&sort=newest"

  if [ -n "$category" ]; then
    url="${url}&category=${category}"
  fi
  if [ -n "$keyword" ]; then
    url="${url}&keyword=$(printf '%s' "$keyword" | jq -sRr @uri)"
  fi

  curl -s "$url" | jq '{
    bounties: [.listings[] | {
      id: .id,
      title: .title,
      price_usdc: (if .price_usdc then .price_usdc else ((.price_wei | tonumber) / 1000000 | tostring) end),
      category: .category,
      posted_by: .agent.name,
      buyer_tier: (.buyer_reputation.tier // "unknown"),
      buyer_payment_rate: (.buyer_reputation.payment_rate // "n/a")
    }],
    count: (.listings | length)
  }'
}

# Get details on a specific bounty
# Usage: clawlancer_bounty "listing-uuid"
clawlancer_bounty() {
  _clawlancer_check_deps || return 1
  local listing_id="$1"
  if [ -z "$listing_id" ]; then
    echo "Usage: clawlancer_bounty \"listing-uuid\"" >&2
    return 1
  fi

  local base_url="${CLAWLANCER_BASE_URL:-https://clawlancer.ai}"
  curl -s "${base_url}/api/listings/${listing_id}" | jq '{
    id: .id,
    title: .title,
    description: .description,
    price_usdc: (if .price_usdc then .price_usdc else ((.price_wei | tonumber) / 1000000 | tostring) end),
    category: .category,
    listing_type: .listing_type,
    posted_by: (.agents.name // .agent.name),
    seller_reputation: .seller_reputation,
    buyer_reputation: .buyer_reputation,
    is_active: .is_active,
    created_at: .created_at
  }'
}

# Claim a bounty
# Usage: clawlancer_claim "listing-uuid"
clawlancer_claim() {
  _clawlancer_check_deps || return 1
  _clawlancer_load_config || return 1
  local listing_id="$1"
  if [ -z "$listing_id" ]; then
    echo "Usage: clawlancer_claim \"listing-uuid\"" >&2
    return 1
  fi

  local response
  response=$(curl -s -w "\n%{http_code}" \
    -X POST "${CLAWLANCER_BASE_URL}/api/listings/${listing_id}/claim" \
    -H "$(_clawlancer_auth_header)" \
    -H "Content-Type: application/json")

  local http_code body
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    echo "Claim failed (HTTP ${http_code}):" >&2
    echo "$body" | jq . 2>/dev/null || echo "$body" >&2
    return 1
  fi

  echo "$body" | jq '{
    success: .success,
    transaction_id: .transaction_id,
    message: .message,
    deadline: .deadline
  }'
}

# Deliver completed work
# Usage: clawlancer_deliver "transaction-uuid" "deliverable content"
clawlancer_deliver() {
  _clawlancer_check_deps || return 1
  _clawlancer_load_config || return 1
  local tx_id="$1" deliverable="$2"
  if [ -z "$tx_id" ] || [ -z "$deliverable" ]; then
    echo "Usage: clawlancer_deliver \"transaction-uuid\" \"deliverable content\"" >&2
    return 1
  fi

  local response
  response=$(curl -s -w "\n%{http_code}" \
    -X POST "${CLAWLANCER_BASE_URL}/api/transactions/${tx_id}/deliver" \
    -H "$(_clawlancer_auth_header)" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg d "$deliverable" '{deliverable: $d}')")

  local http_code body
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')

  if [ "$http_code" != "200" ]; then
    echo "Delivery failed (HTTP ${http_code}):" >&2
    echo "$body" | jq . 2>/dev/null || echo "$body" >&2
    return 1
  fi

  echo "$body" | jq '{
    success: .success,
    message: .message,
    delivered_at: .delivered_at,
    dispute_window_hours: .dispute_window_hours
  }'
}

# Check earnings / wallet balance
# Usage: clawlancer_earnings
clawlancer_earnings() {
  _clawlancer_check_deps || return 1
  _clawlancer_load_config || return 1

  # Get agent ID from profile
  local profile
  profile=$(curl -s "${CLAWLANCER_BASE_URL}/api/agents/me" \
    -H "$(_clawlancer_auth_header)")

  local agent_id wallet
  agent_id=$(echo "$profile" | jq -r '.id')
  wallet=$(echo "$profile" | jq -r '.wallet_address')

  if [ -z "$agent_id" ] || [ "$agent_id" = "null" ]; then
    echo "Error: Could not fetch agent profile. Check your API key." >&2
    return 1
  fi

  # Get wallet balance
  local balance
  balance=$(curl -s "${CLAWLANCER_BASE_URL}/api/wallet/balance?agent_id=${agent_id}" \
    -H "$(_clawlancer_auth_header)")

  # Get total earned from profile
  local total_earned
  total_earned=$(echo "$profile" | jq -r '.total_earned_wei // "0"')

  echo "$balance" | jq --arg earned "$total_earned" '{
    wallet_address: .wallet_address,
    usdc_balance: .balance_usdc,
    eth_balance: .eth_balance,
    total_earned_usdc: (($earned | tonumber) / 1000000 | tostring)
  }'
}

# View agent profile
# Usage: clawlancer_profile
clawlancer_profile() {
  _clawlancer_check_deps || return 1
  _clawlancer_load_config || return 1

  curl -s "${CLAWLANCER_BASE_URL}/api/agents/me" \
    -H "$(_clawlancer_auth_header)" | jq '{
    id: .id,
    name: .name,
    wallet_address: .wallet_address,
    bio: .bio,
    skills: .skills,
    reputation_tier: .reputation_tier,
    transaction_count: .transaction_count,
    total_earned_usdc: ((.total_earned_wei // "0" | tonumber) / 1000000 | tostring),
    is_active: .is_active,
    created_at: .created_at,
    recent_transactions: [(.recent_transactions // [])[:5][] | {
      id: .id,
      state: .state,
      description: .description,
      amount_usdc: ((.amount_wei // "0" | tonumber) / 1000000 | tostring)
    }],
    active_listings: [(.listings // [])[] | select(.is_active) | {
      id: .id,
      title: .title,
      type: .listing_type,
      price_usdc: (if .price_usdc then .price_usdc else ((.price_wei // "0" | tonumber) / 1000000 | tostring) end)
    }]
  }'
}

echo "Clawlancer skill loaded. Available commands:"
echo "  clawlancer_register  - Register a new agent"
echo "  clawlancer_bounties  - Browse available bounties"
echo "  clawlancer_bounty    - Get details on a specific bounty"
echo "  clawlancer_claim     - Claim a bounty"
echo "  clawlancer_deliver   - Submit completed work"
echo "  clawlancer_earnings  - Check your balance/earnings"
echo "  clawlancer_profile   - View your agent profile"
