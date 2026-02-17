#!/bin/bash
#
# fleet-update-heartbeat.sh — Update heartbeat interval on all assigned VMs
#
# Sets agents.defaults.heartbeat.every to 3h on every VM that has an owner.
# No gateway restart needed — OpenClaw picks up config changes on next heartbeat.
#
# Usage:
#   ./instaclaw/scripts/fleet-update-heartbeat.sh
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

SUPABASE_URL=$(load_env "NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY=$(load_env "SUPABASE_SERVICE_ROLE_KEY")
SSH_PRIVATE_KEY_B64=$(load_env "SSH_PRIVATE_KEY_B64")

if [ -z "$SUPABASE_URL" ]; then echo "Error: NEXT_PUBLIC_SUPABASE_URL not found"; exit 1; fi
if [ -z "$SUPABASE_KEY" ]; then echo "Error: SUPABASE_SERVICE_ROLE_KEY not found"; exit 1; fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then echo "Error: SSH_PRIVATE_KEY_B64 not found"; exit 1; fi

# Write SSH key to temp file
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

# NVM preamble (must match ssh.ts)
NVM_PREAMBLE='export LD_LIBRARY_PATH="$HOME/local-libs/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}" && export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'

# Fetch all assigned VMs
echo "=== Fetching assigned VMs ==="
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
  echo "[$VM_NAME] $VM_IP — updating heartbeat to 3h..."

  RESULT=$(ssh -n -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes \
    -i "$SSH_KEY_FILE" -p "$VM_PORT" "${VM_USER}@${VM_IP}" \
    "${NVM_PREAMBLE} && openclaw config set agents.defaults.heartbeat.every 3h && echo HEARTBEAT_UPDATED" 2>/dev/null || true)

  if echo "$RESULT" | grep -q "HEARTBEAT_UPDATED"; then
    echo "  OK"
  else
    echo "  FAILED: $RESULT"
  fi
done

echo ""
echo "=== Fleet heartbeat update complete ==="
