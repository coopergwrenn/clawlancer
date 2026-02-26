#!/bin/bash
#
# fleet-push-brand-skill.sh — Deploy brand asset extraction skill to existing VMs
#
# Pushes: SKILL.md, brand-extraction-guide.md
# No external API keys needed — uses browser automation (pre-installed).
#
# Usage:
#   fleet-push-brand-skill.sh --dry-run    — Preview deployment
#   fleet-push-brand-skill.sh --canary     — Deploy to 1 VM, pause for approval
#   fleet-push-brand-skill.sh --all        — Deploy to all active VMs
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$PROJECT_ROOT/skills/brand-design"

# Load env
if [ -f "$PROJECT_ROOT/.env.local" ]; then
  set -a
  source "$PROJECT_ROOT/.env.local"
  set +a
fi

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
SUPABASE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
  echo "ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" >&2
  exit 1
fi

# Load SSH key
SSH_ENV_FILE="$PROJECT_ROOT/.env.ssh-key"
SSH_PRIVATE_KEY_B64=""
if [ -f "$SSH_ENV_FILE" ]; then
  SSH_PRIVATE_KEY_B64=$(grep "^SSH_PRIVATE_KEY_B64=" "$SSH_ENV_FILE" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" | tr -d '\n')
fi
if [ -z "$SSH_PRIVATE_KEY_B64" ]; then
  echo "ERROR: SSH_PRIVATE_KEY_B64 not found in .env.ssh-key" >&2
  exit 1
fi
SSH_KEY_FILE=$(mktemp)
echo "$SSH_PRIVATE_KEY_B64" | base64 -d > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"
trap 'rm -f "$SSH_KEY_FILE"' EXIT

MODE="${1:---help}"

fetch_vms() {
  curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?gateway_token=not.is.null&select=id,ip_address,ssh_user,name" \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY"
}

deploy_to_vm() {
  local ip="$1" user="$2" vm_id="$3"

  echo "  Deploying to $vm_id ($user@$ip)..."

  local skill_md_b64 guide_b64
  skill_md_b64=$(base64 < "$SKILL_DIR/SKILL.md")
  guide_b64=$(base64 < "$SKILL_DIR/references/brand-extraction-guide.md")

  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i "$SSH_KEY_FILE" "${user}@${ip}" bash -s <<REMOTE_SCRIPT
set -e

SKILL_DIR="\$HOME/.openclaw/skills/brand-design"
mkdir -p "\$SKILL_DIR/references"

echo '$skill_md_b64' | base64 -d > "\$SKILL_DIR/SKILL.md"
echo '$guide_b64' | base64 -d > "\$SKILL_DIR/references/brand-extraction-guide.md"

echo "  Brand asset extraction skill deployed successfully"
REMOTE_SCRIPT

  echo "  done: $vm_id"
}

case "$MODE" in
  --dry-run)
    echo "=== DRY RUN: Brand Asset Extraction Skill Deployment ==="
    echo ""
    echo "Files to deploy:"
    echo "  SKILL.md                   -> ~/.openclaw/skills/brand-design/SKILL.md"
    echo "  brand-extraction-guide.md  -> ~/.openclaw/skills/brand-design/references/"
    echo ""
    echo "No API keys required — uses browser automation (pre-installed)."
    echo ""

    VMS=$(fetch_vms)
    COUNT=$(echo "$VMS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    echo "Active VMs: $COUNT"
    echo ""
    echo "Run with --canary to deploy to 1 VM first, then --all for the rest."
    ;;

  --canary)
    echo "=== CANARY: Deploying to first VM only ==="
    VMS=$(fetch_vms)

    if [ -n "${CANARY_IP:-}" ]; then
      FIRST=$(echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
for v in vms:
    if v['ip_address'] == '${CANARY_IP}':
        print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']}\")
        break
" 2>/dev/null)
    else
      FIRST=$(echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
if vms:
    v = vms[0]
    print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']}\")
" 2>/dev/null)
    fi

    if [ -z "$FIRST" ]; then
      echo "No active VMs found" >&2
      exit 1
    fi

    read -r IP USER VM_ID <<< "$FIRST"
    deploy_to_vm "$IP" "$USER" "$VM_ID"

    echo ""
    echo "=== CANARY COMPLETE ==="
    echo "Verify: ssh ${USER}@${IP} 'ls ~/.openclaw/skills/brand-design/'"
    echo "If healthy, run: $0 --all"
    ;;

  --all)
    echo "=== FLEET DEPLOY: Brand Asset Extraction Skill ==="
    VMS=$(fetch_vms)

    echo "$VMS" | python3 -c "
import json, sys
vms = json.load(sys.stdin)
for v in vms:
    print(f\"{v['ip_address']} {v.get('ssh_user','agent')} {v['id']}\")
" 2>/dev/null | while read -r IP USER VM_ID; do
      deploy_to_vm "$IP" "$USER" "$VM_ID" || echo "  FAILED: $VM_ID ($IP)" >&2
    done

    echo ""
    echo "=== FLEET DEPLOY COMPLETE ==="
    ;;

  --help|*)
    echo "fleet-push-brand-skill.sh — Deploy brand asset extraction skill to fleet"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview deployment (ALWAYS run first)"
    echo "  $0 --canary    — Deploy to 1 VM, verify, then --all"
    echo "  $0 --all       — Deploy to all active VMs"
    ;;
esac
