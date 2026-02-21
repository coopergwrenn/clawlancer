#!/bin/bash
#
# fleet-push-capability-awareness.sh — Push Phase 0 capability awareness to all assigned VMs
#
# Pushes updated CAPABILITIES.md, QUICK-REFERENCE.md, and the generate-capabilities.ts
# script to every assigned VM. Does NOT restart gateways — workspace files don't require it.
#
# Usage:
#   ./instaclaw/scripts/fleet-push-capability-awareness.sh                    # All assigned VMs
#   ./instaclaw/scripts/fleet-push-capability-awareness.sh --canary 1.2.3.4   # Single VM by IP
#   ./instaclaw/scripts/fleet-push-capability-awareness.sh --dry-run           # Show what would happen
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

# QUICK-REFERENCE.md content
QUICK_REF='# Quick Reference — Common Tasks

| User Says | Skill/Tool | Action |
|---|---|---|
| "Send an email" | Email (Skill 8) | AgentMail send via API |
| "Create a video" | Remotion (Skill 1) | Load remotion skill, generate |
| "Add voiceover" | Voice (Skill 11) | ElevenLabs/OpenAI TTS → Remotion |
| "Check competitors" | Competitive Intel (Skill 10) | Brave Search + web_fetch |
| "Process this return" | E-Commerce (Skill 12) | RMA workflow → ShipStation |
| "What sold today?" | E-Commerce (Skill 12) | Pull orders from all platforms |
| "Sync inventory" | E-Commerce (Skill 12) | Cross-platform sync |
| "Find a bounty" | Clawlancer (Skill 6) | mcporter call list_bounties |
| "Write a tweet" | Social Media (Skill 9) | Generate content (posting may be blocked) |
| "Stock price of X" | Financial (Skill 7) | Alpha Vantage API |
| "Extract brand assets" | Brand (Skill 5) | Load brand-extraction skill |
| "Search the web" | Web Search (Skill 2) | Brave Search API (check if configured) |
| "What can you do?" | Meta | Read CAPABILITIES.md |'

QUICK_REF_B64=$(echo "$QUICK_REF" | base64)

# Read the generate-capabilities.ts script
GEN_SCRIPT_PATH="${SCRIPT_DIR}/generate-capabilities.ts"
if [ ! -f "$GEN_SCRIPT_PATH" ]; then
  echo "Error: generate-capabilities.ts not found at $GEN_SCRIPT_PATH"
  exit 1
fi
GEN_SCRIPT_B64=$(base64 < "$GEN_SCRIPT_PATH")

# Fetch VMs
echo "=== Fleet Push: Capability Awareness (Phase 0) ==="
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
    echo "[$VM_NAME] $VM_IP — [DRY RUN] would push QUICK-REFERENCE.md + generate-capabilities.ts"
    continue
  fi

  echo -n "[$VM_NAME] $VM_IP — "

  RESULT=$(ssh -n -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes \
    -i "$SSH_KEY_FILE" -p "$VM_PORT" "${VM_USER}@${VM_IP}" \
    "W=\$HOME/.openclaw/workspace && S=\$HOME/.openclaw/scripts && mkdir -p \$W \$S && echo '${QUICK_REF_B64}' | base64 -d > \$W/QUICK-REFERENCE.md && echo '${GEN_SCRIPT_B64}' | base64 -d > \$S/generate-capabilities.ts && echo CAPABILITY_AWARENESS_PUSHED" 2>/dev/null || true)

  if echo "$RESULT" | grep -q "CAPABILITY_AWARENESS_PUSHED"; then
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
echo ""
echo "Note: CAPABILITIES.md is deployed via configureOpenClaw() for new VMs."
echo "For existing VMs, the generate-capabilities.ts script was pushed."
echo "Run it on each VM with: npx tsx ~/scripts/generate-capabilities.ts"
