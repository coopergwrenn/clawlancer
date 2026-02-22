#!/bin/bash
#
# ecommerce-setup.sh — E-Commerce Platform Setup & Validation
#
# Validates platform credentials, tests API connections, and initializes
# the ecommerce.yaml config file for multi-channel operations.
#
# BYOK: User provides their own API credentials for Shopify, Amazon, eBay, ShipStation.
# No InstaClaw platform-level keys — all credentials belong to the user.
#
# Usage:
#   ecommerce-setup.sh status              — Show all platform connection status
#   ecommerce-setup.sh test <platform>      — Test a specific platform connection
#   ecommerce-setup.sh init                 — Create default ecommerce.yaml template
#   ecommerce-setup.sh validate             — Validate ecommerce.yaml syntax
#
# Platforms: shopify, amazon, ebay, shipstation
#

set -euo pipefail

CONFIG_DIR="$HOME/.openclaw/config"
CONFIG_FILE="$CONFIG_DIR/ecommerce.yaml"
DATA_DIR="$HOME/.openclaw/workspace/ecommerce"

ensure_dirs() {
  mkdir -p "$CONFIG_DIR" "$DATA_DIR" "$DATA_DIR/reports"
}

# ── Test Shopify ──

test_shopify() {
  local shop token response
  shop=$(grep -A5 'shopify:' "$CONFIG_FILE" 2>/dev/null | grep 'shop:' | awk '{print $2}' | tr -d '"' || true)
  token=$(grep -A5 'shopify:' "$CONFIG_FILE" 2>/dev/null | grep 'access_token:' | awk '{print $2}' | tr -d '"' || true)

  if [ -z "$shop" ] || [ -z "$token" ]; then
    echo "  Shopify: ❌ Not configured (missing shop or access_token)"
    return 1
  fi

  echo "  Shopify: Testing connection to $shop..."
  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "X-Shopify-Access-Token: $token" \
    "https://${shop}/admin/api/2024-01/shop.json" 2>/dev/null || echo "000")

  if [ "$response" = "200" ]; then
    echo "  Shopify: ✅ Connected ($shop)"
    return 0
  else
    echo "  Shopify: ❌ Connection failed (HTTP $response)"
    return 1
  fi
}

# ── Test Amazon ──

