#!/bin/bash
#
# fleet-push-heartbeat-md.sh — Push simplified HEARTBEAT.md to all assigned VMs
#
# Overwrites ~/.openclaw/agents/main/agent/HEARTBEAT.md on every assigned VM
# with the new lightweight version (max 10 API calls per cycle).
#
# Usage:
#   ./instaclaw/scripts/fleet-push-heartbeat-md.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env.local not found at $ENV_FILE"
  exit 1
fi

# Load env vars (handle quoted values)
load_env() {
  local key="$1"
  grep "^${key}=" "$ENV_FILE" | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n'
}

ENV_PROD="${SCRIPT_DIR}/../.env.production"

load_env_any() {
  local key="$1"
  local val
  val=$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
  if [ -z "$val" ] && [ -f "$ENV_PROD" ]; then
    val=$(grep "^${key}=" "$ENV_PROD" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
  fi
  echo "$val"
}

SUPABASE_URL=$(load_env_any "NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY=$(load_env_any "SUPABASE_SERVICE_ROLE_KEY")
SSH_PRIVATE_KEY_B64=$(load_env_any "SSH_PRIVATE_KEY_B64")

if [ -z "$SUPABASE_URL" ]; then echo "Error: NEXT_PUBLIC_SUPABASE_URL not found"; exit 1; fi
if [ -z "$SUPABASE_KEY" ]; then echo "Error: SUPABASE_SERVICE_ROLE_KEY not found"; exit 1; fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then echo "Error: SSH_PRIVATE_KEY_B64 not found"; exit 1; fi

# Write SSH key to temp file
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

# The new simplified HEARTBEAT.md content
HEARTBEAT_MD='# Heartbeat Tasks

Keep heartbeats FAST. You have a budget of ~10 API calls per cycle.
Do NOT run heavy tasks like reviewing all conversations or updating profiles.

## Every Heartbeat (quick check-in)
1. Check for unread messages and reply if needed
2. If something important happened since last check-in, add a one-line note to MEMORY.md

## Weekly (First Heartbeat on Monday)
- Review MEMORY.md and clean up stale entries'

# Base64 encode the content for safe transfer
HEARTBEAT_B64=$(echo "$HEARTBEAT_MD" | base64)

# Fetch all assigned VMs
echo "=== Pushing simplified HEARTBEAT.md to all assigned VMs ==="
VMS=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?assigned_to=not.is.null&select=id,ip_address,ssh_port,ssh_user,name" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}")

VM_COUNT=$(echo "$VMS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "Found $VM_COUNT assigned VM(s)"
echo ""

SUCCESS=0
FAILED=0

echo "$VMS" | python3 -c "
import json, sys
for vm in json.load(sys.stdin):
    print(f\"{vm['id']}|{vm['ip_address']}|{vm.get('ssh_port',22)}|{vm.get('ssh_user','openclaw')}|{vm.get('name','unknown')}\")
" | while IFS='|' read -r VM_ID VM_IP VM_PORT VM_USER VM_NAME; do
  echo -n "[$VM_NAME] $VM_IP — "

  RESULT=$(ssh -n -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes \
    -i "$SSH_KEY_FILE" -p "$VM_PORT" "${VM_USER}@${VM_IP}" \
    "AGENT_DIR=\"\$HOME/.openclaw/agents/main/agent\" && mkdir -p \"\$AGENT_DIR\" && echo '${HEARTBEAT_B64}' | base64 -d > \"\$AGENT_DIR/HEARTBEAT.md\" && echo HEARTBEAT_MD_UPDATED" 2>/dev/null || true)

  if echo "$RESULT" | grep -q "HEARTBEAT_MD_UPDATED"; then
    echo "OK"
    SUCCESS=$((SUCCESS + 1))
  else
    echo "FAILED"
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "=== Fleet HEARTBEAT.md push complete ==="
