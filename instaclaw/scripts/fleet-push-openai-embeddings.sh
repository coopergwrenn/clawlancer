#!/bin/bash
#
# fleet-push-openai-embeddings.sh — Deploy OpenAI API key for memory search embeddings
#
# Adds OPENAI_API_KEY to each VM's .env, patches auth-profiles.json with an
# OpenAI provider entry, and restarts the gateway. This enables semantic memory
# search (embeddings) which was previously failing with "no embedding provider."
#
# Usage:
#   ./instaclaw/scripts/fleet-push-openai-embeddings.sh --dry-run               # Show what would happen
#   ./instaclaw/scripts/fleet-push-openai-embeddings.sh --canary 1.2.3.4        # Single VM
#   ./instaclaw/scripts/fleet-push-openai-embeddings.sh --all                   # All assigned VMs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.local"
SSH_ENV_FILE="${SCRIPT_DIR}/../.env.ssh-key"

CANARY_IP=""
DRY_RUN=false
ALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --canary) CANARY_IP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --all) ALL=true; shift ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

if ! $DRY_RUN && [[ -z "$CANARY_IP" ]] && ! $ALL; then
  echo "ERROR: Must specify --canary <IP>, --all, or --dry-run"
  echo "Usage:"
  echo "  $0 --dry-run              # Show what would happen"
  echo "  $0 --canary 1.2.3.4       # Single VM first"
  echo "  $0 --all                  # All assigned VMs"
  exit 1
fi

# Load SSH key
if [[ -f "$SSH_ENV_FILE" ]]; then
  SSH_KEY_B64=$(grep "SSH_PRIVATE_KEY_B64" "$SSH_ENV_FILE" | sed 's/SSH_PRIVATE_KEY_B64="//' | sed 's/"$//')
else
  echo "ERROR: $SSH_ENV_FILE not found"; exit 1
fi

# Load env vars (includes OPENAI_API_KEY)
source "$ENV_FILE" 2>/dev/null || true

OPENAI_KEY="${OPENAI_API_KEY:-}"
if [[ -z "$OPENAI_KEY" ]]; then
  echo "ERROR: OPENAI_API_KEY not found in $ENV_FILE"; exit 1
fi

SSH_KEY_FILE=$(mktemp /tmp/ic-openai-fleet-XXXXXX)
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
  VM_IPS_RAW=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?assigned_to=not.is.null&select=ip_address&health_status=neq.configure_failed" \
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

# Base64 encode the API key for safe transport (avoids shell injection)
OPENAI_KEY_B64=$(echo -n "$OPENAI_KEY" | base64)

for IP in "${VM_IPS[@]}"; do
  [[ -z "$IP" ]] && continue

  if $DRY_RUN; then
    echo "[DRY-RUN] Would deploy OpenAI embeddings key to $IP"
    ((SKIP++)) || true
    continue
  fi

  echo -n "[$IP] "

  # Step 1: Add OPENAI_API_KEY to ~/.openclaw/.env (append or replace)
  ENV_RESULT=$(ssh $SSH_OPTS "openclaw@${IP}" "
    touch \"\$HOME/.openclaw/.env\"
    OAI_KEY=\$(echo '${OPENAI_KEY_B64}' | base64 -d)
    if grep -q '^OPENAI_API_KEY=' \"\$HOME/.openclaw/.env\" 2>/dev/null; then
      EXISTING=\$(grep '^OPENAI_API_KEY=' \"\$HOME/.openclaw/.env\" | head -1 | cut -d= -f2-)
      if [ \"\$EXISTING\" = \"\$OAI_KEY\" ]; then
        echo 'ENV_ALREADY'
      else
        sed -i \"s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=\$OAI_KEY|\" \"\$HOME/.openclaw/.env\"
        echo 'ENV_UPDATED'
      fi
    else
      echo \"OPENAI_API_KEY=\$OAI_KEY\" >> \"\$HOME/.openclaw/.env\"
      echo 'ENV_ADDED'
    fi
  " 2>&1 || echo "ENV_FAIL")

  if echo "$ENV_RESULT" | grep -q "ENV_FAIL"; then
    echo "FAIL (env write): $ENV_RESULT"
    ((FAIL++)) || true
    continue
  fi

  # Step 2: Patch auth-profiles.json to add OpenAI provider
  AUTH_RESULT=$(ssh $SSH_OPTS "openclaw@${IP}" "python3 -c \"
import json, os, sys

auth_path = os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')
try:
    with open(auth_path) as f:
        auth = json.load(f)
except Exception as e:
    print(f'AUTH_READ_FAIL: {e}')
    sys.exit(1)

profiles = auth.get('profiles', {})

# Check if OpenAI profile already exists with same key
import base64
key = base64.b64decode('${OPENAI_KEY_B64}').decode()
existing = profiles.get('openai:default', {})
if existing.get('key') == key and existing.get('provider') == 'openai':
    print('AUTH_ALREADY')
    sys.exit(0)

# Add OpenAI profile
profiles['openai:default'] = {
    'type': 'api_key',
    'provider': 'openai',
    'key': key,
}
auth['profiles'] = profiles

with open(auth_path, 'w') as f:
    json.dump(auth, f, indent=2)
print('AUTH_PATCHED')
\"" 2>&1 || echo "AUTH_FAIL")

  if echo "$AUTH_RESULT" | grep -q "AUTH_FAIL\|AUTH_READ_FAIL"; then
    echo "FAIL (auth profile): $AUTH_RESULT"
    ((FAIL++)) || true
    continue
  fi

  # Check if both were already configured
  if echo "$ENV_RESULT" | grep -q "ENV_ALREADY" && echo "$AUTH_RESULT" | grep -q "AUTH_ALREADY"; then
    echo "OK (already configured)"
    ((ALREADY++)) || true
    ((SUCCESS++)) || true
    continue
  fi

  # Step 3: Restart gateway to pick up new config
  RESTART=$(ssh $SSH_OPTS "openclaw@${IP}" "
    systemctl --user restart openclaw-gateway 2>&1
    sleep 8
    systemctl --user is-active openclaw-gateway 2>&1
  " 2>&1 || echo "RESTART_FAIL")

  if ! echo "$RESTART" | grep -q "active"; then
    echo "WARN (key deployed but gateway restart issue: $RESTART)"
    ((FAIL++)) || true
    continue
  fi

  # Step 4: Verify with openclaw doctor
  DOCTOR=$(ssh $SSH_OPTS "openclaw@${IP}" "
    export PATH=\"\$HOME/.nvm/versions/node/\$(ls \$HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:\$PATH\" 2>/dev/null
    openclaw doctor 2>&1 | grep -iE 'memory|embedding|openai' || echo 'NO_MATCH'
  " 2>&1 || echo "DOCTOR_FAIL")

  ENV_STATUS=$(echo "$ENV_RESULT" | grep -oE 'ENV_[A-Z]+' | tail -1)
  AUTH_STATUS=$(echo "$AUTH_RESULT" | grep -oE 'AUTH_[A-Z]+' | tail -1)
  echo "OK (env:${ENV_STATUS}, auth:${AUTH_STATUS}, gateway:active)"
  echo "  doctor: $(echo "$DOCTOR" | head -3)"
  ((SUCCESS++)) || true

done

echo ""
echo "=== RESULTS ==="
echo "Success:            $SUCCESS"
echo "  Already had key:  $ALREADY"
echo "Failed:             $FAIL"
echo "Skipped:            $SKIP"
echo "Total:              ${#VM_IPS[@]}"