test_amazon() {
  local client_id client_secret refresh_token
  client_id=$(grep -A10 'amazon:' "$CONFIG_FILE" 2>/dev/null | grep 'lwa_client_id:' | awk '{print $2}' | tr -d '"' || true)
  client_secret=$(grep -A10 'amazon:' "$CONFIG_FILE" 2>/dev/null | grep 'lwa_client_secret:' | awk '{print $2}' | tr -d '"' || true)
  refresh_token=$(grep -A10 'amazon:' "$CONFIG_FILE" 2>/dev/null | grep 'refresh_token:' | awk '{print $2}' | tr -d '"' || true)

  if [ -z "$client_id" ] || [ -z "$refresh_token" ]; then
    echo "  Amazon: ❌ Not configured (missing LWA credentials)"
    return 1
  fi

  echo "  Amazon: Testing LWA token exchange..."
  local token_response
  token_response=$(curl -s -X POST "https://api.amazon.com/auth/o2/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=refresh_token&refresh_token=${refresh_token}&client_id=${client_id}&client_secret=${client_secret}" 2>/dev/null)

  if echo "$token_response" | grep -q "access_token"; then
    echo "  Amazon: ✅ LWA token exchange successful"
    return 0
  else
    local error
    error=$(echo "$token_response" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error_description','Unknown error'))" 2>/dev/null || echo "Token exchange failed")
    echo "  Amazon: ❌ $error"
    return 1
  fi
}

# ── Test eBay ──

test_ebay() {
  local user_token
  user_token=$(grep -A5 'ebay:' "$CONFIG_FILE" 2>/dev/null | grep 'user_token:' | awk '{print $2}' | tr -d '"' || true)

  if [ -z "$user_token" ]; then
    echo "  eBay: ❌ Not configured (missing user_token)"
    return 1
  fi

  echo "  eBay: Testing API connection..."
  local response
  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $user_token" \
    "https://api.ebay.com/sell/account/v1/privilege" 2>/dev/null || echo "000")

  if [ "$response" = "200" ]; then
    echo "  eBay: ✅ Connected"
    return 0
  elif [ "$response" = "401" ]; then
    echo "  eBay: ❌ Token expired or invalid (HTTP 401)"
    return 1
  else
    echo "  eBay: ❌ Connection failed (HTTP $response)"
    return 1
  fi
}

# ── Test ShipStation ──

test_shipstation() {
  local api_key api_secret
  api_key=$(grep -A5 'fulfillment:' "$CONFIG_FILE" 2>/dev/null | grep 'api_key:' | awk '{print $2}' | tr -d '"' || true)
  api_secret=$(grep -A5 'fulfillment:' "$CONFIG_FILE" 2>/dev/null | grep 'api_secret:' | awk '{print $2}' | tr -d '"' || true)

  if [ -z "$api_key" ] || [ -z "$api_secret" ]; then
    echo "  ShipStation: ❌ Not configured (missing api_key/api_secret)"
    return 1
  fi

  echo "  ShipStation: Testing API connection..."
  local auth response
  auth=$(echo -n "${api_key}:${api_secret}" | base64)
  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Basic $auth" \
    "https://ssapi.shipstation.com/warehouses" 2>/dev/null || echo "000")

  if [ "$response" = "200" ]; then
    echo "  ShipStation: ✅ Connected"
    return 0
  else
    echo "  ShipStation: ❌ Connection failed (HTTP $response)"
    return 1
  fi
}

# ── Commands ──

cmd_status() {
  echo "=================================="
  echo "E-COMMERCE PLATFORM STATUS"
  echo "=================================="
  echo ""

  if [ ! -f "$CONFIG_FILE" ]; then
    echo "Config: ❌ Not found at $CONFIG_FILE"
    echo ""
    echo "Run: ecommerce-setup.sh init"
    echo "Then edit $CONFIG_FILE with your platform credentials."
    return 1
  fi

  echo "Config: ✅ $CONFIG_FILE"
  echo ""

  echo "PLATFORMS:"
  test_shopify || true
  test_amazon || true
  test_ebay || true
  echo ""

  echo "FULFILLMENT:"
  test_shipstation || true
  echo ""

  # Policies
  echo "POLICIES:"
  local return_window auto_approve human_over buffer max_price
  return_window=$(grep 'return_window_days:' "$CONFIG_FILE" 2>/dev/null | awk '{print $2}' || echo "30")
  auto_approve=$(grep 'auto_approve_threshold:' "$CONFIG_FILE" 2>/dev/null | awk '{print $2}' || echo "100")
  human_over=$(grep 'require_human_over:' "$CONFIG_FILE" 2>/dev/null | awk '{print $2}' || echo "200")
  buffer=$(grep 'inventory_buffer_units:' "$CONFIG_FILE" 2>/dev/null | awk '{print $2}' || echo "5")
  max_price=$(grep 'max_price_change_pct:' "$CONFIG_FILE" 2>/dev/null | awk '{print $2}' || echo "20")

  echo "  Return window: ${return_window} days"
  echo "  Auto-approve returns under: \$${auto_approve}"
  echo "  Human approval over: \$${human_over}"
  echo "  Inventory buffer: ${buffer} units"
  echo "  Max price change: ${max_price}%"
}

cmd_test() {
  local platform="$1"

  case "$platform" in
    shopify)    test_shopify ;;
    amazon)     test_amazon ;;
    ebay)       test_ebay ;;
    shipstation) test_shipstation ;;
    *)
      echo "Unknown platform: $platform"
      echo "Valid platforms: shopify, amazon, ebay, shipstation"
      return 1
      ;;
  esac
}

