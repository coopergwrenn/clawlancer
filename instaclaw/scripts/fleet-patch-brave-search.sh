#!/bin/bash
#
# fleet-patch-brave-search.sh — Add Brave Search API to all assigned VMs
#
# Patches ~/.openclaw/openclaw.json with tools.web.search config and restarts
# the gateway. Uses the correct schema path (tools.web.search, NOT tools.webSearch).
#
# Usage:
#   ./instaclaw/scripts/fleet-patch-brave-search.sh --dry-run           # Show what would happen
#   ./instaclaw/scripts/fleet-patch-brave-search.sh --canary 1.2.3.4    # Single VM
#   ./instaclaw/scripts/fleet-patch-brave-search.sh                     # All assigned VMs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.local"
SSH_ENV_FILE="${SCRIPT_DIR}/../.env.ssh-key"

CANARY_IP=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --canary) CANARY_IP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

# Load SSH key
if [[ -f "$SSH_ENV_FILE" ]]; then
  SSH_KEY_B64=$(grep "SSH_PRIVATE_KEY_B64" "$SSH_ENV_FILE" | sed 's/SSH_PRIVATE_KEY_B64="//' | sed 's/"$//')
else
  echo "ERROR: $SSH_ENV_FILE not found"; exit 1
fi

# Load Brave API key
source "$ENV_FILE" 2>/dev/null || true
BRAVE_KEY="${BRAVE_API_KEY:-}"
if [[ -z "$BRAVE_KEY" ]]; then
  echo "ERROR: BRAVE_API_KEY not found in $ENV_FILE"; exit 1
fi

SSH_KEY_FILE=$(mktemp /tmp/ic-brave-fleet-XXXXXX)
echo "$SSH_KEY_B64" | base64 -d > "$SSH_KEY_FILE" 2>/dev/null || echo "$SSH_KEY_B64" | base64 -D > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap "rm -f $SSH_KEY_FILE" EXIT

SSH_OPTS="-i $SSH_KEY_FILE -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15"

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL}"
SUPABASE_KEY="${SUPABASE_SERVICE_ROLE_KEY}"

# Get VM IPs
if [[ -n "$CANARY_IP" ]]; then
  VM_IPS=("$CANARY_IP")
  echo "=== Canary mode: $CANARY_IP ==="
else
  echo "=== Fetching assigned VMs ==="
  VM_IPS_RAW=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?gateway_token=not.is.null&select=ip_address&health_status=neq.configure_failed" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" \
    | python3 -c "import sys,json; [print(v['ip_address']) for v in json.load(sys.stdin)]" 2>/dev/null)

  VM_IPS=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && VM_IPS+=("$line")
  done <<< "$VM_IPS_RAW"
  echo "Found ${#VM_IPS[@]} VMs"
fi

SUCCESS=0
FAIL=0
SKIP=0
ALREADY=0

for IP in "${VM_IPS[@]}"; do
  [[ -z "$IP" ]] && continue

  if $DRY_RUN; then
    echo "[DRY-RUN] Would patch Brave Search on $IP"
    ((SKIP++)) || true
    continue
  fi

  echo -n "[$IP] "

  # Patch openclaw.json and restart gateway
  RESULT=$(ssh $SSH_OPTS "openclaw@${IP}" "python3 -c \"
import json, sys

config_path = '/home/openclaw/.openclaw/openclaw.json'
try:
    with open(config_path) as f:
        config = json.load(f)
except Exception as e:
    print(f'ERROR: {e}')
    sys.exit(1)

# Check if already configured
existing = config.get('tools', {}).get('web', {}).get('search', {})
if existing.get('apiKey') == '${BRAVE_KEY}':
    print('ALREADY_CONFIGURED')
    sys.exit(0)

# Patch in the correct schema path
if 'tools' not in config:
    config['tools'] = {}
if 'web' not in config['tools']:
    config['tools']['web'] = {}
config['tools']['web']['search'] = {
    'provider': 'brave',
    'apiKey': '${BRAVE_KEY}',
}

# Remove old wrong path if it exists
if 'webSearch' in config.get('tools', {}):
    del config['tools']['webSearch']

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)
print('PATCHED')
\"" 2>&1 || true)

  if echo "$RESULT" | grep -q "ALREADY_CONFIGURED"; then
    echo "OK (already configured)"
    ((ALREADY++)) || true
    ((SUCCESS++)) || true
    continue
  fi

  if echo "$RESULT" | grep -q "PATCHED"; then
    # Restart gateway to pick up new config
    RESTART=$(ssh $SSH_OPTS "openclaw@${IP}" "systemctl --user restart openclaw-gateway 2>&1; sleep 5; systemctl --user is-active openclaw-gateway 2>&1" 2>&1 || true)
    if echo "$RESTART" | grep -q "active"; then
      echo "OK (patched + restarted)"
      ((SUCCESS++)) || true
    else
      echo "WARN (patched but gateway restart issue: $RESTART)"
      ((SUCCESS++)) || true
    fi
  elif echo "$RESULT" | grep -q "ERROR\|Connection"; then
    echo "FAIL: $RESULT"
    ((FAIL++)) || true
  else
    echo "FAIL: $RESULT"
    ((FAIL++)) || true
  fi
done

echo ""
echo "=== RESULTS ==="
echo "Success:            $SUCCESS"
echo "  Already had key:  $ALREADY"
echo "Failed:             $FAIL"
echo "Skipped:            $SKIP"
echo "Total:              ${#VM_IPS[@]}"
