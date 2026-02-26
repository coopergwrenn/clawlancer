#!/bin/bash
#
# fleet-push-soul-ops.sh — Insert Operating Principles into SOUL.md on all assigned VMs
#
# Adds the "Operating Principles" section (error handling + config safety) before
# the existing "Boundaries" section in SOUL.md. Skips VMs that already have it.
# Does NOT restart gateways (workspace files don't require restart).
#
# Usage:
#   ./instaclaw/scripts/fleet-push-soul-ops.sh                    # All assigned VMs
#   ./instaclaw/scripts/fleet-push-soul-ops.sh --canary 1.2.3.4   # Single VM by IP
#   ./instaclaw/scripts/fleet-push-soul-ops.sh --dry-run           # Show what would happen
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.local"
SSH_ENV_FILE="${SCRIPT_DIR}/../.env.ssh-key"

# Defaults
CANARY_IP=""
DRY_RUN=false

# Parse args
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
      echo "Unknown arg: $1"
      echo "Usage: $0 [--canary <ip>] [--dry-run]"
      exit 1
      ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env.local not found at $ENV_FILE"
  exit 1
fi

# Load env vars (handle quoted values)
load_env() {
  local key="$1"
  local val=""
  # Try .env.local first, then .env.ssh-key
  val=$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
  if [ -z "$val" ] && [ -f "$SSH_ENV_FILE" ]; then
    val=$(grep "^${key}=" "$SSH_ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
  fi
  echo "$val"
}

SUPABASE_URL=$(load_env "NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY=$(load_env "SUPABASE_SERVICE_ROLE_KEY")
SSH_PRIVATE_KEY_B64=$(load_env "SSH_PRIVATE_KEY_B64")

if [ -z "$SUPABASE_URL" ]; then echo "Error: NEXT_PUBLIC_SUPABASE_URL not found"; exit 1; fi
if [ -z "$SUPABASE_KEY" ]; then echo "Error: SUPABASE_SERVICE_ROLE_KEY not found"; exit 1; fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then echo "Error: SSH_PRIVATE_KEY_B64 not found in .env.local or .env.ssh-key"; exit 1; fi

# Write SSH key to temp file
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

# The content to insert (as a sed-safe replacement string)
# Using base64 to avoid escaping issues
OPS_CONTENT="## Operating Principles

1. **Error handling:** Fix routine errors immediately without bothering the user. For anything involving security, data loss, or money — ask first.

2. **Config safety:** Always back up files before modifying them. For unfamiliar systems, read docs first. For routine changes, proceed confidently.

"
OPS_B64=$(echo "$OPS_CONTENT" | base64)

# Fetch VMs
echo "=== Fleet Push: SOUL.md Operating Principles ==="
echo ""

if [ -n "$CANARY_IP" ]; then
  echo "Mode: CANARY ($CANARY_IP)"
  VMS=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?ip_address=eq.${CANARY_IP}&select=id,ip_address,ssh_port,ssh_user,name" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}")
else
  echo "Mode: FLEET (all assigned VMs)"
  VMS=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?gateway_token=not.is.null&select=id,ip_address,ssh_port,ssh_user,name" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}")
fi

VM_COUNT=$(echo "$VMS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
echo "Found $VM_COUNT VM(s)"
if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN — no changes will be made"
fi
echo ""

SUCCESS=0
FAILED=0
SKIPPED=0

push_vm() {
  local VM_IP="$1"
  local VM_PORT="$2"
  local VM_USER="$3"
  local VM_NAME="$4"

  local SSH_CMD="ssh -n -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i $SSH_KEY_FILE -p $VM_PORT ${VM_USER}@${VM_IP}"

  # Check if already present
  local CHECK
  CHECK=$($SSH_CMD 'grep -qF "Operating Principles" ~/.openclaw/workspace/SOUL.md 2>/dev/null && echo PRESENT || echo ABSENT' 2>/dev/null || echo "SSH_FAIL")

  if [ "$CHECK" = "PRESENT" ]; then
    echo "[$VM_NAME] $VM_IP — already present, skipping"
    SKIPPED=$((SKIPPED + 1))
    return 0
  fi

  if [ "$CHECK" = "SSH_FAIL" ]; then
    echo "[$VM_NAME] $VM_IP — SSH failed"
    FAILED=$((FAILED + 1))
    return 1
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "[$VM_NAME] $VM_IP — [DRY RUN] would insert Operating Principles before Boundaries"
    return 0
  fi

  # Insert: decode the base64 content to a temp file, then use sed to insert before ## Boundaries
  local RESULT
  RESULT=$($SSH_CMD "
    set -e
    SOUL=\$HOME/.openclaw/workspace/SOUL.md
    if [ ! -f \$SOUL ]; then
      echo NO_SOUL
      exit 0
    fi
    # Back up first
    cp \$SOUL \$SOUL.bak
    # Write the operating principles to a temp file
    echo '$OPS_B64' | base64 -d > /tmp/ops_insert.md
    # Use python to insert before ## Boundaries (safer than sed for multiline)
    python3 -c \"
import sys
with open('\$SOUL', 'r') as f:
    content = f.read()
with open('/tmp/ops_insert.md', 'r') as f:
    ops = f.read()
if '## Boundaries' in content:
    content = content.replace('## Boundaries', ops + '## Boundaries')
else:
    # No Boundaries section — append before ## Vibe or at the end
    if '## Vibe' in content:
        content = content.replace('## Vibe', ops + '## Vibe')
    else:
        content += '\n' + ops
with open('\$SOUL', 'w') as f:
    f.write(content)
print('INSERTED')
\"
    rm -f /tmp/ops_insert.md
  " 2>/dev/null || echo "SSH_FAILED")

  if echo "$RESULT" | grep -q "INSERTED"; then
    echo "[$VM_NAME] $VM_IP — UPDATED"
    SUCCESS=$((SUCCESS + 1))
    return 0
  elif echo "$RESULT" | grep -q "NO_SOUL"; then
    echo "[$VM_NAME] $VM_IP — no SOUL.md found, skipping"
    SKIPPED=$((SKIPPED + 1))
    return 0
  else
    echo "[$VM_NAME] $VM_IP — FAILED: $RESULT"
    FAILED=$((FAILED + 1))
    return 1
  fi
}

# Process VMs
echo "$VMS" | python3 -c "
import json, sys
for vm in json.load(sys.stdin):
    print(f\"{vm['ip_address']}|{vm.get('ssh_port',22)}|{vm.get('ssh_user','openclaw')}|{vm.get('name','unknown')}\")
" | while IFS='|' read -r VM_IP VM_PORT VM_USER VM_NAME; do
  push_vm "$VM_IP" "$VM_PORT" "$VM_USER" "$VM_NAME" || true
done

echo ""
echo "=== Done ==="
echo "  Updated: $SUCCESS"
echo "  Skipped: $SKIPPED"
echo "  Failed:  $FAILED"
