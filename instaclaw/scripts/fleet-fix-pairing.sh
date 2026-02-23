#!/bin/bash
#
# fleet-fix-pairing.sh — Deploy auto-approve cron + fix existing pairing on all VMs
#
# Deploys a Python script that runs every minute alongside strip-thinking.py.
# It checks ~/.openclaw/devices/pending.json for scope upgrade requests and
# auto-approves them. Also ensures all paired devices have all 6 operator scopes.
#
# This fixes the recurring bug where the gateway-client device gets paired with
# only operator.read, then the scope upgrade to operator.write gets stuck in
# pending.json, causing a crash loop ("pairing required" every second).
#
# Usage:
#   ./instaclaw/scripts/fleet-fix-pairing.sh                    # All assigned VMs
#   ./instaclaw/scripts/fleet-fix-pairing.sh --canary 1.2.3.4   # Single VM
#   ./instaclaw/scripts/fleet-fix-pairing.sh --dry-run           # Show what would happen
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.local"
SSH_ENV_FILE="${SCRIPT_DIR}/../.env.ssh-key"

CANARY_IP=""
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --canary)
      CANARY_IP="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Load SSH key
if [[ -f "$SSH_ENV_FILE" ]]; then
  SSH_KEY_B64=$(grep "SSH_PRIVATE_KEY_B64" "$SSH_ENV_FILE" | sed 's/SSH_PRIVATE_KEY_B64="//' | sed 's/"$//')
else
  echo "ERROR: $SSH_ENV_FILE not found"
  exit 1
fi

SSH_KEY_FILE=$(mktemp /tmp/ic-fleet-pair-XXXXXX)
echo "$SSH_KEY_B64" | base64 -d > "$SSH_KEY_FILE" 2>/dev/null || echo "$SSH_KEY_B64" | base64 -D > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap "rm -f $SSH_KEY_FILE" EXIT

SSH_OPTS="-i $SSH_KEY_FILE -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15"

# Load Supabase creds
source "$ENV_FILE" 2>/dev/null || true
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

# The auto-approve cron script
read -r -d '' APPROVE_SCRIPT << 'PYEOF' || true
#!/usr/bin/env python3
"""auto-approve-pairing.py — Fix stuck device pairing scope upgrades.

Runs every minute via cron. Checks for:
1. Pending scope upgrade requests in pending.json → auto-approves with all scopes
2. Paired devices missing scopes → patches them to have all 6 scopes

This prevents the gateway crash loop where operator.read → operator.write
upgrade gets stuck in pending.json.
"""
import json, os, sys, time

DEVICES_DIR = os.path.expanduser("~/.openclaw/devices")
PENDING_FILE = os.path.join(DEVICES_DIR, "pending.json")
PAIRED_FILE = os.path.join(DEVICES_DIR, "paired.json")

ALL_SCOPES = [
    "operator.admin",
    "operator.approvals",
    "operator.pairing",
    "operator.read",
    "operator.write",
    "operator.talk",
]

changed = False

# Load current state
try:
    with open(PAIRED_FILE) as f:
        paired = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    paired = {}

try:
    with open(PENDING_FILE) as f:
        pending = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    pending = {}

# 1. Auto-approve any pending requests
if pending:
    for rid, req in pending.items():
        device_id = req.get("deviceId", rid)
        existing = paired.get(device_id, {})
        paired[device_id] = {
            "deviceId": device_id,
            "publicKey": req.get("publicKey", existing.get("publicKey", "")),
            "platform": req.get("platform", existing.get("platform", "linux")),
            "clientId": req.get("clientId", existing.get("clientId", "")),
            "clientMode": req.get("clientMode", existing.get("clientMode", "backend")),
            "role": "operator",
            "roles": ["operator"],
            "scopes": ALL_SCOPES,
            "approvedScopes": ALL_SCOPES,
            "tokens": existing.get("tokens", {}),
            "createdAtMs": existing.get("createdAtMs", int(time.time() * 1000)),
            "approvedAtMs": int(time.time() * 1000),
            "displayName": existing.get("displayName", req.get("clientId", "agent")),
        }
    # Clear pending
    with open(PENDING_FILE, "w") as f:
        json.dump({}, f)
    changed = True

# 2. Ensure all paired devices have all scopes
for device_id, device in paired.items():
    current_scopes = set(device.get("scopes", []))
    if not current_scopes.issuperset(ALL_SCOPES):
        device["scopes"] = ALL_SCOPES
        device["approvedScopes"] = ALL_SCOPES
        changed = True

# Write if changed
if changed:
    os.makedirs(DEVICES_DIR, exist_ok=True)
    with open(PAIRED_FILE, "w") as f:
        json.dump(paired, f, indent=2)
PYEOF

SUCCESS=0
FAIL=0
SKIP=0

for IP in "${VM_IPS[@]}"; do
  [[ -z "$IP" ]] && continue

  if $DRY_RUN; then
    echo "[DRY-RUN] Would deploy auto-approve-pairing.py to $IP"
    ((SKIP++))
    continue
  fi

  echo -n "[$IP] "

  # Deploy the script and add cron entry
  RESULT=$(ssh $SSH_OPTS "openclaw@${IP}" bash -s << SSHEOF 2>&1
set -e

# Write the auto-approve script
mkdir -p ~/.openclaw/scripts
cat > ~/.openclaw/scripts/auto-approve-pairing.py << 'INNEREOF'
${APPROVE_SCRIPT}
INNEREOF
chmod +x ~/.openclaw/scripts/auto-approve-pairing.py

# Add cron entry if not already present
CRON_LINE="* * * * * python3 ~/.openclaw/scripts/auto-approve-pairing.py > /dev/null 2>&1"
(crontab -l 2>/dev/null | grep -v "auto-approve-pairing" ; echo "\$CRON_LINE") | crontab -

# Run it once NOW to fix any current stuck pairing
python3 ~/.openclaw/scripts/auto-approve-pairing.py 2>/dev/null || true

# Check results
PAIRED_SCOPES=""
if [ -f ~/.openclaw/devices/paired.json ]; then
  PAIRED_SCOPES=\$(python3 -c "
import json
try:
  with open('$HOME/.openclaw/devices/paired.json') as f:
    d = json.load(f)
  for did, dev in d.items():
    scopes = dev.get('scopes', [])
    print(f'{dev.get(\"displayName\",\"?\")}: {len(scopes)} scopes')
except: print('parse-error')
" 2>/dev/null)
fi

PENDING_COUNT=0
if [ -f ~/.openclaw/devices/pending.json ]; then
  PENDING_COUNT=\$(python3 -c "
import json
try:
  with open('$HOME/.openclaw/devices/pending.json') as f:
    print(len(json.load(f)))
except: print(0)
" 2>/dev/null)
fi

echo "OK paired=[\${PAIRED_SCOPES}] pending=\${PENDING_COUNT}"
SSHEOF
  )

  if echo "$RESULT" | grep -q "OK"; then
    echo "$RESULT" | grep "OK" | tail -1
    ((SUCCESS++))
  else
    echo "FAIL: $(echo "$RESULT" | tail -1)"
    ((FAIL++))
  fi
done

echo ""
echo "=== RESULTS ==="
echo "Success: $SUCCESS"
echo "Failed:  $FAIL"
echo "Skipped: $SKIP"
echo "Total:   ${#VM_IPS[@]}"
