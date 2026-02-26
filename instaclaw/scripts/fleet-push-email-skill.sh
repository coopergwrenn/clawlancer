#!/bin/bash
#
# fleet-push-email-skill.sh — Push Email & Outreach skill to all assigned VMs
#
# Deploys the complete email-outreach skill package:
#   - SKILL.md (complete documentation)
#   - Helper scripts (email-client.sh, email-safety-check.py, email-digest.py)
#   - Email operations reference guide
#
# Does NOT restart gateways — skill files don't require it.
#
# Usage:
#   ./instaclaw/scripts/fleet-push-email-skill.sh                    # All assigned VMs
#   ./instaclaw/scripts/fleet-push-email-skill.sh --canary 1.2.3.4   # Single VM by IP
#   ./instaclaw/scripts/fleet-push-email-skill.sh --dry-run           # Show what would happen
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="${SCRIPT_DIR}/../skills/email-outreach"
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

# Verify skill directory exists
if [ ! -f "$SKILL_DIR/SKILL.md" ]; then
  echo "Error: Skill directory not found at $SKILL_DIR"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env.local not found at $ENV_FILE"
  exit 1
fi

# Load env vars
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
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then echo "Error: SSH_PRIVATE_KEY_B64 not found"; exit 1; fi

# Write SSH key to temp file
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

# Base64 encode all skill files
SKILL_MD_B64=$(base64 < "$SKILL_DIR/SKILL.md")
EMAIL_CLIENT_B64=$(base64 < "$SKILL_DIR/assets/email-client.sh")
SAFETY_CHECK_B64=$(base64 < "$SKILL_DIR/assets/email-safety-check.py")
EMAIL_DIGEST_B64=$(base64 < "$SKILL_DIR/assets/email-digest.py")
EMAIL_GUIDE_B64=$(base64 < "$SKILL_DIR/references/email-guide.md")

# Fetch VMs
echo "=== Fleet Push: Email & Outreach Skill ==="
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

echo "$VMS" | python3 -c "
import json, sys
for vm in json.load(sys.stdin):
    print(f\"{vm['id']}|{vm['ip_address']}|{vm.get('ssh_port',22)}|{vm.get('ssh_user','openclaw')}|{vm.get('name','unknown')}\")
" | while IFS='|' read -r VM_ID VM_IP VM_PORT VM_USER VM_NAME; do
  if [ "$DRY_RUN" = true ]; then
    echo "[$VM_NAME] $VM_IP — [DRY RUN] would push email skill (SKILL.md + 3 scripts + reference)"
    continue
  fi

  echo -n "[$VM_NAME] $VM_IP — "

  RESULT=$(ssh -n -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes \
    -i "$SSH_KEY_FILE" -p "$VM_PORT" "${VM_USER}@${VM_IP}" \
    "set -e && \
     SKILL=\$HOME/.openclaw/skills/email-outreach && \
     SCRIPTS=\$HOME/scripts && \
     mkdir -p \$SKILL/references \$SKILL/assets \$SCRIPTS && \
     echo '${SKILL_MD_B64}' | base64 -d > \$SKILL/SKILL.md && \
     echo '${EMAIL_GUIDE_B64}' | base64 -d > \$SKILL/references/email-guide.md && \
     echo '${EMAIL_CLIENT_B64}' | base64 -d > \$SCRIPTS/email-client.sh && \
     echo '${SAFETY_CHECK_B64}' | base64 -d > \$SCRIPTS/email-safety-check.py && \
     echo '${EMAIL_DIGEST_B64}' | base64 -d > \$SCRIPTS/email-digest.py && \
     chmod +x \$SCRIPTS/email-client.sh \$SCRIPTS/email-safety-check.py \$SCRIPTS/email-digest.py && \
     echo EMAIL_SKILL_PUSHED" 2>/dev/null || true)

  if echo "$RESULT" | grep -q "EMAIL_SKILL_PUSHED"; then
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
echo "Files deployed per VM:"
echo "  ~/.openclaw/skills/email-outreach/SKILL.md"
echo "  ~/.openclaw/skills/email-outreach/references/email-guide.md"
echo "  ~/scripts/email-client.sh"
echo "  ~/scripts/email-safety-check.py"
echo "  ~/scripts/email-digest.py"
