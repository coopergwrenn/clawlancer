#!/bin/bash
#
# open-spots.sh — Open new spots by provisioning VMs
#
# Usage:
#   ./scripts/open-spots.sh 3          # Provision 3 new VMs (max 10)
#   ./scripts/open-spots.sh            # Default: provision 2 new VMs
#
# Prerequisites:
#   - ADMIN_KEY env var set (or pass as second arg)
#   - App running at SITE_URL (defaults to https://instaclaw.io)
#

COUNT="${1:-2}"
SITE_URL="${SITE_URL:-https://instaclaw.io}"
ADMIN_KEY="${ADMIN_KEY:-$2}"

if [ -z "$ADMIN_KEY" ]; then
  echo "Error: Set ADMIN_KEY env var or pass as second argument"
  echo "Usage: ADMIN_KEY=your-key ./scripts/open-spots.sh 3"
  exit 1
fi

if [ "$COUNT" -lt 1 ] || [ "$COUNT" -gt 10 ]; then
  echo "Error: Count must be between 1 and 10"
  exit 1
fi

echo "Opening $COUNT spot(s) on $SITE_URL..."
echo ""

# Check current pool status
echo "Current pool status:"
curl -s "$SITE_URL/api/spots" | python3 -m json.tool 2>/dev/null || curl -s "$SITE_URL/api/spots"
echo ""

# Provision new VMs
echo "Provisioning $COUNT VM(s)..."
RESPONSE=$(curl -s -X POST "$SITE_URL/api/admin/provision" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -d "{\"count\": $COUNT}")

echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
echo ""

# Wait a moment for DB to update
sleep 3

# Check new pool status
echo "Updated pool status:"
curl -s "$SITE_URL/api/spots" | python3 -m json.tool 2>/dev/null || curl -s "$SITE_URL/api/spots"
echo ""

echo "Done! $COUNT spot(s) should now be open."