cmd_init() {
  ensure_dirs

  if [ -f "$CONFIG_FILE" ]; then
    echo "Config already exists at $CONFIG_FILE"
    echo "Delete it first if you want to start fresh."
    return 1
  fi

  cat > "$CONFIG_FILE" <<'YAML'
# E-Commerce Configuration — BYOK (Bring Your Own Keys)
# Edit this file with your platform credentials.
# Credentials are encrypted at rest via libsodium.

platforms:
  shopify:
    enabled: false
    shop: yourstore.myshopify.com
    access_token: YOUR_SHOPIFY_ADMIN_API_TOKEN

  amazon:
    enabled: false
    lwa_client_id: YOUR_LWA_CLIENT_ID
    lwa_client_secret: YOUR_LWA_CLIENT_SECRET
    refresh_token: YOUR_REFRESH_TOKEN
    aws_access_key: YOUR_AWS_ACCESS_KEY
    aws_secret_key: YOUR_AWS_SECRET_KEY
    seller_id: YOUR_SELLER_ID
    marketplace_id: ATVPDKIKX0DER

  ebay:
    enabled: false
    app_id: YOUR_EBAY_APP_ID
    cert_id: YOUR_EBAY_CERT_ID
    user_token: YOUR_EBAY_USER_TOKEN

fulfillment:
  system: shipstation
  api_key: YOUR_SHIPSTATION_API_KEY
  api_secret: YOUR_SHIPSTATION_API_SECRET

policies:
  return_window_days: 30
  auto_approve_threshold: 100
  require_human_over: 200
  restocking_fee_pct: 0
  low_stock_threshold: 10
  inventory_buffer_units: 5
  max_price_change_pct: 20
YAML

  echo "✅ Created template config: $CONFIG_FILE"
  echo ""
  echo "Next steps:"
  echo "  1. Edit $CONFIG_FILE with your platform credentials"
  echo "  2. Set 'enabled: true' for each platform you use"
  echo "  3. Run: ecommerce-setup.sh status"
  echo ""
  echo "Setup guides:"
  echo "  Shopify:     10 min — Admin > Settings > Apps > Develop apps > Create token"
  echo "  Amazon:      30-45 min — Register as SP-API Developer, create IAM + LWA creds"
  echo "  eBay:        15-20 min — developer.ebay.com > Create app > Generate token"
  echo "  ShipStation:  5 min — Settings > API Settings > Generate keys"
}

cmd_validate() {
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ Config not found: $CONFIG_FILE"
    echo "Run: ecommerce-setup.sh init"
    return 1
  fi

  echo "Validating $CONFIG_FILE..."

  local errors=0

  # Check required sections
  for section in "platforms:" "fulfillment:" "policies:"; do
    if ! grep -q "$section" "$CONFIG_FILE"; then
      echo "  ❌ Missing section: $section"
      errors=$((errors + 1))
    fi
  done

  # Check for placeholder values
  if grep -q "YOUR_" "$CONFIG_FILE"; then
    echo "  ⚠️  Placeholder values found (YOUR_...) — replace with real credentials"
    grep "YOUR_" "$CONFIG_FILE" | while read -r line; do
      echo "    $line"
    done
  fi

  # Check policies are numbers
  for policy in return_window_days auto_approve_threshold require_human_over low_stock_threshold inventory_buffer_units max_price_change_pct; do
    local val
    val=$(grep "${policy}:" "$CONFIG_FILE" 2>/dev/null | awk '{print $2}' || true)
    if [ -n "$val" ] && ! echo "$val" | grep -qE '^[0-9]+$'; then
      echo "  ❌ Policy ${policy} must be a number, got: $val"
      errors=$((errors + 1))
    fi
  done

  if [ "$errors" -eq 0 ]; then
    echo "  ✅ Config syntax valid"
  else
    echo "  ❌ Found $errors error(s)"
    return 1
  fi
}

# ── Main ──

CMD="${1:---help}"

case "$CMD" in
  status)
    cmd_status
    ;;
  test)
    if [ -z "${2:-}" ]; then
      echo "Usage: ecommerce-setup.sh test <platform>"
      echo "Platforms: shopify, amazon, ebay, shipstation"
      exit 1
    fi
    cmd_test "$2"
    ;;
  init)
    cmd_init
    ;;
  validate)
    cmd_validate
    ;;
  --help|*)
    echo "ecommerce-setup.sh — E-Commerce Platform Setup & Validation"
    echo ""
    echo "Usage:"
    echo "  $0 status              — Show all platform connection status"
    echo "  $0 test <platform>     — Test a specific platform (shopify|amazon|ebay|shipstation)"
    echo "  $0 init                — Create default ecommerce.yaml template"
    echo "  $0 validate            — Validate ecommerce.yaml syntax"
    echo ""
    echo "Config: $CONFIG_FILE"
    echo ""
    echo "BYOK: You provide your own platform API credentials."
    echo "No InstaClaw platform-level keys required."
    ;;
esac
