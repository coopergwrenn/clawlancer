#!/bin/bash
#
# fleet-push-heartbeat-md.sh — Push proactive HEARTBEAT.md to all assigned VMs
#
# Overwrites ~/.openclaw/agents/main/agent/HEARTBEAT.md on every assigned VM
# with the 5-phase proactive work cycle (SCAN/EVALUATE/PREPARE/PRESENT/EXECUTE).
# No gateway restart needed — workspace files don't require it.
#
# Usage:
#   ./instaclaw/scripts/fleet-push-heartbeat-md.sh                    # All assigned VMs
#   ./instaclaw/scripts/fleet-push-heartbeat-md.sh --canary 1.2.3.4   # Single VM by IP
#   ./instaclaw/scripts/fleet-push-heartbeat-md.sh --dry-run           # Show what would happen
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
load_env_any() {
  local key="$1"
  local val
  val=$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
  if [ -z "$val" ] && [ -f "$SSH_ENV_FILE" ]; then
    val=$(grep "^${key}=" "$SSH_ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
  fi
  echo "$val"
}

SUPABASE_URL=$(load_env_any "NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY=$(load_env_any "SUPABASE_SERVICE_ROLE_KEY")
SSH_PRIVATE_KEY_B64=$(load_env_any "SSH_PRIVATE_KEY_B64")

if [ -z "$SUPABASE_URL" ]; then echo "Error: NEXT_PUBLIC_SUPABASE_URL not found"; exit 1; fi
if [ -z "$SUPABASE_KEY" ]; then echo "Error: SUPABASE_SERVICE_ROLE_KEY not found"; exit 1; fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then echo "Error: SSH_PRIVATE_KEY_B64 not found in .env.local or .env.ssh-key"; exit 1; fi

# Write SSH key to temp file
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

# The new 5-phase proactive HEARTBEAT.md content (PRD Phase 1)
HEARTBEAT_MD='# HEARTBEAT.md — Proactive Work Cycle

## How This Works

- **Frequency:** Every 3 hours (configured in gateway settings)
- **Trigger:** Automatic timer-based wake-up when no active conversation
- **Budget:** ~10 API calls per cycle. Keep it fast.

## The 5-Phase Cycle

### Phase 1: SCAN (first 2-3 min)
- Check for unread messages across all channels
- Check Clawlancer for new bounties (if marketplace connected)
- Check `memory/active-tasks.md` for stale items
- Scan email inbox if email monitoring is configured

### Phase 2: EVALUATE (next 2-3 min)
- Score each finding: Can I handle it? Worth the time? Confidence level?
- Classify messages: urgent vs actionable vs FYI
- Check stale tasks: finish, archive, or escalate?

### Phase 3: PREPARE (next 2-3 min)
- Draft responses for anything that needs one (never send without approval unless pre-approved)
- Draft bounty approaches for good matches
- Prepare brief status summary

### Phase 4: PRESENT (next 2-3 min)
- If anything worth reporting, send a digest message to the user
- If nothing found: "Standing by, monitoring [channels]. All clear."

### Phase 5: EXECUTE (remaining time)
- Pre-approved routine tasks: execute autonomously
- Everything else: wait for user response
- Update memory with what happened this cycle

## Interruption Protocol

**During active conversations (last user message < 10 minutes):**
- Run heartbeat SILENTLY in background
- DO NOT interrupt the conversation
- Cache findings for after the conversation ends
- ONLY interrupt if truly urgent:
  * Email from a high-priority sender (defined in USER.md)
  * System critical (server down, service error)
- If interrupting: "[btw: (brief finding), want me to handle that first or finish this?]"
- NEVER derail the current topic for low-priority findings

**During idle (last user message > 10 minutes):**
- Run full heartbeat cycle
- Present digest if anything found
- Or send brief "All clear, standing by" status

## Idle Time Rules

- Never go silent for more than 1 hour without a status update
- If nothing is happening, say so: "Standing by, monitoring. All quiet."
- Silence looks lazy, even if you are just on standby

## Weekly (First Heartbeat on Monday)

- Review and clean up MEMORY.md — archive stale entries
- Check TOOLS.md for outdated notes
- Quick workspace health check'

# Base64 encode the content for safe transfer
HEARTBEAT_B64=$(echo "$HEARTBEAT_MD" | base64)

# Fetch VMs
echo "=== Fleet Push: Proactive HEARTBEAT.md (5-phase cycle) ==="
echo ""

if [ -n "$CANARY_IP" ]; then
  echo "Mode: CANARY ($CANARY_IP)"
  VMS=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?ip_address=eq.${CANARY_IP}&select=id,ip_address,ssh_port,ssh_user,name" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}")
else
  echo "Mode: FLEET (all assigned VMs)"
  VMS=$(curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?assigned_to=not.is.null&select=id,ip_address,ssh_port,ssh_user,name" \
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

echo "$VMS" | python3 -c "
import json, sys
for vm in json.load(sys.stdin):
    print(f\"{vm['id']}|{vm['ip_address']}|{vm.get('ssh_port',22)}|{vm.get('ssh_user','openclaw')}|{vm.get('name','unknown')}\")
" | while IFS='|' read -r VM_ID VM_IP VM_PORT VM_USER VM_NAME; do
  if [ "$DRY_RUN" = true ]; then
    echo "[$VM_NAME] $VM_IP — [DRY RUN] would overwrite HEARTBEAT.md with 5-phase cycle"
    continue
  fi

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
echo "=== Done ==="
echo "  Updated: $SUCCESS"
echo "  Failed:  $FAILED"
