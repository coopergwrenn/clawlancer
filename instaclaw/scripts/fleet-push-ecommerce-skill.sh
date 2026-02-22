#!/bin/bash
#
# fleet-push-ecommerce-skill.sh — Deploy e-commerce marketplace skill to existing VMs
#
# Pushes: SKILL.md, ecommerce-ops.py, ecommerce-setup.sh, ecommerce-guide.md to all active VMs.
# BYOK — no platform-level API keys deployed. Users provide their own credentials.
#
# Usage:
#   fleet-push-ecommerce-skill.sh --dry-run    — Preview deployment
#   fleet-push-ecommerce-skill.sh --canary     — Deploy to 1 VM, pause for approval
#   fleet-push-ecommerce-skill.sh --all        — Deploy to all active VMs
#
# MANDATORY: Always run --dry-run first, per CLAUDE.md rules.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_DIR="$PROJECT_ROOT/skills/ecommerce-marketplace"

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
  curl -s "${SUPABASE_URL}/rest/v1/instaclaw_vms?assigned_to=not.is.null&select=id,ip_address,ssh_user,name" \
    -H "apikey: $SUPABASE_KEY" \
    -H "Authorization: Bearer $SUPABASE_KEY"
}

deploy_to_vm() {
  local ip="$1" user="$2" vm_id="$3"

  echo "  Deploying to $vm_id ($user@$ip)..."

  local skill_md_b64 guide_b64 ops_b64 setup_b64
  skill_md_b64=$(base64 < "$SKILL_DIR/SKILL.md")
  guide_b64=$(base64 < "$SKILL_DIR/references/ecommerce-guide.md")
  ops_b64=$(base64 < "$SKILL_DIR/assets/ecommerce-ops.py")
  setup_b64=$(base64 < "$SKILL_DIR/assets/ecommerce-setup.sh")

  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i "$SSH_KEY_FILE" "${user}@${ip}" bash -s <<REMOTE_SCRIPT
set -e

SKILL_DIR="\$HOME/.openclaw/skills/ecommerce-marketplace"
mkdir -p "\$SKILL_DIR/references" "\$SKILL_DIR/assets" "\$HOME/scripts"
mkdir -p "\$HOME/.openclaw/workspace/ecommerce/reports"
mkdir -p "\$HOME/.openclaw/config"

echo '$skill_md_b64' | base64 -d > "\$SKILL_DIR/SKILL.md"
echo '$guide_b64' | base64 -d > "\$SKILL_DIR/references/ecommerce-guide.md"
echo '$ops_b64' | base64 -d > "\$HOME/scripts/ecommerce-ops.py"
echo '$setup_b64' | base64 -d > "\$HOME/scripts/ecommerce-setup.sh"
chmod +x "\$HOME/scripts/ecommerce-ops.py"
chmod +x "\$HOME/scripts/ecommerce-setup.sh"

# Create default ecommerce.yaml if it doesn't exist (preserves user's config)
if [ ! -f "\$HOME/.openclaw/config/ecommerce.yaml" ]; then
  "\$HOME/scripts/ecommerce-setup.sh" init 2>/dev/null || true
fi

echo "  E-commerce skill deployed successfully"
REMOTE_SCRIPT

  echo "  done: $vm_id"
}

case "$MODE" in
  --dry-run)
    echo "=== DRY RUN: E-Commerce Marketplace Skill Deployment ==="
    echo ""
    echo "Files to deploy:"
    echo "  SKILL.md             -> ~/.openclaw/skills/ecommerce-marketplace/SKILL.md"
    echo "  ecommerce-guide.md   -> ~/.openclaw/skills/ecommerce-marketplace/references/ecommerce-guide.md"
    echo "  ecommerce-ops.py     -> ~/scripts/ecommerce-ops.py"
    echo "  ecommerce-setup.sh   -> ~/scripts/ecommerce-setup.sh"
    echo ""
    echo "Directories created:"
    echo "  ~/.openclaw/workspace/ecommerce/reports/"
    echo "  ~/.openclaw/config/"
    echo ""
    echo "BYOK — No platform-level API keys deployed."
    echo "Users configure their own Shopify/Amazon/eBay credentials via ecommerce-setup.sh init"
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
    echo "Verify: ssh ${USER}@${IP} 'python3 ~/scripts/ecommerce-ops.py status'"
    echo "If healthy, run: $0 --all"
    ;;

  --all)
    echo "=== FLEET DEPLOY: E-Commerce Marketplace Skill ==="
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
    echo "fleet-push-ecommerce-skill.sh — Deploy e-commerce marketplace skill to fleet"
    echo ""
    echo "Usage:"
    echo "  $0 --dry-run   — Preview deployment (ALWAYS run first)"
    echo "  $0 --canary    — Deploy to 1 VM, verify, then --all"
    echo "  $0 --all       — Deploy to all active VMs"
    echo ""
    echo "BYOK: No platform API keys deployed. Users configure their own credentials."
    ;;
esac
